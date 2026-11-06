import { RemoteKitError } from '../../shared/errors';
import type { AdminNode } from '../../shared/product';
import type { ControlDatabase } from '../persistence/database';
import type { NodeRegistry } from './node-link';
import type { ObjectIndex } from './objects';
import type { Placement } from './placement';

export class NodeAdmin {
  constructor(
    private readonly store: ControlDatabase,
    private readonly nodes: NodeRegistry,
    private readonly placement: Pick<Placement, 'evacuate' | 'activeSessions'>,
    private readonly objects: Pick<ObjectIndex, 'forgetNode' | 'tick'>,
  ) {
    nodes.isRemoved = (nodeId) =>
      !!store.db.prepare('SELECT 1 FROM removed_nodes WHERE node_id=?').get(nodeId);
  }
  list(): AdminNode[] {
    return this.nodes.all().map((node) => {
      const sample = node.metrics.latest();
      return {
        nodeId: node.nodeId,
        state: this.nodes.isRemoved(node.nodeId) ? 'removed' : node.state.state,
        buildId: node.buildId ?? null,
        pressure: sample?.pressure ?? null,
        sessions: sample?.value.sessions ?? this.placement.activeSessions(node.nodeId),
      };
    });
  }
  remove(nodeId: string) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new RemoteKitError('not_found', 'Node is not configured');
    if (node.state.state === 'ready') throw new RemoteKitError('conflict', 'Ready nodes cannot be removed');
    this.store.transaction(() => {
      if (this.nodes.isRemoved(nodeId)) return;
      this.store.db.prepare('INSERT INTO removed_nodes VALUES (?,?)').run(nodeId, Date.now());
      this.placement.evacuate(nodeId);
      this.objects.forgetNode(nodeId);
    });
    node.evict();
    void this.objects.tick().catch(() => {});
    return this.list();
  }
  readd(nodeId: string) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new RemoteKitError('not_found', 'Node is not configured');
    this.store.db.prepare('DELETE FROM removed_nodes WHERE node_id=?').run(nodeId);
    node.start();
    return this.list();
  }
}
