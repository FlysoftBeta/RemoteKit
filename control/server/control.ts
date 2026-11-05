import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BackgroundPolicy } from './background-policy';
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
import { FileUploads, FileUploadError, type InternalFileRequest, type UploadLimits } from './file-uploads';
import type { Readable } from 'node:stream';
import { QualityState } from './quality';
import type { ControlState, Device } from '../client/types';
import type { Endpoint, RtcSignal } from './endpoint';
import { Store } from './store';
import { AuthError } from './security-crypto';
import { ViewerAuth, type ViewerSecurity } from './viewer-auth';
import { LoopbackRelay, rewriteSdp, selectLocalCandidate, type NetworkSimulation } from './network-sim.mjs';
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
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type FullscreenBinding = {
  page: PageFullscreen;
  viewId: string;
  browserIncarnation: string;
  instance: string;
  document: string;
};
export class Control extends EventEmitter {
  private unsubscribeSignals?: () => void;
  private unsubscribeActions?: () => void;
  private closed = false;
  private readonly serverIncarnation = randomUUID();
  private snapshotSequences = new Map<string, number>();
  private applyingOperations = new Map<string, OperationReceipt>();
  private connectionLeases = new Map<string, string>();
  private queues = new Map<string, Promise<unknown>>();
  private errors = new Map<string, string>();
  private connections = new Map<string, string>();
  private signalBindings = new Map<
    string,
    {
      tenant: string;
      lease: string;
      attemptId: string;
      resolve: (sdp: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      answered: boolean;
    }
  >();
  private configurations = new Map<string, string>();
  private ticking = false;
  private endpointGeneration = 0;
  private tenantEndpointGenerations = new Map<string, number>();
  private pendingRtcChecks = new Set<string>();
  private mediaGeneration(tenant: string) {
    return this.tenantEndpointGenerations.get(tenant) ?? this.endpointGeneration;
  }
  private relays = new Map<string, LoopbackRelay>();
  private diagnosticTenants = new Set<string>();
  private readonly viewerAuth: ViewerAuth;
  private viewers = new Map<
    string,
    {
      id: string;
      authentication?: { identity: string; valid: () => boolean };
      revoke: (reason: 'another-viewer' | 'logout') => void;
      viewport?: ViewerViewport;
      security?: ViewerSecurity;
    }
  >();
  private lastViewports = new Map<string, ViewerViewport>();
  private started = new Set<string>();
  private backgroundPolicy = new BackgroundPolicy();
  private transitions = new Map<string, { action: string; at: number }>();
  private siteApplications = new Map<string, { encoded: string; applied: boolean; browserPid?: number }>();
  private mediaApplications = new Map<string, { encoded: string; applied: boolean; browserPid?: number }>();
  private qualityStates = new Map<string, QualityState>();
  private actualMediaPolicies = new Map<string, AppliedMediaPolicy>();
  private dialogs = new Map<
    string,
    (PageDialog & {
      viewId: string;
      requestId: string;
      browserIncarnation: string;
      instance: string;
      document: string;
    })[]
  >();
  private pageFullscreen = new Map<string, FullscreenBinding>();
  private browserIncarnations = new Map<string, string>();
  private fileAuthorizations = new Map<string, string>();
  private fileRequests = new Map<string, InternalFileRequest[]>();
  private uploads: FileUploads;
  private readonly library: FileLibrary;
  constructor(
    readonly store: Store,
    readonly endpoint: Endpoint,
    private simulation?: NetworkSimulation,
    fileLimits: UploadLimits = FILE_LIMITS,
  ) {
    super();
    this.unsubscribeActions = endpoint.onClientAction?.((event) => {
      void this.handleEndpointAction(event).catch(() => {});
    });
    this.unsubscribeSignals = endpoint.onSignal?.((event) => this.receiveSignal(event));
    this.viewerAuth = new ViewerAuth(
      store,
      endpoint,
      (tenant, viewer, workspace) => {
        const lease = this.viewers.get(tenant)?.id;
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
        const lease = this.viewers.get(tenant)?.id;
        if (!lease || !this.validSecurity(tenant, viewer)) return;
        this.fileAuthorizations.delete(tenant);
        if (viewer.locked) this.pageFullscreen.delete(tenant);
        this.qualityState(tenant).resetFeedback();
        void this.serial(tenant, async () => {
          if (!this.validSecurity(tenant, viewer)) return;
          await this.uploads.revoke(tenant, lease);
          if (!viewer.locked) {
            this.fileAuthorizations.delete(tenant);
            this.authorizeFiles(tenant);
          }
          if (viewer.locked) await this.reconcileProduct(tenant);
        }).catch(() => {});
      },
    );
    this.library = new FileLibrary(store.db, endpoint, fileLimits);
    this.uploads = new FileUploads(
      endpoint,
      (tenant, lease, authentication) => {
        this.assertProductViewer(tenant, lease);
        if ((this.viewers.get(tenant)?.authentication?.identity ?? '') !== authentication)
          throw new ApiError(401, '上传登录身份已改变');
      },
      (tenant, id) => this.fileRequests.get(tenant)?.find((request) => request.id === id),
      fileLimits,
    );
  }
  private receiveSignal(event: RtcSignal) {
    const binding = this.signalBindings.get(event.connectionId);
    if (
      !binding ||
      binding.tenant !== event.tenantId ||
      this.connections.get(event.tenantId) !== event.connectionId
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
      binding.reject(new Error(event.signal.message));
    else
      this.emit('rtc.signal', event.tenantId, binding.lease, {
        type: 'rtc.signal',
        connectionId: event.connectionId,
        attemptId: binding.attemptId,
        signal: event.signal,
      });
  }
  private clearSignal(connectionId: string) {
    this.connectionLeases.delete(connectionId);
    const binding = this.signalBindings.get(connectionId);
    if (!binding) return;
    clearTimeout(binding.timer);
    this.signalBindings.delete(connectionId);
    if (!binding.answered) binding.reject(new Error('媒体协商已取消'));
  }
  serial<T>(tenant: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(tenant) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(tenant, next);
    void next
      .finally(() => {
        if (this.queues.get(tenant) === next) this.queues.delete(tenant);
      })
      .catch(() => {});
    return next;
  }
  state(tenant: string) {
    return {
      ...this.store.state(tenant),
      endpointError: this.errors.get(tenant) ?? null,
      endpointGeneration: this.mediaGeneration(tenant),
      ...(this.simulation ? { networkSimulation: this.simulation } : {}),
    };
  }
  async getState(tenant: string) {
    this.diagnosticTenants.add(tenant);
    return this.serial(tenant, async () => {
      const state = this.store.state(tenant);
      if (state.pendingClose?.awaiting) {
        try {
          const snapshot = await this.endpoint.request('session.snapshot', tenant);
          await this.observe(state, snapshot);
        } catch (error) {
          this.errors.set(tenant, String(error));
        }
      }
      return this.state(tenant);
    });
  }
  private async observe(state: ControlState, snapshot: any) {
    if (!Array.isArray(snapshot?.views)) return;
    const before = JSON.stringify(state);
    const events = (Array.isArray(snapshot.events) ? snapshot.events : []).filter(
      (event: any) =>
        event?.type === 'view.closed' &&
        typeof event.eventId === 'string' &&
        typeof event.viewId === 'string',
    );
    for (const tab of [...state.tabs]) {
      const view = snapshot.views.find((view: any) => String(view.viewId ?? view.id) === tab.webviewId);
      if (events.some((event: any) => event.viewId === tab.webviewId) || view?.close_state === 'closed') {
        state.tabs = state.tabs.filter((item) => item.id !== tab.id);
        if (state.pendingClose?.id === tab.id) state.pendingClose = null;
        if (state.activeTabId === tab.id) state.activeTabId = state.tabs[0]?.id ?? null;
        if (state.splitTabId === tab.id) state.splitTabId = null;
        continue;
      }
      if (state.pendingClose?.id === tab.id) {
        this.observePendingClose(state, snapshot, view);
      }
      if (!view) continue;
      if (typeof view.title === 'string') tab.title = view.title.slice(0, 120);
      if (typeof view.canGoBack === 'boolean') tab.canGoBack = view.canGoBack;
      if (typeof view.canGoForward === 'boolean') tab.canGoForward = view.canGoForward;
      if (typeof view.loading === 'boolean') tab.loading = view.loading;
      if (typeof view.url === 'string' && /^(https?:\/\/|about:blank$)/.test(view.url)) {
        if (
          !tab.pendingUrl ||
          view.url === tab.pendingUrl ||
          view.loading === false ||
          view.navigationStatus === 'completed'
        ) {
          tab.url = view.url;
          delete tab.pendingUrl;
        }
      }
    }
    if (JSON.stringify(state) !== before) this.store.save(state);
    if (events.length) {
      const result = await this.endpoint.request('session.events.ack', state.tenantId, {
        eventIds: events.map((event: any) => event.eventId),
      });
      if (result?.accepted !== true) throw new Error('Endpoint关闭事件尚未确认');
    }
  }
  async reconcile(tenant: string) {
    if (!this.diagnosticTenants.has(tenant)) return this.reconcileProduct(tenant);
    const state = this.store.state(tenant);
    try {
      await this.endpoint.request('session.ensure', tenant);
      const snapshot = await this.endpoint.request('session.snapshot', tenant);
      await this.observe(state, snapshot);
      const actual: { viewId?: string; id?: string }[] = snapshot?.views ?? [];
      // Hide old foreground views before showing new ones, avoiding transient atlas overflow.
      const ordered = [...state.tabs].sort(
        (a, b) =>
          Number(a.id === state.activeTabId || a.id === state.splitTabId) -
          Number(b.id === state.activeTabId || b.id === state.splitTabId),
      );
      for (const tab of ordered) {
        if (state.pendingClose?.awaiting && state.pendingClose.id === tab.id) continue;
        const config = {
          viewId: tab.webviewId,
          width: state.device.width,
          height: state.device.height,
          device: state.device,
          visible: tab.id === state.activeTabId || tab.id === state.splitTabId,
        };
        const key = tenant + '/' + tab.webviewId;
        const encoded = JSON.stringify(config);
        const exists = actual.some((view) => String(view.viewId ?? view.id) === tab.webviewId);
        if (!exists) {
          this.configurations.delete(key);
          await this.endpoint.request('view.ensure', tenant, { ...config, url: tab.pendingUrl ?? tab.url });
        }
        if (this.configurations.get(key) !== encoded) {
          await this.endpoint.request('view.configure', tenant, config);
          this.configurations.set(key, encoded);
        }
      }
      for (const view of actual) {
        const viewId = String(view.viewId ?? view.id);
        if (!state.tabs.some((tab) => tab.webviewId === viewId))
          await this.endpoint.request('view.close', tenant, { viewId, force: true, orphan: true });
      }
      this.errors.delete(tenant);
    } catch (error) {
      this.errors.set(tenant, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await Promise.all(
        [
          ...new Set([
            ...this.diagnosticTenants,
            ...this.viewers.keys(),
            ...this.started,
            ...this.pendingRtcChecks,
          ]),
        ].map((tenant) =>
          this.serial(tenant, async () => {
            if (this.pendingRtcChecks.has(tenant)) await this.checkReconnectedRtc(tenant);
            await this.reconcile(tenant);
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
    await Promise.allSettled([...this.queues.values()]);
    this.closeRelays();
  }
  closeRelays() {
    for (const id of this.signalBindings.keys()) this.clearSignal(id);
    for (const relay of this.relays.values()) relay.close();
    this.relays.clear();
  }
  private async checkReconnectedRtc(tenant: string) {
    const snapshot = await this.endpoint.request('session.snapshot', tenant);
    const connectionId = this.connections.get(tenant);
    if (connectionId && (snapshot?.rtc?.active !== true || snapshot.rtc.connectionId !== connectionId)) {
      this.clearSignal(connectionId);
      this.relays.get(connectionId)?.close();
      this.relays.delete(connectionId);
      this.connections.delete(tenant);
      const security = this.viewers.get(tenant)?.security;
      if (security) this.viewerAuth.forgetPeer(tenant, security);
      this.tenantEndpointGenerations.set(tenant, this.mediaGeneration(tenant) + 1);
      const lease = this.viewers.get(tenant)?.id;
      if (security && lease) this.emit('auth', tenant, lease, this.authState(tenant, security));
      this.push(tenant);
      // A mismatching peer is not authorized by the surviving Viewer lease.
      if (snapshot?.rtc?.active === true && typeof snapshot.rtc.connectionId === 'string')
        await this.endpoint.request('rtc.close', tenant, { connectionId: snapshot.rtc.connectionId });
    }
    const security = this.viewers.get(tenant)?.security;
    if (security) await this.viewerAuth.restore(tenant, security);
    this.pendingRtcChecks.delete(tenant);
  }
  async endpointReady(identity?: { processChanged: boolean }) {
    // Stdio ready means a new child; only authenticated remote hello can prove
    // that a replacement management socket still belongs to the same process.
    if (identity?.processChanged !== false) return this.reconcileAll();
    this.fileAuthorizations.clear();
    this.configurations.clear();
    this.siteApplications.clear();
    this.mediaApplications.clear();
    for (const tenant of this.connections.keys()) this.pendingRtcChecks.add(tenant);
    for (const tenant of new Set([...this.diagnosticTenants, ...this.viewers.keys(), ...this.started])) {
      await this.serial(tenant, async () => {
        try {
          await this.checkReconnectedRtc(tenant);
          await this.reconcile(tenant);
        } catch (error) {
          this.errors.set(tenant, error instanceof Error ? error.message : String(error));
        }
        this.push(tenant);
      });
    }
  }
  async reconcileAll() {
    this.endpointGeneration =
      Math.max(this.endpointGeneration, ...this.tenantEndpointGenerations.values()) + 1;
    this.tenantEndpointGenerations.clear();
    this.pendingRtcChecks.clear();
    this.closeRelays();
    this.connections.clear();
    for (const [tenant, viewer] of this.viewers)
      if (viewer.security) this.viewerAuth.forgetPeer(tenant, viewer.security);
    this.connectionLeases.clear();
    this.fileAuthorizations.clear();
    this.configurations.clear();
    this.started.clear();
    this.transitions.clear();
    this.backgroundPolicy.clear();
    this.siteApplications.clear();
    this.mediaApplications.clear();
    this.actualMediaPolicies.clear();
    this.pageFullscreen.clear();
    this.dialogs.clear();
    for (const tenant of new Set([...this.diagnosticTenants, ...this.viewers.keys()]))
      await this.serial(tenant, async () => {
        if (this.diagnosticTenants.has(tenant)) {
          const state = this.store.state(tenant);
          state.pendingClose = null;
          this.store.save(state);
        }
        const viewer = this.viewers.get(tenant);
        if (viewer?.security) {
          this.emit('auth', tenant, viewer.id, this.authState(tenant, viewer.security));
          void this.viewerAuth.capabilities(tenant, viewer.security);
        }
        await this.reconcile(tenant);
        this.push(tenant);
      }).catch(() => {});
  }
  async action(tenant: string, body: any) {
    this.diagnosticTenants.add(tenant);
    return this.serial(tenant, async () => {
      const state = this.store.state(tenant);
      let reloadDevicePages = false;
      const tab = state.tabs.find((tab) => tab.id === body.id);
      const requireTab = () => {
        if (!tab) throw new ApiError(404, '标签页不存在');
        return tab;
      };
      switch (body.type) {
        case 'tab.create': {
          if (state.tabs.length >= 16) throw new ApiError(400, '最多支持 16 个标签页');
          const id = randomUUID();
          state.tabs.push({
            id,
            title: String(body.title ?? '新标签页').slice(0, 120),
            url: url(body.url),
            webviewId: this.store.viewId(),
          });
          state.activeTabId = id;
          break;
        }
        case 'tab.navigate': {
          const current = requireTab();
          const address = url(body.url);
          await this.endpoint.request('view.navigate', tenant, { viewId: current.webviewId, url: address });
          current.url = address;
          current.pendingUrl = address;
          break;
        }
        case 'tab.command': {
          const current = requireTab();
          if (!['back', 'forward', 'reload', 'stop'].includes(body.command))
            throw new ApiError(400, '未知导航命令');
          await this.endpoint.request('view.command', tenant, {
            viewId: current.webviewId,
            command: body.command,
          });
          break;
        }
        case 'tab.close': {
          const current = requireTab();
          if (state.pendingClose && state.pendingClose.id !== current.id)
            throw new ApiError(409, '请先处理当前页面的关闭请求');
          const replying = body.confirm === true || body.cancel === true;
          if (
            replying &&
            (state.pendingClose?.id !== current.id ||
              !body.requestId ||
              state.pendingClose.requestId !== body.requestId)
          )
            throw new ApiError(409, '关闭请求已失效');
          const result = replying
            ? await this.replyClose(tenant, current.webviewId!, state.pendingClose!, body.confirm === true)
            : await this.endpoint.request('view.close', tenant, { viewId: current.webviewId, force: false });
          if (body.cancel === true) {
            state.pendingClose = null;
            this.store.save(state);
            return this.state(tenant);
          }
          if (
            result?.pending ||
            result?.accepted ||
            result?.status === 'pending' ||
            result?.status === 'accepted'
          ) {
            state.pendingClose = replying
              ? { ...state.pendingClose!, awaiting: true }
              : this.pendingClose(current.id, result);
            this.store.save(state);
            return this.state(tenant);
          }
          if (!(result?.closed === true || result?.status === 'closed'))
            throw new ApiError(409, 'Endpoint 尚未确认页面关闭');
          state.tabs = state.tabs.filter((item) => item.id !== current.id);
          state.pendingClose = null;
          if (state.activeTabId === current.id) state.activeTabId = state.tabs[0]?.id ?? null;
          if (state.splitTabId === current.id) state.splitTabId = null;
          break;
        }
        case 'tab.activate':
          state.activeTabId = requireTab().id;
          if (state.splitTabId === state.activeTabId) state.splitTabId = null;
          break;
        case 'split.set':
          if (body.id !== null) requireTab();
          state.splitTabId = body.id === state.activeTabId ? null : body.id;
          break;
        case 'device.set': {
          const next = device(body.device);
          reloadDevicePages = next.mode !== state.device.mode;
          state.device = next;
          break;
        }
        default:
          throw new ApiError(400, '未知操作');
      }
      this.store.save(state);
      try {
        await this.reconcile(tenant);
        if (reloadDevicePages)
          for (const item of state.tabs)
            await this.endpoint.request('view.command', tenant, {
              viewId: item.webviewId,
              command: 'reload',
            });
      } catch (error) {
        this.errors.set(tenant, error instanceof Error ? error.message : String(error));
      }
      return this.state(tenant);
    });
  }
  async offer(tenant: string, body: any, lease?: string) {
    if (
      body.type !== 'offer' ||
      typeof body.sdp !== 'string' ||
      body.sdp.length > 900000 ||
      !body.sdp.startsWith('v=0')
    )
      throw new ApiError(400, '无效的 SDP offer');
    const receivedAt = performance.now();
    return this.serial(tenant, async () => {
      const timings: Record<string, number> = { queueMs: performance.now() - receivedAt };
      if (lease) this.assertViewer(tenant, lease);
      if (!this.diagnosticTenants.has(tenant)) this.qualityState(tenant).resetFeedback();
      await this.reconcile(tenant);
      timings.reconcileEndMs = performance.now() - receivedAt;
      const security = lease ? this.viewers.get(tenant)?.security : undefined;
      const previous = this.connections.get(tenant);
      if (previous) {
        this.clearSignal(previous);
        try {
          await this.endpoint.request('rtc.close', tenant, { connectionId: previous });
        } finally {
          this.relays.get(previous)?.close();
          this.relays.delete(previous);
          this.connections.delete(tenant);
        }
      }
      if (security) this.viewerAuth.forgetPeer(tenant, security);
      const connectionId = randomUUID();
      let relay: LoopbackRelay | undefined;
      try {
        let offerSdp = body.sdp;
        if (this.simulation) {
          relay = await new LoopbackRelay(this.simulation, selectLocalCandidate(offerSdp)).bind();
          offerSdp = rewriteSdp(offerSdp, relay.serverAddress);
        }
        const trickle = body.trickle === true && !!lease && !!this.endpoint.onSignal && !this.simulation;
        if (body.trickle === true && !trickle) throw new ApiError(400, '当前连接要求完整 ICE 收集');
        let answer;
        if (trickle) {
          if (typeof body.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.attemptId))
            throw new ApiError(400, '无效媒体连接尝试');
          this.connections.set(tenant, connectionId);
          let resolve!: (sdp: string) => void, reject!: (error: Error) => void;
          const pending = new Promise<string>((yes, no) => {
            resolve = yes;
            reject = no;
          });
          // Observe rejection immediately, including cancellation while the acceptance RPC is pending.
          void pending.catch(() => {});
          const timer = setTimeout(() => reject(new Error('RTC answer 等待超时')), 15000);
          this.signalBindings.set(connectionId, {
            tenant,
            lease: lease!,
            attemptId: body.attemptId,
            resolve,
            reject,
            timer,
            answered: false,
          });
          const accepted = await this.endpoint.request('rtc.offer', tenant, {
            connectionId,
            sdp: offerSdp,
            trickle: true,
            ...(security ? { authRequired: true } : {}),
          });
          timings.endpointAcceptedMs = performance.now() - receivedAt;
          if (accepted?.accepted !== true || accepted.connectionId !== connectionId)
            throw new ApiError(502, 'Endpoint未接受媒体协商');
          answer = { sdp: await pending };
          timings.answerReadyMs = performance.now() - receivedAt;
          this.assertViewer(tenant, lease!);
        } else
          answer = await this.endpoint.request('rtc.offer', tenant, {
            connectionId,
            sdp: offerSdp,
            ...(security ? { authRequired: true } : {}),
          });
        if (typeof answer?.sdp !== 'string' || !answer.sdp.startsWith('v=0'))
          throw new ApiError(502, 'Endpoint 未返回有效 answer');
        // Full-gather can finish after a Viewer takeover too. Publish both the
        // connection and its action authority only for the current Viewer.
        if (lease) this.assertViewer(tenant, lease);
        let answerSdp = answer.sdp;
        if (relay) {
          relay.setServer(selectLocalCandidate(answerSdp, { requireLoopback: true }));
          answerSdp = rewriteSdp(answerSdp, relay.clientAddress);
          this.relays.set(connectionId, relay);
        }
        this.connections.set(tenant, connectionId);
        if (security) await this.viewerAuth.bind(tenant, security, connectionId);
        if (lease) {
          this.assertViewer(tenant, lease);
          this.connectionLeases.set(connectionId, lease);
        }
        this.fileAuthorizations.delete(tenant);
        this.authorizeFiles(tenant);
        return {
          type: 'answer',
          sdp: answerSdp,
          connectionId,
          endpointGeneration: this.mediaGeneration(tenant),
          negotiationTiming: timings,
          signalingMode: trickle
            ? 'trickle'
            : this.simulation
              ? 'full-gather-simulation'
              : 'full-gather-compatibility',
          ...(relay ? { networkSimulation: relay.snapshot() } : {}),
        };
      } catch (error) {
        if (security) this.viewerAuth.forgetPeer(tenant, security);
        this.clearSignal(connectionId);
        if (this.connections.get(tenant) === connectionId) this.connections.delete(tenant);
        relay?.close();
        this.relays.delete(connectionId);
        await this.endpoint.request('rtc.close', tenant, { connectionId }).catch(() => {});
        throw error;
      }
    });
  }
  async ice(tenant: string, body: any) {
    if (!body.connectionId || this.connections.get(tenant) !== body.connectionId)
      throw new ApiError(403, '连接不属于当前会话');
    if (this.simulation) throw new ApiError(400, '网络实验使用完整 gathered SDP，拒绝额外 trickle 候选');
    const binding = this.signalBindings.get(body.connectionId);
    if (binding && body.attemptId !== binding.attemptId) throw new ApiError(403, '媒体连接尝试已失效');
    if (
      !body.candidate ||
      typeof body.candidate.candidate !== 'string' ||
      body.candidate.candidate.length > 16384 ||
      typeof body.candidate.sdpMid !== 'string' ||
      !Number.isInteger(body.candidate.sdpMLineIndex)
    )
      throw new ApiError(400, '无效 ICE candidate');
    return this.endpoint.request('rtc.ice', tenant, {
      connectionId: body.connectionId,
      candidate: body.candidate,
    });
  }
  async closeRtc(tenant: string, body: any, lease?: string) {
    if (lease) this.assertViewer(tenant, lease);
    const owned = this.connections.get(tenant) === body.connectionId;
    if (owned) this.clearSignal(body.connectionId);
    return this.serial(tenant, async () => {
      if (lease) this.assertViewer(tenant, lease);
      if (this.connections.get(tenant) !== body.connectionId) {
        if (owned) return { closed: true };
        throw new ApiError(403, '连接不属于当前会话');
      }
      this.clearSignal(body.connectionId);
      const security = this.viewers.get(tenant)?.security;
      if (security) {
        this.viewerAuth.forgetPeer(tenant, security);
        this.emit('auth', tenant, lease, this.authState(tenant, security));
        void this.viewerAuth.capabilities(tenant, security);
      }
      try {
        await this.endpoint.request('rtc.close', tenant, { connectionId: body.connectionId });
      } finally {
        this.relays.get(body.connectionId)?.close();
        this.relays.delete(body.connectionId);
        this.connections.delete(tenant);
      }
      return { closed: true };
    });
  }
  networkStats(tenant: string, body: any) {
    if (this.connections.get(tenant) !== body.connectionId) throw new ApiError(403, '连接不属于当前会话');
    return this.relays.get(body.connectionId)?.snapshot() ?? { enabled: false };
  }
  productState(tenant: string): ProductState {
    this.snapshotSequences.set(tenant, (this.snapshotSequences.get(tenant) ?? 0) + 1);
    const workspace = this.store.workspace(tenant);
    return {
      operationReceipts: this.store.recentOperations(tenant),
      serverIncarnation: this.serverIncarnation,
      snapshotSequence: this.snapshotSequences.get(tenant)!,
      operationGeneration: this.store.operationGeneration(tenant),
      user: this.store.userForTenant(tenant)!,
      workspace,
      pageFullscreen: this.fullscreenBinding(workspace)?.page,
      pageDialogs: (this.dialogs.get(tenant) ?? []).map(
        ({ viewId, requestId, browserIncarnation, instance, document, ...dialog }) => dialog,
      ),
      fileRequests: (this.fileRequests.get(tenant) ?? []).map(({ binding, ...request }) => request),
      quality: this.qualityFor(tenant, workspace),
      endpointGeneration: this.mediaGeneration(tenant),
      endpointError: this.errors.get(tenant) ?? null,
      viewer: {
        connected: this.viewers.has(tenant),
        trickleIce: !!this.endpoint.onSignal && !this.simulation,
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
    const viewer = this.viewers.get(workspace.tenantId),
      binding = this.pageFullscreen.get(workspace.tenantId);
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
      viewer = this.viewers.get(tenant),
      previous = this.pageFullscreen.get(tenant);
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
        const view = views.find((view) => String(view.viewId ?? view.view ?? view.id) === tab.webviewId);
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
    if (next) this.pageFullscreen.set(tenant, next);
    else this.pageFullscreen.delete(tenant);
    return next?.page.target !== previous?.page.target || next?.page.windowId !== previous?.page.windowId;
  }
  private push(tenant: string) {
    this.emit('state', tenant, this.productState(tenant));
  }
  private saveProduct(state: ProductWorkspace) {
    const operation = this.applyingOperations.get(state.tenantId);
    if (operation) {
      this.store.saveOperation(state, operation);
      this.push(state.tenantId);
    } else {
      const changed = this.store.saveWorkspace(state);
      if (changed) this.push(state.tenantId);
    }
  }
  assertViewer(tenant: string, lease: string) {
    const viewer = this.viewers.get(tenant);
    if (viewer?.id !== lease) throw new ApiError(409, '此窗口已由另一个 Viewer 接管');
    if (viewer.authentication && !viewer.authentication.valid()) throw new ApiError(401, '登录已过期');
  }
  private validSecurity(tenant: string, security: ViewerSecurity) {
    const viewer = this.viewers.get(tenant);
    return viewer?.security === security && viewer.authentication?.valid() === true;
  }
  private authState(tenant: string, security: ViewerSecurity) {
    return this.viewerAuth.state(
      security,
      !!this.endpoint.onSignal && !this.simulation,
      this.mediaGeneration(tenant),
    );
  }
  productEpoch(tenant: string, lease: string) {
    return this.viewers.get(tenant)?.id === lease ? this.viewers.get(tenant)?.security?.epoch : undefined;
  }
  productAllowed(tenant: string, lease: string) {
    const viewer = this.viewers.get(tenant);
    return (
      viewer?.id === lease &&
      (!viewer.authentication || viewer.authentication.valid()) &&
      !viewer.security?.locked
    );
  }
  private assertProductViewer(tenant: string, lease: string, epoch?: number) {
    this.assertViewer(tenant, lease);
    const security = this.viewers.get(tenant)?.security;
    if (security?.locked || (epoch !== undefined && security?.epoch !== epoch))
      throw new ApiError(423, 'Viewer 已锁定');
  }
  async pollFaceAuth() {
    await Promise.all(
      [...this.viewers].map(
        ([tenant, viewer]) => viewer.security && this.viewerAuth.poll(tenant, viewer.security),
      ),
    );
  }
  endpointOffline() {
    for (const [tenant, viewer] of this.viewers)
      if (viewer.security) {
        viewer.security.face = { available: false };
        void this.viewerAuth.lock(tenant, viewer.security, false, false);
      }
  }
  async attachViewer(
    tenant: string,
    id: string,
    revoke: (reason: 'another-viewer' | 'logout') => void,
    authentication?: { identity: string; valid: () => boolean },
    initialUnlocked?: boolean,
  ) {
    this.qualityState(tenant).resetFeedback();
    const old = this.viewers.get(tenant);
    if (old?.security) {
      void this.viewerAuth.lock(tenant, old.security).catch(() => {});
      this.viewerAuth.forgetPeer(tenant, old.security);
    }
    const user = this.store.userForTenant(tenant);
    const security =
      user && initialUnlocked !== undefined ? this.viewerAuth.create(user, initialUnlocked) : undefined;
    this.pageFullscreen.delete(tenant);
    this.viewers.set(tenant, { id, revoke, authentication, security });
    old?.revoke('another-viewer');
    if (security) this.emit('auth', tenant, id, this.authState(tenant, security));
    const previous = this.connections.get(tenant);
    if (previous) this.clearSignal(previous);
    return this.serial(tenant, async () => {
      if (old) await this.uploads.revoke(tenant, old.id);
      this.assertViewer(tenant, id);
      await this.closeMedia(tenant);
      try {
        await this.reconcileProduct(tenant);
      } catch {
        /* State carries Endpoint error; controls still work offline. */
      }
      if (security) void this.viewerAuth.capabilities(tenant, security);
      this.push(tenant);
      return security?.locked ? undefined : this.productState(tenant);
    });
  }
  async detachViewer(tenant: string, id: string) {
    const viewer = this.viewers.get(tenant);
    if (viewer?.id !== id) return;
    this.viewers.delete(tenant);
    this.pageFullscreen.delete(tenant);
    if (viewer.security) {
      void this.viewerAuth.lock(tenant, viewer.security).catch(() => {});
      this.viewerAuth.forgetPeer(tenant, viewer.security);
    }
    const previous = this.connections.get(tenant);
    if (previous) this.clearSignal(previous);
    return this.serial(tenant, async () => {
      await this.uploads.revoke(tenant, id);
      // A replacement owns media now; an old close must not hide or close it.
      if (this.viewers.has(tenant)) return;
      await this.closeMedia(tenant);
      try {
        await this.reconcileProduct(tenant);
      } catch {}
      this.push(tenant);
    });
  }
  async logout(tenant: string, authenticationIdentity: string) {
    const viewer = this.viewers.get(tenant);
    if (viewer?.authentication?.identity === authenticationIdentity) {
      viewer.revoke('logout');
      await this.detachViewer(tenant, viewer.id);
    }
  }
  private async closeMedia(tenant: string) {
    const previous = this.connections.get(tenant);
    if (!previous) return;
    this.clearSignal(previous);
    try {
      await this.endpoint.request('rtc.close', tenant, { connectionId: previous });
    } catch {
    } finally {
      this.connections.delete(tenant);
      this.relays.get(previous)?.close();
      this.relays.delete(previous);
    }
  }
  async viewerRequest(tenant: string, lease: string, method: string, params: any) {
    this.assertViewer(tenant, lease);
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw new ApiError(400, '需要参数对象');
    if (['tenantId', 'tenant', 'userId', 'user'].some((key) => key in params))
      throw new ApiError(400, '客户端不能指定用户或租户');
    const security = this.viewers.get(tenant)?.security;
    if (method.startsWith('auth.')) {
      if (!security) throw new ApiError(400, '当前会话不支持锁屏');
      try {
        await this.viewerAuth.request(tenant, security, method, params);
        this.assertViewer(tenant, lease);
        return this.authState(tenant, security);
      } catch (error) {
        if (error instanceof AuthError) throw new ApiError(error.status, error.message);
        throw error;
      }
    }
    if (method === 'clock.ping')
      return {
        serverTime: Date.now(),
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
        if (!this.store.userForTenant(tenant)?.isAdmin) throw new ApiError(403, '需要管理员权限');
      };
      authorize();
      if (method === 'admin.get') return this.store.adminStatus();
      try {
        return await this.store.setRegistrationCredential(tenant, params.serverCredential, authorize);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, error instanceof Error ? error.message : String(error));
      }
    }
    if (method.startsWith('library.')) {
      try {
        return await this.library.request(
          tenant,
          method,
          params,
          () => this.assertProductViewer(tenant, lease, epoch),
          (id) => this.fileRequests.get(tenant)?.find((request) => request.id === id),
        );
      } catch (error) {
        if (error instanceof FileUploadError) throw new ApiError(error.status, error.message);
        throw error;
      }
    }
    if (method === 'operation.status') return this.operationStatus(tenant, params);
    // Browser actions belong to the reliable Endpoint DataChannel.
    if (method === 'action' && params.type === 'settings.update')
      return this.productAction(tenant, params, lease);
    if (method === 'action') throw new ApiError(400, '产品操作必须通过WebRTC数据通道');
    if (method === 'viewport') return this.viewport(tenant, params, lease, epoch);
    return this.serial(tenant, async () => {
      this.assertProductViewer(tenant, lease, epoch);
      if (['files.begin', 'files.commit', 'files.cancel'].includes(method)) {
        if (security) throw new ApiError(400, '产品文件必须通过WebRTC数据通道');
        try {
          const authentication = this.viewers.get(tenant)?.authentication?.identity ?? '';
          const result =
            method === 'files.begin'
              ? await this.uploads.begin(tenant, lease, authentication, params)
              : method === 'files.commit'
                ? await this.uploads.commit(tenant, lease, authentication, params)
                : await this.uploads.cancel(tenant, lease, authentication, params);
          try {
            this.collectDialogs(
              tenant,
              this.store.workspace(tenant),
              await this.endpoint.request('session.snapshot', tenant),
            );
          } catch {}
          return result;
        } catch (error) {
          if (error instanceof FileUploadError) throw new ApiError(error.status, error.message);
          throw error;
        }
      }
      if (method === 'clock.ping')
        return {
          serverTime: Date.now(),
          ...(typeof params.clientTime === 'number' ? { clientTime: params.clientTime } : {}),
        };
      if (method === 'feedback') {
        if (this.diagnosticTenants.has(tenant)) return { accepted: false };
        const state = this.store.workspace(tenant),
          viewport = this.viewers.get(tenant)?.viewport;
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
        const accepted = this.qualityState(tenant).observe(params, Date.now(), visible);
        this.push(tenant);
        return { accepted };
      }
      throw new ApiError(400, '未知 WebSocket 方法');
    });
  }
  private viewport(tenant: string, body: any, lease: string, epoch?: number) {
    return this.serial(tenant, async () => {
      this.assertProductViewer(tenant, lease, epoch);
      const state = this.store.workspace(tenant);
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
        throw new ApiError(400, '无效的显示区域');
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
          throw new ApiError(400, '无效的窗口显示区域');
        ids.add(w.windowId);
      }
      // Preflight cannot mutate live observations or replace a valid viewport.
      const feasibility = new QualityState().snapshot(state, body);
      if (feasibility.resourceLimitation) throw new ApiError(400, feasibility.resourceLimitation);
      this.viewers.get(tenant)!.viewport = {
        devicePixelRatio: body.devicePixelRatio,
        refreshHz: body.refreshHz,
        windows: body.windows.map((w: any) => ({
          windowId: w.windowId,
          width: w.width,
          height: w.height,
          visible: w.visible,
        })),
      };
      this.lastViewports.set(tenant, this.viewers.get(tenant)!.viewport!);
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
    if (operation.operationGeneration !== this.store.operationGeneration(tenant))
      return { ...operation, status: 'expired', error: '操作收据代次已过期，请核对当前工作区' };
    return (
      this.store.operation(tenant, operation.operationId)?.receipt ?? {
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
      lease = this.connectionLeases.get(connectionId);
    if (!lease || this.connections.get(tenant) !== connectionId) return;
    const security = this.viewers.get(tenant)?.security;
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
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // A replaced peer never receives a late result from an accepted old operation.
    if (
      this.connections.get(tenant) !== connectionId ||
      !this.productAllowed(tenant, lease) ||
      (security && event.authEpoch !== security.peer?.appliedEpoch)
    )
      return;
    await this.endpoint
      .request('rtc.actionResult', tenant, {
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
    const epoch = this.viewers.get(tenant)?.security?.epoch;
    return this.serial(tenant, async () => {
      this.assertProductViewer(tenant, lease, epoch);
      if (connectionId && this.connections.get(tenant) !== connectionId)
        throw new ApiError(409, 'RTC连接已被替换');
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          operation.operationId,
        ) ||
        !operation.action ||
        JSON.stringify(operation.action).length > 32768
      )
        throw new ApiError(400, '无效产品操作');
      if (operation.operationGeneration !== this.store.operationGeneration(tenant))
        return {
          operationId: operation.operationId,
          operationGeneration: operation.operationGeneration,
          status: 'expired',
          error: '操作收据代次已过期',
        };
      const payload = operationPayload(operation.action),
        existing = this.store.operation(tenant, operation.operationId);
      if (existing) {
        if (existing.payload !== payload) throw new ApiError(409, '同一操作ID不能用于不同内容');
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
          ? { browserIncarnation: this.browserIncarnations.get(tenant) }
          : {}),
      };
      if (!this.store.reserveOperation(tenant, payload, receipt)) {
        this.push(tenant);
        return { ...receipt, status: 'expired', error: '操作收据已轮换，请核对工作区' };
      }
      receipt.status = 'applying';
      this.store.saveOperation(this.store.workspace(tenant), receipt);
      this.applyingOperations.set(tenant, receipt);
      try {
        const result = await this.applyProductAction(tenant, operation.action);
        if (!['committed', 'rejected'].includes(receipt.status)) {
          receipt.status =
            ['tab.navigate', 'tab.command'].includes(operation.action.type) && result.application
              ? 'applying'
              : 'committed';
          if (result.application) receipt.application = result.application;
          const current = this.store.workspace(tenant),
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
        const durable = this.store.operation(tenant, operation.operationId)?.receipt;
        if (durable && ['committed', 'rejected'].includes(durable.status)) {
          Object.assign(receipt, durable);
        } else {
          receipt.status = error instanceof ApiError ? 'rejected' : 'unknown';
          receipt.error = error instanceof Error ? error.message : String(error);
          const workspace = this.store.workspace(tenant);
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
          this.store.saveOperation(workspace, receipt);
        }
      } finally {
        this.applyingOperations.delete(tenant);
        this.store.saveOperation(this.store.workspace(tenant), receipt);
        this.push(tenant);
      }
      return receipt;
    });
  }
  async productAction(tenant: string, body: ProductAction, lease?: string): Promise<ProductActionResult> {
    const epoch = this.viewers.get(tenant)?.security?.epoch;
    return this.serial(tenant, async () => {
      if (lease) this.assertProductViewer(tenant, lease, epoch);
      return this.applyProductAction(tenant, body);
    });
  }
  private async applyProductAction(tenant: string, body: ProductAction): Promise<ProductActionResult> {
    const state = this.store.workspace(tenant),
      action = body as any;
    const tab = () => {
      const found = state.tabs.find((t) => t.id === action.tabId);
      if (!found) throw new ApiError(404, '标签页不存在');
      return found;
    };
    const window = () => {
      const found = state.windows.find((w) => w.id === action.windowId);
      if (!found) throw new ApiError(404, '窗口不存在');
      return found;
    };
    const navigationUrl = (value: unknown) => {
      try {
        return resolveNavigation(value, state.settings.searchEngine);
      } catch (error) {
        throw new ApiError(400, error instanceof Error ? error.message : '无效网址或搜索内容');
      }
    };
    const createTab = (windowId: string, files = false) => {
      if (state.tabs.length >= 32) throw new ApiError(400, '最多支持32个标签页');
      const kind = files ? 'files' : action.url === undefined ? 'start' : 'remote';
      const next: ProductTab = {
        id: randomUUID(),
        windowId,
        webviewId: this.store.viewId(),
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
        if (state.windows.length >= 8) throw new ApiError(400, '最多支持8个窗口');
        const id = randomUUID();
        state.windows.push({ id, activeTabId: null, weight: 1 });
        createTab(id);
        break;
      }
      case 'window.activate':
        state.activeWindowId = window().id;
        break;
      case 'window.layout': {
        if (!['side-by-side', 'focused'].includes(action.mode)) throw new ApiError(400, '无效的窗口布局');
        state.layoutMode = action.mode;
        if (action.weights !== undefined) {
          if (
            !Array.isArray(action.weights) ||
            action.weights.length > 8 ||
            new Set(action.weights.map((w: any) => w.windowId)).size !== action.weights.length
          )
            throw new ApiError(400, '无效的窗口比例');
          for (const entry of action.weights) {
            const w = state.windows.find((w) => w.id === entry.windowId);
            if (
              !w ||
              typeof entry.weight !== 'number' ||
              !Number.isFinite(entry.weight) ||
              entry.weight < 0.1 ||
              entry.weight > 10
            )
              throw new ApiError(400, '无效的窗口比例');
            w.weight = entry.weight;
          }
        }
        break;
      }
      case 'window.close': {
        const w = window();
        if (state.pendingWindowCloseId && state.pendingWindowCloseId !== w.id)
          throw new ApiError(409, '请先处理当前关闭请求');
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
          throw new ApiError(409, '目标窗口已打开我的文件');
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
          operation = this.applyingOperations.get(tenant);
        if (t.lifecycleRecovery || t.lifecycleRecoveryError)
          throw new ApiError(409, t.lifecycleRecoveryError ?? '页面正在恢复');
        if (operation)
          t.navigation = {
            operationId: operation.operationId,
            operationGeneration: operation.operationGeneration,
            status: 'applying',
            browserIncarnation: this.browserIncarnations.get(tenant),
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
          const snapshot = await this.endpoint.request('session.snapshot', tenant),
            exists = (snapshot.views ?? []).some(
              (view: any) => String(view.viewId ?? view.view ?? view.id) === t.webviewId,
            );
          const region = this.viewers.get(tenant)?.viewport?.windows.find((w) => w.windowId === t.windowId);
          if (exists)
            await this.endpoint.request('view.navigate', tenant, {
              viewId: t.webviewId,
              url: address,
              ...metadata,
            });
          else
            await this.endpoint.request('view.ensure', tenant, {
              viewId: t.webviewId,
              url: address,
              width: region?.width ?? 1440,
              height: region?.height ?? 900,
              device: { mode: 'desktop', deviceScaleFactor: this.qualityFor(tenant, state).effectiveDpr },
              visible: false,
              ...metadata,
            });
        } else
          await this.endpoint.request('view.navigate', tenant, {
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
          throw new ApiError(400, '未知导航命令');
        if (isLocalTab(t)) break;
        if (t.lifecycleRecovery || t.lifecycleRecoveryError)
          throw new ApiError(409, t.lifecycleRecoveryError ?? '页面正在恢复');
        const operation = this.applyingOperations.get(tenant);
        // Stop owns a command receipt, not a document navigation. Retain the
        // pending navigation's original rollback state until its own result.
        if (operation && action.command !== 'stop') {
          t.navigation = {
            operationId: operation.operationId,
            operationGeneration: operation.operationGeneration,
            status: 'applying',
            browserIncarnation: this.browserIncarnations.get(tenant),
            previousUrl: t.url,
            previousKind: t.kind ?? 'remote',
          };
          this.saveProduct(state);
        }
        await this.endpoint.request('view.command', tenant, {
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
            throw new ApiError(409, '关闭请求已失效');
          await this.replyClose(tenant, t.webviewId, state.pendingClose, action.confirm === true);
          if (action.cancel === true) {
            const windowId = state.pendingWindowCloseId;
            state.pendingClose = null;
            state.pendingWindowCloseId = null;
            for (const pending of this.store.pendingOperations(tenant))
              if (
                pending.receipt.operationId !== this.applyingOperations.get(tenant)?.operationId &&
                ((pending.action.type === 'tab.close' && pending.action.tabId === t.id) ||
                  (pending.action.type === 'window.close' && pending.action.windowId === windowId))
              ) {
                pending.receipt.status = 'rejected';
                pending.receipt.error = '用户取消关闭';
                delete pending.receipt.application;
                this.store.saveOperation(state, pending.receipt);
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
          throw new ApiError(400, '无效的页面对话回复');
        const latest = await this.endpoint.request('session.snapshot', tenant);
        this.collectDialogs(tenant, state, latest);
        const dialog = this.dialogs.get(tenant)?.find((d) => d.id === action.dialogId);
        if (!dialog || !state.tabs.some((t) => t.id === dialog.tabId && t.webviewId === dialog.viewId))
          throw new ApiError(410, '页面对话已过期');
        if (dialog.kind === 'alert' && !action.accept) throw new ApiError(400, '提示对话仅支持确认');
        const result = await this.endpoint.request('view.page.reply', tenant, {
          viewId: dialog.viewId,
          requestId: dialog.requestId,
          browserIncarnation: dialog.browserIncarnation,
          instance: dialog.instance,
          document: dialog.document,
          accept: action.accept,
          ...(action.text === undefined ? {} : { text: action.text }),
        });
        if (result?.accepted !== true || result?.browser?.ok !== true)
          throw new ApiError(409, 'Endpoint未确认页面对话回复');
        this.dialogs.set(
          tenant,
          (this.dialogs.get(tenant) ?? []).filter((d) => d.id !== dialog.id),
        );
        this.push(tenant);
        break;
      }
      case 'page.exitFullscreen': {
        const binding = this.fullscreenBinding(state);
        if (!binding || action.target !== binding.page.target)
          throw new ApiError(409, '网页全屏已结束或页面已更换');
        const { viewId, browserIncarnation, instance, document } = binding;
        await this.endpoint.request('view.page.exitFullscreen', tenant, {
          viewId,
          browserIncarnation,
          instance,
          document,
        });
        this.pageFullscreen.delete(tenant);
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
          throw new ApiError(400, '无效的设置');
        if ('searchEngine' in value && !SEARCH_ENGINES.some((engine) => engine.value === value.searchEngine))
          throw new ApiError(400, '无效的搜索引擎');
        if ('qualityPreference' in value && !['quality', 'auto', 'smooth'].includes(value.qualityPreference))
          throw new ApiError(400, '无效的画面质量');
        if (
          'clientScaleOverride' in value &&
          value.clientScaleOverride !== null &&
          (typeof value.clientScaleOverride !== 'number' ||
            !Number.isFinite(value.clientScaleOverride) ||
            value.clientScaleOverride < 0.5 ||
            value.clientScaleOverride > 4)
        )
          throw new ApiError(400, '显示比例需0.5–4');
        if ('memorySaverEnabled' in value && typeof value.memorySaverEnabled !== 'boolean')
          throw new ApiError(400, '无效的内存设置');
        if ('autoFullscreen' in value && typeof value.autoFullscreen !== 'boolean')
          throw new ApiError(400, '无效的全屏设置');
        if (
          'audioChannels' in value &&
          (!value.audioChannels ||
            typeof value.audioChannels !== 'object' ||
            Array.isArray(value.audioChannels) ||
            Object.keys(value.audioChannels).length !== 2 ||
            typeof value.audioChannels.left !== 'boolean' ||
            typeof value.audioChannels.right !== 'boolean')
        )
          throw new ApiError(400, '声道设置需同时提供左右开关');
        if ('showStats' in value && typeof value.showStats !== 'boolean')
          throw new ApiError(400, '无效的统计设置');
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
            throw new Error();
          origin = parsed.origin;
        } catch {
          throw new ApiError(400, '站点需有效HTTP(S) origin，最长2048字符');
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
          throw new ApiError(400, '无效的站点设置');
        }
        let target: ProductTab | undefined;
        if (action.tabId !== undefined) {
          target = tab();
          if (!URL.canParse(target.url) || new URL(target.url).origin !== origin)
            throw new ApiError(400, '标签页不属于该站点');
        }
        if (!(origin in state.sites) && Object.keys(state.sites).length >= 4096)
          throw new ApiError(400, '站点设置已达上限');
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
        throw new ApiError(400, '未知产品操作');
    }
    const operation = this.applyingOperations.get(tenant);
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
      const latest = this.store.workspace(tenant),
        applied = this.siteApplications.get(tenant)?.applied === true;
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
    this.backgroundPolicy.forget(state.tenantId + '/' + tab.webviewId);
    this.transitions.delete(state.tenantId + '/' + tab.webviewId);
  }
  private pendingClose(id: string, result: any, windowId?: string): PendingClose {
    if (
      typeof result.browserIncarnation !== 'string' ||
      !result.browserIncarnation ||
      result.instance === undefined ||
      result.document === undefined
    )
      throw new ApiError(409, 'Endpoint关闭请求缺少页面身份');
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
      throw new ApiError(409, '关闭请求已失效');
    const result = await this.endpoint.request('view.close.reply', tenant, {
      viewId,
      browserIncarnation: pending.browserIncarnation,
      instance: pending.instance,
      document: pending.document,
      requestId: pending.nativeRequestId,
      accept,
    });
    if (result?.accepted !== true || result?.browser?.ok !== true)
      throw new ApiError(409, 'Endpoint未确认关闭请求回复');
    return result;
  }
  private async closeProductTab(state: ProductWorkspace, tab: ProductTab) {
    if (state.pendingClose && state.pendingClose.id !== tab.id)
      throw new ApiError(409, '请先处理当前关闭请求');
    if (isLocalTab(tab) || (tab.popup && tab.popup.status !== 'adopted')) {
      this.removeProductTab(state, tab);
      return;
    }
    const result = await this.endpoint.request('view.close', state.tenantId, {
      viewId: tab.webviewId,
      force: false,
    });
    if (result.closed === true) this.removeProductTab(state, tab);
    else if (result.accepted || result.pending)
      state.pendingClose = this.pendingClose(tab.id, result, tab.windowId);
    else throw new ApiError(409, 'Endpoint 尚未确认页面关闭');
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
    if (this.diagnosticTenants.has(tenant)) return;
    if (!this.viewers.has(tenant) && !this.started.has(tenant)) return;
    try {
      if (!this.viewers.has(tenant)) {
        await this.observeOffline(tenant);
        return;
      }
      const desired = this.store.workspace(tenant);
      let resourceLimitation = this.qualityFor(tenant, desired).resourceLimitation;
      if (!resourceLimitation) {
        // This operation caches preferences without starting an offline Browser.
        await this.applySites(tenant, desired);
        await this.applyMedia(tenant);
        if (!this.viewers.has(tenant)) {
          if (this.started.has(tenant)) await this.observeOffline(tenant);
          return;
        }
        const ensured = await this.endpoint.request('session.ensure', tenant);
        this.started.add(tenant);
        if (!this.viewers.has(tenant)) {
          await this.observeOffline(tenant);
          return;
        }
        const applied = this.siteApplications.get(tenant)!;
        if (
          !applied.applied ||
          (ensured.browserPid !== undefined && applied.browserPid !== ensured.browserPid)
        )
          await this.applySites(tenant, desired, true, ensured.browserPid);
        if (!this.siteApplications.get(tenant)?.applied)
          throw new Error('站点身份尚未应用，等待Endpoint恢复');
        const media = this.mediaApplications.get(tenant)!;
        if (!media.applied || (ensured.browserPid !== undefined && media.browserPid !== ensured.browserPid))
          await this.applyMedia(tenant, true, ensured.browserPid);
      }
      // Native source/encoder application may finish after views or RTC exist.
      // Accepted policy is cached before their creation; stats retain unknown actuals.
      const snapshot = await this.endpoint.request('session.snapshot', tenant),
        state = this.store.workspace(tenant),
        actual: any[] = Array.isArray(snapshot?.views) ? snapshot.views : [];
      this.backgroundPolicy.retain(
        tenant,
        new Set(
          snapshot.running === false || resourceLimitation
            ? []
            : actual
                .filter((v) => state.tabs.some((t) => t.webviewId === String(v.viewId ?? v.view ?? v.id)))
                .map((v) => String(v.viewId ?? v.view ?? v.id)),
        ),
      );
      if (typeof snapshot.browserIncarnation === 'string')
        this.browserIncarnations.set(tenant, snapshot.browserIncarnation);
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
          const saved = this.store.operation(tenant, nav.operationId);
          if (saved && !['committed', 'rejected'].includes(saved.receipt.status)) {
            saved.receipt.status = 'unknown';
            saved.receipt.resolved = true;
            saved.receipt.resolution = 'target-retired';
            saved.receipt.error = '原页面实例已结束，导航执行结果未知';
            delete saved.receipt.application;
            this.store.saveOperation(state, saved.receipt);
          }
        }
      }
      const appliedPolicy = snapshot.stats?.mediaPolicy?.applied;
      if (appliedPolicy === null) this.actualMediaPolicies.delete(tenant);
      else if (appliedPolicy) this.actualMediaPolicies.set(tenant, appliedPolicy);
      const closedViews = await this.consumeClosedEvents(state, snapshot);
      if (!this.viewers.has(tenant)) {
        await this.observeOffline(tenant);
        return;
      }
      await this.observePopups(state, snapshot);
      this.store.prunePopupReceipts(tenant);
      if (state.pendingClose)
        this.observePendingClose(
          state,
          snapshot,
          actual.find(
            (v) =>
              String(v.viewId ?? v.view ?? v.id) ===
              state.tabs.find((t) => t.id === state.pendingClose?.id)?.webviewId,
          ),
        );
      for (const t of [...state.tabs]) {
        const current = actual.find((v) => String(v.viewId ?? v.view ?? v.id) === t.webviewId);
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
            const operation = this.store.operation(tenant, nav.operationId),
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
              const active = this.applyingOperations.get(tenant);
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
              this.store.saveOperation(state, operation.receipt);
            }
          }
        }
        for (const terminal of current.navigationOperations ?? [])
          if (['committed', 'cancelled', 'failed', 'superseded'].includes(terminal.state)) {
            const saved = this.store.operation(tenant, terminal.operationId);
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
              this.store.saveOperation(state, saved.receipt);
            }
            const active = this.applyingOperations.get(tenant);
            if (
              active &&
              active.operationId === terminal.operationId &&
              active.operationGeneration === terminal.operationGeneration
            ) {
              Object.assign(active, saved.receipt);
              delete active.application;
            }
            await this.endpoint
              .request('view.navigation.ack', tenant, {
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
      for (const pending of this.store.pendingOperations(tenant)) {
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
          this.store.saveOperation(state, pending.receipt);
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
          this.store.saveOperation(state, pending.receipt);
        }
        const removed =
          (a.type === 'tab.close' && !state.tabs.some((tab) => tab.id === a.tabId)) ||
          (a.type === 'window.close' && !state.windows.some((window) => window.id === a.windowId));
        if (removed) {
          pending.receipt.status = 'committed';
          delete pending.receipt.application;
          this.store.saveOperation(state, pending.receipt);
          const active = this.applyingOperations.get(tenant);
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
        throw new Error('Browser已离线，页面保留并等待恢复');
      const viewer = this.viewers.get(tenant),
        viewport = viewer?.viewport ?? this.lastViewports.get(tenant);
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
        const current = actual.find((v) => String(v.viewId ?? v.view ?? v.id) === t.webviewId),
          key = tenant + '/' + t.webviewId;
        if (!current) {
          this.configurations.delete(key);
          continue;
        }
        this.backgroundPolicy.forget(key);
        const config = { viewId: t.webviewId, visible: false, requireRunning: true },
          encoded = JSON.stringify(config);
        if (
          current.visible === true ||
          (current.visible !== false && this.configurations.get(key) !== encoded)
        ) {
          this.configurations.delete(key);
          await this.endpoint.request('view.configure', tenant, config);
        }
        // This hide-only cache deliberately differs from the complete remote
        // config, so the next navigation reapplies bounds/device/visibility.
        this.configurations.set(key, encoded);
      }
      for (const t of resourceLimitation ? [] : ordered) {
        if (!this.viewers.has(tenant)) {
          await this.observeOffline(tenant);
          return;
        }
        const current = actual.find((v) => String(v.viewId ?? v.view ?? v.id) === t.webviewId),
          key = tenant + '/' + t.webviewId,
          visible = wanted(t),
          region = viewport?.windows.find((w) => w.windowId === t.windowId),
          dpr = this.qualityFor(tenant, state).effectiveDpr;
        if (t.popup?.status === 'failed') continue;
        if (visible) this.backgroundPolicy.forget(key);
        const actualState = current?.actual ?? 0,
          recovering = current?.recovery?.pending === true;
        const lifecycleBlocked =
          current?.lifecycle_uncertain === true || !!t.lifecycleRecovery || !!t.lifecycleRecoveryError;
        let readyToShow = !lifecycleBlocked && actualState === 0 && !current?.pending;
        if (!lifecycleBlocked && visible && actualState !== 0 && !current?.pending) {
          const attempt = this.transitions.get(key);
          if (!attempt || attempt.action !== 'restore' || Date.now() - attempt.at > 12000) {
            await this.endpoint.request('view.lifecycle', tenant, { viewId: t.webviewId, action: 'restore' });
            this.transitions.set(key, { action: 'restore', at: Date.now() });
          }
          readyToShow = false;
        } else if (readyToShow && this.transitions.get(key)?.action === 'restore')
          this.transitions.delete(key);
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
            const adopted = await this.endpoint.request('view.adopt', tenant, {
              ...config,
              url: t.url,
              provisionalId: t.popup.provisionalId,
            });
            if (adopted?.accepted !== true || adopted.completed !== true)
              throw new Error('Endpoint尚未完成新页面收养');
            t.popup = { provisionalId: t.popup.provisionalId, status: 'adopted' };
            this.saveProduct(state);
            this.configurations.set(key, encoded);
          } catch (error) {
            // Transport failures are retried with the same binding, never with view.ensure.
            if (String(error).includes('popup_not_pending')) {
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
          await this.endpoint.request('view.ensure', tenant, { ...config, url: t.pendingUrl ?? t.url });
          this.configurations.set(key, encoded);
        } else if (
          this.configurations.get(key) !== encoded ||
          (!recovering && current.visible !== undefined && current.visible !== config.visible)
        ) {
          await this.endpoint.request(
            'view.configure',
            tenant,
            lifecycleBlocked ? { ...config, requireRunning: true } : config,
          );
          this.configurations.set(key, encoded);
        }
        if (lifecycleBlocked) {
          await this.advanceLifecycleRecovery(
            state,
            t,
            current,
            snapshot.browserIncarnation,
            visible && viewer === this.viewers.get(tenant) && !viewer?.security?.locked,
          );
          continue;
        }
        if (t.pendingUaReloadOrigin && readyToShow) {
          const requestedOrigin = t.pendingUaReloadOrigin;
          if (current && new URL(t.url).origin === requestedOrigin)
            await this.endpoint.request('view.command', tenant, { viewId: t.webviewId, command: 'reload' });
          delete t.pendingUaReloadOrigin;
          this.saveProduct(state);
        }
        await this.maintainBackgroundTab(state, t, current, visible, snapshot.browserIncarnation);
      }
      for (const v of actual) {
        const viewId = String(v.viewId ?? v.view ?? v.id);
        if (!state.tabs.some((t) => t.webviewId === viewId) && !v.provisional && !closedViews.has(viewId))
          await this.endpoint.request('view.close', tenant, { viewId, force: true, orphan: true });
      }
      if (resourceLimitation) {
        const changed = this.errors.get(tenant) !== resourceLimitation;
        this.errors.set(tenant, resourceLimitation);
        if (changed) this.push(tenant);
      } else {
        const previousError = this.errors.delete(tenant);
        if (previousError) this.push(tenant);
      }
    } catch (error) {
      this.pageFullscreen.delete(tenant);
      this.dialogs.delete(tenant);
      this.fileRequests.delete(tenant);
      this.uploads.retireMissing(tenant, new Set());
      this.errors.set(tenant, error instanceof Error ? error.message : String(error));
      this.push(tenant);
      throw error;
    }
  }
  private async observeOffline(tenant: string) {
    // Snapshot is read-only. Maintenance must never revive a missing Browser/view.
    const snapshot = await this.endpoint.request('session.snapshot', tenant),
      state = this.store.workspace(tenant);
    this.backgroundPolicy.retain(
      tenant,
      new Set(
        snapshot.running === false
          ? []
          : (snapshot.views ?? [])
              .filter((v: any) => state.tabs.some((t) => t.webviewId === String(v.viewId ?? v.view ?? v.id)))
              .map((v: any) => String(v.viewId ?? v.view ?? v.id)),
      ),
    );
    await this.consumeClosedEvents(state, snapshot);
    this.dialogs.delete(tenant);
    this.fileRequests.delete(tenant);
    this.uploads.retireMissing(tenant, new Set());
    if (state.pendingClose) {
      const tab = state.tabs.find((t) => t.id === state.pendingClose?.id);
      this.observePendingClose(
        state,
        snapshot,
        (snapshot.views ?? []).find((v: any) => String(v.viewId ?? v.view ?? v.id) === tab?.webviewId),
      );
      this.saveProduct(state);
    }
    if (snapshot.running === false) {
      this.started.delete(tenant);
      this.siteApplications.delete(tenant);
      this.mediaApplications.delete(tenant);
      this.actualMediaPolicies.delete(tenant);
      this.push(tenant);
      return;
    }
    for (const tab of state.tabs) {
      const current = (snapshot.views ?? []).find(
        (view: any) => String(view.viewId ?? view.view ?? view.id) === tab.webviewId,
      );
      const lifecycleBlocked = this.observeLifecycleRecovery(
        state,
        tab,
        current,
        snapshot.browserIncarnation,
      );
      if (!current) continue;
      const key = tenant + '/' + tab.webviewId;
      if (current.visible !== false) {
        await this.endpoint.request('view.configure', tenant, {
          viewId: tab.webviewId,
          visible: false,
          requireRunning: true,
        });
        this.configurations.delete(key);
      }
      if (lifecycleBlocked)
        await this.advanceLifecycleRecovery(state, tab, current, snapshot.browserIncarnation, false);
      else await this.maintainBackgroundTab(state, tab, current, false, snapshot.browserIncarnation);
    }
    this.saveProduct(state);
    const previousError = this.errors.delete(tenant);
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
      } else if (recovery.phase === 'unloaded' || Date.now() - recovery.submittedAt > 15000) {
        tab.lifecycleRecoveryError = '无法确认页面恢复结果，请关闭此标签页后重新打开';
      }
    }
    if (tab.lifecycleRecovery?.phase === 'unloaded' && this.viewers.has(state.tenantId))
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
    const saved = this.store.operation(state.tenantId, nav.operationId);
    if (!saved || ['committed', 'rejected'].includes(saved.receipt.status)) return;
    saved.receipt.status = 'unknown';
    saved.receipt.resolved = true;
    saved.receipt.resolution = 'target-retired';
    saved.receipt.error = '原页面实例已结束，导航执行结果未知';
    delete saved.receipt.application;
    this.store.saveOperation(state, saved.receipt);
  }
  private lifecycleError(error: unknown) {
    const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
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
    tab.lifecycleRecovery = { browserIncarnation, generation, phase: action, submittedAt: Date.now() };
    tab.restoring = true;
    this.saveProduct(state);
    try {
      const result = await this.endpoint.request('view.lifecycle', state.tenantId, {
        viewId: tab.webviewId,
        action,
        requireRunning: true,
        browserIncarnation,
        lifecycleGeneration: generation,
      });
      if (result?.accepted !== true) throw new Error('Endpoint 未确认请求');
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
    const action = this.backgroundPolicy.action(
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
    const attempt = this.transitions.get(key);
    if (attempt?.action === action && Date.now() - attempt.at <= 12000) return;
    await this.endpoint.request('view.lifecycle', tenant, {
      viewId: tab.webviewId,
      action,
      requireRunning: true,
    });
    this.transitions.set(key, { action, at: Date.now() });
    if (action === 'freeze') this.backgroundPolicy.freezeRequested(key);
  }
  private qualityState(tenant: string) {
    let state = this.qualityStates.get(tenant);
    if (!state) this.qualityStates.set(tenant, (state = new QualityState()));
    return state;
  }
  private qualityFor(tenant: string, workspace = this.store.workspace(tenant)) {
    return this.qualityState(tenant).snapshot(
      workspace,
      this.viewers.get(tenant)?.viewport ?? this.lastViewports.get(tenant),
      Date.now(),
      this.diagnosticTenants.has(tenant),
      this.actualMediaPolicies.get(tenant) ?? null,
    );
  }
  private async applyMedia(tenant: string, force = false, browserPid?: number) {
    const requested = this.qualityFor(tenant).requested,
      encoded = JSON.stringify(requested),
      previous = this.mediaApplications.get(tenant);
    if (!force && previous?.encoded === encoded && previous.applied) return;
    this.mediaApplications.set(tenant, { encoded, applied: false, browserPid });
    const result = await this.endpoint.request(
      'session.mediaPolicy',
      tenant,
      requested as unknown as Record<string, unknown>,
    );
    if (result?.accepted !== true) throw new Error('Endpoint未接受媒体质量策略');
    this.mediaApplications.set(tenant, { encoded, applied: result.applied === true, browserPid });
  }
  private authorizeFiles(tenant: string) {
    const connectionId = this.connections.get(tenant),
      viewer = this.viewers.get(tenant);
    if (!connectionId || !viewer || !this.productAllowed(tenant, viewer.id)) return;
    const authEpoch = viewer.security?.peer?.appliedEpoch;
    if (viewer.security && (!authEpoch || viewer.security.peer?.connectionId !== connectionId)) return;
    const requests = (this.fileRequests.get(tenant) ?? [])
      .slice(0, 64)
      .map((request) => ({ id: request.id, binding: request.binding }));
    const params = { connectionId, requests, library: true, ...(authEpoch ? { authEpoch } : {}) };
    const encoded = JSON.stringify(params);
    if (this.fileAuthorizations.get(tenant) === encoded) return;
    this.fileAuthorizations.set(tenant, encoded);
    const retry = () => {
      if (this.fileAuthorizations.get(tenant) === encoded) this.fileAuthorizations.delete(tenant);
    };
    void this.endpoint.request('session.files.authorize', tenant, params).then((result) => {
      if (result?.accepted !== true) retry();
    }, retry);
  }
  private collectDialogs(tenant: string, state: ProductWorkspace, snapshot: any) {
    const found: (PageDialog & {
      viewId: string;
      requestId: string;
      browserIncarnation: string;
      instance: string;
      document: string;
    })[] = [];
    const files: InternalFileRequest[] = [];
    for (const view of Array.isArray(snapshot.views) ? snapshot.views : []) {
      const viewId = String(view.viewId ?? view.view ?? view.id),
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
            limits: { ...this.uploads.limits },
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
      JSON.stringify(found) !== JSON.stringify(this.dialogs.get(tenant) ?? []) ||
      JSON.stringify(files) !== JSON.stringify(this.fileRequests.get(tenant) ?? []);
    this.dialogs.set(tenant, found);
    this.fileRequests.set(tenant, files);
    this.authorizeFiles(tenant);
    this.uploads.retireMissing(tenant, new Set(files.map((request) => request.id)));
    if (changed) this.push(tenant);
  }
  async receiveFileUpload(
    tenant: string,
    authentication: string,
    ticket: string,
    source: Readable,
    contentLength?: string,
  ) {
    const viewer = this.viewers.get(tenant);
    if (viewer?.security?.locked) throw new ApiError(423, 'Viewer 已锁定');
    try {
      await this.uploads.stream(tenant, authentication, ticket, source, contentLength);
    } catch (error) {
      if (error instanceof FileUploadError) throw new ApiError(error.status, error.message);
      throw error;
    }
  }
  private async applySites(tenant: string, state: ProductWorkspace, force = false, browserPid?: number) {
    const sites = Object.fromEntries(
      Object.keys(state.sites)
        .sort()
        .filter((origin) => state.sites[origin].tabletUa)
        .map((origin) => [origin, { tabletUa: true }]),
    );
    const encoded = JSON.stringify(sites),
      previous = this.siteApplications.get(tenant);
    if (!force && previous?.encoded === encoded && previous.applied) return;
    this.siteApplications.set(tenant, { encoded, applied: false, browserPid });
    const result = await this.endpoint.request('session.sitePreferences', tenant, { sites });
    if (result?.accepted !== true) throw new Error('Endpoint未接受站点身份设置');
    this.siteApplications.set(tenant, { encoded, applied: result.applied === true, browserPid });
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
      const result = await this.endpoint.request('session.events.ack', state.tenantId, { eventIds });
      if (result?.accepted !== true) throw new Error('Endpoint关闭事件尚未确认');
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
        this.store.popupTabId(state.tenantId, popup.provisionalId) ||
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
        webviewId: this.store.viewId(),
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
      this.store.savePopupWorkspace(state, popup.provisionalId, tab.id);
      this.push(state.tenantId);
    }
  }
}
function url(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192) throw new ApiError(400, '无效网址');
  if (value === 'about:blank') return value;
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    return parsed.href;
  } catch {
    throw new ApiError(400, '请输入 HTTP 或 HTTPS 网址');
  }
}
function device(value: any): Device {
  if (
    !value ||
    !['desktop', 'tablet'].includes(value.mode) ||
    !Number.isInteger(value.width) ||
    value.width < 320 ||
    value.width > 4096 ||
    !Number.isInteger(value.height) ||
    value.height < 240 ||
    value.height > 4096 ||
    typeof value.deviceScaleFactor !== 'number' ||
    value.deviceScaleFactor < 0.5 ||
    value.deviceScaleFactor > 4 ||
    value.width * value.height * value.deviceScaleFactor ** 2 > 16777216
  )
    throw new ApiError(400, '设备尺寸或像素密度超出范围');
  return {
    mode: value.mode,
    width: value.width,
    height: value.height,
    deviceScaleFactor: value.deviceScaleFactor,
  };
}
