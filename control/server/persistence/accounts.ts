import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import type { ProductUser } from '../../shared/product';
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface StoredUser {
  id: string;
  username: string;
  tenant: string;
  isAdmin: boolean;
  lastLoginAt: number | null;
  disabledAt: number | null;
}
interface UserRow {
  id: string;
  username: string;
  tenant: string;
  is_admin: bigint;
  last_login_at: bigint | null;
  disabled_at: bigint | null;
}
const stored = (row: UserRow): StoredUser => ({
  id: row.id,
  username: row.username,
  tenant: row.tenant,
  isAdmin: !!row.is_admin,
  lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
  disabledAt: row.disabled_at === null ? null : Number(row.disabled_at),
});
const userColumns = 'id,username,tenant,is_admin,last_login_at,disabled_at';

export class AccountsRepository {
  constructor(private readonly db: Database.Database) {}
  issueToken(userId: string, value = randomBytes(32).toString('hex')) {
    this.db
      .prepare('INSERT INTO auth_tokens VALUES (?,?,?)')
      .run(tokenHash(value), userId, Date.now() + 30 * 86400000);
    return value;
  }
  identity(token?: string): { user: ProductUser; tenantId: string } | undefined {
    if (!token || token.length > 256) return;
    const row = this.db
      .prepare(
        `SELECT u.id,u.username,u.tenant,u.is_admin FROM auth_tokens t JOIN users u ON u.id=t.user_id
        WHERE t.hash=? AND t.expires_at>? AND u.disabled_at IS NULL`,
      )
      .get(tokenHash(token), Date.now()) as
      { id: string; username: string; tenant: string; is_admin: bigint } | undefined;
    return row
      ? {
          user: { id: row.id, username: row.username, isAdmin: !!row.is_admin },
          tenantId: row.tenant,
        }
      : undefined;
  }
  authenticated(token?: string): string | undefined {
    return this.identity(token)?.tenantId;
  }
  userForTenant(tenant: string): ProductUser | undefined {
    const row = this.db.prepare('SELECT id,username,is_admin FROM users WHERE tenant=?').get(tenant) as
      { id: string; username: string; is_admin: bigint } | undefined;
    return row ? { id: row.id, username: row.username, isAdmin: !!row.is_admin } : undefined;
  }
  users(): StoredUser[] {
    return (
      this.db.prepare(`SELECT ${userColumns} FROM users ORDER BY username COLLATE NOCASE`).all() as UserRow[]
    ).map(stored);
  }
  byUsername(name: string): StoredUser | undefined {
    const row = this.db
      .prepare(`SELECT ${userColumns} FROM users WHERE username=? COLLATE NOCASE`)
      .get(name) as UserRow | undefined;
    return row && stored(row);
  }
  revoke(token?: string) {
    if (token) this.db.prepare('DELETE FROM auth_tokens WHERE hash=?').run(tokenHash(token));
  }
  revokeUser(userId: string) {
    this.db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(userId);
  }
  hasUsers() {
    return !!this.db.prepare('SELECT 1 FROM users').get();
  }
  usernameExists(name: string) {
    return !!this.db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(name);
  }
  insertUser(user: {
    id: string;
    username: string;
    tenant: string;
    salt: string;
    password_hash: string;
    is_admin: number;
  }) {
    this.db
      .prepare(
        'INSERT INTO users(id,username,tenant,salt,password_hash,is_admin) VALUES (@id,@username,@tenant,@salt,@password_hash,@is_admin)',
      )
      .run(user);
  }
  loginUser(name: string) {
    return this.db
      .prepare(
        'SELECT id,username,tenant,salt,password_hash,is_admin,disabled_at FROM users WHERE username=? COLLATE NOCASE',
      )
      .get(name) as
      | {
          id: string;
          username: string;
          tenant: string;
          salt: string;
          password_hash: string;
          is_admin: bigint;
          disabled_at: bigint | null;
        }
      | undefined;
  }
  passwordHash(id: string) {
    return (
      this.db.prepare('SELECT password_hash AS hash FROM users WHERE id=?').get(id) as
        { hash: string } | undefined
    )?.hash;
  }
  recordLogin(id: string, at: number) {
    this.db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(at, id);
  }
  setPassword(id: string, salt: string, hash: string) {
    this.db.prepare('UPDATE users SET salt=?, password_hash=? WHERE id=?').run(salt, hash, id);
  }
  setDisabled(id: string, at: number | null) {
    this.db.prepare('UPDATE users SET disabled_at=? WHERE id=?').run(at, id);
  }
  transferAdmin(from: string, to: string) {
    this.db.prepare('UPDATE users SET is_admin=0 WHERE id=?').run(from);
    this.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(to);
  }
  deleteUser(id: string) {
    this.revokeUser(id);
    this.db.prepare('DELETE FROM users WHERE id=?').run(id);
  }
}
