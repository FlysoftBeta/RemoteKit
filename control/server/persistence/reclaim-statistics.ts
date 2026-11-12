import type Database from 'better-sqlite3';
import type { Clock } from '../util/clock';
import type { PageDwell } from '../workspace/reclaim-policy';

type Dwell = { visibleMs: number; visits: number; lastVisibleAt: number };
type Tracking = {
  observedAt: number;
  lastWrite: number;
  visible: Map<string, string>;
  pending: Map<string, Dwell>;
};
const retentionMs = 90 * 24 * 60 * 60 * 1000;

export class ReclaimStatistics {
  private readonly tenants = new Map<string, Tracking>();
  private heartbeatAt: number;
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {
    const now = clock.wallMs();
    const previous = db.prepare('SELECT last_ran_at FROM control_heartbeat').get() as
      { last_ran_at: bigint } | undefined;
    db.prepare(
      'UPDATE viewer_presence SET disconnected_at=max(connected_at,?) WHERE disconnected_at IS NULL',
    ).run(Math.min(now, Number(previous?.last_ran_at ?? now)));
    for (const row of db.prepare('SELECT DISTINCT tenant FROM viewer_presence').all() as { tenant: string }[])
      this.prune(row.tenant);
    this.heartbeatAt = clock.monotonicMs();
    this.writeHeartbeat();
  }
  private writeHeartbeat() {
    this.db
      .prepare('INSERT OR REPLACE INTO control_heartbeat(id,last_ran_at) VALUES (1,?)')
      .run(this.clock.wallMs());
  }
  private prune(tenant: string) {
    this.db
      .prepare(
        `DELETE FROM viewer_presence WHERE tenant=? AND
      (coalesce(disconnected_at,connected_at) < ? OR rowid IN
        (SELECT rowid FROM viewer_presence WHERE tenant=? ORDER BY connected_at DESC,rowid DESC LIMIT -1 OFFSET 2000))`,
      )
      .run(tenant, this.clock.wallMs() - retentionMs, tenant);
  }
  attach(tenant: string) {
    this.detach(tenant);
    this.db
      .prepare('INSERT INTO viewer_presence(tenant,connected_at) VALUES (?,?)')
      .run(tenant, this.clock.wallMs());
    this.prune(tenant);
  }
  detach(tenant: string) {
    this.observeWanted(tenant, new Map());
    this.db
      .prepare('UPDATE viewer_presence SET disconnected_at=? WHERE tenant=? AND disconnected_at IS NULL')
      .run(this.clock.wallMs(), tenant);
    this.prune(tenant);
  }
  absences(tenant: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT connected_at,disconnected_at FROM viewer_presence
      WHERE tenant=? AND connected_at>=? ORDER BY connected_at,rowid`,
      )
      .all(tenant, this.clock.wallMs() - retentionMs) as {
      connected_at: bigint;
      disconnected_at: bigint | null;
    }[];
    const intervals: number[] = [];
    for (let index = 1; index < rows.length; index++) {
      const end = rows[index - 1].disconnected_at;
      if (end !== null && rows[index].connected_at > end)
        intervals.push(Number(rows[index].connected_at - end));
    }
    return intervals;
  }
  absentSince(tenant: string): number | undefined {
    const row = this.db
      .prepare(
        'SELECT disconnected_at FROM viewer_presence WHERE tenant=? ORDER BY connected_at DESC,rowid DESC LIMIT 1',
      )
      .get(tenant) as { disconnected_at: bigint | null } | undefined;
    return row?.disconnected_at === null || row === undefined ? undefined : Number(row.disconnected_at);
  }
  observeWanted(tenant: string, visible: Map<string, string>) {
    const now = this.clock.monotonicMs();
    let tracking = this.tenants.get(tenant);
    if (!tracking) {
      tracking = { observedAt: now, lastWrite: now, visible: new Map(), pending: new Map() };
      this.tenants.set(tenant, tracking);
    }
    for (const key of tracking.visible.values()) {
      const dwell = tracking.pending.get(key) ?? { visibleMs: 0, visits: 0, lastVisibleAt: 0 };
      dwell.visibleMs += Math.max(0, now - tracking.observedAt);
      dwell.lastVisibleAt = this.clock.wallMs();
      tracking.pending.set(key, dwell);
    }
    for (const [id, key] of visible) {
      if (tracking.visible.get(id) === key) continue;
      const dwell = tracking.pending.get(key) ?? { visibleMs: 0, visits: 0, lastVisibleAt: 0 };
      dwell.visits++;
      dwell.lastVisibleAt = this.clock.wallMs();
      tracking.pending.set(key, dwell);
    }
    tracking.visible = new Map(visible);
    tracking.observedAt = now;
    if (now - tracking.lastWrite >= 10_000) this.flushTenant(tenant, tracking);
  }
  private flushTenant(tenant: string, tracking: Tracking) {
    this.db.transaction(() => {
      for (const [key, value] of tracking.pending)
        this.db
          .prepare(
            `INSERT INTO page_dwell(tenant,page_key,visible_ms,visits,last_visible_at)
          VALUES (?,?,?,?,?) ON CONFLICT(tenant,page_key) DO UPDATE SET
          visible_ms=visible_ms+excluded.visible_ms,visits=visits+excluded.visits,
          last_visible_at=max(last_visible_at,excluded.last_visible_at)`,
          )
          .run(tenant, key, value.visibleMs, value.visits, value.lastVisibleAt);
    })();
    tracking.pending.clear();
    tracking.lastWrite = this.clock.monotonicMs();
  }
  dwell(tenant: string): PageDwell[] {
    const totals = new Map(
      (
        this.db.prepare('SELECT page_key,visible_ms FROM page_dwell WHERE tenant=?').all(tenant) as {
          page_key: string;
          visible_ms: bigint;
        }[]
      ).map((row) => [row.page_key, Number(row.visible_ms)]),
    );
    for (const [key, value] of this.tenants.get(tenant)?.pending ?? [])
      totals.set(key, (totals.get(key) ?? 0) + value.visibleMs);
    return [...totals].map(([pageKey, visibleMs]) => ({ pageKey, visibleMs }));
  }
  tick() {
    for (const [tenant, tracking] of this.tenants) this.observeWanted(tenant, tracking.visible);
    if (this.clock.monotonicMs() - this.heartbeatAt >= 10_000) {
      this.writeHeartbeat();
      this.heartbeatAt = this.clock.monotonicMs();
      for (const tenant of this.tenants.keys()) this.prune(tenant);
    }
  }
  close() {
    for (const tenant of this.tenants.keys()) this.detach(tenant);
    for (const [tenant, tracking] of this.tenants) this.flushTenant(tenant, tracking);
    this.writeHeartbeat();
  }
  deleteTenant(tenant: string) {
    this.tenants.delete(tenant);
    this.db.prepare('DELETE FROM viewer_presence WHERE tenant=?').run(tenant);
    this.db.prepare('DELETE FROM page_dwell WHERE tenant=?').run(tenant);
  }
}
