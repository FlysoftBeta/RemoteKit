import { RemoteKitError } from '../../shared/errors';

import type { ProductState } from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import { type ViewerSecurityState } from '../auth/viewer-security';
import { QualityState } from '../quality';

export class ViewerHub {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'pageRequests' | 'policy' | 'reconciler' | 'rtc' | 'security'
    >,
  ) {}
  productState(tenant: string): ProductState {
    const runtime = this.context.tenants.get(tenant);
    runtime.snapshotSequence = (runtime.snapshotSequence ?? 0) + 1;
    const workspace = this.context.store.workspaces.workspace(tenant);
    return {
      operationReceipts: this.context.store.operations.recentOperations(tenant),
      serverIncarnation: this.context.serverIncarnation,
      snapshotSequence: runtime.snapshotSequence!,
      operationGeneration: this.context.store.operations.operationGeneration(tenant),
      user: this.context.store.accounts.userForTenant(tenant)!,
      workspace,
      pageFullscreen: this.services.pageRequests.fullscreenBinding(workspace)?.page,
      pageDialogs: (runtime.pageRequests.dialogs ?? []).map(
        ({ viewId, requestId, browserIncarnation, instance, document, ...dialog }) => dialog,
      ),
      fileRequests: (runtime.pageRequests.files ?? []).map(({ binding, ...request }) => request),
      quality: this.services.policy.qualityFor(tenant, workspace),
      endpointGeneration: this.context.tenants.mediaGeneration(tenant),
      endpointError: runtime.lastError ?? null,
      viewer: {
        connected: runtime.viewer !== undefined,
      },
      integrations: { siteUa: true, lifecycle: true, popupAdoption: true },
      constraints: { clientScaleMin: 0.5, clientScaleMax: 4 },
    };
  }
  push(tenant: string) {
    this.context.events.emit('state', tenant, this.productState(tenant));
  }
  assertViewer(tenant: string, lease: string) {
    const viewer = this.context.tenants.get(tenant).viewer;
    if (viewer?.id !== lease) throw new RemoteKitError('conflict', '此窗口已由另一个 Viewer 接管');
    if (viewer.authentication && !viewer.authentication.valid())
      throw new RemoteKitError('unauthenticated', '登录已过期');
  }
  validSecurity(tenant: string, security: ViewerSecurityState) {
    const viewer = this.context.tenants.get(tenant).viewer;
    return viewer?.security === security && viewer.authentication?.valid() === true;
  }
  authState(tenant: string, security: ViewerSecurityState) {
    return this.services.security.state(security, this.context.tenants.mediaGeneration(tenant));
  }
  productEpoch(tenant: string, lease: string) {
    const runtime = this.context.tenants.get(tenant);
    return runtime.viewer?.id === lease ? runtime.viewer?.security?.epoch : undefined;
  }
  productAllowed(tenant: string, lease: string) {
    const viewer = this.context.tenants.get(tenant).viewer;
    return viewer?.id === lease && viewer.authentication.valid() && !viewer.security?.locked;
  }
  assertProductViewer(tenant: string, lease: string, epoch?: number) {
    this.assertViewer(tenant, lease);
    const security = this.context.tenants.get(tenant).viewer?.security;
    if (security?.locked || (epoch !== undefined && security?.epoch !== epoch))
      throw new RemoteKitError('locked', 'Viewer 已锁定');
  }
  async pollFaceAuth() {
    await Promise.all(
      this.context.tenants
        .withViewers()
        .map(([tenant, viewer]) => viewer.security && this.services.security.poll(tenant, viewer.security)),
    );
  }
  async attachViewer(
    tenant: string,
    id: string,
    revoke: (reason: 'another-viewer' | 'logout') => void,
    authentication: { identity: string; valid: () => boolean },
    initialUnlocked = false,
  ) {
    const runtime = this.context.tenants.get(tenant);
    this.services.policy.qualityState(tenant).resetFeedback();
    const old = runtime.viewer;
    if (old?.security) {
      void this.services.security.lock(tenant, old.security).catch(() => {});
      this.services.security.forgetPeer(tenant, old.security);
    }
    const user = this.context.store.accounts.userForTenant(tenant);
    if (!user) throw new RemoteKitError('unauthenticated', 'Account does not exist');
    const security = this.services.security.create(user, initialUnlocked);
    this.services.pageRequests.clearFullscreen(tenant);
    runtime.viewer = { id, revoke, authentication, security };
    old?.revoke('another-viewer');
    this.context.events.emit('auth', tenant, id, this.authState(tenant, security));
    const previous = runtime.connectionId;
    if (previous) this.services.rtc.clearSignal(previous);
    return this.context.tenants.serial(tenant, async () => {
      this.assertViewer(tenant, id);
      await this.services.rtc.closeMedia(tenant);
      try {
        await this.services.reconciler.reconcileProduct(tenant);
      } catch {
        /* State carries Endpoint error; controls still work offline. */
      }
      void this.services.security.capabilities(tenant, security);
      this.push(tenant);
      return security.locked ? undefined : this.productState(tenant);
    });
  }
  async detachViewer(tenant: string, id: string) {
    const runtime = this.context.tenants.get(tenant);
    const viewer = runtime.viewer;
    if (viewer?.id !== id) return;
    delete runtime.viewer;
    runtime.viewerAbsentSince = this.context.clock.monotonicMs();
    delete runtime.pageRequests.fullscreen;
    if (viewer.security) {
      void this.services.security.lock(tenant, viewer.security).catch(() => {});
      this.services.security.forgetPeer(tenant, viewer.security);
    }
    const previous = runtime.connectionId;
    if (previous) this.services.rtc.clearSignal(previous);
    return this.context.tenants.serial(tenant, async () => {
      // A replacement owns media now; an old close must not hide or close it.
      if (runtime.viewer !== undefined) return;
      await this.services.rtc.closeMedia(tenant);
      try {
        await this.services.reconciler.reconcileProduct(tenant);
      } catch {}
      this.push(tenant);
    });
  }
  async logout(tenant: string, authenticationIdentity: string) {
    const viewer = this.context.tenants.get(tenant).viewer;
    if (viewer?.authentication?.identity === authenticationIdentity) {
      viewer.revoke('logout');
      await this.detachViewer(tenant, viewer.id);
    }
  }
  viewport(tenant: string, body: any, lease: string, epoch?: number) {
    const runtime = this.context.tenants.get(tenant);
    return this.context.tenants.serial(tenant, async () => {
      this.assertProductViewer(tenant, lease, epoch);
      const state = this.context.store.workspaces.workspace(tenant);
      if (
        typeof body.devicePixelRatio !== 'number' ||
        !Number.isFinite(body.devicePixelRatio) ||
        body.devicePixelRatio < 0.5 ||
        body.devicePixelRatio > 4 ||
        !Array.isArray(body.windows) ||
        body.windows.length > 8 ||
        (body.refreshHz !== undefined &&
          (!Number.isFinite(body.refreshHz) || body.refreshHz < 1 || body.refreshHz > 500))
      )
        throw new RemoteKitError('invalid_request', '无效的显示区域');
      const ids = new Set<string>();
      for (const w of body.windows) {
        if (
          !w ||
          ids.has(w.windowId) ||
          !state.windows.some((item) => item.id === w.windowId) ||
          typeof w.visible !== 'boolean' ||
          !Number.isInteger(w.width) ||
          !Number.isInteger(w.height) ||
          w.width < 1 ||
          w.height < 1 ||
          w.width > 8192 ||
          w.height > 8192
        )
          throw new RemoteKitError('invalid_request', '无效的窗口显示区域');
        ids.add(w.windowId);
      }
      // Preflight cannot mutate live observations or replace a valid viewport.
      const feasibility = new QualityState().snapshot(state, body);
      if (feasibility.resourceLimitation)
        throw new RemoteKitError('limit_exceeded', feasibility.resourceLimitation);
      runtime.viewer!.viewport = {
        devicePixelRatio: body.devicePixelRatio,
        refreshHz: body.refreshHz,
        windows: body.windows.map((w: any) => ({
          windowId: w.windowId,
          width: w.width,
          height: w.height,
          visible: w.visible,
        })),
      };
      runtime.lastViewport = runtime.viewer!.viewport!;
      try {
        await this.services.reconciler.reconcileProduct(tenant);
      } catch {}
      this.push(tenant);
      return this.productState(tenant);
    });
  }
  feedback(authority: ViewerAuthority, params: unknown) {
    const { tenantId: tenant, leaseId, epoch } = authority;
    return this.context.tenants.serial(tenant, async () => {
      this.assertProductViewer(tenant, leaseId, epoch);
      const runtime = this.context.tenants.get(tenant);
      const state = this.context.store.workspaces.workspace(tenant),
        viewport = runtime.viewer?.viewport;
      const visible = !!viewport?.windows.some(
        (region) =>
          region.visible &&
          state.windows.some(
            (window) =>
              window.id === region.windowId &&
              !!window.activeTabId &&
              !state.tabs.some((tab) => tab.id === window.activeTabId && isLocalTab(tab)),
          ) &&
          (state.layoutMode !== 'focused' || region.windowId === state.activeWindowId),
      );
      const accepted = this.services.policy
        .qualityState(tenant)
        .observe(params, this.context.clock.wallMs(), visible);
      this.push(tenant);
      return { accepted };
    });
  }
}

export interface ViewerAuthority {
  tenantId: string;
  leaseId: string;
  epoch: number;
  connectionId?: string;
}
