import type { ControlDatabase } from '../persistence/database';
import type { NodeRegistry } from '../cluster/node-link';
import type { DiagnosticSessions } from './sessions';
import { readServerSettings, setLogRetentionDays } from '../persistence/server-settings';
import { pruneHostLogs } from './host-logs';
import { localDate, log } from '../log';

export class LogRetention {
  private timer?: NodeJS.Timeout;
  private work = Promise.resolve();
  constructor(
    private readonly store: ControlDatabase,
    private readonly nodes: NodeRegistry,
    private readonly directory: string,
    private readonly sessions?: DiagnosticSessions,
    private readonly now = () => new Date(),
  ) {}
  get days() {
    return readServerSettings(this.store.db).logRetentionDays;
  }
  start() {
    this.apply();
    this.schedule();
  }
  async change(days: unknown) {
    setLogRetentionDays(this.store.db, days);
    await this.apply();
    return { logRetentionDays: this.days };
  }
  private schedule() {
    const now = this.now();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    this.timer = setTimeout(
      () => {
        this.apply();
        this.schedule();
      },
      Math.max(1, next.getTime() - now.getTime()),
    );
    this.timer.unref();
  }
  apply() {
    const days = this.days;
    this.nodes.setLogRetentionDays(days);
    this.work = this.work
      .then(async () => {
        await pruneHostLogs(this.directory, days, this.now());
        await this.sessions?.prune(days, this.now());
      })
      .catch((err) => {
        log.error('logs.retention_failed', { err, date: localDate(this.now()) });
      });
    return this.work;
  }
  async close() {
    clearTimeout(this.timer);
    await this.work;
  }
}
