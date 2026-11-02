import Database from 'better-sqlite3';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import type { ControlState } from '../client/types';
import type { ProductUser, ProductWorkspace } from '../shared/product';
const scrypt = promisify(scryptCallback);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const defaultSettings = () => ({ qualityPreference: 'auto' as const, clientScaleOverride: null, memorySaverEnabled: true, showStats: false, audioChannels: { left: true, right: true } });
export function emptyWorkspace(tenantId: string): ProductWorkspace { return { schemaVersion: 2, tenantId, revision: 0, tabs: [], windows: [], activeWindowId: null, layoutMode: 'side-by-side', settings: defaultSettings(), sites: {}, pendingClose: null, pendingWindowCloseId: null }; }
export function migrateLegacy(state: ControlState): ProductWorkspace {
  const result = emptyWorkspace(state.tenantId), first = randomUUID(), second = randomUUID();
  const split = state.splitTabId && state.splitTabId !== state.activeTabId && state.tabs.some(t => t.id === state.splitTabId) ? state.splitTabId : null;
  result.windows = [{ id: first, activeTabId: state.tabs.some(t => t.id === state.activeTabId) ? state.activeTabId : state.tabs.find(t => t.id !== split)?.id ?? null, weight: 1 }];
  if (split) result.windows.push({ id: second, activeTabId: split, weight: 1 });
  result.activeWindowId = first;
  result.tabs = state.tabs.map(tab => ({ ...tab, webviewId: tab.webviewId ?? '', windowId: tab.id === split ? second : first }));
  result.pendingClose = state.pendingClose ?? null; return result;
}
export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path); this.db.defaultSafeIntegers(true); this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id));
      CREATE TABLE IF NOT EXISTS view_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, tenant TEXT NOT NULL UNIQUE, salt TEXT, password_hash TEXT, legacy INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS auth_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, active_window TEXT, layout_mode TEXT NOT NULL, pending TEXT);
      CREATE TABLE IF NOT EXISTS workspace_windows (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, position INTEGER NOT NULL, active_tab TEXT, weight REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_tabs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, window_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_settings (tenant TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS site_preferences (tenant TEXT NOT NULL, origin TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,origin));
      CREATE TABLE IF NOT EXISTS diagnostic_devices (tenant TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    if (!(this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).some(column => column.name === 'is_admin')) this.db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`CREATE TABLE IF NOT EXISTS registration_policy (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, credential_hash TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS single_admin ON users(is_admin) WHERE is_admin=1;`);
    this.db.exec('CREATE TABLE IF NOT EXISTS popup_receipts (tenant TEXT NOT NULL, provisional_id TEXT NOT NULL, tab_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,provisional_id))');
    this.db.transaction(() => {
      const legacyRows = this.db.prepare('SELECT id,state FROM tenants').all() as { id: string; state: string }[];
      let legacyMax = 0n;
      for (const row of legacyRows) for (const tab of JSON.parse(row.state).tabs ?? []) if (/^[1-9][0-9]*$/.test(tab.webviewId)) legacyMax = BigInt(tab.webviewId) > legacyMax ? BigInt(tab.webviewId) : legacyMax;
      if (legacyMax > 0n) this.db.prepare('INSERT OR IGNORE INTO view_ids(id) VALUES (?)').run(legacyMax);
      for (const row of legacyRows) {
        if (this.db.prepare('SELECT tenant FROM workspaces WHERE tenant=?').get(row.id)) continue;
        const old = JSON.parse(row.state) as ControlState;
        this.db.prepare('INSERT OR IGNORE INTO users(id,username,tenant,salt,password_hash,legacy) VALUES (?,?,?,?,?,1)').run(randomUUID(), `legacy-${row.id}`, row.id, null, null);
        const migrated = migrateLegacy(old);
        for (const tab of migrated.tabs) if (!tab.webviewId) tab.webviewId = this.viewId();
        this.writeWorkspace(migrated);
        this.db.prepare('INSERT OR REPLACE INTO diagnostic_devices VALUES (?,?)').run(row.id, JSON.stringify(old.device));
        const owner = this.userForTenant(row.id)!;
        for (const session of this.db.prepare('SELECT token FROM sessions WHERE tenant=?').all(row.id) as { token: string }[]) this.db.prepare('INSERT OR IGNORE INTO auth_tokens VALUES (?,?,?)').run(tokenHash(session.token), owner.id, Date.now() + 30 * 86400000);
      }
      if (!this.hasAdmin()) this.db.prepare('UPDATE users SET is_admin=1 WHERE rowid=(SELECT rowid FROM users WHERE legacy=0 ORDER BY rowid LIMIT 1)').run();
      let max = 0n;
      for (const row of this.db.prepare('SELECT data FROM workspace_tabs').all() as { data: string }[]) { const id = JSON.parse(row.data).webviewId; if (/^[1-9][0-9]*$/.test(id)) max = BigInt(id) > max ? BigInt(id) : max; }
      if (max > 0n) this.db.prepare('INSERT OR IGNORE INTO view_ids(id) VALUES (?)').run(max);
      for (const row of this.db.prepare('SELECT tenant,data FROM user_settings').all() as { tenant: string; data: string }[]) {
        const settings = JSON.parse(row.data);
        if (settings.showStats === undefined) this.db.prepare('UPDATE user_settings SET data=? WHERE tenant=?').run(JSON.stringify({ ...defaultSettings(), ...settings }), row.tenant);
      }
    })();
  }
  session(token?: string): { token: string; tenantId: string; fresh: boolean } {
    const tenant = this.authenticated(token); if (tenant) return { token: token!, tenantId: tenant, fresh: false };
    return this.db.transaction(() => {
      const tenantId = randomUUID(), userId = randomUUID(), token = randomBytes(32).toString('hex');
      this.db.prepare('INSERT INTO tenants VALUES (?,?)').run(tenantId, '{}');
      this.db.prepare('INSERT INTO users(id,username,tenant,salt,password_hash,legacy) VALUES (?,?,?,?,?,1)').run(userId, `diagnostic-${userId}`, tenantId, null, null);
      this.writeWorkspace(emptyWorkspace(tenantId)); this.issueToken(userId, token); return { token, tenantId, fresh: true };
    })();
  }
  private issueToken(userId: string, value = randomBytes(32).toString('hex')) { this.db.prepare('INSERT INTO auth_tokens VALUES (?,?,?)').run(tokenHash(value), userId, Date.now() + 30 * 86400000); return value; }
  identity(token?: string): { user: ProductUser; tenantId: string; legacy: boolean } | undefined {
    if (!token || token.length > 256) return;
    const row = this.db.prepare('SELECT u.id,u.username,u.tenant,u.legacy,u.is_admin FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.hash=? AND t.expires_at>?').get(tokenHash(token), Date.now()) as { id: string; username: string; tenant: string; legacy: bigint; is_admin: bigint } | undefined;
    return row ? { user: { id: row.id, username: row.username, isAdmin: !!row.is_admin }, tenantId: row.tenant, legacy: !!row.legacy } : undefined;
  }
  authenticated(token?: string): string | undefined { return this.identity(token)?.tenantId; }
  userForTenant(tenant: string): ProductUser | undefined { const row = this.db.prepare('SELECT id,username,is_admin FROM users WHERE tenant=?').get(tenant) as { id: string; username: string; is_admin: bigint } | undefined; return row ? { id: row.id, username: row.username, isAdmin: !!row.is_admin } : undefined; }
  isLegacy(tenant: string): boolean { return !!(this.db.prepare('SELECT legacy FROM users WHERE tenant=?').get(tenant) as { legacy: bigint } | undefined)?.legacy; }
  revoke(token?: string) { if (token) this.db.prepare('DELETE FROM auth_tokens WHERE hash=?').run(tokenHash(token)); }
  private hasAdmin() { return !!this.db.prepare('SELECT id FROM users WHERE is_admin=1').get(); }
  private registrationCredential() { return this.db.prepare('SELECT salt,credential_hash FROM registration_policy WHERE id=1').get() as { salt: string; credential_hash: string } | undefined; }
  registrationStatus() { const hasAdmin = this.hasAdmin(), configured = !!this.registrationCredential(); return { hasAdmin, credentialRequired: hasAdmin, registrationOpen: !hasAdmin || configured }; }
  adminStatus() { return { registrationCredentialConfigured: !!this.registrationCredential() }; }
  async setRegistrationCredential(tenant: string, value: unknown, validate: () => void = () => {}) {
    const authorize = () => { validate(); if (!this.userForTenant(tenant)?.isAdmin) throw new Error('需要管理员权限'); };
    authorize(); this.validateServerCredential(value);
    const salt = randomBytes(16).toString('hex'), hash = (await scrypt(value as string, salt, 64) as Buffer).toString('hex');
    return this.db.transaction(() => { authorize(); this.db.prepare('INSERT OR REPLACE INTO registration_policy VALUES (1,?,?)').run(salt, hash); return this.adminStatus(); })();
  }
  private validateServerCredential(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length < 8 || value.length > 256) throw new Error('注册口令需8–256个字符'); }
  async register(username: unknown, password: unknown, serverCredential?: unknown) {
    const name = this.credentials(username, password), hasAdmin = this.hasAdmin(), credential = this.registrationCredential();
    if (hasAdmin && !credential) throw new Error('管理员尚未配置注册口令，注册暂未开放');
    if (hasAdmin) this.validateServerCredential(serverCredential);
    const salt = randomBytes(16).toString('hex');
    const [hash, supplied] = await Promise.all([scrypt(password as string, salt, 64), hasAdmin ? scrypt(serverCredential as string, credential!.salt, 64) : Promise.resolve(undefined)]) as [Buffer, Buffer | undefined];
    if (hasAdmin && !timingSafeEqual(supplied!, Buffer.from(credential!.credential_hash, 'hex'))) throw new Error('注册口令错误');
    return this.db.transaction(() => {
      // Hashing yields: check the exact current policy again before granting an account.
      const current = this.registrationCredential();
      if (this.hasAdmin() !== hasAdmin || current?.salt !== credential?.salt || current?.credential_hash !== credential?.credential_hash) throw new Error('注册策略已更新，请重试');
      if (this.db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(name)) throw new Error('用户名已存在');
      const id = randomUUID(), tenantId = randomUUID(), isAdmin = !hasAdmin;
      this.db.prepare('INSERT INTO tenants VALUES (?,?)').run(tenantId, '{}');
      this.db.prepare('INSERT INTO users(id,username,tenant,salt,password_hash,legacy,is_admin) VALUES (?,?,?,?,?,0,?)').run(id, name, tenantId, salt, hash.toString('hex'), Number(isAdmin));
      this.writeWorkspace(emptyWorkspace(tenantId)); return { token: this.issueToken(id), tenantId, user: { id, username: name, isAdmin } };
    })();
  }
  async login(username: unknown, password: unknown) {
    const name = this.credentials(username, password);
    const row = this.db.prepare('SELECT id,username,tenant,salt,password_hash,is_admin FROM users WHERE username=? COLLATE NOCASE AND legacy=0').get(name) as { id: string; username: string; tenant: string; salt: string; password_hash: string; is_admin: bigint } | undefined;
    const actual = await scrypt(password as string, row?.salt ?? 'unknown-user-salt', 64) as Buffer;
    if (!row || !timingSafeEqual(actual, Buffer.from(row.password_hash, 'hex'))) throw new Error('用户名或密码错误');
    return { token: this.issueToken(row.id), tenantId: row.tenant, user: { id: row.id, username: row.username, isAdmin: !!row.is_admin } };
  }
  private credentials(username: unknown, password: unknown) { if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,40}$/.test(username) || typeof password !== 'string' || password.length < 8 || password.length > 256) throw new Error('用户名需3–40个字母、数字或_.-，密码需8–256个字符'); return username; }
  workspace(tenant: string): ProductWorkspace {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE tenant=?').get(tenant) as { revision: bigint; active_window: string | null; layout_mode: ProductWorkspace['layoutMode']; pending: string } | undefined;
    if (!row) throw new Error('工作区不存在');
    const settings = this.db.prepare('SELECT data FROM user_settings WHERE tenant=?').get(tenant) as { data: string };
    return { schemaVersion: 2, tenantId: tenant, revision: Number(row.revision), activeWindowId: row.active_window, layoutMode: row.layout_mode, ...JSON.parse(row.pending ?? '{}'), settings: { ...defaultSettings(), ...JSON.parse(settings.data) },
      windows: (this.db.prepare('SELECT id,active_tab,weight FROM workspace_windows WHERE tenant=? ORDER BY position').all(tenant) as { id: string; active_tab: string | null; weight: number }[]).map(w => ({ id: w.id, activeTabId: w.active_tab, weight: w.weight })),
      tabs: (this.db.prepare('SELECT data FROM workspace_tabs WHERE tenant=? ORDER BY position').all(tenant) as { data: string }[]).map(t => JSON.parse(t.data)),
      sites: Object.fromEntries((this.db.prepare('SELECT origin,data FROM site_preferences WHERE tenant=?').all(tenant) as { origin: string; data: string }[]).map(s => [s.origin, JSON.parse(s.data)])) };
  }
  saveWorkspace(state: ProductWorkspace) {
    const windows = new Set(state.windows.map(w => w.id)), tabs = new Set(state.tabs.map(t => t.id));
    if (windows.size !== state.windows.length || tabs.size !== state.tabs.length || state.tabs.some(t => !windows.has(t.windowId)) || state.windows.some(w => w.activeTabId !== null && !state.tabs.some(t => t.id === w.activeTabId && t.windowId === w.id)) || state.activeWindowId !== null && !windows.has(state.activeWindowId)) throw new Error('工作区窗口/标签归属不一致');
    const previous = this.workspace(state.tenantId);
    if (isDeepStrictEqual({ ...state, revision: 0, pendingClose: state.pendingClose ?? null, pendingWindowCloseId: state.pendingWindowCloseId ?? null }, { ...previous, revision: 0 })) { state.revision = previous.revision; return false; }
    state.revision = previous.revision + 1; this.db.transaction(() => this.writeWorkspace(state))(); return true;
  }
  private writeWorkspace(state: ProductWorkspace) {
    this.db.prepare('INSERT OR REPLACE INTO workspaces VALUES (?,?,?,?,?)').run(state.tenantId, state.revision, state.activeWindowId, state.layoutMode, JSON.stringify({ pendingClose: state.pendingClose ?? null, pendingWindowCloseId: state.pendingWindowCloseId ?? null }));
    for (const table of ['workspace_windows', 'workspace_tabs', 'site_preferences']) this.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(state.tenantId);
    state.windows.forEach((w, i) => this.db.prepare('INSERT INTO workspace_windows VALUES (?,?,?,?,?)').run(w.id, state.tenantId, i, w.activeTabId, w.weight));
    state.tabs.forEach((t, i) => this.db.prepare('INSERT INTO workspace_tabs VALUES (?,?,?,?,?)').run(t.id, state.tenantId, t.windowId, i, JSON.stringify(t)));
    this.db.prepare('INSERT OR REPLACE INTO user_settings VALUES (?,?)').run(state.tenantId, JSON.stringify(state.settings));
    for (const [origin, data] of Object.entries(state.sites)) this.db.prepare('INSERT INTO site_preferences VALUES (?,?,?)').run(state.tenantId, origin, JSON.stringify(data));
  }
  state(id: string): ControlState {
    const ws = this.workspace(id), active = ws.windows.find(w => w.id === ws.activeWindowId) ?? ws.windows[0];
    const device = this.db.prepare('SELECT data FROM diagnostic_devices WHERE tenant=?').get(id) as { data: string } | undefined;
    return { tenantId: id, tabs: ws.tabs, activeTabId: active?.activeTabId ?? null, splitTabId: ws.windows.find(w => w.id !== active?.id)?.activeTabId ?? null, device: device ? JSON.parse(device.data) : { mode: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 }, pendingClose: ws.pendingClose };
  }
  save(state: ControlState) { const next = migrateLegacy(state); const current = this.workspace(state.tenantId); next.revision = current.revision; next.settings = current.settings; next.sites = current.sites; this.saveWorkspace(next); this.db.prepare('INSERT OR REPLACE INTO diagnostic_devices VALUES (?,?)').run(state.tenantId, JSON.stringify(state.device)); }
  all(): string[] { return (this.db.prepare('SELECT tenant FROM workspaces').all() as { tenant: string }[]).map(row => row.tenant); }
  popupTabId(tenant: string, provisionalId: string): string | undefined { return (this.db.prepare('SELECT tab_id FROM popup_receipts WHERE tenant=? AND provisional_id=?').get(tenant, provisionalId) as { tab_id: string } | undefined)?.tab_id; }
  savePopupWorkspace(state: ProductWorkspace, provisionalId: string, tabId: string) {
    this.db.transaction(() => { this.saveWorkspace(state); this.db.prepare('INSERT INTO popup_receipts VALUES (?,?,?,?)').run(state.tenantId, provisionalId, tabId, Date.now()); })();
  }
  prunePopupReceipts(tenant: string) { this.db.prepare('DELETE FROM popup_receipts WHERE tenant=? AND created_at<? AND tab_id NOT IN (SELECT id FROM workspace_tabs WHERE tenant=?)').run(tenant, Date.now() - 120000, tenant); }
  viewId(): string { return String(this.db.prepare('INSERT INTO view_ids DEFAULT VALUES').run().lastInsertRowid); }
}
