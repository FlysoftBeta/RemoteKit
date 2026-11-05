import { RemoteKitError, toRemoteKitError } from '../shared/errors';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TenantRegistry } from './tenants/tenant-registry';
import type { FullscreenBinding } from './tenants/tenant-runtime';
import { systemClock, type Clock } from './util/clock';
import type {
  ProductOperation,
  OperationReceipt,
  ProductAction,
  ProductActionResult,
  ProductState,
  ProductWorkspace,
  ProductTab,
  ViewerViewport,
  PageDialog,
  PageFullscreen,
  FileRequestAnchor,
  AppliedMediaPolicy,
  PendingClose,
} from '../shared/product';
import { resolveNavigation } from './navigation';
import { SEARCH_ENGINES, FILE_LIMITS, isLocalTab } from '../shared/product';
import { FileLibrary } from './file-library';
import { QualityState } from './quality';
import { type InternalFileRequest, type FileLimits } from './file-requests';
import type { EndpointGateway } from './endpoint/gateway';
import type { RtcSignal } from './endpoint/types';
import { ControlDatabase } from './persistence/database';
import { ViewerAuth, type ViewerSecurity } from './viewer-auth';
function operationPayload(value: unknown): string {
  const canonical = (input: any): any =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, canonical(input[key])]),
          )
        : input;
  return JSON.stringify(canonical(value));
}
function fileRequestAnchor(value: any, instance: string, document: string): FileRequestAnchor | undefined {
  if (
    !value ||
    value.instance !== instance ||
    value.document !== document ||
    typeof value.layoutGeneration !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value.layoutGeneration)
  )
    return;
  const { x, y, width, height, viewportWidth, viewportHeight, deviceScaleFactor, layoutGeneration } = value;
  if (
    ![x, y, width, height, viewportWidth, viewportHeight, deviceScaleFactor].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    deviceScaleFactor <= 0 ||
    x + width > viewportWidth + 0.001 ||
    y + height > viewportHeight + 0.001
  )
    return;
  return {
    x,
    y,
    width,
    height,
    viewportWidth,
    viewportHeight,
    deviceScaleFactor,
    instance,
    document,
    layoutGeneration,
  };
}

