import { log } from '../log';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type { AdminSessionState, AdminStorage, AdminUser } from '../../shared/admin';
import type { DomainContext, DomainServices } from '../application';
import { validPassword } from '../auth/accounts';
import { hashSecret } from '../auth/crypto';
import type { StoredUser } from '../persistence/accounts';
import { isLocalTab } from '../../shared/product';

type Services = Pick<
  DomainServices,
  | 'accounts'
  | 'viewers'
  | 'lifecycle'
  | 'objects'
  | 'sessionPurge'
  | 'sessionImporter'
  | 'operations'
  | 'learning'
  | 'reconciler'
  | 'security'
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
    const boundNodeId = this.context.endpoint.placement.boundNodeId(tenant);
    if (!placement) return { state: 'none', boundNodeId };
    return {
      state: placement.runState,
      boundNodeId,
      nodeId: placement.nodeId,
      dataState: placement.dataState,
      nodeOffline: this.context.endpoint.nodes.get(placement.nodeId)?.state.state !== 'ready',
      checkpointAt: this.context.endpoint.placement.newestComplete(tenant)?.takenAt ?? null,
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
  async resetPassword(actor: string, loginIdentity: string, username: unknown, password: unknown) {
    const user = this.find(username);
    validPassword(password);
    const secret = await hashSecret(password);
    this.context.store.transaction(() => {
      this.context.store.accounts.setPassword(user.id, secret.salt, secret.hash);
      if (user.tenant === actor) this.context.store.accounts.revokeUserExcept(user.id, loginIdentity);
      else this.context.store.accounts.revokeUser(user.id);
    });
    if (user.tenant !== actor) await this.disconnect(user.tenant);
    return this.list();
  }
  async clearSecondFactors(actor: string, username: unknown) {
    const user = this.find(username);
    if (user.tenant === actor) {
      const viewer = this.context.tenants.get(actor).viewer!;
      this.services.security.clearSecondFactors(actor, viewer.security);
    } else {
      this.context.store.security.clearSecondFactors(user.id);
      await this.disconnect(user.tenant);
    }
    return this.list();
  }
  async signOut(username: unknown) {
    const user = this.find(username);
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
  async transferAdmin(actor: string, username: unknown) {
    const user = this.other(actor, username);
    if (user.disabledAt !== null) throw new RemoteKitError('conflict', '不能转让给已停用的账户');
    const current = this.context.store.accounts.userForTenant(actor)!;
    this.context.store.transaction(() => this.context.store.accounts.transferAdmin(current.id, user.id));
    // The console App belongs to the administrator role; the former administrator's copy closes.
    for (const window of this.context.store.workspaces.workspace(actor).windows)
      if (window.appId === 'admin')
        await this.services.operations.productAction(actor, { type: 'window.close', windowId: window.id });
    this.services.viewers.push(actor);
    this.services.viewers.push(user.tenant);
    return this.list();
  }
  async stop(username: unknown) {
    const user = this.find(username);
    await this.context.tenants.serial(user.tenant, async () => {
      const placement = this.context.endpoint.placement.peek(user.tenant);
      if (placement?.runState !== 'running' && !placement?.pendingCommit)
        throw new RemoteKitError('conflict', '会话未运行');
      await this.rebuildSession(user.tenant, () => this.context.endpoint.stop(user.tenant, { force: true }));
    });
    return this.list();
  }
  private restarting(tenant: string) {
    this.context.tenants.get(tenant).lastError = new RemoteKitError(
      'unavailable',
      '浏览器正在恢复，请稍候…',
      { reason: 'browser_restarting' },
    );
    this.services.viewers.push(tenant);
  }
  private async resume(tenant: string, generation: number) {
    this.services.lifecycle.finishStop(tenant);
    this.services.reconciler.resetTenantEndpoint(tenant, generation);
    this.services.viewers.push(tenant);
    await this.services.reconciler.resumeTenant(tenant);
  }
  private async rebuildSession(tenant: string, change: () => Promise<unknown>) {
    const source = this.context.endpoint.placement.peek(tenant);
    const generation = this.context.tenants.mediaGeneration(tenant) + 1;
    this.restarting(tenant);
    let resuming = false;
    try {
      await change();
      resuming = true;
      await this.resume(tenant, generation);
    } catch (error) {
      const current = this.context.endpoint.placement.peek(tenant);
      if (
        !resuming &&
        current &&
        (current.placementEpoch !== source?.placementEpoch || current.runState === 'stopped')
      )
        // The change's own error is what the caller reports; a failed resume leaves the
        // reconciler's next pass to start the Session.
        await this.resume(tenant, generation).catch((resumeError) =>
          log.warn('admin.resume_failed', { tenant, err: resumeError }),
        );
      this.context.tenants.get(tenant).lastError = toRemoteKitError(error);
      this.services.viewers.push(tenant);
      throw error;
    }
  }
  async transfer(username: unknown, nodeId: unknown, bind: unknown) {
    if (
      typeof bind !== 'boolean' ||
      (bind && !nodeId) ||
      (nodeId !== undefined && (typeof nodeId !== 'string' || !nodeId))
    )
      throw new RemoteKitError('invalid_request', '目标节点或绑定状态无效');
    const user = this.find(username);
    await this.context.tenants.serial(user.tenant, async () => {
      const source = this.context.endpoint.placement.peek(user.tenant);
      if (source && source.nodeId === nodeId) {
        await this.context.endpoint.transfer(user.tenant, nodeId as string, bind);
        return;
      }
      await this.rebuildSession(user.tenant, () =>
        this.context.endpoint.transfer(user.tenant, nodeId as string | undefined, bind),
      );
    });
    return this.list();
  }
  async resetSession(username: unknown) {
    const user = this.find(username);
    await this.services.learning.retireTenant(user.tenant);
    await this.context.tenants.serial(user.tenant, async () => {
      await this.rebuildSession(user.tenant, async () => {
        const placement = this.context.endpoint.placement.peek(user.tenant);
        if (placement?.runState === 'running' || placement?.pendingCommit)
          await this.context.endpoint.stop(user.tenant, { force: true });
        this.services.learning.forgetTenantData(
          user.tenant,
          () => {
            this.context.store.clipboards.clear(user.id);
            this.context.store.coordination.deleteTenant(user.tenant);
            const sessionId = this.context.endpoint.placement.forgetTenant(user.tenant);
            if (sessionId) this.services.sessionPurge.enqueue(sessionId);
            const workspace = this.context.store.workspaces.workspace(user.tenant);
            for (const tab of workspace.tabs)
              if (!isLocalTab(tab)) {
                tab.residency = 'discarded';
                tab.restoring = false;
              }
            this.context.store.workspaces.saveWorkspace(workspace);
          },
          true,
        );
        this.context.endpoint.forget(user.tenant);
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
    await this.services.learning.forgetTenant(user.tenant);
    await this.context.tenants.serial(user.tenant, async () => {
      const store = this.context.store;
      const importMail = store.transaction(() => {
        const sessionId = this.context.endpoint.placement.deleteTenant(user.tenant);
        if (sessionId) this.services.sessionPurge.enqueue(sessionId);
        this.services.objects.forgetTenant(user.tenant);
        store.coordination.deleteTenant(user.tenant);
        store.library.deleteTenant(user.tenant);
        store.operations.deleteTenant(user.tenant);
        store.workspaces.deleteTenant(user.tenant);
        store.reclaim.deleteTenant(user.tenant);
        store.viewerGenerations.deleteTenant(user.tenant);
        store.announcements.deleteUser(user.id);
        store.clipboards.clear(user.id);
        const importMail = this.services.sessionImporter.deleteUser(user.tenant);
        store.accounts.deleteUser(user.id);
        return importMail;
      });
      this.services.sessionImporter.queueDeletedDevices(importMail);
      this.context.endpoint.forget(user.tenant);
    });
    this.context.tenants.dispose(user.tenant);
    void this.services.sessionPurge.flush();
    void this.services.objects
      .tick()
      .catch((err) => log.warn('admin.objects_failed', { tenant: user.tenant, err }));
    return { tenant: user.tenant, users: this.list() };
  }
}
