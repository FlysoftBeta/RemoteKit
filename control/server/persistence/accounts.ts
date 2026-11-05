import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import type { ProductUser } from '../../shared/product';
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

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
        'SELECT u.id,u.username,u.tenant,u.is_admin FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.hash=? AND t.expires_at>?',
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
  revoke(token?: string) {
    if (token) this.db.prepare('DELETE FROM auth_tokens WHERE hash=?').run(tokenHash(token));
  }
  hasAdmin() {
    return !!this.db.prepare('SELECT id FROM users WHERE is_admin=1').get();
  }
  registrationCredential() {
    return this.db.prepare('SELECT salt,credential_hash FROM registration_policy WHERE id=1').get() as
      { salt: string; credential_hash: string } | undefined;
  }

  saveRegistrationCredential(salt: string, hash: string) {
    this.db.prepare('INSERT OR REPLACE INTO registration_policy VALUES (1,?,?)').run(salt, hash);
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
        'SELECT id,username,tenant,salt,password_hash,is_admin FROM users WHERE username=? COLLATE NOCASE',
      )
      .get(name) as
      | {
          id: string;
          username: string;
          tenant: string;
          salt: string;
          password_hash: string;
          is_admin: bigint;
        }
      | undefined;
  }
  passwordHash(id: string) {
    return (
      this.db.prepare('SELECT password_hash AS hash FROM users WHERE id=?').get(id) as
        { hash: string } | undefined
    )?.hash;
  }
}
