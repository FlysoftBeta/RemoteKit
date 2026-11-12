import { createHash } from 'node:crypto';
import { log } from '../log';
import { RemoteKitError } from '../../shared/errors';
import type { AdminNode } from '../../shared/admin';
import type { ControlDatabase } from '../persistence/database';
import type { NodeRegistry } from './node-link';
import type { ObjectIndex } from './objects';
import type { Placement } from './placement';

export class NodeAdmin {
  constructor(
    private readonly store: ControlDatabase,
    private readonly nodes: NodeRegistry,
    private readonly placement: Pick<Placement, 'evacuate' | 'activeSessions' | 'activeTenants'>,
    private readonly objects: Pick<ObjectIndex, 'forgetNode' | 'tick' | 'replicaBytes'>,
  ) {
    nodes.isRemoved = (nodeId) =>
      !!store.db.prepare('SELECT 1 FROM removed_nodes WHERE node_id=?').get(nodeId);
  }
  list(): AdminNode[] {
    return this.nodes.all().map((node) => {
      const sample = node.metrics.latest();
      const history = node.history();
      return {
        nodeId: node.nodeId,
        state: this.nodes.isRemoved(node.nodeId) ? 'removed' : node.state.state,
        managed: !!node.configured.local,
        publicKeyFingerprint: createHash('sha256')
          .update(Buffer.from(node.configured.publicKey, 'base64'))
          .digest('hex')
          .slice(0, 16),
        bootstrapFile: node.configured.remote ? node.configured.bootstrapFile : null,
        peerAddress: node.config.peer.address,
        buildId: node.state.state === 'ready' ? (node.buildId ?? null) : null,
        pressure: sample?.pressure ?? null,
        headroom: sample ? 1 - node.metrics.predicted()! : null,
        underPressure: node.metrics.underPressure(),
        diskDraining: node.diskDraining,
        sessions: sample?.value.sessions ?? this.placement.activeSessions(node.nodeId),
        maxSessions: node.limits.maxSessions,
        users: this.placement
          .activeTenants(node.nodeId)
          .flatMap((tenant) => this.store.accounts.userForTenant(tenant)?.username ?? []),
        replicaBytes: this.objects.replicaBytes(node.nodeId),
        metrics: sample
          ? {
              at: sample.at,
              cpu: sample.value.cpu,
              memory: sample.value.memory,
              gpus: sample.value.gpus.map(({ luid, ...gpu }) => gpu),
              disk: sample.value.disk,
              objectBytes: sample.value.objectBytes,
            }
          : null,
        connectedAt: history.connectedAt ?? null,
        disconnectedAt: history.disconnectedAt ?? null,
        rejected: history.rejected ?? null,
        exited: history.exited ?? null,
      };
    });
  }
  remove(nodeId: string) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new RemoteKitError('not_found', '节点未配置');
    if (node.state.state === 'ready') throw new RemoteKitError('conflict', '在线节点不能移除');
    this.store.transaction(() => {
      if (this.nodes.isRemoved(nodeId)) return;
      this.store.db.prepare('INSERT INTO removed_nodes VALUES (?,?)').run(nodeId, Date.now());
      this.placement.evacuate(nodeId);
      this.objects.forgetNode(nodeId);
    });
    node.evict();
    this.nodes.publishPeers();
    void this.objects.tick().catch((err) => log.warn('node.objects_failed', { nodeId, err }));
    return this.list();
  }
  readd(nodeId: string) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new RemoteKitError('not_found', '节点未配置');
    this.store.db.prepare('DELETE FROM removed_nodes WHERE node_id=?').run(nodeId);
    this.nodes.publishPeers();
    node.start();
    return this.list();
  }
}
