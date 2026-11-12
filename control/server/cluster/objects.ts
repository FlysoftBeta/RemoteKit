import { log } from '../log';
import { errorHandling, retryDelay } from '../../shared/error-policy';
import { diskFloor } from './disk';
import { createHmac, randomUUID } from 'node:crypto';
import { RemoteKitError, parseWireError, toRemoteKitError, type ErrorCode } from '../../shared/errors';
import type { ControlDatabase } from '../persistence/database';
import type Sqlite from 'better-sqlite3';
import type { NodeLink, NodeRegistry } from './node-link';
import { clusterObjectKeys } from './keys';
import {
  tenantObjects,
  syncObjectReferences,
  OBJECT_GRACE_MS as GRACE_MS,
} from '../persistence/object-references';

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
  id: string;
  size: bigint;
  stored_size: bigint;
  stored_sha256: string;
  created_at: bigint;
}
type CommitStatements = Record<
  | 'object'
  | 'replica'
  | 'insertObject'
  | 'derivation'
  | 'clearRender'
  | 'claim'
  | 'refreshGc'
  | 'insertReplica'
  | 'clearOrphan'
  | 'source',
  Sqlite.Statement
>;
interface RenderFailure {
  reason: ErrorCode;
  message: string;
  failed_at: bigint;
  attempts: bigint;
  retry_at: bigint | null;
  node_id: string | null;
  display_reason: string | null;
}
export class ObjectIndex {
  private readonly commitSql: CommitStatements;
  private readonly fetches = new Map<string, Set<string>>();
  private readonly readFetches = new Map<string, Set<string>>();
  private readonly puts = new Map<
    string,
    { node: NodeLink; tenant: string; epoch: string; ending: boolean; object?: string }
  >();
  private readonly busy = new Map<string, number>();
  private readonly renders = new Map<string, { node: NodeLink; epoch: string }>();
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
    readonly tenantObjectBytes: number | null,
    private readonly placedOn: (tenant: string, node: string) => boolean,
    private readonly checkpointing: (tenant: string) => boolean,
    private readonly now = Date.now,
  ) {
    this.commitSql = {
      object: store.db.prepare('SELECT * FROM objects WHERE id=?'),
      replica: store.db.prepare('SELECT 1 FROM object_replicas WHERE id=? AND node_id=?'),
      insertObject: store.db.prepare('INSERT INTO objects VALUES (?,?,?,?,?)'),
      derivation: store.db.prepare('INSERT OR IGNORE INTO object_derivations VALUES (?,?,?)'),
      clearRender: store.db.prepare('DELETE FROM object_render_failures WHERE source_id=?'),
      claim: store.db.prepare(
        'INSERT INTO object_claims VALUES (?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET claimed_at=excluded.claimed_at',
      ),
      refreshGc: store.db.prepare('UPDATE object_gc SET unreferenced_at=? WHERE id=? AND unreferenced_at>=0'),
      insertReplica: store.db.prepare('INSERT OR IGNORE INTO object_replicas VALUES (?,?)'),
      clearOrphan: store.db.prepare('DELETE FROM object_inventory_orphans WHERE node_id=? AND id=?'),
      source: store.db.prepare('SELECT 1 FROM objects WHERE id=?'),
    };
    this.retired = retiringObjects(store);
    nodes.objectKeys = clusterObjectKeys(store);
    nodes.handlers.set('object.claims.refresh', (node, message) => {
      const { tenantId, ids } = message;
      if (
        typeof tenantId !== 'string' ||
        !Array.isArray(ids) ||
        ids.length > 1024 ||
        ids.some((id) => !objectId(id))
      )
        throw new RemoteKitError('invalid_request', 'Invalid claim refresh');
      if (!this.placedOn(tenantId, node.nodeId))
        throw new RemoteKitError('forbidden', 'Session is not placed on this node');
      this.store.transaction(() => {
        const refresh = this.store.db.prepare(
          'UPDATE object_claims SET claimed_at=? WHERE tenant=? AND id=?',
        );
        for (const id of ids) refresh.run(this.now(), tenantId, id);
      });
      return { ok: true };
    });
    nodes.handlers.set('object.committed', (node, message) => this.committed(node, message));
    nodes.handlers.set('object.committed.batch', (node, message) => this.committedBatch(node, message));
    nodes.handlers.set('object.locate', (node, message) => this.locate(node, message));
    nodes.handlers.set('object.derivation', (node, message) => this.derivation(node, message));
    nodes.on('ready', this.ready);
    nodes.on('metrics', this.metrics);
    nodes.on('offline', this.offline);
  }
  private readonly offline = (nodeId: string) => {
    this.readFetches.delete(nodeId);
  };
  private track(work: Promise<unknown>) {
    this.jobs.add(work);
    void work
      .catch((err) => log.warn('objects.background_failed', { err }))
      .finally(() => this.jobs.delete(work));
  }
  private readonly ready = ({ nodeId }: { nodeId: string }) => {
    this.readFetches.delete(nodeId);
    this.store.db
      .prepare("UPDATE object_render_failures SET retry_at=0 WHERE reason='unavailable' AND build_id=?")
      .run(this.nodes.options.buildId);
    this.track(this.reconcile(this.nodes.get(nodeId)!).then(() => this.tick()));
  };
  private readonly metrics = () => {
    this.track(this.tick());
  };
  bytes(tenant: string) {
    let bytes = 0;
    const lookup = this.store.db.prepare('SELECT size FROM objects WHERE id=?');
    for (const id of tenantObjects(this.store.db).get(tenant) ?? [])
      bytes += Number((lookup.get(id) as { size: bigint } | undefined)?.size ?? 0);
    return bytes;
  }
  require(tenant: string, id: string, references?: ReadonlySet<string>) {
    if (!objectId(id))
      throw new RemoteKitError('invalid_request', '文件标识格式无效', {
        detail: 'Asset id must be an object id',
      });
    if (this.retired.has(id) || !(references ?? tenantObjects(this.store.db).get(tenant))?.has(id))
      throw new RemoteKitError('forbidden', '无权访问该文件', {
        detail: 'Tenant has no object reference or claim',
      });
    if (!this.store.db.prepare('SELECT 1 FROM objects WHERE id=?').get(id))
      throw new RemoteKitError('not_found', '文件不可用', { detail: 'Object is not available' });
  }
  checkQuota(tenant: string) {
    if (this.tenantObjectBytes !== null && this.bytes(tenant) > this.tenantObjectBytes)
      throw new RemoteKitError('limit_exceeded', '存储空间已满，请清理文件后重试', {
        detail: 'Tenant object quota exceeded',
      });
  }
  derived(sourceId: string, kind: 'thumbnail' | 'document'): string | undefined {
    const row = this.store.db
      .prepare(
        'SELECT d.id FROM object_derivations d JOIN objects o ON o.id=d.id WHERE source_id=? AND kind=? ORDER BY o.created_at,d.id LIMIT 1',
      )
      .get(sourceId, kind) as { id: string } | undefined;
    return row && !this.retired.has(row.id) ? row.id : undefined;
  }
  private rendering(node: NodeLink, sourceId: string) {
    const operation = this.renders.get(sourceId);
    return (
      node.state.state === 'ready' &&
      ((operation?.node === node && operation.epoch === node.state.connectionEpoch) ||
        this.renderFailure(sourceId)?.node_id === node.nodeId)
    );
  }
  derivation(node: NodeLink, message: Record<string, any>) {
    const { id: sourceId, kind } = message.params ?? {};
    if (!objectId(sourceId) || kind !== 'document')
      throw new RemoteKitError('invalid_request', '文档转换请求格式无效', {
        detail: 'Invalid document derivation request',
      });
    if (!message.tenantId && this.rendering(node, sourceId)) {
      if (this.retired.has(sourceId))
        throw new RemoteKitError('conflict', '源文件正在删除', { detail: 'Source object is being deleted' });
    } else {
      if (!this.placedOn(message.tenantId, node.nodeId))
        throw new RemoteKitError('forbidden', '会话已迁移，请刷新状态', {
          detail: 'Tenant session is not hosted on this node',
        });
      this.require(message.tenantId, sourceId);
    }
    const id = this.derived(sourceId, 'document');
    if (
      !id &&
      message.tenantId &&
      (this.renders.has(sourceId) ||
        this.renderFailure(sourceId) ||
        this.store.db
          .prepare('SELECT 1 FROM learning_downloads WHERE object_id=? AND document=1')
          .get(sourceId))
    ) {
      this.render(sourceId);
      if (this.renders.has(sourceId))
        throw new RemoteKitError('busy', '文档正在转换', { detail: 'Document conversion in progress' });
      const failure = this.renderFailure(sourceId);
      throw new RemoteKitError(
        failure?.reason ?? 'unavailable',
        failure?.message ?? 'Document conversion unavailable',
        {
          reason: failure?.display_reason ?? undefined,
          retryAfterMs:
            failure?.retry_at === null || failure?.retry_at === undefined
              ? undefined
              : Math.min(86_400_000, Math.max(0, Number(failure.retry_at) - this.now())),
        },
      );
    }
    return id ? { id } : null;
  }
  // Nodes run Control's build, so a failure recorded by another build may be fixed by this one.
  private renderFailure(id: string) {
    return this.store.db
      .prepare('SELECT * FROM object_render_failures WHERE source_id=? AND build_id=?')
      .get(id, this.nodes.options.buildId) as RenderFailure | undefined;
  }
  private failRender(id: string, error: unknown, node?: NodeLink) {
    const value = parseWireError(error) ?? toRemoteKitError(error);
    const reason = value.code;
    const attempts = Number(this.renderFailure(id)?.attempts ?? 0) + 1;
    const failedAt = this.now();
    const handling = errorHandling(reason);
    const policyDelay = retryDelay(value, attempts - 1);
    const delay =
      reason === 'unavailable'
        ? Math.min(24, 2 ** Math.min(attempts - 1, 5)) * 3600_000
        : policyDelay !== undefined
          ? Math.max(value.retryAfterMs ?? 0, Math.min(3600_000, 60_000 * 2 ** Math.min(attempts - 1, 6)))
          : handling === 'reconcile'
            ? 60_000
            : undefined;
    const retryAt = delay === undefined ? null : failedAt + delay;
    // An unknown outcome may still be running. Retry only that node, whose queue deduplicates by source.
    const nodeId = reason === 'outcome_unknown' ? (node?.nodeId ?? this.renderFailure(id)?.node_id) : null;
    this.store.db
      .prepare(
        `INSERT INTO object_render_failures(source_id,state,reason,message,failed_at,attempts,retry_at,node_id,build_id,display_reason) VALUES (?,'failed',?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET reason=excluded.reason,message=excluded.message,
      failed_at=excluded.failed_at,attempts=excluded.attempts,retry_at=excluded.retry_at,
      node_id=excluded.node_id,build_id=excluded.build_id,display_reason=excluded.display_reason`,
      )
      .run(
        id,
        reason,
        value?.message ?? 'Document conversion unavailable',
        failedAt,
        attempts,
        retryAt,
        nodeId ?? null,
        this.nodes.options.buildId,
        error && typeof error === 'object' && 'reason' in error && typeof error.reason === 'string'
          ? error.reason
          : null,
      );
    log.error('render.failed', { id, err: error });
  }
  render(id: string): void {
    if (this.closed || this.renders.has(id) || this.derived(id, 'document')) return;
    if (
      !objectId(id) ||
      this.retired.has(id) ||
      !this.store.db.prepare('SELECT 1 FROM objects WHERE id=?').get(id)
    ) {
      log.error('render.failed', { id, reason: 'source_unavailable' });
      return;
    }
    const failure = this.renderFailure(id);
    if (failure && (failure.retry_at === null || Number(failure.retry_at) > this.now())) return;
    const replicas = new Set(this.sources(id).map((source) => source.nodeId));
    const node = this.nodes
      .all()
      .filter(
        (candidate) =>
          candidate.state.state === 'ready' &&
          (!failure?.node_id || candidate.nodeId === failure.node_id) &&
          !candidate.diskDraining &&
          !this.nodes.isRemoved(candidate.nodeId),
      )
      .sort(
        (a, b) =>
          Number(replicas.has(b.nodeId)) - Number(replicas.has(a.nodeId)) ||
          (a.metrics.latest()?.pressure ?? 1) - (b.metrics.latest()?.pressure ?? 1) ||
          a.nodeId.localeCompare(b.nodeId),
      )[0];
    if (!node || node.state.state !== 'ready') {
      if (failure?.reason === 'outcome_unknown') return;
      this.failRender(id, new RemoteKitError('unavailable', '没有可用节点', { detail: 'No ready node' }));
      return;
    }
    this.renders.set(id, { node, epoch: node.state.connectionEpoch });
    this.track(
      (async () => {
        try {
          const result = await node.request('object.render', '', { params: { id } }, 6 * 60_000);
          if (!objectId(result?.documentId) || this.derived(id, 'document') !== result.documentId)
            throw new RemoteKitError('outcome_unknown', '文档转换结果待确认', {
              detail: 'Invalid object render result',
            });
          this.store.db.prepare('DELETE FROM object_render_failures WHERE source_id=?').run(id);
        } catch (error) {
          if (!this.derived(id, 'document')) this.failRender(id, error, node);
        } finally {
          this.renders.delete(id);
        }
      })(),
    );
  }
  committed(node: NodeLink, message: Record<string, any>) {
    const quotas = new Set<string>();
    const effects: (() => void)[] = [];
    this.store.transaction(() => {
      this.commitObject(node, message, quotas, effects);
      for (const tenant of quotas) this.checkQuota(tenant);
    });
    for (const effect of effects) effect();
    return { accepted: true };
  }
  committedBatch(node: NodeLink, message: Record<string, any>) {
    if (
      !Array.isArray(message.objects) ||
      !message.objects.length ||
      message.objects.length > 1024 ||
      Buffer.byteLength(JSON.stringify(message)) > 256 * 1024 ||
      (message.tenantId !== undefined && typeof message.tenantId !== 'string') ||
      message.objects.some(
        (item: any) =>
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          Object.keys(item).length !== 4 ||
          !['objectId', 'size', 'storedSize', 'storedSha256'].every((key) =>
            Object.prototype.hasOwnProperty.call(item, key),
          ),
      )
    )
      throw new RemoteKitError('invalid_request', 'Invalid object commit batch');
    const quotas = new Set<string>();
    const effects: (() => void)[] = [];
    const placementAuthorized = !!message.tenantId && this.placedOn(message.tenantId, node.nodeId);
    try {
      this.store.transaction(() => {
        for (const item of message.objects)
          this.commitObject(
            node,
            { ...item, tenantId: message.tenantId },
            quotas,
            effects,
            placementAuthorized,
          );
        for (const tenant of quotas) this.checkQuota(tenant);
      });
    } catch (error) {
      const failure = toRemoteKitError(error);
      throw new RemoteKitError(failure.code, failure.message, {
        reason: failure.reason,
        retryAfterMs: failure.retryAfterMs,
        errorId: failure.errorId,
        detail: failure.detail,
        cause: failure,
      });
    }
    for (const effect of effects) effect();
    return { ok: true };
  }
  private commitObject(
    node: NodeLink,
    message: Record<string, any>,
    quotas: Set<string>,
    effects: (() => void)[],
    placementAuthorized = false,
  ) {
    const { tenantId: tenant, objectId: id, size, storedSize, storedSha256, derivedFrom, kind } = message;
    if (
      !objectId(id) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isSafeInteger(storedSize) ||
      storedSize < 0 ||
      !objectId(storedSha256) ||
      (derivedFrom !== undefined &&
        (!objectId(derivedFrom) || derivedFrom === id || !['thumbnail', 'document'].includes(kind))) ||
      (kind !== undefined && derivedFrom === undefined)
    )
      throw new RemoteKitError('invalid_request', '文件元数据格式无效', {
        detail: 'Invalid object metadata',
      });
    const replication =
      !tenant &&
      (this.fetches.get(node.nodeId)?.has(id) ||
        this.readFetches.get(node.nodeId)?.has(id) ||
        this.commitSql.replica.get(id, node.nodeId));
    const put = typeof message.putId === 'string' ? this.puts.get(message.putId) : undefined;
    const expectedPut =
      put &&
      put.node === node &&
      put.tenant === tenant &&
      put.ending &&
      !put.object &&
      node.state.state === 'ready' &&
      node.state.connectionEpoch === put.epoch;
    const render = !tenant && kind === 'document' && this.rendering(node, derivedFrom);
    if (
      message.putId !== undefined
        ? !expectedPut
        : tenant
          ? !placementAuthorized && !this.placedOn(tenant, node.nodeId)
          : !replication && !render
    )
      throw new RemoteKitError('forbidden', '文件写入缺少有效操作授权', {
        detail: 'Commit has no session or Control operation',
      });

    const previous = this.commitSql.object.get(id) as IndexedObject | undefined;
    if (
      previous &&
      (previous.stored_sha256 !== storedSha256 ||
        Number(previous.size) !== size ||
        Number(previous.stored_size) !== storedSize)
    )
      throw new RemoteKitError('conflict', '文件元数据与索引不一致', {
        detail: 'Object metadata conflicts with the index',
      });
    if (this.retired.has(id))
      throw new RemoteKitError('conflict', '文件正在删除', { detail: 'Object is being deleted' });
    if (derivedFrom) {
      if (tenant) this.require(tenant, derivedFrom);
      else if (!render || this.retired.has(derivedFrom) || !this.commitSql.source.get(derivedFrom))
        throw new RemoteKitError('forbidden', '文件转换操作未获授权', {
          detail: 'Commit has no source render operation',
        });
    }
    if (!previous) this.commitSql.insertObject.run(id, size, storedSize, storedSha256, Date.now());
    if (derivedFrom) this.commitSql.derivation.run(id, derivedFrom, kind);
    if (kind === 'document') this.commitSql.clearRender.run(derivedFrom);
    if (tenant) {
      this.commitSql.claim.run(tenant, id, Date.now());
      const affected = derivedFrom ? tenantObjects(this.store.db).keys() : [tenant];
      for (const owner of affected) quotas.add(owner);
      this.commitSql.refreshGc.run(Date.now(), id);
    }
    this.commitSql.insertReplica.run(id, node.nodeId);
    effects.push(() => this.inventoryCommits.get(node.nodeId)?.add(id));
    this.commitSql.clearOrphan.run(node.nodeId, id);
    effects.push(() => {
      if (put) put.object = id;
      this.readFetches.get(node.nodeId)?.delete(id);
    });
  }
  locate(node: NodeLink, message: Record<string, any>) {
    const render = !message.tenantId && this.rendering(node, message.renderSource);
    if (!render && !this.placedOn(message.tenantId, node.nodeId))
      throw new RemoteKitError('forbidden', '会话已迁移，请刷新状态', {
        detail: 'Tenant session is not hosted on this node',
      });
    if (
      !Array.isArray(message.ids) ||
      message.ids.length > 4096 ||
      message.ids.some((id: unknown) => !objectId(id))
    )
      throw new RemoteKitError('invalid_request', '文件标识格式无效', { detail: 'Invalid object ids' });
    const references = render
      ? undefined
      : (tenantObjects(this.store.db).get(message.tenantId) ?? new Set<string>());
    for (const id of message.ids) {
      if (!render) this.require(message.tenantId, id, references);
      else if (
        this.retired.has(id) ||
        (id !== message.renderSource && id !== this.derived(message.renderSource, 'document'))
      )
        throw new RemoteKitError('forbidden', '文件不属于当前转换操作', {
          detail: 'Object is outside the render operation',
        });
    }
    const expected = this.readFetches.get(node.nodeId) ?? new Set<string>();
    this.readFetches.set(node.nodeId, expected);
    const sources: Record<string, { nodeId: string; address: string }[]> = {};
    for (const id of message.ids) {
      sources[id] = this.sources(id);
      expected.add(id);
    }
    return { sources };
  }
  private sources(id: string) {
    return (
      this.store.db.prepare('SELECT node_id FROM object_replicas WHERE id=? ORDER BY node_id').all(id) as {
        node_id: string;
      }[]
    ).flatMap(({ node_id }) => {
      const node = this.nodes.get(node_id);
      return node?.state.state === 'ready' && !this.nodes.isRemoved(node_id)
        ? [{ nodeId: node_id, address: node.config.peer.address }]
        : [];
    });
  }
  async put(
    tenant: string,
    chunks: AsyncIterable<Uint8Array>,
    options: { maxBytes: number; signal?: AbortSignal; onIdentity?: (id: string) => void },
  ): Promise<{ id: string; size: number }> {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(tenant) ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 0
    )
      throw new RemoteKitError('invalid_request', '文件上传参数无效', {
        detail: 'Invalid object put options',
      });
    const check = () => {
      if (options.signal?.aborted) throw new RemoteKitError('canceled', '');
      if (this.closed)
        throw new RemoteKitError('unavailable', '文件服务已关闭', { detail: 'Object index closed' });
    };
    check();
    const node = this.nodes
      .all()
      .filter(
        (n) =>
          n.state.state === 'ready' &&
          !n.diskDraining &&
          !this.nodes.isRemoved(n.nodeId) &&
          n.metrics.latest() &&
          [...this.puts.values()].filter((p) => p.node === n).length < 4,
      )
      .sort((a, b) => {
        const x = a.metrics.latest()!.value.disk,
          y = b.metrics.latest()!.value.disk;
        return 1 - x.free / x.total - (1 - y.free / y.total) || a.nodeId.localeCompare(b.nodeId);
      })[0];
    if (!node || node.state.state !== 'ready')
      throw new RemoteKitError(
        this.nodes
          .all()
          .some((n) => n.state.state === 'ready' && !n.diskDraining && !this.nodes.isRemoved(n.nodeId))
          ? 'busy'
          : 'unavailable',
        '文件服务暂时没有可用容量',
        { detail: 'No ready node has put capacity' },
      );
    const putId = randomUUID(),
      epoch = node.state.connectionEpoch;
    const operation = { node, tenant, epoch, ending: false, object: undefined as string | undefined };
    this.puts.set(putId, operation);
    const digest = createHmac('sha256', Buffer.from(this.nodes.objectKeys!.objectIdKey, 'base64'));
    let completed = false;
    const cancel = () => {
      if (node.state.state === 'ready' && node.state.connectionEpoch === epoch)
        return node.request('object.put.cancel', '', { putId }).catch(() => {});
      return Promise.resolve();
    };
    let interrupt!: (error: RemoteKitError) => void;
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = reject;
    });
    void interrupted.catch(() => {});
    const onAbort = () => {
      interrupt(
        new RemoteKitError(
          operation.ending ? 'outcome_unknown' : 'canceled',
          operation.ending ? '文件写入结果待确认' : '',
        ),
      );
      if (!operation.ending) void cancel();
    };
    const onOffline = () =>
      interrupt(
        new RemoteKitError(operation.ending ? 'outcome_unknown' : 'unavailable', '节点连接已断开', {
          detail: 'Node disconnected',
        }),
      );
    node.on('offline', onOffline);
    let iterator: AsyncIterator<Uint8Array> | undefined;
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      check();
      iterator = chunks[Symbol.asyncIterator]();
      await Promise.race([node.request('object.put.begin', tenant, { putId }), interrupted]);
      check();
      let offset = 0;
      while (true) {
        const next = await Promise.race([iterator.next(), interrupted]);
        if (next.done) break;
        const bytes = next.value;
        digest.update(bytes);
        check();
        if (offset + bytes.byteLength > Math.min(options.maxBytes, 256 * 1024 * 1024))
          throw new RemoteKitError('limit_exceeded', '文件超过大小上限', { detail: 'Object too large' });
        for (let start = 0; start < bytes.byteLength; start += 1024 * 1024) {
          check();
          const data = Buffer.from(
            bytes.buffer,
            bytes.byteOffset + start,
            Math.min(1024 * 1024, bytes.byteLength - start),
          );
          await Promise.race([node.sendBinary({ putId, offset }, data, epoch), interrupted]);
          offset += data.length;
        }
      }
      check();
      options.onIdentity?.(digest.digest('hex'));
      operation.ending = true;
      const result = await Promise.race([node.request('object.put.end', '', { putId }), interrupted]);
      if (!objectId(result?.objectId) || result.objectId !== operation.object || result.size !== offset)
        throw new RemoteKitError('outcome_unknown', '文件写入结果待确认', {
          detail: 'Invalid object put result',
        });
      completed = true;
      return { id: result.objectId, size: result.size };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      node.off('offline', onOffline);
      if (!completed) void Promise.resolve(iterator?.return?.()).catch(() => {});
      if (!completed) await cancel();
      this.puts.delete(putId);
    }
  }
  async reconcile(node: NodeLink) {
    if (node.state.state !== 'ready' || this.reconciling.has(node.nodeId)) return;
    this.reconciling.add(node.nodeId);
    const epoch = node.state.connectionEpoch,
      present = new Set<string>(),
      seen = new Set<string>();
    this.inventoryCommits.set(node.nodeId, present);
    let cursor: string | null = null;
    try {
      do {
        const page = await node.request('object.inventory', '', { cursor });
        if (node.state.state !== 'ready' || node.state.connectionEpoch !== epoch) return;
        if (!Array.isArray(page.objects) || (page.next !== null && typeof page.next !== 'string'))
          throw new RemoteKitError('internal', '文件清单格式错误', { detail: 'Invalid object inventory' });
        for (const item of page.objects) {
          if (
            !objectId(item.id) ||
            !objectId(item.storedSha256) ||
            !Number.isSafeInteger(item.storedSize) ||
            item.storedSize < 0
          )
            throw new RemoteKitError('internal', '文件清单条目格式错误', {
              detail: 'Invalid inventory object',
            });
          present.add(item.id);
          const indexed = this.store.db.prepare('SELECT * FROM objects WHERE id=?').get(item.id) as
            IndexedObject | undefined;
          if (
            indexed &&
            indexed.stored_sha256 === item.storedSha256 &&
            Number(indexed.stored_size) === item.storedSize
          )
            this.store.db
              .prepare('INSERT OR IGNORE INTO object_replicas VALUES (?,?)')
              .run(item.id, node.nodeId);
          else if (indexed) {
            await node.request('object.delete', '', { ids: [item.id] });
            this.store.db
              .prepare('DELETE FROM object_replicas WHERE id=? AND node_id=?')
              .run(item.id, node.nodeId);
          } else
            this.store.db
              .prepare('INSERT OR IGNORE INTO object_inventory_orphans VALUES (?,?,?)')
              .run(node.nodeId, item.id, Date.now());
        }
        cursor = page.next;
        if (cursor !== null && seen.has(cursor))
          throw new RemoteKitError('internal', '文件清单游标重复', { detail: 'Inventory cursor repeated' });
        if (cursor !== null) seen.add(cursor);
      } while (cursor !== null);
      if (node.state.state !== 'ready' || node.state.connectionEpoch !== epoch) return;
      for (const item of this.store.db
        .prepare('SELECT id FROM object_replicas WHERE node_id=?')
        .all(node.nodeId) as { id: string }[])
        if (!present.has(item.id) && !this.fetches.get(node.nodeId)?.has(item.id))
          this.store.db
            .prepare('DELETE FROM object_replicas WHERE id=? AND node_id=?')
            .run(item.id, node.nodeId);
      for (const item of this.store.db
        .prepare('SELECT id FROM object_inventory_orphans WHERE node_id=?')
        .all(node.nodeId) as { id: string }[])
        if (!present.has(item.id))
          this.store.db
            .prepare('DELETE FROM object_inventory_orphans WHERE node_id=? AND id=?')
            .run(node.nodeId, item.id);
    } finally {
      this.reconciling.delete(node.nodeId);
      this.inventoryCommits.delete(node.nodeId);
      if (!this.closed && node.state.state === 'ready' && node.state.connectionEpoch !== epoch)
        this.ready({ nodeId: node.nodeId });
    }
  }
  async gc(now = Date.now()) {
    const durable = tenantObjects(this.store.db, false, now);
    const claims = this.store.db.prepare('SELECT tenant,id,claimed_at FROM object_claims').all() as {
      tenant: string;
      id: string;
      claimed_at: bigint;
    }[];
    const claimed = new Set(
      claims
        .filter((c) => Number(c.claimed_at) >= now - GRACE_MS || this.checkpointing(c.tenant))
        .map((c) => c.id),
    );
    for (const c of claims)
      if (
        !durable.get(c.tenant)?.has(c.id) &&
        !this.checkpointing(c.tenant) &&
        Number(c.claimed_at) < now - GRACE_MS
      )
        this.store.db.prepare('DELETE FROM object_claims WHERE tenant=? AND id=?').run(c.tenant, c.id);
    let references: { durable: Set<string>; all: Set<string> } | undefined;
    const currentReferences = () =>
      (references ??= {
        durable: new Set([...tenantObjects(this.store.db, false, now).values()].flatMap((ids) => [...ids])),
        all: new Set([...tenantObjects(this.store.db, true, now).values()].flatMap((ids) => [...ids])),
      });
    const lastClaims = new Map<string, number>();
    for (const claim of claims)
      lastClaims.set(claim.id, Math.max(lastClaims.get(claim.id) ?? 0, Number(claim.claimed_at)));
    for (const object of this.store.db.prepare('SELECT * FROM objects').all() as IndexedObject[]) {
      if (this.retired.has(object.id)) continue;
      const current = currentReferences();
      if (this.renders.has(object.id) || current.durable.has(object.id)) {
        this.store.db
          .prepare('INSERT INTO object_gc VALUES (?,-1) ON CONFLICT(id) DO UPDATE SET unreferenced_at=-1')
          .run(object.id);
        continue;
      }
      const lastClaim = Math.max(Number(object.created_at), lastClaims.get(object.id) ?? 0);
      this.store.db
        .prepare('INSERT OR IGNORE INTO object_gc VALUES (?,?)')
        .run(object.id, Math.min(now, lastClaim));
      this.store.db
        .prepare('UPDATE object_gc SET unreferenced_at=? WHERE id=? AND unreferenced_at=-1')
        .run(now, object.id);
      const since = this.store.db
        .prepare('SELECT unreferenced_at FROM object_gc WHERE id=?')
        .get(object.id) as { unreferenced_at: bigint };
      if (
        claimed.has(object.id) ||
        current.all.has(object.id) ||
        Number(since.unreferenced_at) >= now - GRACE_MS
      )
        continue;
      this.retired.add(object.id);
      this.store.db.prepare('DELETE FROM object_render_failures WHERE source_id=?').run(object.id);
      try {
        for (const replica of this.store.db
          .prepare('SELECT node_id FROM object_replicas WHERE id=?')
          .all(object.id) as { node_id: string }[]) {
          const node = this.nodes.get(replica.node_id);
          if (node?.state.state !== 'ready') continue;
          await node.request('object.delete', '', { ids: [object.id] });
          references = undefined;
          this.store.db
            .prepare('DELETE FROM object_replicas WHERE id=? AND node_id=?')
            .run(object.id, node.nodeId);
        }
        if (!this.store.db.prepare('SELECT 1 FROM object_replicas WHERE id=?').get(object.id))
          this.store.transaction(() => {
            this.store.db.prepare('DELETE FROM objects WHERE id=?').run(object.id);
            this.store.db
              .prepare('DELETE FROM object_derivations WHERE id=? OR source_id=?')
              .run(object.id, object.id);
            this.store.db.prepare('DELETE FROM object_gc WHERE id=?').run(object.id);
            this.store.db.prepare('DELETE FROM object_claims WHERE id=?').run(object.id);
          });
      } finally {
        this.retired.delete(object.id);
      }
    }
    for (const orphan of this.store.db
      .prepare('SELECT * FROM object_inventory_orphans WHERE first_seen<?')
      .all(now - GRACE_MS) as { node_id: string; id: string }[]) {
      const node = this.nodes.get(orphan.node_id);
      if (node?.state.state !== 'ready') continue;
      if (this.retired.has(orphan.id)) continue;
      if (!this.store.db.prepare('SELECT 1 FROM objects WHERE id=?').get(orphan.id)) {
        this.retired.add(orphan.id);
        try {
          await node.request('object.delete', '', { ids: [orphan.id] });
        } finally {
          this.retired.delete(orphan.id);
        }
      }
      this.store.db
        .prepare('DELETE FROM object_inventory_orphans WHERE node_id=? AND id=?')
        .run(orphan.node_id, orphan.id);
    }
  }
  private async fetch(node: NodeLink, object: IndexedObject) {
    const key = node.nodeId;
    const expected = this.fetches.get(key) ?? new Set<string>();
    expected.add(object.id);
    this.fetches.set(key, expected);
    this.busy.set(node.nodeId, (this.busy.get(node.nodeId) ?? 0) + 1);
    this.reserved.set(node.nodeId, (this.reserved.get(node.nodeId) ?? 0) + Number(object.stored_size));
    try {
      await node.request('object.fetch', '', {
        ids: [object.id],
        sources: { [object.id]: this.sources(object.id) },
      });
      return !!this.store.db
        .prepare('SELECT 1 FROM object_replicas WHERE id=? AND node_id=?')
        .get(object.id, node.nodeId);
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
      .prepare(
        `SELECT o.* FROM objects o ORDER BY EXISTS (
        SELECT 1 FROM checkpoint_objects co JOIN checkpoints c ON c.tenant=co.tenant AND c.manifest_id=co.manifest_id
        WHERE co.id=o.id AND c.id=(SELECT max(newest.id) FROM checkpoints newest WHERE newest.tenant=c.tenant)
      ) DESC,o.created_at DESC,o.id`,
      )
      .all() as IndexedObject[]) {
      const sources = this.sources(object.id);
      if (!sources.length) continue;
      let missing =
        target -
        sources.length -
        ready.filter((node) => this.fetches.get(node.nodeId)?.has(object.id)).length;
      for (const node of ready
        .filter((node) => {
          const sample = node.metrics.latest();
          return (
            sample &&
            sample.value.disk.free - (this.reserved.get(node.nodeId) ?? 0) - Number(object.stored_size) >=
              diskFloor(node, sample) &&
            !node.diskDraining &&
            !this.reconciling.has(node.nodeId) &&
            !this.fetches.get(node.nodeId)?.has(object.id) &&
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
            diskFloor(node, node.metrics.latest()!)
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
      const floor = diskFloor(node, sample);
      if (sample.value.disk.free >= 2 * floor) node.diskDraining = false;
      if (sample.value.disk.free < floor) node.diskDraining = true;
      if (!node.diskDraining) continue;
      await node.request('session.cold.delete', '', {});
      this.store.db
        .prepare(
          `DELETE FROM warm_session_copies WHERE node_id=? AND tenant NOT IN
        (SELECT tenant FROM session_placements WHERE node_id=? AND run_state='running')`,
        )
        .run(node.nodeId, node.nodeId);
      let free = node.metrics.latest()?.value.disk.free ?? sample.value.disk.free;
      const copies = this.store.db
        .prepare(
          `SELECT o.* FROM objects o JOIN object_replicas r
        ON r.id=o.id WHERE r.node_id=? ORDER BY o.created_at`,
        )
        .all(node.nodeId) as IndexedObject[];
      for (const object of copies) {
        if (free >= 2 * diskFloor(node, node.metrics.latest() ?? sample)) break;
        let elsewhere = this.sources(object.id).filter((source) => source.nodeId !== node.nodeId);
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
              metrics.value.disk.free - Number(object.stored_size) >= diskFloor(candidate, metrics) &&
              !elsewhere.some((source) => source.nodeId === candidate.nodeId)
            );
          })
          .sort((a, b) => a.nodeId.localeCompare(b.nodeId))) {
          if (elsewhere.length >= target) break;
          await this.fetch(destination, object);
          elsewhere = this.sources(object.id).filter((source) => source.nodeId !== node.nodeId);
        }
        if (elsewhere.length < target) continue;
        await node.request('object.delete', '', { ids: [object.id] });
        this.store.db
          .prepare('DELETE FROM object_replicas WHERE id=? AND node_id=?')
          .run(object.id, node.nodeId);
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
  forgetTenant(tenant: string) {
    this.store.transaction(() => {
      for (const table of ['object_claims', 'checkpoints', 'checkpoint_objects'])
        this.store.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(tenant);
      syncObjectReferences(this.store.db);
    });
  }
  tenantUsage(tenant: string) {
    const ids = tenantObjects(this.store.db).get(tenant) ?? new Set<string>();
    return { objects: ids.size, bytes: this.bytes(tenant), quotaBytes: this.tenantObjectBytes };
  }
  replicaBytes(nodeId: string) {
    const row = this.store.db
      .prepare(
        `SELECT coalesce(sum(o.stored_size),0) AS bytes FROM object_replicas r JOIN objects o
        ON o.id=r.id WHERE r.node_id=?`,
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
        (SELECT count(*) FROM object_replicas r WHERE r.id=o.id) < ?`,
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
    this.nodes.off('offline', this.offline);
    this.nodes.handlers.delete('object.claims.refresh');
    this.nodes.handlers.delete('object.committed');
    this.nodes.handlers.delete('object.committed.batch');
    this.nodes.handlers.delete('object.locate');
    this.nodes.handlers.delete('object.derivation');
    await Promise.allSettled([...this.jobs, ...(this.maintenance ? [this.maintenance] : [])]);
  }
}
