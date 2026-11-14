import { log } from '../log';
import { endpointError } from '../endpoint/gateway';
import { RetryLedger } from '../persistence/retry-units';
import type { ControlDatabase } from '../persistence/database';
import type { NodeLink, NodeRegistry } from './node-link';
import { rpcId } from '../endpoint/rpc-results';

export class SessionPurge {
  private readonly flushing = new Map<string, Promise<void>>();
  private readonly ledger: RetryLedger;
  private closed = false;
  constructor(
    private readonly store: ControlDatabase,
    private readonly nodes: NodeRegistry,
  ) {
    this.ledger = new RetryLedger(store, 'session_purge.delete');
    nodes.on('ready', this.ready);
  }
  private readonly ready = ({ nodeId }: { nodeId: string }) => {
    const node = this.nodes.get(nodeId);
    if (node) void this.flushNode(node);
  };
  enqueue(sessionId: string) {
    for (const node of this.nodes.all())
      this.store.db
        .prepare('INSERT OR IGNORE INTO session_deletions(session_id,node_id) VALUES (?,?)')
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
  failures() {
    return (
      this.store.db.prepare('SELECT session_id,node_id FROM session_deletions').all() as {
        session_id: string;
        node_id: string;
      }[]
    ).flatMap((row) => {
      const error = this.ledger.unit(JSON.stringify([row.node_id, row.session_id])).record().error;
      return error ? [{ sessionId: row.session_id, nodeId: row.node_id, error }] : [];
    });
  }
  flush() {
    return Promise.all(this.nodes.all().map((node) => this.flushNode(node))).then(() => undefined);
  }
  private flushNode(node: NodeLink): Promise<void> {
    if (this.closed || node.state.state !== 'ready') return Promise.resolve();
    const pending = this.flushing.get(node.nodeId);
    if (pending) return pending;
    const epoch = node.state.connectionEpoch;
    const work = (async () => {
      const rows = this.store.db
        .prepare('SELECT session_id FROM session_deletions WHERE node_id=?')
        .all(node.nodeId) as { session_id: string }[];
      for (const row of rows) {
        const key = JSON.stringify([node.nodeId, row.session_id]);
        const unit = this.ledger.unit(key);
        if (!unit.ready(JSON.stringify([epoch, this.nodes.options.buildId]))) continue;
        try {
          await node.request(
            'session.delete',
            '',
            { sessionId: row.session_id },
            undefined,
            rpcId('session.delete', row.session_id),
          );
          this.ledger.remove(key, () => {
            this.store.db
              .prepare('DELETE FROM session_deletions WHERE session_id=? AND node_id=?')
              .run(row.session_id, node.nodeId);
          });
          unit.succeed();
        } catch (cause) {
          unit.fail(endpointError(cause));
          this.ledger.save(key);
          unit.schedule(() => {
            void this.flushNode(node);
          });
        }
      }
    })()
      .catch((err) => log.error('session_purge.failed', { nodeId: node.nodeId, err }))
      .finally(() => {
        this.flushing.delete(node.nodeId);
      });
    this.flushing.set(node.nodeId, work);
    return work;
  }
  async close() {
    this.closed = true;
    this.nodes.off('ready', this.ready);
    await Promise.allSettled(this.flushing.values());
    this.ledger.close();
  }
}
