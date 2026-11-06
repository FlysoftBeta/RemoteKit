import { randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { ControlDatabase } from '../persistence/database';
import { emptyWorkspace } from '../persistence/workspaces';
import { hashSecret, verifySecret } from './crypto';

export function validUsername(username: unknown): asserts username is string {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,40}$/.test(username))
    throw new RemoteKitError('invalid_request', '用户名需3–40个字母、数字或_.-');
}
export function validPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256)
    throw new RemoteKitError('invalid_request', '密码需8–256个字符');
}

export class AccountService {
  private readonly repository;
  constructor(private readonly store: ControlDatabase) {
    this.repository = store.accounts;
  }
  identity(token?: string) {
    return this.repository.identity(token);
  }
  logout(token?: string) {
    this.repository.revoke(token);
  }
  me(token?: string) {
    const identity = this.identity(token);
    if (!identity) throw new RemoteKitError('unauthenticated', '请先登录');
    return { authenticated: true, user: identity.user };
  }
  setupStatus() {
    return { setupRequired: !this.repository.hasUsers() };
  }
  // Only the first account is created without an administrator; it becomes the administrator.
  async setup(username: unknown, password: unknown) {
    validUsername(username);
    validPassword(password);
    if (this.repository.hasUsers()) throw new RemoteKitError('forbidden', '账户由管理员创建');
    const secret = await hashSecret(password);
    return this.store.transaction(() => {
      if (this.repository.hasUsers()) throw new RemoteKitError('forbidden', '账户由管理员创建');
      const user = this.insert(username, secret, true);
      this.repository.recordLogin(user.id, Date.now());
      return { token: this.repository.issueToken(user.id), tenantId: user.tenantId, user: user.user };
    });
  }
  async createUser(username: unknown, password: unknown) {
    validUsername(username);
    validPassword(password);
    const secret = await hashSecret(password);
    return this.store.transaction(() => this.insert(username, secret, false));
  }
  private insert(username: string, secret: { salt: string; hash: string }, isAdmin: boolean) {
    if (this.repository.usernameExists(username)) throw new RemoteKitError('conflict', '用户名已存在');
    const id = randomUUID(),
      tenantId = randomUUID();
    this.repository.insertUser({
      id,
      username,
      tenant: tenantId,
      salt: secret.salt,
      password_hash: secret.hash,
      is_admin: Number(isAdmin),
    });
    this.store.workspaces.writeWorkspace(emptyWorkspace(tenantId));
    return { id, tenantId, user: { id, username, isAdmin } };
  }
  async login(username: unknown, password: unknown) {
    validUsername(username);
    validPassword(password);
    const row = this.repository.loginUser(username);
    return this.store.security.authAttempts.run(
      'password:' + (row?.id ?? 'unknown:' + username.toLowerCase()),
      async () => {
        const valid = await verifySecret(password, row && { salt: row.salt, hash: row.password_hash });
        if (!row || !valid || this.repository.passwordHash(row.id) !== row.password_hash)
          throw new RemoteKitError('unauthenticated', '用户名或密码错误');
        if (row.disabled_at !== null) throw new RemoteKitError('forbidden', '账户已停用');
        this.repository.recordLogin(row.id, Date.now());
        return {
          token: this.repository.issueToken(row.id),
          tenantId: row.tenant,
          user: { id: row.id, username: row.username, isAdmin: !!row.is_admin },
        };
      },
    );
  }
}
