import { transaction } from './database';
import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { deriveSecret as scrypt, verifySecret } from '../security-crypto';
import { emptyWorkspace, type WorkspacesRepository } from './workspaces';
import type { SecurityRepository } from './security';
import type { ProductUser } from '../../shared/product';
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class AccountsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly security: SecurityRepository,
    private readonly workspaces: WorkspacesRepository,
  ) {}
  private issueToken(userId: string, value = randomBytes(32).toString('hex')) {
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
  private hasAdmin() {
    return !!this.db.prepare('SELECT id FROM users WHERE is_admin=1').get();
  }
  private registrationCredential() {
    return this.db.prepare('SELECT salt,credential_hash FROM registration_policy WHERE id=1').get() as
      { salt: string; credential_hash: string } | undefined;
  }
  registrationStatus() {
    const hasAdmin = this.hasAdmin(),
      configured = !!this.registrationCredential();
    return { hasAdmin, credentialRequired: hasAdmin, registrationOpen: !hasAdmin || configured };
  }
  adminStatus() {
    return { registrationCredentialConfigured: !!this.registrationCredential() };
  }
  async setRegistrationCredential(tenant: string, value: unknown, validate: () => void = () => {}) {
    const authorize = () => {
      validate();
      if (!this.userForTenant(tenant)?.isAdmin) throw new RemoteKitError('forbidden', '需要管理员权限');
    };
    authorize();
    this.validateServerCredential(value);
    const salt = randomBytes(16).toString('hex'),
      hash = ((await scrypt(value as string, salt)) as Buffer).toString('hex');
    return transaction(this.db, () => {
      authorize();
      this.db.prepare('INSERT OR REPLACE INTO registration_policy VALUES (1,?,?)').run(salt, hash);
      return this.adminStatus();
    });
  }
  private validateServerCredential(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length < 8 || value.length > 256)
      throw new RemoteKitError('invalid_request', '注册口令需8–256个字符');
  }
  async register(username: unknown, password: unknown, serverCredential?: unknown) {
    const name = this.credentials(username, password),
      hasAdmin = this.hasAdmin(),
      credential = this.registrationCredential();
    if (hasAdmin && !credential)
      throw new RemoteKitError('unavailable', '管理员尚未配置注册口令，注册暂未开放');
    if (hasAdmin) this.validateServerCredential(serverCredential);
    const salt = randomBytes(16).toString('hex');
    const [hash, supplied] = (await Promise.all([
      scrypt(password as string, salt),
      hasAdmin ? scrypt(serverCredential as string, credential!.salt) : Promise.resolve(undefined),
    ])) as [Buffer, Buffer | undefined];
    if (hasAdmin && !timingSafeEqual(supplied!, Buffer.from(credential!.credential_hash, 'hex')))
      throw new RemoteKitError('forbidden', '注册口令错误');
    return transaction(this.db, () => {
      // Hashing yields: check the exact current policy again before granting an account.
      const current = this.registrationCredential();
      if (
        this.hasAdmin() !== hasAdmin ||
        current?.salt !== credential?.salt ||
        current?.credential_hash !== credential?.credential_hash
      )
        throw new RemoteKitError('conflict', '注册策略已更新，请重试');
      if (this.db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(name))
        throw new RemoteKitError('conflict', '用户名已存在');
      const id = randomUUID(),
        tenantId = randomUUID(),
        isAdmin = !hasAdmin;
      this.db
        .prepare('INSERT INTO users(id,username,tenant,salt,password_hash,is_admin) VALUES (?,?,?,?,?,?)')
        .run(id, name, tenantId, salt, hash.toString('hex'), Number(isAdmin));
      this.workspaces.writeWorkspace(emptyWorkspace(tenantId));
      return { token: this.issueToken(id), tenantId, user: { id, username: name, isAdmin } };
    });
  }
  async login(username: unknown, password: unknown) {
    const name = this.credentials(username, password);
    const row = this.db
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
    return this.security.authAttempts.run(
      'password:' + (row?.id ?? 'unknown:' + name.toLowerCase()),
      async () => {
        const valid = await verifySecret(
          password as string,
          row && { salt: row.salt, hash: row.password_hash },
        );
        if (
          !row ||
          !valid ||
          (
            this.db.prepare('SELECT password_hash AS hash FROM users WHERE id=?').get(row.id) as
              { hash: string } | undefined
          )?.hash !== row.password_hash
        )
          throw new RemoteKitError('unauthenticated', '用户名或密码错误');
        return {
          token: this.issueToken(row.id),
          tenantId: row.tenant,
          user: { id: row.id, username: row.username, isAdmin: !!row.is_admin },
        };
      },
    );
  }
  private credentials(username: unknown, password: unknown) {
    if (
      typeof username !== 'string' ||
      !/^[A-Za-z0-9_.-]{3,40}$/.test(username) ||
      typeof password !== 'string' ||
      password.length < 8 ||
      password.length > 256
    )
      throw new RemoteKitError('invalid_request', '用户名需3–40个字母、数字或_.-，密码需8–256个字符');
    return username;
  }
}
