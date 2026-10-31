import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ControlState } from '../client/types';
export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path); this.db.defaultSafeIntegers(true); this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id)); CREATE TABLE IF NOT EXISTS view_ids (id INTEGER PRIMARY KEY AUTOINCREMENT)');
  }
  session(token?: string): { token: string; tenantId: string; fresh: boolean } {
    const row = token && this.db.prepare('SELECT tenant FROM sessions WHERE token=?').get(token) as { tenant: string } | undefined;
    if (row) return { token: token!, tenantId: row.tenant, fresh: false };
    return this.db.transaction(() => {
      const tenantId = randomUUID(); const token = randomBytes(32).toString('hex');
      const state: ControlState = { tenantId, tabs: [], activeTabId: null, splitTabId: null, device: { mode: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 } };
      this.db.prepare('INSERT INTO tenants VALUES (?,?)').run(tenantId, JSON.stringify(state));
      this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(token, tenantId);
      return { token, tenantId, fresh: true };
    })();
  }
  authenticated(token?: string): string | undefined { return token ? (this.db.prepare('SELECT tenant FROM sessions WHERE token=?').get(token) as { tenant: string } | undefined)?.tenant : undefined; }
  state(id: string): ControlState { return JSON.parse((this.db.prepare('SELECT state FROM tenants WHERE id=?').get(id) as { state: string }).state); }
  save(state: ControlState) { this.db.prepare('UPDATE tenants SET state=? WHERE id=?').run(JSON.stringify(state), state.tenantId); }
  all(): string[] { return (this.db.prepare('SELECT id FROM tenants').all() as { id: string }[]).map(row => row.id); }
  viewId(): string { return String(this.db.prepare('INSERT INTO view_ids DEFAULT VALUES').run().lastInsertRowid); }
}
