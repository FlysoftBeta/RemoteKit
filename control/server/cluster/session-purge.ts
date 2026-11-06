import type { ControlDatabase } from '../persistence/database';
import type { NodeLink, NodeRegistry } from './node-link';

// Deleted sessions are purged from every configured node, including nodes that are offline now.
export class SessionPurge {
  private readonly flushing = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private readonly store: ControlDatabase,
    private readonly nodes: NodeRegistry,
  ) {
    nodes.on('ready', this.ready);
  }
  private readonly ready = ({ nodeId }: { nodeId: string }) => {
    void this.flushNode(this.nodes.get(nodeId)!);
  };
  enqueue(sessionId: string) {
    for (const node of this.nodes.all())
      this.store.db
        .prepare('INSERT OR IGNORE INTO session_deletions VALUES (?,?)')
        .run(sessionId, node.nodeId);
  }
  pending() {
    return Number(
      (
        this.store.db.prepare('SELECT count(DISTINCT session_id) AS count FROM session_deletions').get() as {
          count: bigint;
        }
      ).count,
    );
  }
  flush() {
    return Promise.all(this.nodes.all().map((node) => this.flushNode(node))).then(() => {});
  }
  private flushNode(node: NodeLink): Promise<void> {
    if (this.closed || node.state.state !== 'ready') return Promise.resolve();
    const running = this.flushing.get(node.nodeId);
    if (running) return running;
    const work = (async () => {
      for (;;) {
        const row = this.store.db
          .prepare('SELECT session_id FROM session_deletions WHERE node_id=? LIMIT 1')
          .get(node.nodeId) as { session_id: string } | undefined;
        if (!row) return;
        await node.request('session.delete', '', { sessionId: row.session_id });
        this.store.db
          .prepare('DELETE FROM session_deletions WHERE session_id=? AND node_id=?')
          .run(row.session_id, node.nodeId);
      }
    })()
      .catch(() => {})
      .finally(() => this.flushing.delete(node.nodeId));
    this.flushing.set(node.nodeId, work);
    return work;
  }
  async close() {
    this.closed = true;
    this.nodes.off('ready', this.ready);
    await Promise.allSettled(this.flushing.values());
  }
}