export class Control extends EventEmitter {
  private unsubscribeSignals?: () => void;
  private unsubscribeActions?: () => void;
  private closed = false;
  private readonly serverIncarnation = randomUUID();
  private ticking = false;
  private endpointGeneration = 0;
  private mediaGeneration(tenant: string) {
    return this.tenants.get(tenant).mediaGeneration ?? this.endpointGeneration;
  }
  private readonly viewerAuth: ViewerAuth;
  private readonly library: FileLibrary;
  private readonly tenants: TenantRegistry;
  constructor(
    readonly store: ControlDatabase,
    readonly endpoint: EndpointGateway,
    private readonly fileLimits: FileLimits = FILE_LIMITS,
    private readonly clock: Clock = systemClock,
  ) {
    super();
    this.tenants = new TenantRegistry(clock);
    this.unsubscribeActions = endpoint.onClientAction?.((event) => {
      void this.handleEndpointAction(event).catch(() => {});
    });
    this.unsubscribeSignals = endpoint.onSignal?.((event) => this.receiveSignal(event));
    this.viewerAuth = new ViewerAuth(
      store,
      endpoint,
      (tenant, viewer, workspace) => {
        const lease = this.tenants.get(tenant).viewer?.id;
        if (!lease || !this.validSecurity(tenant, viewer)) return;
        this.emit('auth', tenant, lease, this.authState(tenant, viewer));
        if (workspace) {
          this.push(tenant);
          this.authorizeFiles(tenant);
          void this.serial(tenant, () => this.reconcileProduct(tenant)).catch(() => {});
        }
      },
      (tenant, viewer) => this.validSecurity(tenant, viewer),
      (tenant, viewer) => {
        const lease = this.tenants.get(tenant).viewer?.id;
        if (!lease || !this.validSecurity(tenant, viewer)) return;
        delete this.tenants.get(tenant).pageRequests.authorization;
        if (viewer.locked) delete this.tenants.get(tenant).pageRequests.fullscreen;
        this.qualityState(tenant).resetFeedback();
        void this.serial(tenant, async () => {
          if (!this.validSecurity(tenant, viewer)) return;
          if (!viewer.locked) {
            delete this.tenants.get(tenant).pageRequests.authorization;
            this.authorizeFiles(tenant);
          }
          if (viewer.locked) await this.reconcileProduct(tenant);
        }).catch(() => {});
      },
      clock,
    );
    this.library = new FileLibrary(store.library, endpoint, fileLimits);
  }
  private receiveSignal(event: RtcSignal) {
    const binding = this.tenants.forConnection(event.connectionId)?.rtc.signal;
    if (
      !binding ||
      binding.tenant !== event.tenantId ||
      this.tenants.get(event.tenantId).connectionId !== event.connectionId
    )
      return;
    try {
      this.assertViewer(binding.tenant, binding.lease);
    } catch {
      this.clearSignal(event.connectionId);
      return;
    }
    if (event.signal.type === 'answer') {
      binding.answered = true;
      clearTimeout(binding.timer);
      binding.resolve(event.signal.sdp);
    } else if (event.signal.type === 'error' && !binding.answered)
      binding.reject(new RemoteKitError('rejected', event.signal.message));
    else
      this.emit('rtc.signal', event.tenantId, binding.lease, {
        type: 'rtc.signal',
        connectionId: event.connectionId,
        attemptId: binding.attemptId,
        signal: event.signal,
      });
  }
  private clearSignal(connectionId: string) {
    this.tenants.forConnection(connectionId)?.clearSignal();
  }
  serial<T>(tenant: string, work: () => Promise<T>): Promise<T> {
    return this.tenants.serial(tenant, work);
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await Promise.all(
        this.tenants.activeTenants().map((tenant) =>
          this.serial(tenant, async () => {
            if (this.tenants.get(tenant).pendingRtcCheck) await this.checkReconnectedRtc(tenant);
            await this.reconcileProduct(tenant);
          }).catch(() => {}),
        ),
      );
    } finally {
      this.ticking = false;
    }
  }
  async close() {
    this.closed = true;
    this.unsubscribeActions?.();
    this.unsubscribeActions = undefined;
    this.unsubscribeSignals?.();
    this.unsubscribeSignals = undefined;
    await this.tenants.close();
    this.clearSignals();
  }
  clearSignals() {
    for (const id of this.tenants
      .values()
      .flatMap((runtime) => (runtime.connectionId ? [runtime.connectionId] : [])))
      this.clearSignal(id);
  }
  private async checkReconnectedRtc(tenant: string) {
    const snapshot = await this.endpoint.snapshot(tenant);
    const runtime = this.tenants.get(tenant);
    const connectionId = runtime.connectionId ?? runtime.rtc.disconnectedPeer?.connectionId;
    if (connectionId && (snapshot?.rtc?.active !== true || snapshot.rtc.connectionId !== connectionId)) {
      this.clearSignal(connectionId);
      this.tenants.get(tenant).closeRtc();
      const security = this.tenants.get(tenant).viewer?.security;
      if (security) this.viewerAuth.forgetPeer(tenant, security);
      this.tenants.get(tenant).mediaGeneration = this.mediaGeneration(tenant) + 1;
      const lease = this.tenants.get(tenant).viewer?.id;
      if (security && lease) this.emit('auth', tenant, lease, this.authState(tenant, security));
      this.push(tenant);
      // A mismatching peer is not authorized by the surviving Viewer lease.
      if (snapshot?.rtc?.active === true && typeof snapshot.rtc.connectionId === 'string')
        await this.endpoint.closeRtc(tenant, { connectionId: snapshot.rtc.connectionId });
    }
    const disconnected = runtime.rtc.disconnectedPeer;
    if (
      disconnected &&
      snapshot.rtc?.active &&
      snapshot.rtc.connectionId === disconnected.connectionId &&
      runtime.viewer?.id === disconnected.leaseId
    )
      runtime.activateRtc(disconnected.connectionId, disconnected.leaseId);
    runtime.rtc.disconnectedPeer = undefined;
    const security = this.tenants.get(tenant).viewer?.security;
    if (security) await this.viewerAuth.restore(tenant, security);
    this.tenants.get(tenant).pendingRtcCheck = false;
  }
  async endpointReady(identity?: { processChanged: boolean }) {
    // Stdio ready means a new child; only authenticated remote hello can prove
    // that a replacement management socket still belongs to the same process.
    if (identity?.processChanged !== false) return this.reconcileAll();
    this.tenants.values().forEach((runtime) => {
      delete runtime.pageRequests.authorization;
    });
    this.tenants.values().forEach((runtime) => runtime.policy.configurations.clear());
    this.tenants.values().forEach((runtime) => {
      delete runtime.policy.site;
    });
    this.tenants.values().forEach((runtime) => {
      delete runtime.policy.media;
    });
    for (const tenant of this.tenants
      .values()
      .filter((runtime) => runtime.connectionId || runtime.rtc.disconnectedPeer)
      .map((runtime) => runtime.tenantId))
      this.tenants.get(tenant).pendingRtcCheck = true;
    for (const tenant of new Set([
      ...this.tenants
        .values()
        .filter((runtime) => runtime.viewer !== undefined)
        .map((runtime) => runtime.tenantId),
      ...this.tenants
        .values()
        .filter((runtime) => runtime.started)
        .map((runtime) => runtime.tenantId),
    ])) {
      await this.serial(tenant, async () => {
        try {
          await this.checkReconnectedRtc(tenant);
          await this.reconcileProduct(tenant);
        } catch (error) {
          this.tenants.get(tenant).lastError = toRemoteKitError(error).message;
        }
        this.push(tenant);
      });
    }
  }
  async reconcileAll() {
    this.endpointGeneration =
      Math.max(
        this.endpointGeneration,
        ...this.tenants
          .values()
          .flatMap((runtime) => (runtime.mediaGeneration === undefined ? [] : [runtime.mediaGeneration])),
      ) + 1;
    for (const runtime of this.tenants.values()) {
      if (runtime.viewer) this.viewerAuth.forgetPeer(runtime.tenantId, runtime.viewer.security);
      runtime.resetEndpoint();
    }
    for (const tenant of new Set([
      ...this.tenants
        .values()
        .filter((runtime) => runtime.viewer !== undefined)
        .map((runtime) => runtime.tenantId),
    ]))
      await this.serial(tenant, async () => {
        const viewer = this.tenants.get(tenant).viewer;
        if (viewer?.security) {
          this.emit('auth', tenant, viewer.id, this.authState(tenant, viewer.security));
          void this.viewerAuth.capabilities(tenant, viewer.security);
        }
        await this.reconcileProduct(tenant);
        this.push(tenant);
      }).catch(() => {});
  }
  async offer(tenant: string, body: any, lease: string) {
    const runtime = this.tenants.get(tenant);
    if (
      body.type !== 'offer' ||
      typeof body.sdp !== 'string' ||
      body.sdp.length > 900000 ||
      !body.sdp.startsWith('v=0')
    )
      throw new RemoteKitError('invalid_request', '无效的 SDP offer');
    const receivedAt = this.clock.monotonicMs();
    return this.serial(tenant, async () => {
      const timings: Record<string, number> = { queueMs: this.clock.monotonicMs() - receivedAt };
      this.assertViewer(tenant, lease);
      this.qualityState(tenant).resetFeedback();
      await this.reconcileProduct(tenant);
      timings.reconcileEndMs = this.clock.monotonicMs() - receivedAt;
      const security = runtime.viewer!.security;
      const previous = runtime.connectionId;
      if (previous) {
        this.clearSignal(previous);
        try {
          await this.endpoint.closeRtc(tenant, { connectionId: previous });
        } finally {
          runtime.closeRtc();
        }
      }
      this.viewerAuth.forgetPeer(tenant, security);
      const connectionId = randomUUID();
      try {
        if (typeof body.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.attemptId))
          throw new RemoteKitError('invalid_request', '无效媒体连接尝试');
        runtime.beginRtc(connectionId, body.attemptId, lease);
        let resolve!: (sdp: string) => void, reject!: (error: Error) => void;
        const pending = new Promise<string>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        // Observe rejection immediately, including cancellation while the acceptance RPC is pending.
        void pending.catch(() => {});
        const timer = setTimeout(
          () => reject(new RemoteKitError('outcome_unknown', 'RTC answer 等待超时')),
          15000,
        );
        runtime.rtc.signal = {
          tenant,
          lease: lease,
          attemptId: body.attemptId,
          resolve,
          reject,
          timer,
          answered: false,
        };
        const accepted = await this.endpoint.offer(tenant, {
          connectionId,
          sdp: body.sdp,
          trickle: true,
          authRequired: true,
        });
        timings.endpointAcceptedMs = this.clock.monotonicMs() - receivedAt;
        if (accepted?.accepted !== true || accepted.connectionId !== connectionId)
          throw new RemoteKitError('rejected', 'Endpoint未接受媒体协商');
        const answer = { sdp: await pending };
        timings.answerReadyMs = this.clock.monotonicMs() - receivedAt;
        this.assertViewer(tenant, lease);

        if (typeof answer?.sdp !== 'string' || !answer.sdp.startsWith('v=0'))
          throw new RemoteKitError('rejected', 'Endpoint 未返回有效 answer');
        runtime.beginRtc(connectionId, body.attemptId, lease);
        await this.viewerAuth.bind(tenant, security, connectionId);
        this.assertViewer(tenant, lease);
        runtime.activateRtc(connectionId, lease);
        delete runtime.pageRequests.authorization;
        this.authorizeFiles(tenant);
        return {
          type: 'answer',
          sdp: answer.sdp,
          connectionId,
          endpointGeneration: this.mediaGeneration(tenant),
          negotiationTiming: timings,
          signalingMode: 'trickle',
        };
      } catch (error) {
        this.viewerAuth.forgetPeer(tenant, security);
        this.clearSignal(connectionId);
        if (runtime.connectionId === connectionId) runtime.closeRtc();
        await this.endpoint.closeRtc(tenant, { connectionId }).catch(() => {});
        throw error;
      }
    });
  }
  async ice(tenant: string, body: any) {
    if (!body.connectionId || this.tenants.get(tenant).connectionId !== body.connectionId)
      throw new RemoteKitError('forbidden', '连接不属于当前会话');
    const binding = this.tenants.forConnection(body.connectionId)?.rtc.signal;
    if (binding && body.attemptId !== binding.attemptId)
      throw new RemoteKitError('forbidden', '媒体连接尝试已失效');
    if (
      !body.candidate ||
      typeof body.candidate.candidate !== 'string' ||
      body.candidate.candidate.length > 16384 ||
      typeof body.candidate.sdpMid !== 'string' ||
      !Number.isInteger(body.candidate.sdpMLineIndex)
    )
      throw new RemoteKitError('invalid_request', '无效 ICE candidate');
    return this.endpoint.ice(tenant, {
      connectionId: body.connectionId,
      candidate: body.candidate,
    });
  }
  async closeRtc(tenant: string, body: any, lease: string) {
    const runtime = this.tenants.get(tenant);
    this.assertViewer(tenant, lease);
    const owned = runtime.connectionId === body.connectionId;
    if (owned) this.clearSignal(body.connectionId);
    return this.serial(tenant, async () => {
      this.assertViewer(tenant, lease);
      if (runtime.connectionId !== body.connectionId) {
        if (owned) return { closed: true };
        throw new RemoteKitError('forbidden', '连接不属于当前会话');
      }
      this.clearSignal(body.connectionId);
      const security = runtime.viewer?.security;
      if (security) {
        this.viewerAuth.forgetPeer(tenant, security);
        this.emit('auth', tenant, lease, this.authState(tenant, security));
        void this.viewerAuth.capabilities(tenant, security);
      }
      try {
        await this.endpoint.closeRtc(tenant, { connectionId: body.connectionId });
      } finally {
        runtime.closeRtc();
      }
      return { closed: true };
    });
  }
  productState(tenant: string): ProductState {
    const runtime = this.tenants.get(tenant);
    runtime.snapshotSequence = (runtime.snapshotSequence ?? 0) + 1;
    const workspace = this.store.workspaces.workspace(tenant);
    return {
      operationReceipts: this.store.operations.recentOperations(tenant),
      serverIncarnation: this.serverIncarnation,
      snapshotSequence: runtime.snapshotSequence!,
      operationGeneration: this.store.operations.operationGeneration(tenant),
      user: this.store.accounts.userForTenant(tenant)!,
      workspace,
      pageFullscreen: this.fullscreenBinding(workspace)?.page,
      pageDialogs: (runtime.pageRequests.dialogs ?? []).map(
        ({ viewId, requestId, browserIncarnation, instance, document, ...dialog }) => dialog,
      ),
      fileRequests: (runtime.pageRequests.files ?? []).map(({ binding, ...request }) => request),
      quality: this.qualityFor(tenant, workspace),
      endpointGeneration: this.mediaGeneration(tenant),
      endpointError: runtime.lastError ?? null,
      viewer: {
        connected: runtime.viewer !== undefined,
      },
      integrations: { siteUa: true, lifecycle: true, popupAdoption: true },
      constraints: { clientScaleMin: 0.5, clientScaleMax: 4 },
    };
  }
  private fullscreenTabs(workspace: ProductWorkspace) {
    return workspace.tabs.filter(
      (tab) =>
        !isLocalTab(tab) &&
        workspace.windows.some((window) => window.id === tab.windowId && window.activeTabId === tab.id) &&
        (workspace.layoutMode !== 'focused' || tab.windowId === workspace.activeWindowId),
    );
  }
  private fullscreenBinding(workspace: ProductWorkspace) {
    const viewer = this.tenants.get(workspace.tenantId).viewer,
      binding = this.tenants.get(workspace.tenantId).pageRequests.fullscreen;
    if (
      viewer &&
      !viewer.security?.locked &&
      binding &&
      this.fullscreenTabs(workspace).some(
        (tab) =>
          tab.id === binding.page.tabId &&
          tab.webviewId === binding.viewId &&
          tab.windowId === binding.page.windowId,
      )
    )
      return binding;
  }
  private observeFullscreen(workspace: ProductWorkspace, snapshot: any, views: any[]) {
    const tenant = workspace.tenantId,
      viewer = this.tenants.get(tenant).viewer,
      previous = this.tenants.get(tenant).pageRequests.fullscreen;
    const browserIncarnation = snapshot.browserIncarnation;
    let next: FullscreenBinding | undefined;
    if (
      viewer &&
      !viewer.security?.locked &&
      snapshot.running !== false &&
      typeof browserIncarnation === 'string' &&
      browserIncarnation
    ) {
      const tabs = this.fullscreenTabs(workspace).sort((a, b) => {
        const priority = (tab: ProductTab) =>
          tab.id === previous?.page.tabId ? 2 : Number(tab.windowId === workspace.activeWindowId);
        return priority(b) - priority(a);
      });
      for (const tab of tabs) {
        const view = views.find((view) => view.viewId === tab.webviewId);
        if (
          view?.fullscreen !== true ||
          view.close_state === 'closed' ||
          (view.visible !== true &&
            tab.windowId !== workspace.activeWindowId &&
            tab.id !== previous?.page.tabId) ||
          ![view.instance, view.document].every(
            (id) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id),
          )
        )
          continue;
        const { instance, document } = view;
        const target = createHash('sha256')
          .update(JSON.stringify([browserIncarnation, tab.webviewId, instance, document]))
          .digest('hex');
        next = {
          page: { tabId: tab.id, windowId: tab.windowId, target },
          viewId: tab.webviewId,
          browserIncarnation,
          instance,
          document,
        };
        break;
      }
    }
    if (next) this.tenants.get(tenant).pageRequests.fullscreen = next;
    else delete this.tenants.get(tenant).pageRequests.fullscreen;
    return next?.page.target !== previous?.page.target || next?.page.windowId !== previous?.page.windowId;
  }
  private push(tenant: string) {
    this.emit('state', tenant, this.productState(tenant));
  }
  private saveProduct(state: ProductWorkspace) {
    const operation = this.tenants.get(state.tenantId).applyingOperation;
    if (operation) {
      this.store.operations.saveOperation(state, operation);
      this.push(state.tenantId);
    } else {
      const changed = this.store.workspaces.saveWorkspace(state);
      if (changed) this.push(state.tenantId);
    }
  }
  assertViewer(tenant: string, lease: string) {
    const viewer = this.tenants.get(tenant).viewer;
    if (viewer?.id !== lease) throw new RemoteKitError('conflict', '此窗口已由另一个 Viewer 接管');
    if (viewer.authentication && !viewer.authentication.valid())
      throw new RemoteKitError('unauthenticated', '登录已过期');
  }
  private validSecurity(tenant: string, security: ViewerSecurity) {
    const viewer = this.tenants.get(tenant).viewer;
    return viewer?.security === security && viewer.authentication?.valid() === true;
  }
  private authState(tenant: string, security: ViewerSecurity) {
    return this.viewerAuth.state(security, this.mediaGeneration(tenant));
  }
  productEpoch(tenant: string, lease: string) {
    const runtime = this.tenants.get(tenant);
    return runtime.viewer?.id === lease ? runtime.viewer?.security?.epoch : undefined;
  }
  productAllowed(tenant: string, lease: string) {
    const viewer = this.tenants.get(tenant).viewer;
    return viewer?.id === lease && viewer.authentication.valid() && !viewer.security?.locked;
  }
  private assertProductViewer(tenant: string, lease: string, epoch?: number) {
    this.assertViewer(tenant, lease);
    const security = this.tenants.get(tenant).viewer?.security;
    if (security?.locked || (epoch !== undefined && security?.epoch !== epoch))
      throw new RemoteKitError('locked', 'Viewer 已锁定');
  }
  async pollFaceAuth() {
    await Promise.all(
      this.tenants
        .withViewers()
        .map(([tenant, viewer]) => viewer.security && this.viewerAuth.poll(tenant, viewer.security)),
    );
  }
  endpointOffline() {
    for (const runtime of this.tenants.values()) runtime.disconnectRtc();
    for (const [tenant, viewer] of this.tenants.withViewers())
      if (viewer.security) {
        viewer.security.face = { available: false };
        void this.viewerAuth.lock(tenant, viewer.security, false, false);
      }
  }
  async attachViewer(
    tenant: string,
    id: string,
    revoke: (reason: 'another-viewer' | 'logout') => void,
    authentication: { identity: string; valid: () => boolean },
    initialUnlocked = false,
  ) {
    const runtime = this.tenants.get(tenant);
    this.qualityState(tenant).resetFeedback();
    const old = runtime.viewer;
    if (old?.security) {
      void this.viewerAuth.lock(tenant, old.security).catch(() => {});
      this.viewerAuth.forgetPeer(tenant, old.security);
    }
    const user = this.store.accounts.userForTenant(tenant);
    if (!user) throw new RemoteKitError('unauthenticated', 'Account does not exist');
    const security = this.viewerAuth.create(user, initialUnlocked);
    delete runtime.pageRequests.fullscreen;
    runtime.viewer = { id, revoke, authentication, security };
    old?.revoke('another-viewer');
    this.emit('auth', tenant, id, this.authState(tenant, security));
    const previous = runtime.connectionId;
    if (previous) this.clearSignal(previous);
    return this.serial(tenant, async () => {
      this.assertViewer(tenant, id);
      await this.closeMedia(tenant);
      try {
        await this.reconcileProduct(tenant);
      } catch {
        /* State carries Endpoint error; controls still work offline. */
      }
      void this.viewerAuth.capabilities(tenant, security);
      this.push(tenant);
      return security.locked ? undefined : this.productState(tenant);
    });
  }
  async detachViewer(tenant: string, id: string) {
    const runtime = this.tenants.get(tenant);
    const viewer = runtime.viewer;
    if (viewer?.id !== id) return;
    delete runtime.viewer;
    delete runtime.pageRequests.fullscreen;
    if (viewer.security) {
      void this.viewerAuth.lock(tenant, viewer.security).catch(() => {});
      this.viewerAuth.forgetPeer(tenant, viewer.security);
    }
    const previous = runtime.connectionId;
    if (previous) this.clearSignal(previous);
    return this.serial(tenant, async () => {
      // A replacement owns media now; an old close must not hide or close it.
      if (runtime.viewer !== undefined) return;
      await this.closeMedia(tenant);
      try {
        await this.reconcileProduct(tenant);
      } catch {}
      this.push(tenant);
    });
  }
  async logout(tenant: string, authenticationIdentity: string) {
    const viewer = this.tenants.get(tenant).viewer;
    if (viewer?.authentication?.identity === authenticationIdentity) {
      viewer.revoke('logout');
      await this.detachViewer(tenant, viewer.id);
    }
  }
  private async closeMedia(tenant: string) {
    const runtime = this.tenants.get(tenant);
    const previous = runtime.connectionId;
    if (!previous) return;
    this.clearSignal(previous);
    try {
      await this.endpoint.closeRtc(tenant, { connectionId: previous });
    } catch {
    } finally {
      runtime.closeRtc();
    }
  }
  async viewerRequest(tenant: string, lease: string, method: string, params: any): Promise<any> {
    const runtime = this.tenants.get(tenant);
    this.assertViewer(tenant, lease);
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw new RemoteKitError('invalid_request', '需要参数对象');
    if (['tenantId', 'tenant', 'userId', 'user'].some((key) => key in params))
      throw new RemoteKitError('invalid_request', '客户端不能指定用户或租户');
    const security = runtime.viewer?.security;
    if (method.startsWith('auth.')) {
      if (!security) throw new RemoteKitError('invalid_request', '当前会话不支持锁屏');
      try {
        await this.viewerAuth.request(tenant, security, method, params);
        this.assertViewer(tenant, lease);
        return this.authState(tenant, security);
      } catch (error) {
        throw error;
      }
    }
    if (method === 'clock.ping')
      return {
        serverTime: this.clock.wallMs(),
        ...(typeof params.clientTime === 'number' ? { clientTime: params.clientTime } : {}),
      };
    if (method === 'rtc.offer') return this.offer(tenant, params, lease);
    if (method === 'rtc.close') return this.closeRtc(tenant, params, lease);
    // Candidate delivery must not queue behind an offer waiting for its answer.
    if (method === 'rtc.ice') return this.ice(tenant, params);
    const epoch = security?.epoch;
    this.assertProductViewer(tenant, lease, epoch);
    if (method === 'admin.get' || method === 'admin.setRegistrationCredential') {
      const authorize = () => {
        this.assertProductViewer(tenant, lease, epoch);
        if (!this.store.accounts.userForTenant(tenant)?.isAdmin)
          throw new RemoteKitError('forbidden', '需要管理员权限');
      };
      authorize();
      if (method === 'admin.get') return this.store.accounts.adminStatus();
      try {
        return await this.store.accounts.setRegistrationCredential(
          tenant,
          params.serverCredential,
          authorize,
        );
      } catch (error) {
        throw toRemoteKitError(error);
      }
    }
    if (method.startsWith('library.')) {
      try {
        return await this.library.request(
          tenant,
          method,
          params,
          () => this.assertProductViewer(tenant, lease, epoch),
          (id) => runtime.pageRequests.files?.find((request) => request.id === id),
        );
      } catch (error) {
        throw error;
      }
    }
    if (method === 'operation.status') return this.operationStatus(tenant, params);
    // Browser actions belong to the reliable Endpoint DataChannel.
    if (method === 'action' && params.type === 'settings.update')
      return this.productAction(tenant, params, lease);
    if (method === 'action') throw new RemoteKitError('invalid_request', '产品操作必须通过WebRTC数据通道');
    if (method === 'viewport') return this.viewport(tenant, params, lease, epoch);
    return this.serial(tenant, async () => {
      this.assertProductViewer(tenant, lease, epoch);
      if (method === 'feedback') {
        const state = this.store.workspaces.workspace(tenant),
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
        const accepted = this.qualityState(tenant).observe(params, this.clock.wallMs(), visible);
        this.push(tenant);
        return { accepted };
      }
      throw new RemoteKitError('invalid_request', '未知 WebSocket 方法');
    });
  }
  private viewport(tenant: string, body: any, lease: string, epoch?: number) {
    const runtime = this.tenants.get(tenant);
    return this.serial(tenant, async () => {
      this.assertProductViewer(tenant, lease, epoch);
      const state = this.store.workspaces.workspace(tenant);
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
        await this.reconcileProduct(tenant);
      } catch {}
      this.push(tenant);
      return this.productState(tenant);
    });
  }
  operationStatus(
    tenant: string,
    operation: { operationId: string; operationGeneration: string },
  ): OperationReceipt {
    if (operation.operationGeneration !== this.store.operations.operationGeneration(tenant))
      return { ...operation, status: 'expired', error: '操作收据代次已过期，请核对当前工作区' };
    return (
      this.store.operations.operation(tenant, operation.operationId)?.receipt ?? {
        ...operation,
        status: 'unknown',
        error: '尚无操作收据',
      }
    );
  }
  async handleEndpointAction(
    event: ProductOperation & { tenantId: string; connectionId: string; authEpoch?: number },
  ) {
    if (this.closed) return;
    const { tenantId: tenant, connectionId } = event,
      lease = this.tenants.forConnection(connectionId)?.connectionLease;
    if (!lease || this.tenants.get(tenant).connectionId !== connectionId) return;
    const security = this.tenants.get(tenant).viewer?.security;
    if (
      security &&
      (!this.productAllowed(tenant, lease) ||
        !event.authEpoch ||
        event.authEpoch !== security.peer?.appliedEpoch)
    )
      return;
    let receipt: OperationReceipt;
    try {
      receipt = await this.submitOperation(tenant, event, lease, connectionId);
    } catch (error) {
      receipt = {
        operationId: event.operationId,
        operationGeneration: event.operationGeneration,
        status: 'rejected',
        error: toRemoteKitError(error).message,
      };
    }
    // A replaced peer never receives a late result from an accepted old operation.
    if (
      this.tenants.get(tenant).connectionId !== connectionId ||
      !this.productAllowed(tenant, lease) ||
      (security && event.authEpoch !== security.peer?.appliedEpoch)
    )
      return;
    await this.endpoint
      .actionResult(tenant, {
        connectionId,
        ...(event.authEpoch !== undefined ? { authEpoch: event.authEpoch } : {}),
        operationId: event.operationId,
        operationGeneration: event.operationGeneration,
        ok: !['rejected', 'expired'].includes(receipt.status),
        result: receipt,
      })
      .catch(() => {});
  }
  async submitOperation(
    tenant: string,
    operation: ProductOperation,
    lease: string,
    connectionId?: string,
  ): Promise<OperationReceipt> {
    const runtime = this.tenants.get(tenant);
    const epoch = runtime.viewer?.security?.epoch;
    return this.serial(tenant, async () => {
      this.assertProductViewer(tenant, lease, epoch);
      if (connectionId && runtime.connectionId !== connectionId)
        throw new RemoteKitError('conflict', 'RTC连接已被替换');
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          operation.operationId,
        ) ||
        !operation.action ||
        JSON.stringify(operation.action).length > 32768
      )
        throw new RemoteKitError('invalid_request', '无效产品操作');
      if (operation.operationGeneration !== this.store.operations.operationGeneration(tenant))
        return {
          operationId: operation.operationId,
          operationGeneration: operation.operationGeneration,
          status: 'expired',
          error: '操作收据代次已过期',
        };
      const payload = operationPayload(operation.action),
        existing = this.store.operations.operation(tenant, operation.operationId);
      if (existing) {
        if (existing.payload !== payload) throw new RemoteKitError('conflict', '同一操作ID不能用于不同内容');
        return existing.receipt;
      }
      const receipt: OperationReceipt = {
        operationId: operation.operationId,
        operationGeneration: operation.operationGeneration,
        status: 'accepted',
        ...([
          'tab.navigate',
          'tab.command',
          'tab.close',
          'window.close',
          'page.reply',
          'page.exitFullscreen',
        ].includes(operation.action.type)
          ? { browserIncarnation: runtime.browserIncarnation }
          : {}),
      };
      if (!this.store.operations.reserveOperation(tenant, payload, receipt)) {
        this.push(tenant);
        return { ...receipt, status: 'expired', error: '操作收据已轮换，请核对工作区' };
      }
      receipt.status = 'applying';
      this.store.operations.saveOperation(this.store.workspaces.workspace(tenant), receipt);
      runtime.applyingOperation = receipt;
      try {
        const result = await this.applyProductAction(tenant, operation.action);
        if (!['committed', 'rejected'].includes(receipt.status)) {
          receipt.status =
            ['tab.navigate', 'tab.command'].includes(operation.action.type) && result.application
              ? 'applying'
              : 'committed';
          if (result.application) receipt.application = result.application;
          const current = this.store.workspaces.workspace(tenant),
            a = operation.action;
          if (
            (a.type === 'tab.close' && !a.cancel && current.tabs.some((tab) => tab.id === a.tabId)) ||
            (a.type === 'window.close' && current.windows.some((window) => window.id === a.windowId))
          ) {
            receipt.status = 'applying';
            receipt.application = { status: 'pending', reason: '关闭已受理，等待页面确认' };
          }
        }
      } catch (error) {
        const durable = this.store.operations.operation(tenant, operation.operationId)?.receipt;
        if (durable && ['committed', 'rejected'].includes(durable.status)) {
          Object.assign(receipt, durable);
        } else {
          receipt.status = toRemoteKitError(error).code === 'outcome_unknown' ? 'unknown' : 'rejected';
          receipt.error = toRemoteKitError(error).message;
          const workspace = this.store.workspaces.workspace(tenant);
          for (const tab of workspace.tabs)
            if (tab.navigation?.operationId === operation.operationId) {
              tab.navigation.status = receipt.status === 'rejected' ? 'rejected' : 'unknown';
              if (receipt.status === 'rejected') {
                tab.kind = tab.navigation.previousKind;
                tab.url = tab.navigation.previousUrl;
                if (isLocalTab(tab)) tab.loading = false;
                delete tab.pendingUrl;
              }
            }
          this.store.operations.saveOperation(workspace, receipt);
        }
      } finally {
        delete runtime.applyingOperation;
        this.store.operations.saveOperation(this.store.workspaces.workspace(tenant), receipt);
        this.push(tenant);
      }
      return receipt;
    });
  }
  async productAction(tenant: string, body: ProductAction, lease?: string): Promise<ProductActionResult> {
    const epoch = this.tenants.get(tenant).viewer?.security?.epoch;
    return this.serial(tenant, async () => {
      if (lease) this.assertProductViewer(tenant, lease, epoch);
      return this.applyProductAction(tenant, body).catch((error) => {
        throw toRemoteKitError(error);
      });
    });
  }
  private async applyProductAction(tenant: string, body: ProductAction): Promise<ProductActionResult> {
    const runtime = this.tenants.get(tenant);
    const state = this.store.workspaces.workspace(tenant),
      action = body as any;
    const tab = () => {
      const found = state.tabs.find((t) => t.id === action.tabId);
      if (!found) throw new RemoteKitError('not_found', '标签页不存在');
      return found;
    };
    const window = () => {
      const found = state.windows.find((w) => w.id === action.windowId);
      if (!found) throw new RemoteKitError('not_found', '窗口不存在');
      return found;
    };
    const navigationUrl = (value: unknown) => {
      try {
        return resolveNavigation(value, state.settings.searchEngine);
      } catch (error) {
        throw new RemoteKitError(
          'invalid_request',
          error instanceof Error ? error.message : '无效网址或搜索内容',
        );
      }
    };
    const createTab = (windowId: string, files = false) => {
      if (state.tabs.length >= 32) throw new RemoteKitError('limit_exceeded', '最多支持32个标签页');
      const kind = files ? 'files' : action.url === undefined ? 'start' : 'remote';
      const next: ProductTab = {
        id: randomUUID(),
        windowId,
        webviewId: this.store.workspaces.viewId(),
        kind,
        title: files ? '我的文件' : String(action.title ?? '新标签页').slice(0, 120),
        url: kind === 'remote' ? navigationUrl(action.url) : '',
      };
      state.tabs.push(next);
      state.windows.find((w) => w.id === windowId)!.activeTabId = next.id;
      state.activeWindowId = windowId;
    };
    const reservesFilesTab = (tab: ProductTab) =>
      tab.kind === 'files' ||
      (tab.navigation?.previousKind === 'files' &&
        !tab.navigation.resolved &&
        ['applying', 'unknown'].includes(tab.navigation.status));
    let application: ProductActionResult['application'];
    let siteUaChanged = false;
    switch (action.type) {
      case 'window.create': {
        if (state.windows.length >= 8) throw new RemoteKitError('limit_exceeded', '最多支持8个窗口');
        const id = randomUUID();
        state.windows.push({ id, activeTabId: null, weight: 1 });
        createTab(id);
        break;
      }
      case 'window.activate':
        state.activeWindowId = window().id;
        break;
      case 'window.layout': {
        if (!['side-by-side', 'focused'].includes(action.mode))
          throw new RemoteKitError('invalid_request', '无效的窗口布局');
        state.layoutMode = action.mode;
        if (action.weights !== undefined) {
          if (
            !Array.isArray(action.weights) ||
            action.weights.length > 8 ||
            new Set(action.weights.map((w: any) => w.windowId)).size !== action.weights.length
          )
            throw new RemoteKitError('invalid_request', '无效的窗口比例');
          for (const entry of action.weights) {
            const w = state.windows.find((w) => w.id === entry.windowId);
            if (
              !w ||
              typeof entry.weight !== 'number' ||
              !Number.isFinite(entry.weight) ||
              entry.weight < 0.1 ||
              entry.weight > 10
            )
              throw new RemoteKitError('invalid_request', '无效的窗口比例');
            w.weight = entry.weight;
          }
        }
        break;
      }
      case 'window.close': {
        const w = window();
        if (state.pendingWindowCloseId && state.pendingWindowCloseId !== w.id)
          throw new RemoteKitError('conflict', '请先处理当前关闭请求');
        state.pendingWindowCloseId = w.id;
        await this.continueWindowClose(state);
        break;
      }
      case 'tab.create':
        createTab(window().id);
        break;
      case 'tab.files': {
        const target = window(),
          existing = state.tabs.find((tab) => tab.windowId === target.id && reservesFilesTab(tab));
        if (existing) {
          target.activeTabId = existing.id;
          state.activeWindowId = target.id;
        } else createTab(target.id, true);
        break;
      }
      case 'tab.activate': {
        const t = tab();
        state.windows.find((w) => w.id === t.windowId)!.activeTabId = t.id;
        state.activeWindowId = t.windowId;
        break;
      }
      case 'tab.move': {
        const t = tab(),
          target = window(),
          old = state.windows.find((w) => w.id === t.windowId)!;
        if (
          reservesFilesTab(t) &&
          state.tabs.some(
            (other) => other.id !== t.id && other.windowId === target.id && reservesFilesTab(other),
          )
        )
          throw new RemoteKitError('conflict', '目标窗口已打开我的文件');
        t.windowId = target.id;
        if (old.activeTabId === t.id)
          old.activeTabId = state.tabs.find((item) => item.windowId === old.id)?.id ?? null;
        target.activeTabId = t.id;
        state.activeWindowId = target.id;
        break;
      }
      case 'tab.navigate': {
        const t = tab(),
          address = navigationUrl(action.url),
          previousKind = t.kind ?? 'remote',
          operation = runtime.applyingOperation;
        if (t.lifecycleRecovery || t.lifecycleRecoveryError)
          throw new RemoteKitError('conflict', t.lifecycleRecoveryError ?? '页面正在恢复');
        if (operation)
          t.navigation = {
            operationId: operation.operationId,
            operationGeneration: operation.operationGeneration,
            status: 'applying',
            browserIncarnation: runtime.browserIncarnation,
            previousUrl: t.url,
            previousKind,
          };
        t.pendingUrl = address;
        if (operation) t.kind = 'remote';
        this.saveProduct(state);
        const metadata = operation
          ? {
              operationId: operation.operationId,
              operationGeneration: operation.operationGeneration,
              operationSequence: operation.operationSequence,
            }
          : {};
        if (isLocalTab({ kind: previousKind })) {
          const snapshot = await this.endpoint.snapshot(tenant),
            exists = (snapshot.views ?? []).some((view: any) => view.viewId === t.webviewId);
          const region = runtime.viewer?.viewport?.windows.find((w) => w.windowId === t.windowId);
          if (exists)
            await this.endpoint.navigate(tenant, {
              viewId: t.webviewId,
              url: address,
              ...metadata,
            });
          else
            await this.endpoint.ensureView(tenant, {
              viewId: t.webviewId,
              url: address,
              width: region?.width ?? 1440,
              height: region?.height ?? 900,
              device: { mode: 'desktop', deviceScaleFactor: this.qualityFor(tenant, state).effectiveDpr },
              visible: false,
              ...metadata,
            });
        } else
          await this.endpoint.navigate(tenant, {
            viewId: t.webviewId,
            url: address,
            ...metadata,
          });
        t.kind = 'remote';
        if (!operation) t.url = address;
        t.pendingUrl = address;
        if (operation) application = { status: 'pending', reason: '导航已受理，等待页面确认' };
        break;
      }
      case 'tab.command': {
        const t = tab();
        if (!['back', 'forward', 'reload', 'stop'].includes(action.command))
          throw new RemoteKitError('invalid_request', '未知导航命令');
        if (isLocalTab(t)) break;
        if (t.lifecycleRecovery || t.lifecycleRecoveryError)
          throw new RemoteKitError('conflict', t.lifecycleRecoveryError ?? '页面正在恢复');
        const operation = runtime.applyingOperation;
        // Stop owns a command receipt, not a document navigation. Retain the
        // pending navigation's original rollback state until its own result.
        if (operation && action.command !== 'stop') {
          t.navigation = {
            operationId: operation.operationId,
            operationGeneration: operation.operationGeneration,
            status: 'applying',
            browserIncarnation: runtime.browserIncarnation,
            previousUrl: t.url,
            previousKind: t.kind ?? 'remote',
          };
          this.saveProduct(state);
        }
        await this.endpoint.command(tenant, {
          viewId: t.webviewId,
          command: action.command,
          ...(operation
            ? {
                operationId: operation.operationId,
                operationGeneration: operation.operationGeneration,
                operationSequence: operation.operationSequence,
              }
            : {}),
        });
        if (operation) application = { status: 'pending', reason: '导航命令已受理，等待页面确认' };
        break;
      }
      case 'tab.close': {
        const t = tab(),
          replying = action.confirm === true || action.cancel === true;
        if (replying) {
          if (
            state.pendingClose?.id !== t.id ||
            !action.requestId ||
            state.pendingClose.requestId !== action.requestId
          )
            throw new RemoteKitError('conflict', '关闭请求已失效');
          await this.replyClose(tenant, t.webviewId, state.pendingClose, action.confirm === true);
          if (action.cancel === true) {
            const windowId = state.pendingWindowCloseId;
            state.pendingClose = null;
            state.pendingWindowCloseId = null;
            for (const pending of this.store.operations.pendingOperations(tenant))
              if (
                pending.receipt.operationId !== runtime.applyingOperation?.operationId &&
                ((pending.action.type === 'tab.close' && pending.action.tabId === t.id) ||
                  (pending.action.type === 'window.close' && pending.action.windowId === windowId))
              ) {
                pending.receipt.status = 'rejected';
                pending.receipt.error = '用户取消关闭';
                delete pending.receipt.application;
                this.store.operations.saveOperation(state, pending.receipt);
              }
          } else state.pendingClose = { ...state.pendingClose, awaiting: true };
        } else await this.closeProductTab(state, t);
        break;
      }
      case 'page.reply': {
        if (
          typeof action.dialogId !== 'string' ||
          typeof action.accept !== 'boolean' ||
          (action.text !== undefined &&
            (typeof action.text !== 'string' || Buffer.byteLength(action.text, 'utf8') > 16384))
        )
          throw new RemoteKitError('invalid_request', '无效的页面对话回复');
        const latest = await this.endpoint.snapshot(tenant);
        this.collectDialogs(tenant, state, latest);
        const dialog = runtime.pageRequests.dialogs?.find((d) => d.id === action.dialogId);
        if (!dialog || !state.tabs.some((t) => t.id === dialog.tabId && t.webviewId === dialog.viewId))
          throw new RemoteKitError('conflict', '页面对话已过期');
        if (dialog.kind === 'alert' && !action.accept)
          throw new RemoteKitError('invalid_request', '提示对话仅支持确认');
        const result = await this.endpoint.replyPage(tenant, {
          viewId: dialog.viewId,
          requestId: dialog.requestId,
          browserIncarnation: dialog.browserIncarnation,
          instance: dialog.instance,
          document: dialog.document,
          accept: action.accept,
          ...(action.text === undefined ? {} : { text: action.text }),
        });
        if (result?.accepted !== true || result?.browser?.ok !== true)
          throw new RemoteKitError('conflict', 'Endpoint未确认页面对话回复');
        runtime.pageRequests.dialogs = (runtime.pageRequests.dialogs ?? []).filter((d) => d.id !== dialog.id);
        this.push(tenant);
        break;
      }
      case 'page.exitFullscreen': {
        const binding = this.fullscreenBinding(state);
        if (!binding || action.target !== binding.page.target)
          throw new RemoteKitError('conflict', '网页全屏已结束或页面已更换');
        const { viewId, browserIncarnation, instance, document } = binding;
        await this.endpoint.exitFullscreen(tenant, {
          viewId,
          browserIncarnation,
          instance,
          document,
        });
        delete runtime.pageRequests.fullscreen;
        break;
      }
      case 'settings.update': {
        const value = action.settings;
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).some(
            (k) =>
              ![
                'qualityPreference',
                'clientScaleOverride',
                'memorySaverEnabled',
                'showStats',
                'audioChannels',
                'searchEngine',
                'autoFullscreen',
              ].includes(k),
          )
        )
          throw new RemoteKitError('invalid_request', '无效的设置');
        if ('searchEngine' in value && !SEARCH_ENGINES.some((engine) => engine.value === value.searchEngine))
          throw new RemoteKitError('invalid_request', '无效的搜索引擎');
        if ('qualityPreference' in value && !['quality', 'auto', 'smooth'].includes(value.qualityPreference))
          throw new RemoteKitError('invalid_request', '无效的画面质量');
        if (
          'clientScaleOverride' in value &&
          value.clientScaleOverride !== null &&
          (typeof value.clientScaleOverride !== 'number' ||
            !Number.isFinite(value.clientScaleOverride) ||
            value.clientScaleOverride < 0.5 ||
            value.clientScaleOverride > 4)
        )
          throw new RemoteKitError('invalid_request', '显示比例需0.5–4');
        if ('memorySaverEnabled' in value && typeof value.memorySaverEnabled !== 'boolean')
          throw new RemoteKitError('invalid_request', '无效的内存设置');
        if ('autoFullscreen' in value && typeof value.autoFullscreen !== 'boolean')
          throw new RemoteKitError('invalid_request', '无效的全屏设置');
        if (
          'audioChannels' in value &&
          (!value.audioChannels ||
            typeof value.audioChannels !== 'object' ||
            Array.isArray(value.audioChannels) ||
            Object.keys(value.audioChannels).length !== 2 ||
            typeof value.audioChannels.left !== 'boolean' ||
            typeof value.audioChannels.right !== 'boolean')
        )
          throw new RemoteKitError('invalid_request', '声道设置需同时提供左右开关');
        if ('showStats' in value && typeof value.showStats !== 'boolean')
          throw new RemoteKitError('invalid_request', '无效的统计设置');
        Object.assign(state.settings, value);
        break;
      }
      case 'site.set': {
        let origin: string;
        try {
          const parsed = new URL(action.origin);
          if (
            !['http:', 'https:'].includes(parsed.protocol) ||
            parsed.username ||
            parsed.password ||
            parsed.origin.length > 2048
          )
            throw new RemoteKitError('invalid_request', '无效输入');
          origin = parsed.origin;
        } catch {
          throw new RemoteKitError('invalid_request', '站点需有效HTTP(S) origin，最长2048字符');
        }
        const hasTabletUa = Object.prototype.hasOwnProperty.call(action, 'tabletUa');
        const hasManualKeyboard = Object.prototype.hasOwnProperty.call(action, 'manualKeyboard');
        if (
          (!hasTabletUa && !hasManualKeyboard) ||
          (hasTabletUa && typeof action.tabletUa !== 'boolean') ||
          (hasManualKeyboard && typeof action.manualKeyboard !== 'boolean') ||
          Object.keys(action).some(
            (key) => !['type', 'origin', 'tabId', 'tabletUa', 'manualKeyboard'].includes(key),
          )
        ) {
          throw new RemoteKitError('invalid_request', '无效的站点设置');
        }
        let target: ProductTab | undefined;
        if (action.tabId !== undefined) {
          target = tab();
          if (!URL.canParse(target.url) || new URL(target.url).origin !== origin)
            throw new RemoteKitError('invalid_request', '标签页不属于该站点');
        }
        if (!(origin in state.sites) && Object.keys(state.sites).length >= 4096)
          throw new RemoteKitError('limit_exceeded', '站点设置已达上限');
        const previous = state.sites[origin] ?? { tabletUa: false };
        siteUaChanged = hasTabletUa && previous.tabletUa !== action.tabletUa;
        state.sites[origin] = {
          ...previous,
          ...(hasTabletUa ? { tabletUa: action.tabletUa } : {}),
          ...(hasManualKeyboard ? { manualKeyboard: action.manualKeyboard } : {}),
        };
        if (siteUaChanged) {
          if (target) target.pendingUaReloadOrigin = origin;
          application = { status: 'pending', reason: '设置已保存，正在应用站点身份' };
        }
        break;
      }
      default:
        throw new RemoteKitError('invalid_request', '未知产品操作');
    }
    const operation = runtime.applyingOperation;
    const closePending =
      (action.type === 'tab.close' && !action.cancel && state.tabs.some((tab) => tab.id === action.tabId)) ||
      (action.type === 'window.close' && state.windows.some((window) => window.id === action.windowId));
    if (operation && !['tab.navigate', 'tab.command'].includes(action.type) && !closePending) {
      operation.status = 'committed';
      if (application) operation.application = application;
    }
    this.saveProduct(state);
    if (action.type !== 'site.set' || siteUaChanged) {
      try {
        await this.reconcileProduct(tenant);
      } catch {}
    }
    if (siteUaChanged) {
      const latest = this.store.workspaces.workspace(tenant),
        applied = runtime.policy.site?.applied === true;
      if (
        applied &&
        (!action.tabId || !latest.tabs.find((t) => t.id === action.tabId)?.pendingUaReloadOrigin)
      )
        application = undefined;
      else
        application = { status: 'pending', reason: '设置已保存，应用成功后刷新当前页；其他页面下次加载生效' };
    }
    this.push(tenant);
    return { state: this.productState(tenant), ...(application ? { application } : {}) };
  }
  private removeProductTab(state: ProductWorkspace, tab: ProductTab) {
    state.tabs = state.tabs.filter((t) => t.id !== tab.id);
    const w = state.windows.find((w) => w.id === tab.windowId);
    if (w?.activeTabId === tab.id) w.activeTabId = state.tabs.find((t) => t.windowId === w.id)?.id ?? null;
    if (state.pendingClose?.id === tab.id) state.pendingClose = null;
    this.tenants.get(state.tenantId).lifecycle.background.forget(state.tenantId + '/' + tab.webviewId);
    this.tenants.get(state.tenantId).lifecycle.transitions.delete(state.tenantId + '/' + tab.webviewId);
  }
  private pendingClose(id: string, result: any, windowId?: string): PendingClose {
    if (
      typeof result.browserIncarnation !== 'string' ||
      !result.browserIncarnation ||
      result.instance === undefined ||
      result.document === undefined
    )
      throw new RemoteKitError('conflict', 'Endpoint关闭请求缺少页面身份');
    const nativeRequestId = result.requestId === undefined ? undefined : String(result.requestId);
    return {
      id,
      ...(windowId ? { windowId } : {}),
      browserIncarnation: result.browserIncarnation,
      instance: String(result.instance),
      document: String(result.document),
      ...(nativeRequestId
        ? {
            nativeRequestId,
            requestId: this.closeToken(
              result.browserIncarnation,
              id,
              String(result.instance),
              String(result.document),
              nativeRequestId,
            ),
          }
        : {}),
      awaiting: !nativeRequestId,
    };
  }
  private closeToken(browser: string, tab: string, instance: string, document: string, request: string) {
    return createHash('sha256')
      .update(JSON.stringify([browser, tab, instance, document, request]))
      .digest('hex');
  }
  private observePendingClose(
    state: { pendingClose?: PendingClose | null; pendingWindowCloseId?: string | null },
    snapshot: any,
    view: any,
  ) {
    const pending = state.pendingClose;
    if (!pending) return;
    // Offline/replaced targets invalidate confirmation intent, retaining the tab/window.
    // A missing view alone provides no evidence that a close completed.
    if (
      snapshot.running === false ||
      !pending.browserIncarnation ||
      snapshot.browserIncarnation !== pending.browserIncarnation ||
      (view && (String(view.instance) !== pending.instance || String(view.document) !== pending.document))
    ) {
      state.pendingClose = null;
      state.pendingWindowCloseId = null;
      return;
    }
    const request = view?.pending_close?.requestId ?? view?.closeRequestId ?? view?.close_request_id;
    if (request !== undefined) {
      const nativeRequestId = String(request);
      state.pendingClose = {
        ...pending,
        nativeRequestId,
        requestId: this.closeToken(
          pending.browserIncarnation,
          pending.id,
          pending.instance!,
          pending.document!,
          nativeRequestId,
        ),
        awaiting: false,
      };
    }
  }
  private async replyClose(tenant: string, viewId: string, pending: PendingClose, accept: boolean) {
    if (!pending.browserIncarnation || !pending.instance || !pending.document || !pending.nativeRequestId)
      throw new RemoteKitError('conflict', '关闭请求已失效');
    const result = await this.endpoint.replyClose(tenant, {
      viewId,
      browserIncarnation: pending.browserIncarnation,
      instance: pending.instance,
      document: pending.document,
      requestId: pending.nativeRequestId,
      accept,
    });
    if (result?.accepted !== true || result?.browser?.ok !== true)
      throw new RemoteKitError('conflict', 'Endpoint未确认关闭请求回复');
    return result;
  }
  private async closeProductTab(state: ProductWorkspace, tab: ProductTab) {
    if (state.pendingClose && state.pendingClose.id !== tab.id)
      throw new RemoteKitError('conflict', '请先处理当前关闭请求');
    if (isLocalTab(tab) || (tab.popup && tab.popup.status !== 'adopted')) {
      this.removeProductTab(state, tab);
      return;
    }
    const result = await this.endpoint.closeView(state.tenantId, {
      viewId: tab.webviewId,
      force: false,
    });
    if (result.closed === true) this.removeProductTab(state, tab);
    else if (result.accepted || result.pending)
      state.pendingClose = this.pendingClose(tab.id, result, tab.windowId);
    else throw new RemoteKitError('conflict', 'Endpoint 尚未确认页面关闭');
  }
  private async continueWindowClose(state: ProductWorkspace) {
    if (!state.pendingWindowCloseId || state.pendingClose) return;
    const id = state.pendingWindowCloseId;
    for (const tab of state.tabs.filter((t) => t.windowId === id)) {
      await this.closeProductTab(state, tab);
      this.saveProduct(state);
      if (state.pendingClose) return;
    }
    state.windows = state.windows.filter((w) => w.id !== id);
    if (state.activeWindowId === id) state.activeWindowId = state.windows[0]?.id ?? null;
    state.pendingWindowCloseId = null;
  }
  private async reconcileProduct(tenant: string) {
    const runtime = this.tenants.get(tenant);
    if (!(runtime.viewer !== undefined) && !runtime.started) return;
    try {
      if (!(runtime.viewer !== undefined)) {
        await this.observeOffline(tenant);
        return;
      }
      const desired = this.store.workspaces.workspace(tenant);
      let resourceLimitation = this.qualityFor(tenant, desired).resourceLimitation;
      if (!resourceLimitation) {
        // This operation caches preferences without starting an offline Browser.
        await this.applySites(tenant, desired);
        await this.applyMedia(tenant);
        if (!(runtime.viewer !== undefined)) {
          if (runtime.started) await this.observeOffline(tenant);
          return;
        }
        const ensured = await this.endpoint.ensureSession(tenant);
        runtime.started = true;
        if (!(runtime.viewer !== undefined)) {
          await this.observeOffline(tenant);
          return;
        }
        const applied = runtime.policy.site!;
        if (
          !applied.applied ||
          (ensured.browserPid !== undefined && applied.browserPid !== ensured.browserPid)
        )
          await this.applySites(tenant, desired, true, ensured.browserPid);
        if (!runtime.policy.site?.applied)
          throw new RemoteKitError('unavailable', '站点身份尚未应用，等待Endpoint恢复');
        const media = runtime.policy.media!;
        if (!media.applied || (ensured.browserPid !== undefined && media.browserPid !== ensured.browserPid))
          await this.applyMedia(tenant, true, ensured.browserPid);
      }
      // Native source/encoder application may finish after views or RTC exist.
      // Accepted policy is cached before their creation; stats retain unknown actuals.
      const snapshot = await this.endpoint.snapshot(tenant),
        state = this.store.workspaces.workspace(tenant),
        actual: any[] = Array.isArray(snapshot?.views) ? snapshot.views : [];
      runtime.lifecycle.background.retain(
        tenant,
        new Set(
          snapshot.running === false || resourceLimitation
            ? []
            : actual.filter((v) => state.tabs.some((t) => t.webviewId === v.viewId)).map((v) => v.viewId),
        ),
      );
      if (typeof snapshot.browserIncarnation === 'string')
        runtime.browserIncarnation = snapshot.browserIncarnation;
      for (const tab of state.tabs) {
        const nav = tab.navigation;
        if (
          nav &&
          !nav.resolved &&
          ['applying', 'unknown'].includes(nav.status) &&
          nav.browserIncarnation &&
          (snapshot.running === false ||
            (typeof snapshot.browserIncarnation === 'string' &&
              snapshot.browserIncarnation !== nav.browserIncarnation))
        ) {
          nav.status = 'unknown';
          nav.resolved = true;
          tab.kind = nav.previousKind;
          tab.url = nav.previousUrl;
          if (isLocalTab(tab)) tab.loading = false;
          delete tab.pendingUrl;
          const saved = this.store.operations.operation(tenant, nav.operationId);
          if (saved && !['committed', 'rejected'].includes(saved.receipt.status)) {
            saved.receipt.status = 'unknown';
            saved.receipt.resolved = true;
            saved.receipt.resolution = 'target-retired';
            saved.receipt.error = '原页面实例已结束，导航执行结果未知';
            delete saved.receipt.application;
            this.store.operations.saveOperation(state, saved.receipt);
          }
        }
      }
      const appliedPolicy = snapshot.stats?.mediaPolicy?.applied;
      if (appliedPolicy === null) delete runtime.policy.actualMedia;
      else if (appliedPolicy) runtime.policy.actualMedia = appliedPolicy;
      const closedViews = await this.consumeClosedEvents(state, snapshot);
      if (!(runtime.viewer !== undefined)) {
        await this.observeOffline(tenant);
        return;
      }
      await this.observePopups(state, snapshot);
      this.store.operations.prunePopupReceipts(tenant);
      if (state.pendingClose)
        this.observePendingClose(
          state,
          snapshot,
          actual.find((v) => v.viewId === state.tabs.find((t) => t.id === state.pendingClose?.id)?.webviewId),
        );
      for (const t of [...state.tabs]) {
        const current = actual.find((v) => v.viewId === t.webviewId);
        if (!current) {
          this.observeLifecycleRecovery(state, t, current, snapshot.browserIncarnation);
          continue;
        }
        if (t.navigation && !t.navigation.resolved && ['applying', 'unknown'].includes(t.navigation.status)) {
          const nav = t.navigation,
            terminal = (current.navigationOperations ?? []).find(
              (entry: any) =>
                entry.operationId === nav.operationId &&
                entry.operationGeneration === nav.operationGeneration &&
                ['committed', 'cancelled', 'failed', 'superseded'].includes(entry.state),
            );
          if (terminal) {
            const operation = this.store.operations.operation(tenant, nav.operationId),
              committed = terminal.state === 'committed';
            nav.status = committed ? 'committed' : 'rejected';
            // Failure and document commit are independent. A real Chromium
            // error document must remain visible even when its receipt rejects.
            if (committed || terminal.documentCommitted === true) {
              t.kind = 'remote';
              t.url = typeof terminal.url === 'string' ? terminal.url : (t.pendingUrl ?? t.url);
            } else {
              t.kind = nav.previousKind;
              t.url = nav.previousUrl;
              if (isLocalTab(t)) t.loading = false;
            }
            delete t.pendingUrl;
            if (operation) {
              const active = runtime.applyingOperation;
              if (active?.operationId === nav.operationId) {
                active.status = committed ? 'committed' : 'rejected';
                delete active.application;
                if (!committed)
                  active.error =
                    terminal.state === 'cancelled' ? '导航已取消' : '导航未完成：' + terminal.state;
              }
              operation.receipt.status = committed ? 'committed' : 'rejected';
              delete operation.receipt.application;
              if (!committed)
                operation.receipt.error =
                  terminal.state === 'cancelled' ? '导航已取消' : '导航未完成：' + terminal.state;
              this.store.operations.saveOperation(state, operation.receipt);
            }
          }
        }
        for (const terminal of current.navigationOperations ?? [])
          if (['committed', 'cancelled', 'failed', 'superseded'].includes(terminal.state)) {
            const saved = this.store.operations.operation(tenant, terminal.operationId);
            if (
              !saved ||
              saved.receipt.operationGeneration !== terminal.operationGeneration ||
              saved.receipt.resolved ||
              (saved.receipt.browserIncarnation &&
                saved.receipt.browserIncarnation !== snapshot.browserIncarnation)
            )
              continue;
            const action = JSON.parse(saved.payload);
            if (!['tab.navigate', 'tab.command'].includes(action.type) || action.tabId !== t.id) continue;
            if (!['committed', 'rejected'].includes(saved.receipt.status)) {
              saved.receipt.status = terminal.state === 'committed' ? 'committed' : 'rejected';
              delete saved.receipt.application;
              if (saved.receipt.status === 'rejected')
                saved.receipt.error = terminal.error ?? '导航未完成：' + terminal.state;
              this.store.operations.saveOperation(state, saved.receipt);
            }
            const active = runtime.applyingOperation;
            if (
              active &&
              active.operationId === terminal.operationId &&
              active.operationGeneration === terminal.operationGeneration
            ) {
              Object.assign(active, saved.receipt);
              delete active.application;
            }
            await this.endpoint
              .ackNavigation(tenant, {
                browserIncarnation: snapshot.browserIncarnation,
                viewId: t.webviewId,
                operationId: terminal.operationId,
                operationGeneration: terminal.operationGeneration,
              })
              .catch(() => {});
          }
        // A provisional failure restored a local product tab. Do not project
        // the retained Browser view's URL/title over that local product state.
        if (isLocalTab(t)) continue;
        if (t.popup?.status === 'pending')
          t.popup = { provisionalId: t.popup.provisionalId, status: 'adopted' };
        if (current.close_state === 'closed') {
          this.removeProductTab(state, t);
          continue;
        }
        // Recovery uses an initial blank WebContents, then imports/restores history.
        // Its intermediate URL/title/history are not a new product navigation.
        const lifecycleBlocked = this.observeLifecycleRecovery(
          state,
          t,
          current,
          snapshot.browserIncarnation,
        );
        const recovering = current.recovery?.pending === true || lifecycleBlocked;
        if (!recovering) {
          for (const key of ['title', 'loading', 'canGoBack', 'canGoForward'] as const)
            if (typeof current[key] === (key === 'title' ? 'string' : 'boolean'))
              (t as any)[key] = key === 'title' ? current[key].slice(0, 120) : current[key];
          if (
            (!t.navigation ||
              t.navigation.resolved ||
              !['applying', 'unknown'].includes(t.navigation.status)) &&
            typeof current.url === 'string' &&
            /^(https?:\/\/|about:blank$)/.test(current.url) &&
            (!t.pendingUrl || current.url === t.pendingUrl)
          ) {
            t.url = current.url;
            delete t.pendingUrl;
          }
        }
        if (Number.isInteger(current.actual) && current.actual >= 0 && current.actual <= 3)
          t.residency = (['live', 'frozen', 'discarded', 'unloaded'] as const)[current.actual];
        t.restoring =
          !t.lifecycleRecoveryError && (recovering || (!!current.pending && current.desired === 0));
      }
      await this.continueWindowClose(state);
      for (const pending of this.store.operations.pendingOperations(tenant)) {
        const a = pending.action;
        if (
          !pending.receipt.resolved &&
          pending.receipt.browserIncarnation &&
          (snapshot.running === false ||
            (typeof snapshot.browserIncarnation === 'string' &&
              snapshot.browserIncarnation !== pending.receipt.browserIncarnation))
        ) {
          pending.receipt.status = 'unknown';
          pending.receipt.resolved = true;
          pending.receipt.resolution = 'target-retired';
          pending.receipt.error = '原页面实例已结束，操作执行结果未知';
          delete pending.receipt.application;
          this.store.operations.saveOperation(state, pending.receipt);
        }
        if (
          ['tab.navigate', 'tab.command'].includes(a.type) &&
          !state.tabs.some((tab) => tab.id === a.tabId) &&
          !pending.receipt.resolved
        ) {
          pending.receipt.status = 'unknown';
          pending.receipt.resolved = true;
          pending.receipt.resolution = 'target-retired';
          pending.receipt.error = '页面已关闭，之前的导航结果无法确认';
          delete pending.receipt.application;
          this.store.operations.saveOperation(state, pending.receipt);
        }
        const removed =
          (a.type === 'tab.close' && !state.tabs.some((tab) => tab.id === a.tabId)) ||
          (a.type === 'window.close' && !state.windows.some((window) => window.id === a.windowId));
        if (removed) {
          pending.receipt.status = 'committed';
          delete pending.receipt.application;
          this.store.operations.saveOperation(state, pending.receipt);
          const active = runtime.applyingOperation;
          if (active?.operationId === pending.receipt.operationId) {
            active.status = 'committed';
            delete active.application;
          }
        }
      }
      const fullscreenChanged = this.observeFullscreen(state, snapshot, actual);
      this.saveProduct(state);
      this.collectDialogs(tenant, state, snapshot);
      if (fullscreenChanged) this.push(tenant);
      resourceLimitation = this.qualityFor(tenant, state).resourceLimitation;
      if (snapshot.running === false && !resourceLimitation)
        throw new RemoteKitError('unavailable', 'Browser已离线，页面保留并等待恢复');
      const viewer = runtime.viewer,
        viewport = viewer?.viewport ?? runtime.lastViewport;
      const wanted = (t: ProductTab) =>
        !isLocalTab(t) &&
        !viewer?.security?.locked &&
        !!viewer?.viewport?.windows.some((w) => w.windowId === t.windowId && w.visible) &&
        state.windows.some((w) => w.id === t.windowId && w.activeTabId === t.id) &&
        (state.layoutMode !== 'focused' || t.windowId === state.activeWindowId);
      const ordered = [...state.tabs]
        .filter((t) => !isLocalTab(t))
        .sort((a, b) => Number(wanted(a)) - Number(wanted(b)));
      // A first navigation can have created/shown a Native view before a
      // provisional failure restores a local product tab. Explicitly remove
      // that existing view from the atlas, including under resource limitation.
      for (const t of state.tabs.filter((tab) => isLocalTab(tab))) {
        const current = actual.find((v) => v.viewId === t.webviewId),
          key = tenant + '/' + t.webviewId;
        if (!current) {
          runtime.policy.configurations.delete(key);
          continue;
        }
        runtime.lifecycle.background.forget(key);
        const config = { viewId: t.webviewId, visible: false, requireRunning: true },
          encoded = JSON.stringify(config);
        if (
          current.visible === true ||
          (current.visible !== false && runtime.policy.configurations.get(key) !== encoded)
        ) {
          runtime.policy.configurations.delete(key);
          await this.endpoint.configureView(tenant, config);
        }
        // This hide-only cache deliberately differs from the complete remote
        // config, so the next navigation reapplies bounds/device/visibility.
        runtime.policy.configurations.set(key, encoded);
      }
      for (const t of resourceLimitation ? [] : ordered) {
        if (!(runtime.viewer !== undefined)) {
          await this.observeOffline(tenant);
          return;
        }
        const current = actual.find((v) => v.viewId === t.webviewId),
          key = tenant + '/' + t.webviewId,
          visible = wanted(t),
          region = viewport?.windows.find((w) => w.windowId === t.windowId),
          dpr = this.qualityFor(tenant, state).effectiveDpr;
        if (t.popup?.status === 'failed') continue;
        if (visible) runtime.lifecycle.background.forget(key);
        const actualState = current?.actual ?? 0,
          recovering = current?.recovery?.pending === true;
        const lifecycleBlocked =
          current?.lifecycle_uncertain === true || !!t.lifecycleRecovery || !!t.lifecycleRecoveryError;
        let readyToShow = !lifecycleBlocked && actualState === 0 && !current?.pending;
        if (!lifecycleBlocked && visible && actualState !== 0 && !current?.pending) {
          const attempt = runtime.lifecycle.transitions.get(key);
          if (!attempt || attempt.action !== 'restore' || this.clock.wallMs() - attempt.at > 12000) {
            await this.endpoint.lifecycle(tenant, { viewId: t.webviewId, action: 'restore' });
            runtime.lifecycle.transitions.set(key, { action: 'restore', at: this.clock.wallMs() });
          }
          readyToShow = false;
        } else if (readyToShow && runtime.lifecycle.transitions.get(key)?.action === 'restore')
          runtime.lifecycle.transitions.delete(key);
        // Endpoint hides the recovering WebContents while retaining this desired
        // visibility for its final recovery step. Do not persist a temporary hide.
        const config = {
          viewId: t.webviewId,
          width: region?.width ?? 1440,
          height: region?.height ?? 900,
          device: { mode: 'desktop', deviceScaleFactor: dpr },
          visible: !lifecycleBlocked && visible && (recovering || readyToShow),
        };
        const encoded = JSON.stringify(config);
        if (!current && t.popup?.status === 'pending') {
          try {
            const adopted = await this.endpoint.adoptView(tenant, {
              ...config,
              url: t.url,
              provisionalId: t.popup.provisionalId,
            });
            if (adopted?.accepted !== true || adopted.completed !== true)
              throw new RemoteKitError('rejected', 'Endpoint尚未完成新页面收养');
            t.popup = { provisionalId: t.popup.provisionalId, status: 'adopted' };
            this.saveProduct(state);
            runtime.policy.configurations.set(key, encoded);
          } catch (error) {
            // Transport failures are retried with the same binding, never with view.ensure.
            if (['not_found', 'rejected'].includes(toRemoteKitError(error).code)) {
              t.popup = {
                provisionalId: t.popup.provisionalId,
                status: 'failed',
                error: '新页面已关闭或过期，请关闭后重试',
              };
              this.saveProduct(state);
            } else throw error;
          }
          continue;
        }
        if (
          !current &&
          (lifecycleBlocked ||
            (t.navigation && !t.navigation.resolved && ['applying', 'unknown'].includes(t.navigation.status)))
        )
          continue;
        if (!current) {
          await this.endpoint.ensureView(tenant, { ...config, url: t.pendingUrl ?? t.url });
          runtime.policy.configurations.set(key, encoded);
        } else if (
          runtime.policy.configurations.get(key) !== encoded ||
          (!recovering && current.visible !== undefined && current.visible !== config.visible)
        ) {
          await this.endpoint.configureView(
            tenant,
            lifecycleBlocked ? { ...config, requireRunning: true } : config,
          );
          runtime.policy.configurations.set(key, encoded);
        }
        if (lifecycleBlocked) {
          await this.advanceLifecycleRecovery(
            state,
            t,
            current,
            snapshot.browserIncarnation,
            visible && viewer === runtime.viewer && !viewer?.security?.locked,
          );
          continue;
        }
        if (t.pendingUaReloadOrigin && readyToShow) {
          const requestedOrigin = t.pendingUaReloadOrigin;
          if (current && new URL(t.url).origin === requestedOrigin)
            await this.endpoint.command(tenant, { viewId: t.webviewId, command: 'reload' });
          delete t.pendingUaReloadOrigin;
          this.saveProduct(state);
        }
        await this.maintainBackgroundTab(state, t, current, visible, snapshot.browserIncarnation);
      }
      for (const v of actual) {
        const viewId = v.viewId;
        if (!state.tabs.some((t) => t.webviewId === viewId) && !v.provisional && !closedViews.has(viewId))
          await this.endpoint.closeView(tenant, { viewId, force: true, orphan: true });
      }
      if (resourceLimitation) {
        const changed = runtime.lastError !== resourceLimitation;
        runtime.lastError = resourceLimitation;
        if (changed) this.push(tenant);
      } else {
        const previousError = runtime.clearError();
        if (previousError) this.push(tenant);
      }
    } catch (error) {
      delete runtime.pageRequests.fullscreen;
      delete runtime.pageRequests.dialogs;
      delete runtime.pageRequests.files;
      runtime.lastError = toRemoteKitError(error).message;
      this.push(tenant);
      throw error;
    }
  }
  private async observeOffline(tenant: string) {
    const runtime = this.tenants.get(tenant);
    // Snapshot is read-only. Maintenance must never revive a missing Browser/view.
    const snapshot = await this.endpoint.snapshot(tenant),
      state = this.store.workspaces.workspace(tenant);
    runtime.lifecycle.background.retain(
      tenant,
      new Set(
        snapshot.running === false
          ? []
          : (snapshot.views ?? [])
              .filter((v: any) => state.tabs.some((t) => t.webviewId === v.viewId))
              .map((v: any) => v.viewId),
      ),
    );
    await this.consumeClosedEvents(state, snapshot);
    delete runtime.pageRequests.dialogs;
    delete runtime.pageRequests.files;
    if (state.pendingClose) {
      const tab = state.tabs.find((t) => t.id === state.pendingClose?.id);
      this.observePendingClose(
        state,
        snapshot,
        (snapshot.views ?? []).find((v: any) => v.viewId === tab?.webviewId),
      );
      this.saveProduct(state);
    }
    if (snapshot.running === false) {
      runtime.started = false;
      delete runtime.policy.site;
      delete runtime.policy.media;
      delete runtime.policy.actualMedia;
      this.push(tenant);
      return;
    }
    for (const tab of state.tabs) {
      const current = (snapshot.views ?? []).find((view: any) => view.viewId === tab.webviewId);
      const lifecycleBlocked = this.observeLifecycleRecovery(
        state,
        tab,
        current,
        snapshot.browserIncarnation,
      );
      if (!current) continue;
      const key = tenant + '/' + tab.webviewId;
      if (current.visible !== false) {
        await this.endpoint.configureView(tenant, {
          viewId: tab.webviewId,
          visible: false,
          requireRunning: true,
        });
        runtime.policy.configurations.delete(key);
      }
      if (lifecycleBlocked)
        await this.advanceLifecycleRecovery(state, tab, current, snapshot.browserIncarnation, false);
      else await this.maintainBackgroundTab(state, tab, current, false, snapshot.browserIncarnation);
    }
    this.saveProduct(state);
    const previousError = runtime.clearError();
    if (previousError) this.push(tenant);
  }
  private observeLifecycleRecovery(
    state: ProductWorkspace,
    tab: ProductTab,
    current: any,
    browserIncarnation: unknown,
  ) {
    const recovery = tab.lifecycleRecovery;
    if (
      recovery &&
      typeof browserIncarnation === 'string' &&
      browserIncarnation &&
      recovery.browserIncarnation !== browserIncarnation
    ) {
      delete tab.lifecycleRecovery;
      delete tab.lifecycleRecoveryError;
      delete tab.pendingUrl;
      tab.restoring = false;
      return current?.lifecycle_uncertain === true;
    }
    if (!recovery) {
      if (
        tab.lifecycleRecoveryError &&
        current?.lifecycle_uncertain === false &&
        current.actual === 0 &&
        current.pending === false
      ) {
        delete tab.lifecycleRecoveryError;
        delete tab.pendingUrl;
      }
      return current?.lifecycle_uncertain === true || !!tab.lifecycleRecoveryError;
    }
    const last = current?.last_lifecycle;
    // Native reserves exactly the next generation after checking the guard.
    // The same proof works when a response was lost or Control restarted.
    const expected = (BigInt(recovery.generation) + 1n).toString();
    const completed = (generation: string, action: number, actual: number) =>
      browserIncarnation === recovery.browserIncarnation &&
      current?.lifecycle_generation === generation &&
      current.pending === false &&
      current.lifecycle_uncertain === false &&
      last?.generation === generation &&
      last.succeeded === true &&
      last.action === action &&
      current.actual === actual;
    if (recovery.phase === 'unload' && completed(expected, 2, 3)) {
      tab.lifecycleRecovery = { ...recovery, phase: 'unloaded', generation: expected };
      delete tab.lifecycleRecoveryError;
    } else if (recovery.phase === 'unloaded' && completed(recovery.generation, 2, 3)) {
      delete tab.lifecycleRecoveryError;
    } else if (recovery.phase === 'restore' && completed(expected, 3, 0)) {
      delete tab.lifecycleRecovery;
      delete tab.lifecycleRecoveryError;
      return false;
    } else if (!tab.lifecycleRecoveryError) {
      if (!current) tab.lifecycleRecoveryError = '无法确认原页面实例，请关闭此标签页后重新打开';
      else if (
        recovery.phase !== 'unloaded' &&
        browserIncarnation === recovery.browserIncarnation &&
        current.lifecycle_generation === expected &&
        current.pending === false &&
        last?.generation === expected &&
        last.succeeded === false &&
        last.action === (recovery.phase === 'unload' ? 2 : 3)
      ) {
        tab.lifecycleRecoveryError = this.lifecycleError(last.detail);
      } else if (recovery.phase === 'unloaded' || this.clock.wallMs() - recovery.submittedAt > 15000) {
        tab.lifecycleRecoveryError = '无法确认页面恢复结果，请关闭此标签页后重新打开';
      }
    }
    if (tab.lifecycleRecovery?.phase === 'unloaded' && this.tenants.get(state.tenantId).viewer !== undefined)
      this.retireLifecycleNavigation(state, tab);
    return true;
  }
  private retireLifecycleNavigation(state: ProductWorkspace, tab: ProductTab) {
    const nav = tab.navigation;
    delete tab.pendingUrl;
    if (!nav || nav.resolved || !['applying', 'unknown'].includes(nav.status)) return;
    nav.status = 'unknown';
    nav.resolved = true;
    tab.kind = nav.previousKind;
    tab.url = nav.previousUrl;
    if (isLocalTab(tab)) tab.loading = false;
    const saved = this.store.operations.operation(state.tenantId, nav.operationId);
    if (!saved || ['committed', 'rejected'].includes(saved.receipt.status)) return;
    saved.receipt.status = 'unknown';
    saved.receipt.resolved = true;
    saved.receipt.resolution = 'target-retired';
    saved.receipt.error = '原页面实例已结束，导航执行结果未知';
    delete saved.receipt.application;
    this.store.operations.saveOperation(state, saved.receipt);
  }
  private lifecycleError(error: unknown) {
    const detail = toRemoteKitError(error).message;
    return detail
      ? `页面恢复未确认（${detail.slice(0, 240)}），请关闭此标签页后重新打开`
      : '页面恢复未确认，请关闭此标签页后重新打开';
  }
  private async advanceLifecycleRecovery(
    state: ProductWorkspace,
    tab: ProductTab,
    current: any,
    browserIncarnation: unknown,
    visible: boolean,
  ) {
    if (
      !current ||
      current.pending !== false ||
      current.recovery?.pending === true ||
      current.close_state === 'closing' ||
      current.close_state === 'closed' ||
      isLocalTab(tab) ||
      state.pendingClose?.id === tab.id ||
      state.pendingWindowCloseId === tab.windowId
    )
      return;
    const previous = tab.lifecycleRecovery;
    if (previous && tab.lifecycleRecoveryError) return;
    const action = previous ? 'restore' : 'unload';
    if (
      previous
        ? previous.phase !== 'unloaded' ||
          !visible ||
          previous.browserIncarnation !== browserIncarnation ||
          previous.generation !== current.lifecycle_generation ||
          current.actual !== 3 ||
          current.lifecycle_uncertain !== false
        : current.lifecycle_uncertain !== true
    )
      return;
    const generation = current.lifecycle_generation;
    if (
      typeof browserIncarnation !== 'string' ||
      !browserIncarnation ||
      typeof generation !== 'string' ||
      !/^\d{1,20}$/.test(generation)
    ) {
      tab.lifecycleRecoveryError = '页面恢复缺少实例标识，请关闭此标签页后重新打开';
      tab.restoring = false;
      this.saveProduct(state);
      return;
    }
    // Record the mutation before it can leave Control. Future ticks observe
    // only, including across Control restart or an ambiguous transport error.
    delete tab.lifecycleRecoveryError;
    tab.lifecycleRecovery = {
      browserIncarnation,
      generation,
      phase: action,
      submittedAt: this.clock.wallMs(),
    };
    tab.restoring = true;
    this.saveProduct(state);
    try {
      const result = await this.endpoint.lifecycle(state.tenantId, {
        viewId: tab.webviewId,
        action,
        requireRunning: true,
        browserIncarnation,
        lifecycleGeneration: generation,
      });
      if (result?.accepted !== true) throw new RemoteKitError('rejected', 'Endpoint 未确认请求');
    } catch (error) {
      tab.lifecycleRecoveryError = this.lifecycleError(error);
      tab.restoring = false;
      this.saveProduct(state);
    }
  }
  private async maintainBackgroundTab(
    state: ProductWorkspace,
    tab: ProductTab,
    current: any,
    visible: boolean,
    browserIncarnation: unknown,
  ) {
    const tenant = state.tenantId,
      key = tenant + '/' + tab.webviewId;
    const action = this.tenants
      .get(tenant)
      .lifecycle.background.action(
        key,
        state.settings.memorySaverEnabled,
        visible,
        isLocalTab(tab) ||
          (!!tab.popup && tab.popup.status !== 'adopted') ||
          state.pendingClose?.id === tab.id ||
          state.pendingWindowCloseId === tab.windowId,
        current,
        browserIncarnation,
      );
    if (!action) return;
    const attempt = this.tenants.get(tenant).lifecycle.transitions.get(key);
    if (attempt?.action === action && this.clock.wallMs() - attempt.at <= 12000) return;
    await this.endpoint.lifecycle(tenant, {
      viewId: tab.webviewId,
      action,
      requireRunning: true,
    });
    this.tenants.get(tenant).lifecycle.transitions.set(key, { action, at: this.clock.wallMs() });
    if (action === 'freeze') this.tenants.get(tenant).lifecycle.background.freezeRequested(key);
  }
  private qualityState(tenant: string) {
    return this.tenants.get(tenant).quality;
  }
  private qualityFor(tenant: string, workspace = this.store.workspaces.workspace(tenant)) {
    const runtime = this.tenants.get(tenant);
    return this.qualityState(tenant).snapshot(
      workspace,
      runtime.viewer?.viewport ?? runtime.lastViewport,
      this.clock.wallMs(),
      runtime.policy.actualMedia ?? null,
    );
  }
  private async applyMedia(tenant: string, force = false, browserPid?: number) {
    const runtime = this.tenants.get(tenant);
    const requested = this.qualityFor(tenant).requested,
      encoded = JSON.stringify(requested),
      previous = runtime.policy.media;
    if (!force && previous?.encoded === encoded && previous.applied) return;
    runtime.policy.media = { encoded, applied: false, browserPid };
    const result = await this.endpoint.mediaPolicy(tenant, requested);
    if (result?.accepted !== true) throw new RemoteKitError('rejected', 'Endpoint未接受媒体质量策略');
    runtime.policy.media = { encoded, applied: result.applied === true, browserPid };
  }
  private authorizeFiles(tenant: string) {
    const runtime = this.tenants.get(tenant);
    const connectionId = runtime.connectionId,
      viewer = runtime.viewer;
    if (!connectionId || !viewer || !this.productAllowed(tenant, viewer.id)) return;
    const authEpoch = viewer.security.peer?.appliedEpoch;
    if (!authEpoch || viewer.security.peer?.connectionId !== connectionId) return;
    const requests = (runtime.pageRequests.files ?? [])
      .slice(0, 64)
      .map((request) => ({ id: request.id, binding: request.binding }));
    const params = { connectionId, requests, library: true, authEpoch };
    const encoded = JSON.stringify(params);
    if (runtime.pageRequests.authorization === encoded) return;
    runtime.pageRequests.authorization = encoded;
    const retry = () => {
      if (runtime.pageRequests.authorization === encoded) delete runtime.pageRequests.authorization;
    };
    void this.endpoint.authorizeFiles(tenant, params).then((result) => {
      if (result?.accepted !== true) retry();
    }, retry);
  }
  private collectDialogs(tenant: string, state: ProductWorkspace, snapshot: any) {
    const runtime = this.tenants.get(tenant);
    const found: (PageDialog & {
      viewId: string;
      requestId: string;
      browserIncarnation: string;
      instance: string;
      document: string;
    })[] = [];
    const files: InternalFileRequest[] = [];
    for (const view of Array.isArray(snapshot.views) ? snapshot.views : []) {
      const viewId = view.viewId,
        tab = state.tabs.find((t) => t.webviewId === viewId);
      if (
        !tab ||
        isLocalTab(tab) ||
        snapshot.running === false ||
        typeof snapshot.browserIncarnation !== 'string' ||
        !snapshot.browserIncarnation ||
        view.instance === undefined ||
        view.document === undefined
      )
        continue;
      const instance = String(view.instance),
        document = String(view.document);
      for (const request of Array.isArray(view.pageRequests?.pending) ? view.pageRequests.pending : []) {
        if (request.kind === 'file_chooser' && typeof request.request === 'string') {
          const id = createHash('sha256')
            .update(
              JSON.stringify([
                tenant,
                snapshot.browserIncarnation,
                viewId,
                instance,
                document,
                request.request,
              ]),
            )
            .digest('hex');
          const anchor = fileRequestAnchor(request.input_anchor, instance, document);
          files.push({
            id,
            ...(anchor ? { anchor } : {}),
            tabId: tab.id,
            windowId: tab.windowId,
            origin: String(request.origin ?? ''),
            multiple: request.multiple === true,
            acceptTypesOmitted: request.accept_types_omitted === true,
            accept: Array.isArray(request.accept_types)
              ? request.accept_types
                  .filter((type: unknown): type is string => typeof type === 'string')
                  .slice(0, 64)
              : [],
            state: request.state === 'validating' ? 'validating' : 'pending',
            limits: { ...this.fileLimits },
            binding: {
              browserIncarnation: snapshot.browserIncarnation,
              view: viewId,
              instance,
              document,
              request: request.request,
            },
          });
        }
        if (
          !['alert', 'confirm', 'prompt', 'beforeunload'].includes(request.kind) ||
          typeof request.request !== 'string' ||
          (state.pendingClose?.id === tab.id && request.kind === 'beforeunload')
        )
          continue;
        // Browser replacement may restart its local token/request counters.
        const id = createHash('sha256')
          .update(
            JSON.stringify([
              tenant,
              snapshot.browserIncarnation,
              viewId,
              instance,
              document,
              request.request,
            ]),
          )
          .digest('hex');
        found.push({
          id,
          tabId: tab.id,
          windowId: tab.windowId,
          viewId,
          browserIncarnation: snapshot.browserIncarnation,
          instance,
          document,
          requestId: request.request,
          kind: request.kind,
          message: String(request.message ?? ''),
          defaultPrompt: String(request.default_prompt ?? ''),
          origin: String(request.origin ?? ''),
          ...(typeof request.is_reload === 'boolean' ? { isReload: request.is_reload } : {}),
        });
      }
    }
    const changed =
      JSON.stringify(found) !== JSON.stringify(runtime.pageRequests.dialogs ?? []) ||
      JSON.stringify(files) !== JSON.stringify(runtime.pageRequests.files ?? []);
    runtime.pageRequests.dialogs = found;
    runtime.pageRequests.files = files;
    this.authorizeFiles(tenant);
    if (changed) this.push(tenant);
  }
  private async applySites(tenant: string, state: ProductWorkspace, force = false, browserPid?: number) {
    const runtime = this.tenants.get(tenant);
    const sites = Object.fromEntries(
      Object.keys(state.sites)
        .sort()
        .filter((origin) => state.sites[origin].tabletUa)
        .map((origin) => [origin, { tabletUa: true }]),
    );
    const encoded = JSON.stringify(sites),
      previous = runtime.policy.site;
    if (!force && previous?.encoded === encoded && previous.applied) return;
    runtime.policy.site = { encoded, applied: false, browserPid };
    const result = await this.endpoint.sitePreferences(tenant, { sites });
    if (result?.accepted !== true) throw new RemoteKitError('rejected', 'Endpoint未接受站点身份设置');
    runtime.policy.site = { encoded, applied: result.applied === true, browserPid };
  }
  private async consumeClosedEvents(state: ProductWorkspace, snapshot: any): Promise<Set<string>> {
    const closed = new Set<string>(),
      eventIds: string[] = [];
    for (const event of Array.isArray(snapshot.events) ? snapshot.events : []) {
      if (
        event?.type !== 'view.closed' ||
        typeof event.eventId !== 'string' ||
        typeof event.viewId !== 'string'
      )
        continue;
      closed.add(event.viewId);
      eventIds.push(event.eventId);
      const tab = state.tabs.find((t) => t.webviewId === event.viewId);
      if (tab) this.removeProductTab(state, tab);
    }
    if (eventIds.length) {
      // Commit product deletion before acknowledging durable Endpoint events.
      this.saveProduct(state);
      const result = await this.endpoint.ackEvents(state.tenantId, { eventIds });
      if (result?.accepted !== true) throw new RemoteKitError('rejected', 'Endpoint关闭事件尚未确认');
    }
    return closed;
  }
  private async observePopups(state: ProductWorkspace, snapshot: any) {
    for (const popup of Array.isArray(snapshot.pendingPopups) ? snapshot.pendingPopups : []) {
      if (!popup || typeof popup.provisionalId !== 'string' || popup.provisionalId.length > 256) continue;
      const existing = state.tabs.find((t) => t.popup?.provisionalId === popup.provisionalId);
      if (existing) {
        if (existing.popup?.status === 'pending' && ['closed', 'timed_out'].includes(popup.status)) {
          existing.popup = {
            provisionalId: popup.provisionalId,
            status: 'failed',
            error: popup.status === 'timed_out' ? '新页面创建已过期' : '新页面已关闭',
          };
          this.saveProduct(state);
        }
        continue;
      }
      if (
        popup.status !== 'pending' ||
        popup.userGesture !== true ||
        this.store.operations.popupTabId(state.tenantId, popup.provisionalId) ||
        state.tabs.length >= 32
      )
        continue;
      const opener = state.tabs.find((t) => t.webviewId === popup.openerViewId);
      if (!opener) continue;
      let target = state.windows.find((w) => w.id === opener.windowId);
      if (!target) continue;
      if (![3, 4, 5, 6].includes(popup.disposition)) continue;
      if ([5, 6].includes(popup.disposition)) {
        if (state.windows.length >= 8) continue;
        target = { id: randomUUID(), activeTabId: null, weight: 1 };
        state.windows.push(target);
      }
      let address: string;
      try {
        address = url(popup.url);
      } catch {
        address = 'about:blank';
      }
      const tab: ProductTab = {
        id: randomUUID(),
        windowId: target.id,
        webviewId: this.store.workspaces.viewId(),
        kind: 'remote',
        title: '新页面',
        url: address,
        popup: { provisionalId: popup.provisionalId, status: 'pending' },
      };
      state.tabs.push(tab);
      if (popup.disposition !== 4) {
        target.activeTabId = tab.id;
        state.activeWindowId = target.id;
      }
      this.store.operations.savePopupWorkspace(state, popup.provisionalId, tab.id);
      this.push(state.tenantId);
    }
  }
}
function url(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192)
    throw new RemoteKitError('invalid_request', '无效网址');
  if (value === 'about:blank') return value;
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new RemoteKitError('invalid_request', '无效输入');
    return parsed.href;
  } catch {
    throw new RemoteKitError('invalid_request', '请输入 HTTP 或 HTTPS 网址');
  }
}
