import { RemoteKitError } from '../../shared/errors';
import type { ControlDatabase } from '../persistence/database';
import type { NodeLink, NodeRegistry } from './node-link';

const GRACE_MS = 2 * 60 * 60 * 1000;
const objectId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const retirements = new WeakMap<ControlDatabase, Set<string>>();
export function retiringObjects(store: ControlDatabase) {
  let objects = retirements.get(store);
  if (!objects) {
    objects = new Set();
    retirements.set(store, objects);
  }
  return objects;
}
interface IndexedObject {
  tenant: string;
  id: string;
  size: bigint;
  stored_size: bigint;
  stored_sha256: string;
  created_at: bigint;
  derived_from: string | null;
}
export class ObjectIndex {
  private readonly fetches = new Map<string, Set<string>>();
  private readonly busy = new Map<string, number>();
  private readonly inventoryCommits = new Map<string, Set<string>>();
  private readonly reserved = new Map<string, number>();
  private readonly reconciling = new Set<string>();
  private readonly retired: Set<string>;
  private readonly jobs = new Set<Promise<unknown>>();
  private maintenance?: Promise<void>;
  private closed = false;
  constructor(
    private readonly store: ControlDatabase,
    readonly nodes: NodeRegistry,
    readonly tenantObjectBytes: number,
    private readonly placedOn: (tenant: string, node: string) => boolean,
    private readonly checkpointing: (tenant: string) => boolean,
  ) {
    this.retired = retiringObjects(store);
    nodes.handlers.set('object.committed', (node, message) => this.committed(node, message));
    nodes.handlers.set('object.locate', (node, message) => this.locate(node, message));
    nodes.on('ready', this.ready);
    nodes.on('metrics', this.metrics);
  }
  private track(work: Promise<unknown>) {
    this.jobs.add(work);
    void work.catch(() => {}).finally(() => this.jobs.delete(work));
  }
  private readonly ready = ({ nodeId }: { nodeId: string }) => {
    this.track(this.reconcile(this.nodes.get(nodeId)!).then(() => this.tick()));
  };
  private readonly metrics = () => {
    this.track(this.tick());
  };
  private key(tenant: string, id: string) {
    return tenant + ':' + id;
  }
  private fetchKey(nodeId: string, tenant: string) {
    return nodeId + ':' + tenant;
  }
  bytes(tenant: string) {
    const row = this.store.db
      .prepare('SELECT coalesce(sum(size),0) AS bytes FROM objects WHERE tenant=?')
      .get(tenant) as { bytes: bigint };
    return Number(row.bytes);
  }
  require(tenant: string, id: string) {
    if (!objectId(id)) throw new RemoteKitError('invalid_request', 'Asset id must be an object id');
    if (
      this.retired.has(this.key(tenant, id)) ||
      !this.store.db.prepare('SELECT 1 FROM objects WHERE tenant=? AND id=?').get(tenant, id)
    )
      throw new RemoteKitError('not_found', 'Object is not available');
  }
  committed(node: NodeLink, message: Record<string, any>) {
    const { tenantId: tenant, objectId: id, size, storedSize, storedSha256, derivedFrom } = message;
    if (
      !objectId(id) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isSafeInteger(storedSize) ||
      storedSize < 0 ||
      !objectId(storedSha256) ||
      (derivedFrom !== undefined && derivedFrom !== null && (!objectId(derivedFrom) || derivedFrom === id))
    )
      throw new RemoteKitError('invalid_request', 'Invalid object metadata');
    const expected = this.fetches.get(this.fetchKey(node.nodeId, tenant));
    if (!this.placedOn(tenant, node.nodeId) && !expected?.has(id))
      throw new RemoteKitError('forbidden', 'Tenant is not placed on this node');
    return this.store.transaction(() => {
      const previous = this.store.db
        .prepare('SELECT * FROM objects WHERE tenant=? AND id=?')
        .get(tenant, id) as IndexedObject | undefined;
      if (
        previous &&
        (previous.stored_sha256 !== storedSha256 ||
          Number(previous.size) !== size ||
          Number(previous.stored_size) !== storedSize)
      )
        throw new RemoteKitError('conflict', 'Object metadata conflicts with the index');
      if (this.retired.has(this.key(tenant, id)))
        throw new RemoteKitError('conflict', 'Object is being deleted');
      if (!previous) {
        if (this.bytes(tenant) + size > this.tenantObjectBytes)
          throw new RemoteKitError('limit_exceeded', 'Tenant object quota exceeded');
        this.store.db
          .prepare('INSERT INTO objects VALUES (?,?,?,?,?,?,?)')
          .run(tenant, id, size, storedSize, storedSha256, Date.now(), derivedFrom ?? null);
      }
      if (derivedFrom) {
        this.require(tenant, derivedFrom);
        this.store.db
          .prepare('UPDATE objects SET derived_from=coalesce(derived_from,?) WHERE tenant=? AND id=?')
          .run(derivedFrom, tenant, id);
        this.store.db
          .prepare('INSERT OR IGNORE INTO object_derivations VALUES (?,?,?)')
          .run(tenant, id, derivedFrom);
      }
      this.store.db
        .prepare('INSERT OR IGNORE INTO object_replicas VALUES (?,?,?)')
        .run(tenant, id, node.nodeId);
      this.inventoryCommits.get(node.nodeId)?.add(this.key(tenant, id));
      this.store.db
        .prepare('DELETE FROM object_inventory_orphans WHERE node_id=? AND tenant=? AND id=?')
        .run(node.nodeId, tenant, id);
      return { accepted: true };
    });
  }
  locate(node: NodeLink, message: Record<string, any>) {
    if (!this.placedOn(message.tenantId, node.nodeId))
      throw new RemoteKitError('forbidden', 'Tenant is not placed on this node');
    if (
      !Array.isArray(message.ids) ||
      message.ids.length > 4096 ||
      message.ids.some((id: unknown) => !objectId(id))
    )
      throw new RemoteKitError('invalid_request', 'Invalid object ids');
    const sources: Record<string, { nodeId: string; address: string }[]> = {};
    for (const id of message.ids) sources[id] = this.sources(message.tenantId, id);
    return { sources };
  }
  private sources(tenant: string, id: string) {
    return (
      this.store.db
        .prepare('SELECT node_id FROM object_replicas WHERE tenant=? AND id=? ORDER BY node_id')
        .all(tenant, id) as { node_id: string }[]
    ).flatMap(({ node_id }) => {
      const node = this.nodes.get(node_id);
      return node?.state.state === 'ready' && !this.nodes.isRemoved(node_id)
        ? [{ nodeId: node_id, address: node.config.peer.advertise }]
        : [];
    });
  }
  async reconcile(node: NodeLink) {
    if (node.state.state !== 'ready' || this.reconciling.has(node.nodeId)) return;
    this.reconciling.add(node.nodeId);
    const epoch = node.state.connectionEpoch;
    const present = new Set<string>();
    this.inventoryCommits.set(node.nodeId, present);
    const seen = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        const page = await node.request('object.inventory', '', { cursor });
        if (node.state.state !== 'ready' || node.state.connectionEpoch !== epoch) return;
        if (!Array.isArray(page.objects) || (page.next !== null && typeof page.next !== 'string'))
          throw new RemoteKitError('rejected', 'Invalid object inventory');
        for (const item of page.objects) {
          if (
            typeof item.tenantId !== 'string' ||
            !objectId(item.id) ||
            !objectId(item.storedSha256) ||
            !Number.isSafeInteger(item.storedSize) ||
            item.storedSize < 0
          )
            throw new RemoteKitError('rejected', 'Invalid inventory object');
          const key = this.key(item.tenantId, item.id);
          present.add(key);
          const indexed = this.store.db
            .prepare('SELECT * FROM objects WHERE tenant=? AND id=?')
            .get(item.tenantId, item.id) as IndexedObject | undefined;
          if (
            indexed &&
            indexed.stored_sha256 === item.storedSha256 &&
            Number(indexed.stored_size) === item.storedSize
          ) {
            this.store.db
              .prepare('INSERT OR IGNORE INTO object_replicas VALUES (?,?,?)')
              .run(item.tenantId, item.id, node.nodeId);
          } else if (indexed) {
            await node.request('object.delete', item.tenantId, { ids: [item.id] });
            this.store.db
              .prepare('DELETE FROM object_replicas WHERE tenant=? AND id=? AND node_id=?')
              .run(item.tenantId, item.id, node.nodeId);
          } else {
            this.store.db
              .prepare('INSERT OR IGNORE INTO object_inventory_orphans VALUES (?,?,?,?)')
              .run(node.nodeId, item.tenantId, item.id, Date.now());
          }
        }
        cursor = page.next;
        if (cursor !== null && seen.has(cursor))
          throw new RemoteKitError('rejected', 'Inventory cursor repeated');
        if (cursor !== null) seen.add(cursor);
      } while (cursor !== null);
      if (node.state.state !== 'ready' || node.state.connectionEpoch !== epoch) return;
      const replicas = this.store.db
        .prepare('SELECT tenant,id FROM object_replicas WHERE node_id=?')
        .all(node.nodeId) as { tenant: string; id: string }[];
      for (const item of replicas) {
        if (
          !present.has(this.key(item.tenant, item.id)) &&
          !this.fetches.get(this.fetchKey(node.nodeId, item.tenant))?.has(item.id)
        )
          this.store.db
            .prepare('DELETE FROM object_replicas WHERE tenant=? AND id=? AND node_id=?')
            .run(item.tenant, item.id, node.nodeId);
      }
      const orphans = this.store.db
        .prepare('SELECT tenant,id FROM object_inventory_orphans WHERE node_id=?')
        .all(node.nodeId) as { tenant: string; id: string }[];
      for (const item of orphans)
        if (!present.has(this.key(item.tenant, item.id)))
          this.store.db
            .prepare('DELETE FROM object_inventory_orphans WHERE node_id=? AND tenant=? AND id=?')
            .run(node.nodeId, item.tenant, item.id);
    } finally {
      this.reconciling.delete(node.nodeId);
      this.inventoryCommits.delete(node.nodeId);
      if (!this.closed && node.state.state === 'ready' && node.state.connectionEpoch !== epoch)
        this.ready({ nodeId: node.nodeId });
    }
  }
  private referenced() {
    const refs = new Set<string>();
    const add = (tenant: string, id: string | undefined) => {
      if (id) refs.add(this.key(tenant, id));
    };
    for (const row of this.store.db.prepare('SELECT tenant,snapshot FROM file_library').all() as {
      tenant: string;
      snapshot: string;
    }[]) {
      for (const entry of JSON.parse(row.snapshot).entries) {
        add(row.tenant, entry.assetId);
        add(row.tenant, entry.originalAssetId);
        for (const id of entry.photo?.candidateAssetIds ?? []) add(row.tenant, id);
      }
    }
    for (const row of this.store.db
      .prepare('SELECT tenant,manifest FROM file_library_selections WHERE terminal IS NULL')
      .all() as { tenant: string; manifest: string }[])
      for (const file of JSON.parse(row.manifest).files) add(row.tenant, file.assetId);
    for (const row of this.store.db
      .prepare(
        `SELECT o.tenant,o.object_id FROM checkpoint_objects o WHERE o.checkpoint_id IN
      (SELECT c.id FROM checkpoints c WHERE c.tenant=o.tenant ORDER BY c.id DESC LIMIT 2)`,
      )
      .all() as { tenant: string; object_id: string }[])
      add(row.tenant, row.object_id);
    const derivatives = this.store.db
      .prepare(
        `SELECT tenant,id,derived_from FROM objects WHERE derived_from IS NOT NULL
        UNION SELECT tenant,id,source_id AS derived_from FROM object_derivations`,
      )
      .all() as { tenant: string; id: string; derived_from: string }[];
    let changed: boolean;
    do {
      changed = false;
      for (const row of derivatives)
        if (refs.has(this.key(row.tenant, row.derived_from)) && !refs.has(this.key(row.tenant, row.id))) {
          add(row.tenant, row.id);
          changed = true;
        }
    } while (changed);
    return refs;
  }
  async gc(now = Date.now()) {
    let references = this.referenced();
    const objects = this.store.db
      .prepare('SELECT * FROM objects WHERE created_at<?')
      .all(now - GRACE_MS) as IndexedObject[];
    for (const object of objects) {
      const key = this.key(object.tenant, object.id);
      if (references.has(key) || this.checkpointing(object.tenant)) continue;
      this.retired.add(key);
      try {
        const replicas = this.store.db
          .prepare('SELECT node_id FROM object_replicas WHERE tenant=? AND id=?')
          .all(object.tenant, object.id) as { node_id: string }[];
        for (const replica of replicas) {
          const node = this.nodes.get(replica.node_id);
          if (node?.state.state !== 'ready') continue;
          await node.request('object.delete', object.tenant, { ids: [object.id] });
          references = this.referenced();
          this.store.db
            .prepare('DELETE FROM object_replicas WHERE tenant=? AND id=? AND node_id=?')
            .run(object.tenant, object.id, node.nodeId);
        }
        if (
          !this.store.db
            .prepare('SELECT 1 FROM object_replicas WHERE tenant=? AND id=?')
            .get(object.tenant, object.id)
        )
          this.store.transaction(() => {
            this.store.db
              .prepare('DELETE FROM objects WHERE tenant=? AND id=?')
              .run(object.tenant, object.id);
            this.store.db
              .prepare('DELETE FROM object_derivations WHERE tenant=? AND (id=? OR source_id=?)')
              .run(object.tenant, object.id, object.id);
          });
      } finally {
        this.retired.delete(key);
      }
    }
    const orphans = this.store.db
      .prepare('SELECT * FROM object_inventory_orphans WHERE first_seen<?')
      .all(now - GRACE_MS) as { node_id: string; tenant: string; id: string }[];
    for (const orphan of orphans) {
      const node = this.nodes.get(orphan.node_id);
      if (node?.state.state !== 'ready') continue;
      if (
        !this.store.db.prepare('SELECT 1 FROM objects WHERE tenant=? AND id=?').get(orphan.tenant, orphan.id)
      )
        await node.request('object.delete', orphan.tenant, { ids: [orphan.id] });
      this.store.db
        .prepare('DELETE FROM object_inventory_orphans WHERE node_id=? AND tenant=? AND id=?')
        .run(orphan.node_id, orphan.tenant, orphan.id);
    }
  }
  private async fetch(node: NodeLink, object: IndexedObject) {
    const key = this.fetchKey(node.nodeId, object.tenant);
    const expected = this.fetches.get(key) ?? new Set<string>();
    expected.add(object.id);
    this.fetches.set(key, expected);
    this.busy.set(node.nodeId, (this.busy.get(node.nodeId) ?? 0) + 1);
    this.reserved.set(node.nodeId, (this.reserved.get(node.nodeId) ?? 0) + Number(object.stored_size));
    try {
      await node.request('object.fetch', object.tenant, {
        ids: [object.id],
        sources: { [object.id]: this.sources(object.tenant, object.id) },
      });
      return !!this.store.db
        .prepare('SELECT 1 FROM object_replicas WHERE tenant=? AND id=? AND node_id=?')
        .get(object.tenant, object.id, node.nodeId);
    } finally {
      expected.delete(object.id);
      if (!expected.size) this.fetches.delete(key);
      this.busy.set(node.nodeId, this.busy.get(node.nodeId)! - 1);
      this.reserved.set(node.nodeId, this.reserved.get(node.nodeId)! - Number(object.stored_size));
    }
  }
  async replicate() {
    const ready = this.nodes
      .all()
      .filter((node) => node.state.state === 'ready' && !this.nodes.isRemoved(node.nodeId));
    const target = Math.min(2, ready.length);
    const jobs: Promise<unknown>[] = [];
    for (const object of this.store.db
      .prepare('SELECT * FROM objects ORDER BY created_at,tenant,id')
      .all() as IndexedObject[]) {
      const sources = this.sources(object.tenant, object.id);
      if (!sources.length) continue;
      let missing =
        target -
        sources.length -
        ready.filter((node) => this.fetches.get(this.fetchKey(node.nodeId, object.tenant))?.has(object.id))
          .length;
      for (const node of ready
        .filter((node) => {
          const sample = node.metrics.latest();
          return (
            sample &&
            sample.value.disk.free - (this.reserved.get(node.nodeId) ?? 0) - Number(object.stored_size) >=
              node.config.diskReserveBytes &&
            !node.diskDraining &&
            !this.reconciling.has(node.nodeId) &&
            !this.fetches.get(this.fetchKey(node.nodeId, object.tenant))?.has(object.id) &&
            !sources.some((source) => source.nodeId === node.nodeId)
          );
        })
        .sort((a, b) => {
          const aDisk = a.metrics.latest()!.value.disk,
            bDisk = b.metrics.latest()!.value.disk;
          return (
            1 - aDisk.free / aDisk.total - (1 - bDisk.free / bDisk.total) || a.nodeId.localeCompare(b.nodeId)
          );
        })) {
        if (missing <= 0) break;
        if (
          (this.busy.get(node.nodeId) ?? 0) >= 4 ||
          node.metrics.latest()!.value.disk.free -
            (this.reserved.get(node.nodeId) ?? 0) -
            Number(object.stored_size) <
            node.config.diskReserveBytes
        )
          continue;
        missing--;
        jobs.push(this.fetch(node, object));
      }
    }
    await Promise.allSettled(jobs);
  }
  private async diskPressure() {
    for (const node of this.nodes.all()) {
      const sample = node.metrics.latest();
      if (node.state.state !== 'ready' || !sample) continue;
      if (sample.value.disk.free >= 2 * node.config.diskReserveBytes) node.diskDraining = false;
      if (sample.value.disk.free < node.config.diskReserveBytes) node.diskDraining = true;
      if (!node.diskDraining) continue;
      await node.request('session.cold.delete', '', {});
      this.store.db
        .prepare(
          `DELETE FROM warm_session_copies WHERE node_id=? AND tenant NOT IN
        (SELECT tenant FROM session_placements WHERE node_id=? AND state='active')`,
        )
        .run(node.nodeId, node.nodeId);
      let free = node.metrics.latest()?.value.disk.free ?? sample.value.disk.free;
      const copies = this.store.db
        .prepare(
          `SELECT o.* FROM objects o JOIN object_replicas r
        ON r.tenant=o.tenant AND r.id=o.id WHERE r.node_id=? ORDER BY o.created_at`,
        )
        .all(node.nodeId) as IndexedObject[];
      for (const object of copies) {
        if (free >= 2 * node.config.diskReserveBytes) break;
        let elsewhere = this.sources(object.tenant, object.id).filter(
          (source) => source.nodeId !== node.nodeId,
        );
        const target = Math.min(
          2,
          this.nodes.all().filter((candidate) => candidate.state.state === 'ready').length - 1,
        );
        if (target <= 0) break;
        for (const destination of this.nodes
          .all()
          .filter((candidate) => {
            const metrics = candidate.metrics.latest();
            return (
              !candidate.diskDraining &&
              candidate !== node &&
              candidate.state.state === 'ready' &&
              metrics &&
              metrics.value.disk.free - Number(object.stored_size) >= candidate.config.diskReserveBytes &&
              !elsewhere.some((source) => source.nodeId === candidate.nodeId)
            );
          })
          .sort((a, b) => a.nodeId.localeCompare(b.nodeId))) {
          if (elsewhere.length >= target) break;
          await this.fetch(destination, object);
          elsewhere = this.sources(object.tenant, object.id).filter(
            (source) => source.nodeId !== node.nodeId,
          );
        }
        if (elsewhere.length < target) continue;
        await node.request('object.delete', object.tenant, { ids: [object.id] });
        this.store.db
          .prepare('DELETE FROM object_replicas WHERE tenant=? AND id=? AND node_id=?')
          .run(object.tenant, object.id, node.nodeId);
        free = Math.max(free + Number(object.stored_size), node.metrics.latest()?.value.disk.free ?? 0);
      }
    }
  }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.maintenance) return this.maintenance;
    this.maintenance = (async () => {
      await this.gc();
      await this.diskPressure();
      await this.replicate();
    })().finally(() => {
      this.maintenance = undefined;
    });
    return this.maintenance;
  }
  // Replicas become orphans that the next collection deletes from each node as it is reachable.
  forgetTenant(tenant: string) {
    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO object_inventory_orphans SELECT node_id,tenant,id,0 FROM object_replicas WHERE tenant=?`,
      )
      .run(tenant);
    for (const table of ['objects', 'object_derivations', 'object_replicas'])
      this.store.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(tenant);
  }
  tenantUsage(tenant: string) {
    const row = this.store.db
      .prepare('SELECT count(*) AS count, coalesce(sum(size),0) AS bytes FROM objects WHERE tenant=?')
      .get(tenant) as { count: bigint; bytes: bigint };
    return { objects: Number(row.count), bytes: Number(row.bytes), quotaBytes: this.tenantObjectBytes };
  }
  replicaBytes(nodeId: string) {
    const row = this.store.db
      .prepare(
        `SELECT coalesce(sum(o.stored_size),0) AS bytes FROM object_replicas r JOIN objects o
        ON o.tenant=r.tenant AND o.id=r.id WHERE r.node_id=?`,
      )
      .get(nodeId) as { bytes: bigint };
    return Number(row.bytes);
  }
  usage() {
    const ready = this.nodes
      .all()
      .filter((node) => node.state.state === 'ready' && !this.nodes.isRemoved(node.nodeId)).length;
    const totals = this.store.db
      .prepare(
        'SELECT count(*) AS count, coalesce(sum(size),0) AS bytes, coalesce(sum(stored_size),0) AS stored FROM objects',
      )
      .get() as { count: bigint; bytes: bigint; stored: bigint };
    const under = this.store.db
      .prepare(
        `SELECT count(*) AS count FROM objects o WHERE
        (SELECT count(*) FROM object_replicas r WHERE r.tenant=o.tenant AND r.id=o.id) < ?`,
      )
      .get(Math.min(2, ready)) as { count: bigint };
    const orphans = this.store.db.prepare('SELECT count(*) AS count FROM object_inventory_orphans').get() as {
      count: bigint;
    };
    return {
      objects: Number(totals.count),
      bytes: Number(totals.bytes),
      storedBytes: Number(totals.stored),
      underReplicated: Number(under.count),
      orphans: Number(orphans.count),
    };
  }
  forgetNode(nodeId: string) {
    this.store.db.prepare('DELETE FROM object_replicas WHERE node_id=?').run(nodeId);
    this.store.db.prepare('DELETE FROM object_inventory_orphans WHERE node_id=?').run(nodeId);
  }
  async close() {
    this.closed = true;
    this.nodes.off('ready', this.ready);
    this.nodes.off('metrics', this.metrics);
    this.nodes.handlers.delete('object.committed');
    this.nodes.handlers.delete('object.locate');
    await Promise.allSettled([...this.jobs, ...(this.maintenance ? [this.maintenance] : [])]);
  }
}
