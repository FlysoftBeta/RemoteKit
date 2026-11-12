import { diskFloor } from './disk';
import { randomBytes, randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { ControlDatabase } from '../persistence/database';
import { retiringObjects } from './objects';
import { tenantObjects, syncObjectReferences } from '../persistence/object-references';
import { tenantKeys } from './keys';
import type { NodeRegistry } from './node-link';

export interface SessionPlacement {
  tenant: string;
  sessionId: string;
  nodeId: string;
  placementEpoch: number;
  keyCiphertext: string;
  runState: 'running' | 'stopped';
  dataState: 'clean' | 'dirty';
  pendingCommit: string | null;
  checkpointId: number | null;
  checkpoint: string | null;
}
export class Placement {
  reconcileStop?: (tenant: string) => Promise<number>;
  constructor(
    private readonly store: ControlDatabase,
    private readonly nodes: NodeRegistry,
  ) {
    nodes.fencing = (nodeId) =>
      (
        store.db
          .prepare(
            `SELECT tenant AS tenantId, session_id AS sessionId,
      placement_epoch AS placementEpoch, data_state AS dataState FROM session_placements WHERE node_id=?`,
          )
          .all(nodeId) as {
          tenantId: string;
          sessionId: string;
          placementEpoch: bigint;
          dataState: 'clean' | 'dirty';
        }[]
      ).map((row) => ({ ...row, placementEpoch: Number(row.placementEpoch) }));
  }
  peek(tenant: string): SessionPlacement | undefined {
    const row = this.store.db
      .prepare(
        `SELECT p.tenant, p.session_id AS sessionId, p.node_id AS nodeId,
      p.placement_epoch AS placementEpoch, p.key_ciphertext AS keyCiphertext, p.run_state AS runState, p.data_state AS dataState, p.pending_commit AS pendingCommit,
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
  activeTenants(nodeId: string) {
    return (
      this.store.db
        .prepare(
          "SELECT tenant FROM session_placements WHERE node_id=? AND run_state='running' ORDER BY tenant",
        )
        .all(nodeId) as { tenant: string }[]
    ).map((row) => row.tenant);
  }
  activeSessions(nodeId: string) {
    const row = this.store.db
      .prepare('SELECT count(*) AS count FROM session_placements WHERE node_id=?')
      .get(nodeId) as { count: bigint };
    return Number(row.count);
  }
  // A removed node's sessions resume elsewhere from their latest checkpoint.
  evacuate(nodeId: string) {
    this.store.db
      .prepare(
        `UPDATE session_placements SET run_state='stopped',data_state='clean',pending_commit=NULL,placement_epoch=placement_epoch+1,
      checkpoint_id=(SELECT max(id) FROM checkpoints WHERE tenant=session_placements.tenant) WHERE node_id=?`,
      )
      .run(nodeId);
    this.store.db.prepare('DELETE FROM warm_session_copies WHERE node_id=?').run(nodeId);
  }
  // Removes the placement and every checkpoint; returns the session whose node data must be purged.
  forgetTenant(tenant: string) {
    const sessionId = this.peek(tenant)?.sessionId;
    for (const table of ['session_placements', 'checkpoints', 'checkpoint_objects', 'warm_session_copies'])
      this.store.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(tenant);
    syncObjectReferences(this.store.db);
    return sessionId;
  }
  checkpoints(tenant: string) {
    const row = this.store.db
      .prepare(
        `SELECT count(*) AS count, max(created_at) AS latest,
        (SELECT coalesce(sum(o.stored_size),0) FROM checkpoint_objects c JOIN objects o
          ON o.id=c.id
          WHERE c.tenant=? AND c.manifest_id=(SELECT manifest_id FROM checkpoints WHERE tenant=? ORDER BY id DESC LIMIT 1)) AS bytes
        FROM checkpoints WHERE tenant=?`,
      )
      .get(tenant, tenant, tenant) as { count: bigint; latest: bigint | null; bytes: bigint };
    return {
      count: Number(row.count),
      latestAt: row.latest === null ? null : Number(row.latest),
      latestBytes: Number(row.bytes),
    };
  }
  underPressure(tenant: string) {
    const placement = this.peek(tenant);
    return !!placement && !!this.nodes.get(placement.nodeId)?.metrics.underPressure();
  }
  resolve(tenant: string): SessionPlacement {
    return this.store.transaction(() => {
      const existing = this.peek(tenant);
      if (existing?.pendingCommit) {
        void this.reconcileStop?.(tenant).catch(() => {});
        throw new RemoteKitError('unavailable', '正在提交会话，请稍候');
      }
      if (existing?.dataState === 'dirty') {
        if (this.nodes.get(existing.nodeId)?.state.state !== 'ready')
          throw new RemoteKitError('unavailable', '会话数据所在节点离线，恢复后自动继续', {
            reason: 'session_data_on_offline_node',
          });
        if (existing.runState === 'stopped') {
          this.store.db
            .prepare("UPDATE session_placements SET run_state='running' WHERE tenant=?")
            .run(tenant);
          return { ...existing, runState: 'running' };
        }
        return existing;
      }
      const now = Date.now();
      const candidates = this.nodes.all().flatMap((node) => {
        const sample = node.metrics.latest(now);
        const eligible =
          node.state.state === 'ready' &&
          !node.diskDraining &&
          !this.nodes.isRemoved(node.nodeId) &&
          sample &&
          (node.limits.maxSessions === null ||
            Math.max(this.activeSessions(node.nodeId), sample.value.sessions) < node.limits.maxSessions) &&
          sample.value.disk.free >= diskFloor(node, sample) &&
          (node.limits.sessionMemoryBytes === null ||
            sample.value.memory.available >= node.limits.sessionMemoryBytes);
        if (!eligible) return [];
        const predicted = node.metrics.predicted(now)!;
        const warm =
          predicted < 0.85 &&
          existing?.checkpoint &&
          this.store.db
            .prepare(
              'SELECT 1 FROM warm_session_copies WHERE tenant=? AND node_id=? AND manifest_id=? AND created_at>=?',
            )
            .get(tenant, node.nodeId, existing.checkpoint, now - 7 * 86400000);
        return [{ node, predicted, score: predicted - (warm ? 0.15 : 0) }];
      });
      const winner = candidates.sort(
        (a, b) => a.score - b.score || a.node.nodeId.localeCompare(b.node.nodeId),
      )[0];
      if (!winner) throw new RemoteKitError('unavailable', '没有可用的节点');
      const { node, predicted } = winner;
      if (predicted >= 0.85) node.reliefRequestedAt = now;
      const placement: SessionPlacement = existing
        ? {
            ...existing,
            nodeId: node.nodeId,
            runState: 'running',
            dataState: 'dirty',
            pendingCommit: null,
            placementEpoch: existing.placementEpoch + 1,
          }
        : {
            tenant,
            sessionId: randomBytes(16).toString('hex'),
            nodeId: node.nodeId,
            placementEpoch: 1,
            keyCiphertext: this.store.atRestKey.seal(tenant, randomBytes(32)),
            runState: 'running',
            dataState: 'dirty',
            pendingCommit: null,
            checkpointId: null,
            checkpoint: null,
          };
      this.store.db
        .prepare(
          `INSERT OR REPLACE INTO session_placements
        (tenant,session_id,node_id,placement_epoch,key_ciphertext,run_state,data_state,pending_commit,checkpoint_id) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          tenant,
          placement.sessionId,
          placement.nodeId,
          placement.placementEpoch,
          placement.keyCiphertext,
          placement.runState,
          placement.dataState,
          placement.pendingCommit,
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
  beginStop(tenant: string) {
    return this.store.transaction(() => {
      const placement = this.peek(tenant);
      if (!placement || (placement.runState === 'stopped' && placement.dataState === 'clean'))
        throw new RemoteKitError('conflict', '会话当前未运行');
      const pendingCommit = placement.pendingCommit ?? randomUUID();
      this.store.db
        .prepare("UPDATE session_placements SET run_state='stopped',pending_commit=? WHERE tenant=?")
        .run(pendingCommit, tenant);
      return { ...placement, runState: 'stopped' as const, pendingCommit };
    });
  }
  cancelStop(placement: SessionPlacement) {
    return (
      this.store.db
        .prepare(
          `UPDATE session_placements SET run_state='running',data_state='dirty',pending_commit=NULL
      WHERE tenant=? AND node_id=? AND placement_epoch=? AND pending_commit=?`,
        )
        .run(placement.tenant, placement.nodeId, placement.placementEpoch, placement.pendingCommit).changes >
      0
    );
  }
  discard(tenant: string) {
    const placement = this.peek(tenant);
    if (
      !placement ||
      placement.dataState !== 'dirty' ||
      this.nodes.get(placement.nodeId)?.state.state === 'ready'
    )
      throw new RemoteKitError('conflict', '只能放弃离线节点上的未提交更改');
    this.store.db
      .prepare(
        `UPDATE session_placements SET run_state='stopped',data_state='clean',pending_commit=NULL,
      placement_epoch=placement_epoch+1,
      checkpoint_id=(SELECT max(id) FROM checkpoints WHERE tenant=session_placements.tenant) WHERE tenant=?`,
      )
      .run(tenant);
    this.store.db
      .prepare('DELETE FROM warm_session_copies WHERE tenant=? AND node_id=?')
      .run(tenant, placement.nodeId);
    return this.peek(tenant)!;
  }
  commitCheckpoint(placement: SessionPlacement, manifestId: string, objects: string[], buildId: string) {
    return this.store.transaction(() => {
      const current = this.peek(placement.tenant);
      if (
        !current ||
        (placement.pendingCommit !== null && current.pendingCommit !== placement.pendingCommit) ||
        current.nodeId !== placement.nodeId ||
        current.placementEpoch !== placement.placementEpoch
      )
        throw new RemoteKitError('conflict', '会话位置在保存期间改变', {
          detail: 'Placement changed during stop',
        });
      if (
        !/^[a-f0-9]{64}$/.test(manifestId) ||
        !Array.isArray(objects) ||
        typeof buildId !== 'string' ||
        !buildId ||
        !objects.includes(manifestId) ||
        objects.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      )
        throw new RemoteKitError('rejected', '会话检查点无效', { detail: 'Invalid checkpoint' });
      for (const id of objects) {
        if (
          retiringObjects(this.store).has(id) ||
          !tenantObjects(this.store.db).get(placement.tenant)?.has(id)
        )
          throw new RemoteKitError('conflict', '会话检查点尚未提交', {
            detail: 'Checkpoint object is not committed',
          });
      }
      if (current.checkpoint === manifestId && current.dataState === 'clean') return current.checkpointId!;
      const row = this.store.db
        .prepare('SELECT coalesce(max(id),0)+1 AS id FROM checkpoints WHERE tenant=?')
        .get(placement.tenant) as { id: bigint };
      const id = Number(row.id);
      this.store.db
        .prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?)')
        .run(placement.tenant, id, placement.placementEpoch, manifestId, buildId, Date.now());
      for (const objectId of new Set(objects))
        this.store.db
          .prepare('INSERT OR IGNORE INTO checkpoint_objects VALUES (?,?,?)')
          .run(placement.tenant, manifestId, objectId);
      this.store.db
        .prepare(
          `DELETE FROM checkpoint_objects WHERE tenant=? AND manifest_id NOT IN
        (SELECT manifest_id FROM checkpoints WHERE tenant=? ORDER BY id DESC LIMIT 2)`,
        )
        .run(placement.tenant, placement.tenant);
      this.store.db
        .prepare(
          `DELETE FROM checkpoints WHERE tenant=? AND id NOT IN
        (SELECT id FROM checkpoints WHERE tenant=? ORDER BY id DESC LIMIT 2)`,
        )
        .run(placement.tenant, placement.tenant);
      this.store.db
        .prepare(
          "UPDATE session_placements SET run_state='stopped',data_state='clean',pending_commit=NULL,checkpoint_id=? WHERE tenant=?",
        )
        .run(id, placement.tenant);
      this.markWarm({ ...placement, checkpoint: manifestId });
      syncObjectReferences(this.store.db);
      return id;
    });
  }
}
