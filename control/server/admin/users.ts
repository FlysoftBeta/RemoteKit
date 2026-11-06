import { RemoteKitError } from '../../shared/errors';
import type { AdminSessionState, AdminStorage, AdminUser } from '../../shared/admin';
import type { DomainContext, DomainServices } from '../application';
import { validPassword } from '../auth/accounts';
import { hashSecret } from '../auth/crypto';
import type { StoredUser } from '../persistence/accounts';

type Services = Pick<
  DomainServices,
  'accounts' | 'viewers' | 'lifecycle' | 'objects' | 'sessionPurge' | 'sessionImporter'
>;

export class UserAdmin {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Services,
  ) {}
  private find(username: unknown): StoredUser {
    const user = typeof username === 'string' ? this.context.store.accounts.byUsername(username) : undefined;
    if (!user) throw new RemoteKitError('not_found', '用户不存在');
    return user;
  }
  private other(actor: string, username: unknown) {
    const user = this.find(username);
    if (user.tenant === actor) throw new RemoteKitError('forbidden', '不能对自己的账户执行此操作');
    return user;
  }
  private session(tenant: string): AdminSessionState {
    const placement = this.context.endpoint.placement.peek(tenant);
    if (!placement) return { state: 'none' };
    if (placement.state === 'active') return { state: 'active', nodeId: placement.nodeId };
    return {
      state: 'hibernated',
      checkpointAt: this.context.endpoint.placement.checkpoints(tenant).latestAt,
    };
  }
  list(): AdminUser[] {
    return this.context.store.accounts.users().map((user) => {
      const security = this.context.store.security.security(user.id);
      const usage = this.services.objects.tenantUsage(user.tenant);
      return {
        username: user.username,
        isAdmin: user.isAdmin,
        disabled: user.disabledAt !== null,
        online: !!this.context.tenants.get(user.tenant).viewer,
        lastLoginAt: user.lastLoginAt,
        session: this.session(user.tenant),
        secondFactors: { pin: !!security.pin, face: !!security.face },
        storage: { bytes: usage.bytes, quotaBytes: usage.quotaBytes },
      };
    });
  }
  storage(): AdminStorage {
    const usage = this.services.objects.usage();
    return {
      ...usage,
      pendingSessionDeletions: this.services.sessionPurge.pending(),
      users: this.context.store.accounts.users().map((user) => {
        const objects = this.services.objects.tenantUsage(user.tenant);
        const checkpoints = this.context.endpoint.placement.checkpoints(user.tenant);
        return {
          username: user.username,
          libraryFiles: this.context.store.library.entryCount(user.tenant),
          objects: objects.objects,
          bytes: objects.bytes,
          quotaBytes: objects.quotaBytes,
          checkpoints: checkpoints.count,
          latestCheckpointBytes: checkpoints.latestBytes,
          latestCheckpointAt: checkpoints.latestAt,
        };
      }),
    };
  }
  async create(username: unknown, password: unknown) {
    await this.services.accounts.createUser(username, password);
    return this.list();
  }
  private async disconnect(tenant: string) {
    const viewer = this.context.tenants.get(tenant).viewer;
    if (!viewer) return;
    viewer.revoke('logout');
    await this.services.viewers.detachViewer(tenant, viewer.id);
  }
  async resetPassword(actor: string, username: unknown, password: unknown) {
    const user = this.other(actor, username);
    validPassword(password);
    const secret = await hashSecret(password);
    this.context.store.transaction(() => {
      this.context.store.accounts.setPassword(user.id, secret.salt, secret.hash);
      this.context.store.accounts.revokeUser(user.id);
    });
    await this.disconnect(user.tenant);
    return this.list();
  }
  async clearSecondFactors(actor: string, username: unknown) {
    const user = this.other(actor, username);
    this.context.store.security.clearSecondFactors(user.id);
    await this.disconnect(user.tenant);
    return this.list();
  }
  async signOut(actor: string, username: unknown) {
    const user = this.other(actor, username);
    this.context.store.accounts.revokeUser(user.id);
    await this.disconnect(user.tenant);
    return this.list();
  }
  async setDisabled(actor: string, username: unknown, disabled: unknown) {
    const user = this.other(actor, username);
    if (typeof disabled !== 'boolean') throw new RemoteKitError('invalid_request', '无效的停用状态');
    if (disabled && user.isAdmin) throw new RemoteKitError('forbidden', '不能停用管理员');
    this.context.store.transaction(() => {
      this.context.store.accounts.setDisabled(user.id, disabled ? Date.now() : null);
      if (disabled) this.context.store.accounts.revokeUser(user.id);
    });
    if (disabled) await this.disconnect(user.tenant);
    return this.list();
  }
  transferAdmin(actor: string, username: unknown) {
    const user = this.other(actor, username);
    if (user.disabledAt !== null) throw new RemoteKitError('conflict', '不能转让给已停用的账户');
    const current = this.context.store.accounts.userForTenant(actor)!;
    this.context.store.transaction(() => this.context.store.accounts.transferAdmin(current.id, user.id));
    this.services.viewers.push(actor);
    this.services.viewers.push(user.tenant);
    return this.list();
  }
  async hibernate(username: unknown) {
    const user = this.find(username);
    await this.context.tenants.serial(user.tenant, async () => {
      if (this.context.endpoint.placement.peek(user.tenant)?.state !== 'active')
        throw new RemoteKitError('conflict', '会话未运行');
      if (this.context.tenants.get(user.tenant).viewer) throw new RemoteKitError('conflict', '用户在线');
      const snapshot = await this.context.endpoint.snapshot(user.tenant);
      await this.services.lifecycle.hibernate(user.tenant, snapshot, true);
    });
    return this.list();
  }
  // Hibernated tabs are already discarded; the next start opens a blank Profile and restores them by URL.
  async resetSession(username: unknown) {
    const user = this.find(username);
    await this.context.tenants.serial(user.tenant, async () => {
      if (this.context.endpoint.placement.peek(user.tenant)?.state === 'active')
        throw new RemoteKitError('conflict', '请先休眠会话');
      this.context.store.transaction(() => {
        const sessionId = this.context.endpoint.placement.forgetTenant(user.tenant);
        if (sessionId) this.services.sessionPurge.enqueue(sessionId);
      });
    });
    void this.services.sessionPurge.flush();
    return this.list();
  }
  async delete(actor: string, username: unknown) {
    const user = this.other(actor, username);
    this.context.store.transaction(() => {
      this.context.store.accounts.setDisabled(user.id, Date.now());
      this.context.store.accounts.revokeUser(user.id);
    });
    await this.disconnect(user.tenant);
    await this.context.tenants.serial(user.tenant, async () => {
      await this.context.endpoint.hibernating.get(user.tenant)?.catch(() => {});
      const store = this.context.store;
      const importMail = store.transaction(() => {
        const sessionId = this.context.endpoint.placement.forgetTenant(user.tenant);
        if (sessionId) this.services.sessionPurge.enqueue(sessionId);
        this.services.objects.forgetTenant(user.tenant);
        store.library.deleteTenant(user.tenant);
        store.operations.deleteTenant(user.tenant);
        store.workspaces.deleteTenant(user.tenant);
        store.security.deleteUser(user.id);
        const importMail = this.services.sessionImporter.deleteUser(user.tenant);
        store.accounts.deleteUser(user.id);
        return importMail;
      });
      this.services.sessionImporter.queueDeletedDevices(importMail);
      this.context.endpoint.forget(user.tenant);
    });
    this.context.tenants.dispose(user.tenant);
    void this.services.sessionPurge.flush();
    void this.services.objects.tick().catch(() => {});
    return { tenant: user.tenant, users: this.list() };
  }
}
