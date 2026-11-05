import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { ControlDatabase } from '../persistence/database';
import { emptyWorkspace } from '../persistence/workspaces';
import { deriveSecret as scrypt, verifySecret } from './crypto';
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
  registrationStatus() {
    const hasAdmin = this.repository.hasAdmin(),
      configured = !!this.repository.registrationCredential();
    return { hasAdmin, credentialRequired: hasAdmin, registrationOpen: !hasAdmin || configured };
  }
  adminStatus() {
    return { registrationCredentialConfigured: !!this.repository.registrationCredential() };
  }
  async setRegistrationCredential(tenant: string, value: unknown, validate: () => void = () => {}) {
    const authorize = () => {
      validate();
      if (!this.repository.userForTenant(tenant)?.isAdmin)
        throw new RemoteKitError('forbidden', '需要管理员权限');
    };
    authorize();
    this.validateServerCredential(value);
    const salt = randomBytes(16).toString('hex'),
      hash = ((await scrypt(value as string, salt)) as Buffer).toString('hex');
    return this.store.transaction(() => {
      authorize();
      this.repository.saveRegistrationCredential(salt, hash);
      return this.adminStatus();
    });
  }
  private validateServerCredential(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length < 8 || value.length > 256)
      throw new RemoteKitError('invalid_request', '注册口令需8–256个字符');
  }
  async register(username: unknown, password: unknown, serverCredential?: unknown) {
    const name = this.credentials(username, password),
      hasAdmin = this.repository.hasAdmin(),
      credential = this.repository.registrationCredential();
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
    return this.store.transaction(() => {
      // Hashing yields: check the exact current policy again before granting an account.
      const current = this.repository.registrationCredential();
      if (
        this.repository.hasAdmin() !== hasAdmin ||
        current?.salt !== credential?.salt ||
        current?.credential_hash !== credential?.credential_hash
      )
        throw new RemoteKitError('conflict', '注册策略已更新，请重试');
      if (this.repository.usernameExists(name)) throw new RemoteKitError('conflict', '用户名已存在');
      const id = randomUUID(),
        tenantId = randomUUID(),
        isAdmin = !hasAdmin;
      this.repository.insertUser({
        id,
        username: name,
        tenant: tenantId,
        salt,
        password_hash: hash.toString('hex'),
        is_admin: Number(isAdmin),
      });
      this.store.workspaces.writeWorkspace(emptyWorkspace(tenantId));
      return { token: this.repository.issueToken(id), tenantId, user: { id, username: name, isAdmin } };
    });
  }
  async login(username: unknown, password: unknown) {
    const name = this.credentials(username, password);
    const row = this.repository.loginUser(name);
    return this.store.security.authAttempts.run(
      'password:' + (row?.id ?? 'unknown:' + name.toLowerCase()),
      async () => {
        const valid = await verifySecret(
          password as string,
          row && { salt: row.salt, hash: row.password_hash },
        );
        if (!row || !valid || this.repository.passwordHash(row.id) !== row.password_hash)
          throw new RemoteKitError('unauthenticated', '用户名或密码错误');
        return {
          token: this.repository.issueToken(row.id),
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
