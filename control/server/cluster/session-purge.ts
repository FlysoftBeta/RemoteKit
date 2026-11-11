import { log } from '../log';
import { endpointError } from '../endpoint/gateway';
import { errorHandling, retryDelay } from '../../shared/error-policy';
import type { ControlDatabase } from '../persistence/database';
import type { NodeLink, NodeRegistry } from './node-link';

// Deleted sessions are purged from every configured node, including nodes that are offline now.
export class SessionPurge {
  private readonly flushing = new Map<string, Promise<void>>();
  private closed = false;
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  constructor(
    private readonly store: ControlDatabase,
    private readonly nodes: NodeRegistry,
  ) {
    nodes.on('ready', this.ready);
  }
  private readonly ready = ({ nodeId }: { nodeId: string }) => {
    clearTimeout(this.retries.get(nodeId));
    this.retries.delete(nodeId);
    this.attempts.delete(nodeId);
    void this.flushNode(this.nodes.get(nodeId)!);
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
      this.store.db
        .prepare(
          'SELECT session_id,node_id,error_code,error_message FROM session_deletions WHERE error_code IS NOT NULL',
        )
        .all() as {
        session_id: string;
        node_id: string;
        error_code: import('../../shared/errors').ErrorCode;
        error_message: string;
      }[]
    ).map((row) => ({
      sessionId: row.session_id,
      nodeId: row.node_id,
      error: { code: row.error_code, message: row.error_message },
    }));
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
          .prepare(
            "SELECT session_id FROM session_deletions WHERE node_id=? AND (error_code IS NULL OR error_code IN ('busy','rate_limited','unavailable','outcome_unknown')) LIMIT 1",
          )
          .get(node.nodeId) as { session_id: string } | undefined;
        if (!row) return;
        try {
          await node.request('session.delete', '', { sessionId: row.session_id });
          this.store.db
            .prepare('DELETE FROM session_deletions WHERE session_id=? AND node_id=?')
            .run(row.session_id, node.nodeId);
          this.attempts.delete(node.nodeId);
        } catch (error) {
          if (this.recordFailure(node, row.session_id, error)) return;
        }
      }
    })()
      // Rows stay queued; the next flush (node ready, retry timer) resumes them.
      .catch((err) => log.error('session_purge.failed', { nodeId: node.nodeId, err }))
      .finally(() => this.flushing.delete(node.nodeId));
    this.flushing.set(node.nodeId, work);
    return work;
  }
  private recordFailure(node: NodeLink, sessionId: string, error: unknown) {
    const failure = endpointError(error);
    log.warn('session_purge.delete_failed', { nodeId: node.nodeId, sessionId, err: failure });
    this.store.db
      .prepare('UPDATE session_deletions SET error_code=?,error_message=? WHERE session_id=? AND node_id=?')
      .run(failure.code, failure.message, sessionId, node.nodeId);
    const attempt = this.attempts.get(node.nodeId) ?? 0;
    const wait =
      retryDelay(failure, attempt) ?? (errorHandling(failure.code) === 'reconcile' ? 1000 : undefined);
    if (wait === undefined) return false;
    this.attempts.set(node.nodeId, attempt + 1);
    clearTimeout(this.retries.get(node.nodeId));
    const timer = setTimeout(() => {
      this.retries.delete(node.nodeId);
      void this.flushNode(node);
    }, wait);
    timer.unref();
    this.retries.set(node.nodeId, timer);
    return true;
  }
  async close() {
    this.closed = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    this.nodes.off('ready', this.ready);
    await Promise.allSettled(this.flushing.values());
  }
}
