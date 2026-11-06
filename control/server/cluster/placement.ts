import { randomBytes } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { ControlDatabase } from '../persistence/database';
import { retiringObjects } from './objects';
import { tenantKeys } from './keys';
import type { NodeRegistry } from './node-link';

export interface SessionPlacement {
  tenant: string;
  sessionId: string;
  nodeId: string;
  placementEpoch: number;
  keyCiphertext: string;
  state: 'active' | 'hibernated';
  checkpointId: number | null;
  checkpoint: string | null;
}
export class Placement {
  constructor(
    private readonly store: ControlDatabase,
    private readonly nodes: NodeRegistry,
  ) {
    nodes.isRemoved = (nodeId) =>
      !!store.db.prepare('SELECT 1 FROM removed_nodes WHERE node_id=?').get(nodeId);
    nodes.fencing = (nodeId) =>
      (
        store.db
          .prepare(
            `SELECT tenant AS tenantId, session_id AS sessionId,
      placement_epoch AS placementEpoch FROM session_placements WHERE node_id=? AND state='active'`,
          )
          .all(nodeId) as { tenantId: string; sessionId: string; placementEpoch: bigint }[]
      ).map((row) => ({ ...row, placementEpoch: Number(row.placementEpoch) }));
  }
  peek(tenant: string): SessionPlacement | undefined {
    const row = this.store.db
      .prepare(
        `SELECT p.tenant, p.session_id AS sessionId, p.node_id AS nodeId,
      p.placement_epoch AS placementEpoch, p.key_ciphertext AS keyCiphertext, p.state,
      p.checkpoint_id AS checkpointId, c.manifest_id AS checkpoint
      FROM session_placements p LEFT JOIN checkpoints c ON c.tenant=p.tenant AND c.id=p.checkpoint_id
      WHERE p.tenant=?`,
      )
      .get(tenant) as SessionPlacement | undefined;
    return (
      row && {
        ...row,
        placementEpoch: Number(row.placementEpoch),
        checkpointId: row.checkpointId === null ? null : Number(row.checkpointId),
      }
    );
  }
  underPressure(tenant: string) {
    const placement = this.peek(tenant);
    return !!placement && !!this.nodes.get(placement.nodeId)?.metrics.underPressure();
  }
  resolve(tenant: string): SessionPlacement {
    return this.store.transaction(() => {
      const existing = this.peek(tenant);
      if (existing?.state === 'active') {
        if (this.nodes.get(existing.nodeId)?.state.state !== 'ready')
          throw new RemoteKitError('unavailable', 'Placed node is offline');
        return existing;
      }
      const candidates = this.nodes.all().filter((node) => {
        const sample = node.metrics.latest();
        const row = this.store.db
          .prepare("SELECT count(*) AS count FROM session_placements WHERE node_id=? AND state='active'")
          .get(node.nodeId) as { count: bigint };
        return (
          node.state.state === 'ready' &&
          !node.diskDraining &&
          !this.nodes.isRemoved(node.nodeId) &&
          sample &&
          Math.max(Number(row.count), sample.value.sessions) < node.config.maxSessions &&
          sample.value.disk.free >= node.config.diskReserveBytes &&
          sample.value.memory.available >= node.config.sessionMemoryBytes
        );
      });
      const healthy = candidates.filter((node) => !node.metrics.underPressure());
      const score = (node: (typeof candidates)[number]) =>
        node.metrics.latest()!.pressure -
        (existing?.checkpoint &&
        this.store.db
          .prepare(
            'SELECT 1 FROM warm_session_copies WHERE tenant=? AND node_id=? AND manifest_id=? AND created_at>=?',
          )
          .get(tenant, node.nodeId, existing.checkpoint, Date.now() - 7 * 86400000)
          ? 0.15
          : 0);
      const node = (healthy.length ? healthy : candidates).sort(
        (a, b) => score(a) - score(b) || a.nodeId.localeCompare(b.nodeId),
      )[0];
      if (!node) throw new RemoteKitError('unavailable', 'No ready node has capacity');
      const placement: SessionPlacement = existing
        ? {
            ...existing,
            nodeId: node.nodeId,
            state: 'active',
            placementEpoch: existing.placementEpoch + 1,
          }
        : {
            tenant,
            sessionId: randomBytes(16).toString('hex'),
            nodeId: node.nodeId,
            placementEpoch: 1,
            keyCiphertext: this.store.atRestKey.seal(tenant, randomBytes(32)),
            state: 'active',
            checkpointId: null,
            checkpoint: null,
          };
      this.store.db
        .prepare(
          `INSERT OR REPLACE INTO session_placements
        (tenant,session_id,node_id,placement_epoch,key_ciphertext,state,checkpoint_id) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          tenant,
          placement.sessionId,
          placement.nodeId,
          placement.placementEpoch,
          placement.keyCiphertext,
          placement.state,
          placement.checkpointId,
        );
      return placement;
    });
  }
  markWarm(placement: SessionPlacement) {
    if (placement.checkpoint)
      this.store.db
        .prepare('INSERT OR REPLACE INTO warm_session_copies VALUES (?,?,?,?)')
        .run(placement.tenant, placement.nodeId, placement.checkpoint, Date.now());
  }
  keys(placement: SessionPlacement) {
    return tenantKeys(this.store.atRestKey.open(placement.tenant, placement.keyCiphertext));
  }
  commitCheckpoint(placement: SessionPlacement, manifestId: string, objects: string[], buildId: string) {
    return this.store.transaction(() => {
      const current = this.peek(placement.tenant);
      if (
        current?.state !== 'active' ||
        current.nodeId !== placement.nodeId ||
        current.placementEpoch !== placement.placementEpoch
      )
        throw new RemoteKitError('conflict', 'Placement changed during hibernation');
      if (
        !/^[a-f0-9]{64}$/.test(manifestId) ||
        !Array.isArray(objects) ||
        !objects.includes(manifestId) ||
        objects.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      )
        throw new RemoteKitError('rejected', 'Invalid checkpoint');
      for (const id of objects) {
        if (
          retiringObjects(this.store).has(placement.tenant + ':' + id) ||
          !this.store.db.prepare('SELECT 1 FROM objects WHERE tenant=? AND id=?').get(placement.tenant, id)
        )
          throw new RemoteKitError('conflict', 'Checkpoint object is not committed');
      }
      const row = this.store.db
        .prepare('SELECT coalesce(max(id),0)+1 AS id FROM checkpoints WHERE tenant=?')
        .get(placement.tenant) as { id: bigint };
      const id = Number(row.id);
      this.store.db
        .prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?)')
        .run(placement.tenant, id, placement.placementEpoch, manifestId, buildId, Date.now());
      for (const objectId of new Set(objects))
        this.store.db
          .prepare('INSERT INTO checkpoint_objects VALUES (?,?,?)')
          .run(placement.tenant, id, objectId);
      this.store.db
        .prepare("UPDATE session_placements SET state='hibernated',checkpoint_id=? WHERE tenant=?")
        .run(id, placement.tenant);
      this.markWarm({ ...placement, checkpoint: manifestId });
      return id;
    });
  }
}
