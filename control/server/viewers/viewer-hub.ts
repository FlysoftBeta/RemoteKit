import { reportError } from '../log';
import { RemoteKitError, wireError } from '../../shared/errors';
import { canonicalJson } from '../config';
import { log } from '../log';

import type { ProductState } from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import { type ViewerSecurityState } from '../auth/viewer-security';
import { QualityState } from '../quality';
import { WORKSPACE_LIMITS } from '../workspace/model';

export class ViewerHub {
  private readonly snapshots = new WeakMap<object, { content: string; state: ProductState }>();
  private readonly publications = new WeakMap<object, { state: ProductState; scope: string }>();
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'pageRequests' | 'policy' | 'reconciler' | 'rtc' | 'security' | 'learning'
    >,
  ) {}
  productState(tenant: string): ProductState {
    const runtime = this.context.tenants.get(tenant);
    const workspace = this.context.store.workspaces.workspace(tenant);
    const user = this.context.store.accounts.userForTenant(tenant);
    const state: ProductState = {
      operationReceipts: this.context.store.operations.recentOperations(tenant),
      serverIncarnation: this.context.serverIncarnation,
      snapshotSequence: runtime.snapshotSequence ?? 0,
      operationGeneration: this.context.store.operations.operationGeneration(tenant),
      user: user!,
      workspace,
      learning: this.services.learning.state(tenant),
      pageFullscreen: this.services.pageRequests.fullscreenBinding(workspace)?.page,
      pageDialogs: (runtime.pageRequests.dialogs ?? []).map(
        ({ viewId, requestId, browserIncarnation, instance, document, ...dialog }) => dialog,
      ),
      fileRequests: (runtime.pageRequests.files ?? []).map(({ binding, ...request }) => request),
      quality: this.services.policy.qualityFor(tenant, workspace),
      endpointGeneration: this.context.tenants.mediaGeneration(tenant),
      backgroundTasks: [...runtime.backgroundTasks.values()],
      endpointError: runtime.lastError
        ? wireError(reportError(runtime.lastError, 'viewer.endpoint_failed', { tenant }))
        : null,
      endpointActivity: runtime.lastErrorKey === 'stopping' ? 'saving-session' : undefined,
      endpointErrorKind: runtime.lastErrorKey === 'resource_limit' ? 'output-capacity' : 'runtime',
      browserRestart: runtime.browserRestart,
      viewer: {
        connected: runtime.viewer !== undefined,
      },
      announcements: user ? this.context.store.announcements.forUser(user.id) : [],
      integrations: { siteUa: true, lifecycle: true, popupAdoption: true },
    };
    const content = canonicalJson({ ...state, snapshotSequence: undefined });
    const previous = this.snapshots.get(runtime);
    if (previous?.content === content) return previous.state;
    state.snapshotSequence = runtime.snapshotSequence = (runtime.snapshotSequence ?? 0) + 1;
    this.snapshots.set(runtime, { content, state });
    return state;
  }
  push(tenant: string) {
    const runtime = this.context.tenants.get(tenant);
    const state = this.productState(tenant);
    const scope = JSON.stringify([
      runtime.viewer?.id,
      runtime.viewer?.security?.epoch,
      runtime.viewer?.security?.locked,
    ]);
    const previous = this.publications.get(runtime);
    if (previous?.state === state && previous.scope === scope) return;
    this.publications.set(runtime, { state, scope });
    this.context.events.emit('state', tenant, state);
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
    await this.services.security.retryRevocations();
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
      void this.services.security.revokePeer(tenant, old.security);
    }
    const user = this.context.store.accounts.userForTenant(tenant);
    if (!user)
      throw new RemoteKitError('unauthenticated', '账号不存在', { detail: 'Account does not exist' });
    const security = this.services.security.create(user, initialUnlocked);
    this.services.pageRequests.clearFullscreen(tenant);
    this.context.store.reclaim.attach(tenant);
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
      } catch (err) {
        log.warn('viewer.reconcile_failed', { tenant, err });
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
    this.context.store.reclaim.detach(tenant);
    delete runtime.viewer;
    runtime.viewerAbsentSince = this.context.clock.monotonicMs();
    delete runtime.pageRequests.fullscreen;
    if (viewer.security) {
      void this.services.security.revokePeer(tenant, viewer.security);
    }
    const previous = runtime.connectionId;
    if (previous) this.services.rtc.clearSignal(previous);
    return this.context.tenants.serial(tenant, async () => {
      // A replacement owns media now; an old close must not hide or close it.
      if (runtime.viewer !== undefined) return;
      await this.services.rtc.closeMedia(tenant);
      try {
        await this.services.reconciler.reconcileProduct(tenant);
      } catch (err) {
        log.warn('viewer.reconcile_failed', { tenant, err });
      }
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
        body.devicePixelRatio > 8 ||
        !Array.isArray(body.windows) ||
        body.windows.length > WORKSPACE_LIMITS.windows ||
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
          !Number.isInteger(w.occludedBottom) ||
          w.occludedBottom < 0 ||
          w.occludedBottom > w.height ||
          typeof w.occlusionRevision !== 'string' ||
          !/^[1-9]\d{0,19}$/.test(w.occlusionRevision) ||
          BigInt(w.occlusionRevision) > 0xffffffffffffffffn ||
          w.width < 1 ||
          w.height < 1 ||
          w.width > 8192 ||
          w.height > 8192
        )
          throw new RemoteKitError('invalid_request', '无效的窗口显示区域');
        ids.add(w.windowId);
      }
      const previous = runtime.viewer!.viewport;
      if (
        previous &&
        body.windows.some((w: any) => {
          const old = previous.windows.find((item) => item.windowId === w.windowId);
          return old && BigInt(w.occlusionRevision) < BigInt(old.occlusionRevision);
        })
      )
        return this.productState(tenant);
      // Preflight cannot mutate live observations or replace a valid viewport.
      const feasibility = new QualityState().snapshot(state, body);
      if (feasibility.resourceLimitation)
        throw new RemoteKitError('limit_exceeded', feasibility.resourceLimitation, { capacity: 'windows' });
      const viewport = {
        devicePixelRatio: body.devicePixelRatio,
        refreshHz: body.refreshHz,
        windows: body.windows.map((w: any) => ({
          windowId: w.windowId,
          width: w.width,
          height: w.height,
          occludedBottom: w.visible ? w.occludedBottom : 0,
          occlusionRevision: w.occlusionRevision,
          visible: w.visible,
        })),
      };
      if (canonicalJson(runtime.viewer!.viewport) === canonicalJson(viewport))
        return this.productState(tenant);
      runtime.viewer!.viewport = viewport;
      runtime.lastViewport = viewport;
      try {
        await this.services.reconciler.reconcileProduct(tenant);
      } catch (err) {
        log.warn('viewer.reconcile_failed', { tenant, err });
      }
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
          state.spaces.some(
            (space) => space.id === state.activeSpaceId && space.windowIds.includes(region.windowId),
          ),
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
