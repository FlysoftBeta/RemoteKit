import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ProductAction, ProductActionResult, ProductState, ProductWorkspace, ProductTab, ViewerViewport, PageDialog, AppliedMediaPolicy, PendingClose } from '../shared/product';
import { QualityController } from './quality';
import type { ControlState, Device } from '../client/types';
import type { Endpoint, RtcSignal } from './endpoint';
import { Store } from './store';
import { LoopbackRelay, rewriteSdp, selectLocalCandidate, type NetworkSimulation } from './network-sim.mjs';
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export class Control extends EventEmitter {
  private queues = new Map<string, Promise<unknown>>();
  private errors = new Map<string, string>();
  private connections = new Map<string, string>();
  private signalBindings = new Map<string, { tenant: string; lease: string; attemptId: string; resolve: (sdp: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; answered: boolean }>();
  private configurations = new Map<string, string>();
  private ticking = false;
  private endpointGeneration = 0;
  private relays = new Map<string, LoopbackRelay>();
  private diagnosticTenants = new Set<string>();
  private viewers = new Map<string, { id: string; authentication?: { identity: string; valid: () => boolean }; revoke: (reason: 'another-viewer' | 'logout') => void; viewport?: ViewerViewport; feedback?: Record<string, unknown> }>();
  private lastViewports = new Map<string, ViewerViewport>();
  private started = new Set<string>();
  private hiddenSince = new Map<string, number>();
  private transitions = new Map<string, { action: string; at: number }>();
  private siteApplications = new Map<string, { encoded: string; applied: boolean; browserPid?: number }>();
  private mediaApplications = new Map<string, { encoded: string; applied: boolean; browserPid?: number }>();
  private qualityControllers = new Map<string, QualityController>();
  private actualMediaPolicies = new Map<string, AppliedMediaPolicy>();
  private dialogs = new Map<string, (PageDialog & { viewId: string; requestId: string; browserIncarnation: string; instance: string; document: string })[]>();
  constructor(readonly store: Store, readonly endpoint: Endpoint, private simulation?: NetworkSimulation) {
    super(); endpoint.onSignal?.(event => this.receiveSignal(event));
  }
  private receiveSignal(event: RtcSignal) {
    const binding = this.signalBindings.get(event.connectionId);
    if (!binding || binding.tenant !== event.tenantId || this.connections.get(event.tenantId) !== event.connectionId) return;
    try { this.assertViewer(binding.tenant, binding.lease); } catch { this.clearSignal(event.connectionId); return; }
    if (event.signal.type === 'answer') { binding.answered = true; clearTimeout(binding.timer); binding.resolve(event.signal.sdp); }
    else if (event.signal.type === 'error' && !binding.answered) binding.reject(new Error(event.signal.message));
    else this.emit('rtc.signal', event.tenantId, binding.lease, { type: 'rtc.signal', connectionId: event.connectionId, attemptId: binding.attemptId, signal: event.signal });
  }
  private clearSignal(connectionId: string) {
    const binding = this.signalBindings.get(connectionId); if (!binding) return;
    clearTimeout(binding.timer); this.signalBindings.delete(connectionId);
    if (!binding.answered) binding.reject(new Error('媒体协商已取消'));
  }
  serial<T>(tenant: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(tenant) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(tenant, next); void next.finally(() => { if (this.queues.get(tenant) === next) this.queues.delete(tenant); }).catch(() => {});
    return next;
  }
  state(tenant: string) { return { ...this.store.state(tenant), endpointError: this.errors.get(tenant) ?? null, endpointGeneration: this.endpointGeneration, ...(this.simulation ? { networkSimulation: this.simulation } : {}) }; }
  async getState(tenant: string) {
    this.diagnosticTenants.add(tenant);
    return this.serial(tenant, async () => {
      const state = this.store.state(tenant);
      if (state.pendingClose?.awaiting) {
        try {
          const snapshot = await this.endpoint.request('session.snapshot', tenant);
          await this.observe(state, snapshot);
        } catch (error) { this.errors.set(tenant, String(error)); }
      }
      return this.state(tenant);
    });
  }
  private async observe(state: ControlState, snapshot: any) {
    if (!Array.isArray(snapshot?.views)) return;
    const before = JSON.stringify(state);
    const events = (Array.isArray(snapshot.events) ? snapshot.events : []).filter((event: any) => event?.type === 'view.closed' && typeof event.eventId === 'string' && typeof event.viewId === 'string');
    for (const tab of [...state.tabs]) {
      const view = snapshot.views.find((view: any) => String(view.viewId ?? view.id) === tab.webviewId);
      if (events.some((event: any) => event.viewId === tab.webviewId) || view?.close_state === 'closed') {
        state.tabs = state.tabs.filter(item => item.id !== tab.id); if (state.pendingClose?.id === tab.id) state.pendingClose = null;
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
        if (!tab.pendingUrl || view.url === tab.pendingUrl || view.loading === false || view.navigationStatus === 'completed') { tab.url = view.url; delete tab.pendingUrl; }
      }
    }
    if (JSON.stringify(state) !== before) this.store.save(state);
    if (events.length) { const result = await this.endpoint.request('session.events.ack', state.tenantId, { eventIds: events.map((event: any) => event.eventId) }); if (result?.accepted !== true) throw new Error('Endpoint关闭事件尚未确认'); }
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
      const ordered = [...state.tabs].sort((a, b) => Number(a.id === state.activeTabId || a.id === state.splitTabId) - Number(b.id === state.activeTabId || b.id === state.splitTabId));
      for (const tab of ordered) {
        if (state.pendingClose?.awaiting && state.pendingClose.id === tab.id) continue;
        const config = { viewId: tab.webviewId, width: state.device.width, height: state.device.height, device: state.device, visible: tab.id === state.activeTabId || tab.id === state.splitTabId };
        const key = tenant + '/' + tab.webviewId; const encoded = JSON.stringify(config);
        const exists = actual.some(view => String(view.viewId ?? view.id) === tab.webviewId);
        if (!exists) { this.configurations.delete(key); await this.endpoint.request('view.ensure', tenant, { ...config, url: tab.pendingUrl ?? tab.url }); }
        if (this.configurations.get(key) !== encoded) { await this.endpoint.request('view.configure', tenant, config); this.configurations.set(key, encoded); }
      }
      for (const view of actual) { const viewId = String(view.viewId ?? view.id); if (!state.tabs.some(tab => tab.webviewId === viewId)) await this.endpoint.request('view.close', tenant, { viewId, force: true, orphan: true }); }
      this.errors.delete(tenant);
    } catch (error) { this.errors.set(tenant, error instanceof Error ? error.message : String(error)); throw error; }
  }
  async tick() { if (this.ticking) return; this.ticking = true; try { await Promise.all([...new Set([...this.diagnosticTenants, ...this.viewers.keys(), ...this.started])].map(tenant => this.serial(tenant, () => this.reconcile(tenant)).catch(() => {}))); } finally { this.ticking = false; } }
  closeRelays() { for (const id of this.signalBindings.keys()) this.clearSignal(id); for (const relay of this.relays.values()) relay.close(); this.relays.clear(); }
  async reconcileAll() { this.endpointGeneration++; this.closeRelays(); this.connections.clear(); this.configurations.clear(); this.started.clear(); this.transitions.clear(); this.siteApplications.clear(); this.mediaApplications.clear(); this.actualMediaPolicies.clear(); this.dialogs.clear(); for (const tenant of new Set([...this.diagnosticTenants, ...this.viewers.keys()])) await this.serial(tenant, async () => { if (this.diagnosticTenants.has(tenant)) { const state = this.store.state(tenant); state.pendingClose = null; this.store.save(state); } await this.reconcile(tenant); this.push(tenant); }).catch(() => {}); }
  async action(tenant: string, body: any) {
    this.diagnosticTenants.add(tenant);
    return this.serial(tenant, async () => {
      const state = this.store.state(tenant);
      let reloadDevicePages = false;
      const tab = state.tabs.find(tab => tab.id === body.id);
      const requireTab = () => { if (!tab) throw new ApiError(404, '标签页不存在'); return tab; };
      switch (body.type) {
        case 'tab.create': {
          if (state.tabs.length >= 16) throw new ApiError(400, '最多支持 16 个标签页');
          const id = randomUUID(); state.tabs.push({ id, title: String(body.title ?? '新标签页').slice(0, 120), url: url(body.url), webviewId: this.store.viewId() }); state.activeTabId = id; break;
        }
        case 'tab.navigate': {
          const current = requireTab(); const address = url(body.url);
          await this.endpoint.request('view.navigate', tenant, { viewId: current.webviewId, url: address }); current.url = address; current.pendingUrl = address; break;
        }
        case 'tab.command': {
          const current = requireTab();
          if (!['back', 'forward', 'reload', 'stop'].includes(body.command)) throw new ApiError(400, '未知导航命令');
          await this.endpoint.request('view.command', tenant, { viewId: current.webviewId, command: body.command }); break;
        }
        case 'tab.close': {
          const current = requireTab();
          if (state.pendingClose && state.pendingClose.id !== current.id) throw new ApiError(409, '请先处理当前页面的关闭请求');
          const replying = body.confirm === true || body.cancel === true;
          if (replying && (state.pendingClose?.id !== current.id || !body.requestId || state.pendingClose.requestId !== body.requestId)) throw new ApiError(409, '关闭请求已失效');
          const result = replying ? await this.replyClose(tenant, current.webviewId!, state.pendingClose!, body.confirm === true) : await this.endpoint.request('view.close', tenant, { viewId: current.webviewId, force: false });
          if (body.cancel === true) { state.pendingClose = null; this.store.save(state); return this.state(tenant); }
          if (result?.pending || result?.accepted || result?.status === 'pending' || result?.status === 'accepted') { state.pendingClose = replying ? { ...state.pendingClose!, awaiting: true } : this.pendingClose(current.id, result); this.store.save(state); return this.state(tenant); }
          if (!(result?.closed === true || result?.status === 'closed')) throw new ApiError(409, 'Endpoint 尚未确认页面关闭');
          state.tabs = state.tabs.filter(item => item.id !== current.id);
          state.pendingClose = null;
          if (state.activeTabId === current.id) state.activeTabId = state.tabs[0]?.id ?? null;
          if (state.splitTabId === current.id) state.splitTabId = null; break;
        }
        case 'tab.activate': state.activeTabId = requireTab().id; if (state.splitTabId === state.activeTabId) state.splitTabId = null; break;
        case 'split.set': if (body.id !== null) requireTab(); state.splitTabId = body.id === state.activeTabId ? null : body.id; break;
        case 'device.set': { const next = device(body.device); reloadDevicePages = next.mode !== state.device.mode; state.device = next; break; }
        default: throw new ApiError(400, '未知操作');
      }
      this.store.save(state);
      try { await this.reconcile(tenant); if (reloadDevicePages) for (const item of state.tabs) await this.endpoint.request('view.command', tenant, { viewId: item.webviewId, command: 'reload' }); }
      catch (error) { this.errors.set(tenant, error instanceof Error ? error.message : String(error)); }
      return this.state(tenant);
    });
  }
  async offer(tenant: string, body: any, lease?: string) {
    if (body.type !== 'offer' || typeof body.sdp !== 'string' || body.sdp.length > 900000 || !body.sdp.startsWith('v=0')) throw new ApiError(400, '无效的 SDP offer');
    const receivedAt = performance.now();
    return this.serial(tenant, async () => {
      const timings: Record<string, number> = { queueMs: performance.now() - receivedAt };
      if (lease) this.assertViewer(tenant, lease);
      if (!this.diagnosticTenants.has(tenant)) this.qualityController(tenant).resetFeedback();
      await this.reconcile(tenant);
      timings.reconcileEndMs = performance.now() - receivedAt;
      const previous = this.connections.get(tenant);
      if (previous) { this.clearSignal(previous); try { await this.endpoint.request('rtc.close', tenant, { connectionId: previous }); } finally { this.relays.get(previous)?.close(); this.relays.delete(previous); this.connections.delete(tenant); } }
      const connectionId = randomUUID();
      let relay: LoopbackRelay | undefined;
      try {
        let offerSdp = body.sdp;
        if (this.simulation) { relay = await new LoopbackRelay(this.simulation, selectLocalCandidate(offerSdp)).bind(); offerSdp = rewriteSdp(offerSdp, relay.serverAddress); }
        const trickle = body.trickle === true && !!lease && !!this.endpoint.onSignal && !this.simulation;
        if (body.trickle === true && !trickle) throw new ApiError(400, '当前连接要求完整 ICE 收集');
        let answer;
        if (trickle) {
          if (typeof body.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.attemptId)) throw new ApiError(400, '无效媒体连接尝试');
          this.connections.set(tenant, connectionId);
          let resolve!: (sdp: string) => void, reject!: (error: Error) => void;
          const pending = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
          // Observe rejection immediately, including cancellation while the acceptance RPC is pending.
          void pending.catch(() => {});
          const timer = setTimeout(() => reject(new Error('RTC answer 等待超时')), 15000);
          this.signalBindings.set(connectionId, { tenant, lease: lease!, attemptId: body.attemptId, resolve, reject, timer, answered: false });
          const accepted = await this.endpoint.request('rtc.offer', tenant, { connectionId, sdp: offerSdp, trickle: true });
          timings.endpointAcceptedMs = performance.now() - receivedAt;
          if (accepted?.accepted !== true || accepted.connectionId !== connectionId) throw new ApiError(502, 'Endpoint未接受媒体协商');
          answer = { sdp: await pending };
          timings.answerReadyMs = performance.now() - receivedAt;
          this.assertViewer(tenant, lease!);
        } else answer = await this.endpoint.request('rtc.offer', tenant, { connectionId, sdp: offerSdp });
        if (typeof answer?.sdp !== 'string' || !answer.sdp.startsWith('v=0')) throw new ApiError(502, 'Endpoint 未返回有效 answer');
        let answerSdp = answer.sdp;
        if (relay) { relay.setServer(selectLocalCandidate(answerSdp, { requireLoopback: true })); answerSdp = rewriteSdp(answerSdp, relay.clientAddress); this.relays.set(connectionId, relay); }
        this.connections.set(tenant, connectionId);
        return { type: 'answer', sdp: answerSdp, connectionId, endpointGeneration: this.endpointGeneration, negotiationTiming: timings, signalingMode: trickle ? 'trickle' : this.simulation ? 'full-gather-simulation' : 'full-gather-compatibility', ...(relay ? { networkSimulation: relay.snapshot() } : {}) };
      } catch (error) { this.clearSignal(connectionId); if (this.connections.get(tenant) === connectionId) this.connections.delete(tenant); relay?.close(); await this.endpoint.request('rtc.close', tenant, { connectionId }).catch(() => {}); throw error; }
    });
  }
  async ice(tenant: string, body: any) {
    if (!body.connectionId || this.connections.get(tenant) !== body.connectionId) throw new ApiError(403, '连接不属于当前会话');
    if (this.simulation) throw new ApiError(400, '网络实验使用完整 gathered SDP，拒绝额外 trickle 候选');
    const binding = this.signalBindings.get(body.connectionId);
    if (binding && body.attemptId !== binding.attemptId) throw new ApiError(403, '媒体连接尝试已失效');
    if (!body.candidate || typeof body.candidate.candidate !== 'string' || body.candidate.candidate.length > 16384 || typeof body.candidate.sdpMid !== 'string' || !Number.isInteger(body.candidate.sdpMLineIndex)) throw new ApiError(400, '无效 ICE candidate');
    return this.endpoint.request('rtc.ice', tenant, { connectionId: body.connectionId, candidate: body.candidate });
  }
  async closeRtc(tenant: string, body: any, lease?: string) {
    if (lease) this.assertViewer(tenant, lease);
    const owned = this.connections.get(tenant) === body.connectionId;
    if (owned) this.clearSignal(body.connectionId);
    return this.serial(tenant, async () => {
      if (lease) this.assertViewer(tenant, lease);
      if (this.connections.get(tenant) !== body.connectionId) { if (owned) return { closed: true }; throw new ApiError(403, '连接不属于当前会话'); }
      this.clearSignal(body.connectionId);
      try { await this.endpoint.request('rtc.close', tenant, { connectionId: body.connectionId }); } finally { this.relays.get(body.connectionId)?.close(); this.relays.delete(body.connectionId); this.connections.delete(tenant); } return { closed: true };
    });
  }
  networkStats(tenant: string, body: any) {
    if (this.connections.get(tenant) !== body.connectionId) throw new ApiError(403, '连接不属于当前会话');
    return this.relays.get(body.connectionId)?.snapshot() ?? { enabled: false };
  }
  productState(tenant: string): ProductState {
    return { user: this.store.userForTenant(tenant)!, workspace: this.store.workspace(tenant), pageDialogs: (this.dialogs.get(tenant) ?? []).map(({ viewId, requestId, browserIncarnation, instance, document, ...dialog }) => dialog), quality: this.qualityFor(tenant), endpointGeneration: this.endpointGeneration, endpointError: this.errors.get(tenant) ?? null, viewer: { connected: this.viewers.has(tenant), trickleIce: !!this.endpoint.onSignal && !this.simulation }, integrations: { siteUa: true, lifecycle: true, popupAdoption: true }, constraints: { clientScaleMin: .5, clientScaleMax: 4 } };
  }
  private push(tenant: string) { this.emit('state', tenant, this.productState(tenant)); }
  private saveProduct(state: ProductWorkspace) { const changed = this.store.saveWorkspace(state); if (changed) this.push(state.tenantId); }
  assertViewer(tenant: string, lease: string) { const viewer = this.viewers.get(tenant); if (viewer?.id !== lease) throw new ApiError(409, '此窗口已由另一个 Viewer 接管'); if (viewer.authentication && !viewer.authentication.valid()) throw new ApiError(401, '登录已过期'); }
  async attachViewer(tenant: string, id: string, revoke: (reason: 'another-viewer' | 'logout') => void, authentication?: { identity: string; valid: () => boolean }) {
    this.qualityController(tenant).resetConnection();
    const old = this.viewers.get(tenant); this.viewers.set(tenant, { id, revoke, authentication }); old?.revoke('another-viewer');
    const previous = this.connections.get(tenant); if (previous) this.clearSignal(previous);
    return this.serial(tenant, async () => {
      this.assertViewer(tenant, id); await this.closeMedia(tenant);
      try { await this.reconcileProduct(tenant); } catch { /* State carries Endpoint error; controls still work offline. */ }
      this.push(tenant); return this.productState(tenant);
    });
  }
  async detachViewer(tenant: string, id: string) {
    if (this.viewers.get(tenant)?.id !== id) return;
    this.viewers.delete(tenant);
    const previous = this.connections.get(tenant); if (previous) this.clearSignal(previous);
    return this.serial(tenant, async () => {
      // A replacement owns media now; an old close must not hide or close it.
      if (this.viewers.has(tenant)) return;
      await this.closeMedia(tenant); try { await this.reconcileProduct(tenant); } catch { }
      this.push(tenant);
    });
  }
  async logout(tenant: string, authenticationIdentity: string) { const viewer = this.viewers.get(tenant); if (viewer?.authentication?.identity === authenticationIdentity) { viewer.revoke('logout'); await this.detachViewer(tenant, viewer.id); } }
  private async closeMedia(tenant: string) {
    const previous = this.connections.get(tenant); if (!previous) return;
    this.clearSignal(previous);
    try { await this.endpoint.request('rtc.close', tenant, { connectionId: previous }); } catch { }
    finally { this.connections.delete(tenant); this.relays.get(previous)?.close(); this.relays.delete(previous); }
  }
  async viewerRequest(tenant: string, lease: string, method: string, params: any) {
    this.assertViewer(tenant, lease);
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new ApiError(400, '需要参数对象');
    if (['tenantId', 'tenant', 'userId', 'user'].some(key => key in params)) throw new ApiError(400, '客户端不能指定用户或租户');
    if (method === 'admin.get' || method === 'admin.setRegistrationCredential') {
      const authorize = () => { this.assertViewer(tenant, lease); if (!this.store.userForTenant(tenant)?.isAdmin) throw new ApiError(403, '需要管理员权限'); };
      authorize();
      if (method === 'admin.get') return this.store.adminStatus();
      try { return await this.store.setRegistrationCredential(tenant, params.serverCredential, authorize); }
      catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, error instanceof Error ? error.message : String(error)); }
    }
    if (method === 'action') return this.productAction(tenant, params, lease);
    if (method === 'viewport') return this.viewport(tenant, params, lease);
    if (method === 'rtc.offer') return this.offer(tenant, params, lease);
    if (method === 'rtc.close') return this.closeRtc(tenant, params, lease);
    // Candidate delivery must not queue behind an offer waiting for its answer.
    if (method === 'rtc.ice') return this.ice(tenant, params);
    return this.serial(tenant, async () => {
      this.assertViewer(tenant, lease);
      if (method === 'clock.ping') return { serverTime: Date.now(), ...(typeof params.clientTime === 'number' ? { clientTime: params.clientTime } : {}) };
      if (method === 'feedback') {
        if (this.diagnosticTenants.has(tenant)) return { accepted: false };
        this.qualityFor(tenant);
        const state = this.store.workspace(tenant), viewport = this.viewers.get(tenant)?.viewport;
        const visible = !!viewport?.windows.some(region => region.visible && state.windows.some(window => window.id === region.windowId && !!window.activeTabId) && (state.layoutMode !== 'focused' || region.windowId === state.activeWindowId));
        const accepted = this.qualityController(tenant).observe(params, Date.now(), visible, performance.now());
        if (accepted) { this.viewers.get(tenant)!.feedback = params; try { await this.reconcileProduct(tenant); } catch { } }
        this.push(tenant); return { accepted };
      }
      throw new ApiError(400, '未知 WebSocket 方法');
    });
  }
  private viewport(tenant: string, body: any, lease: string) {
    return this.serial(tenant, async () => {
      this.assertViewer(tenant, lease);
      const state = this.store.workspace(tenant);
      if (typeof body.devicePixelRatio !== 'number' || !Number.isFinite(body.devicePixelRatio) || body.devicePixelRatio < .5 || body.devicePixelRatio > 4 || !Array.isArray(body.windows) || body.windows.length > 8 || (body.refreshHz !== undefined && (!Number.isFinite(body.refreshHz) || body.refreshHz < 1 || body.refreshHz > 500))) throw new ApiError(400, '无效的显示区域');
      const ids = new Set<string>();
      for (const w of body.windows) { if (!w || ids.has(w.windowId) || !state.windows.some(item => item.id === w.windowId) || typeof w.visible !== 'boolean' || !Number.isInteger(w.width) || !Number.isInteger(w.height) || w.width < 1 || w.height < 1 || w.width > 8192 || w.height > 8192) throw new ApiError(400, '无效的窗口显示区域'); ids.add(w.windowId); }
      // Preflight cannot mutate the live controller or replace a valid viewport.
      const feasibility = new QualityController().snapshot(state, body);
      if (feasibility.resourceLimitation) throw new ApiError(400, feasibility.resourceLimitation);
      this.viewers.get(tenant)!.viewport = { devicePixelRatio: body.devicePixelRatio, refreshHz: body.refreshHz, windows: body.windows.map((w: any) => ({ windowId: w.windowId, width: w.width, height: w.height, visible: w.visible })) };
      this.lastViewports.set(tenant, this.viewers.get(tenant)!.viewport!);
      try { await this.reconcileProduct(tenant); } catch { }
      this.push(tenant); return this.productState(tenant);
    });
  }
  async productAction(tenant: string, body: ProductAction, lease?: string): Promise<ProductActionResult> {
    return this.serial(tenant, async () => {
      if (lease) this.assertViewer(tenant, lease);
      const state = this.store.workspace(tenant), action = body as any;
      const tab = () => { const found = state.tabs.find(t => t.id === action.tabId); if (!found) throw new ApiError(404, '标签页不存在'); return found; };
      const window = () => { const found = state.windows.find(w => w.id === action.windowId); if (!found) throw new ApiError(404, '窗口不存在'); return found; };
      const createTab = (windowId: string) => { if (state.tabs.length >= 32) throw new ApiError(400, '最多支持32个标签页'); const next: ProductTab = { id: randomUUID(), windowId, webviewId: this.store.viewId(), title: String(action.title ?? '新标签页').slice(0, 120), url: url(action.url ?? 'about:blank') }; state.tabs.push(next); state.windows.find(w => w.id === windowId)!.activeTabId = next.id; state.activeWindowId = windowId; };
      let application: ProductActionResult['application'];
      const oldQuality = state.settings.qualityPreference;
      switch (action.type) {
        case 'window.create': { if (state.windows.length >= 8) throw new ApiError(400, '最多支持8个窗口'); const id = randomUUID(); state.windows.push({ id, activeTabId: null, weight: 1 }); createTab(id); break; }
        case 'window.activate': state.activeWindowId = window().id; break;
        case 'window.layout': {
          if (!['side-by-side', 'focused'].includes(action.mode)) throw new ApiError(400, '无效的窗口布局'); state.layoutMode = action.mode;
          if (action.weights !== undefined) { if (!Array.isArray(action.weights) || action.weights.length > 8 || new Set(action.weights.map((w: any) => w.windowId)).size !== action.weights.length) throw new ApiError(400, '无效的窗口比例'); for (const entry of action.weights) { const w = state.windows.find(w => w.id === entry.windowId); if (!w || typeof entry.weight !== 'number' || !Number.isFinite(entry.weight) || entry.weight < .1 || entry.weight > 10) throw new ApiError(400, '无效的窗口比例'); w.weight = entry.weight; } } break;
        }
        case 'window.close': { const w = window(); if (state.pendingWindowCloseId && state.pendingWindowCloseId !== w.id) throw new ApiError(409, '请先处理当前关闭请求'); state.pendingWindowCloseId = w.id; await this.continueWindowClose(state); break; }
        case 'tab.create': createTab(window().id); break;
        case 'tab.activate': { const t = tab(); state.windows.find(w => w.id === t.windowId)!.activeTabId = t.id; state.activeWindowId = t.windowId; break; }
        case 'tab.move': { const t = tab(), target = window(), old = state.windows.find(w => w.id === t.windowId)!; t.windowId = target.id; if (old.activeTabId === t.id) old.activeTabId = state.tabs.find(item => item.windowId === old.id)?.id ?? null; target.activeTabId = t.id; state.activeWindowId = target.id; break; }
        case 'tab.navigate': { const t = tab(), address = url(action.url); await this.endpoint.request('view.navigate', tenant, { viewId: t.webviewId, url: address }); t.url = address; t.pendingUrl = address; break; }
        case 'tab.command': { const t = tab(); if (!['back', 'forward', 'reload', 'stop'].includes(action.command)) throw new ApiError(400, '未知导航命令'); await this.endpoint.request('view.command', tenant, { viewId: t.webviewId, command: action.command }); break; }
        case 'tab.close': {
          const t = tab(), replying = action.confirm === true || action.cancel === true;
          if (replying) { if (state.pendingClose?.id !== t.id || !action.requestId || state.pendingClose.requestId !== action.requestId) throw new ApiError(409, '关闭请求已失效'); await this.replyClose(tenant, t.webviewId, state.pendingClose, action.confirm === true); if (action.cancel === true) { state.pendingClose = null; state.pendingWindowCloseId = null; } else state.pendingClose = { ...state.pendingClose, awaiting: true }; }
          else await this.closeProductTab(state, t);
          break;
        }
        case 'page.reply': {
          if (typeof action.dialogId !== 'string' || typeof action.accept !== 'boolean' || action.text !== undefined && (typeof action.text !== 'string' || Buffer.byteLength(action.text, 'utf8') > 16384)) throw new ApiError(400, '无效的页面对话回复');
          const latest = await this.endpoint.request('session.snapshot', tenant); this.collectDialogs(tenant, state, latest);
          const dialog = this.dialogs.get(tenant)?.find(d => d.id === action.dialogId);
          if (!dialog || !state.tabs.some(t => t.id === dialog.tabId && t.webviewId === dialog.viewId)) throw new ApiError(410, '页面对话已过期');
          if (dialog.kind === 'alert' && !action.accept) throw new ApiError(400, '提示对话仅支持确认');
          const result = await this.endpoint.request('view.page.reply', tenant, { viewId: dialog.viewId, requestId: dialog.requestId, browserIncarnation: dialog.browserIncarnation, instance: dialog.instance, document: dialog.document, accept: action.accept, ...(action.text === undefined ? {} : { text: action.text }) });
          if (result?.accepted !== true || result?.browser?.ok !== true) throw new ApiError(409, 'Endpoint未确认页面对话回复');
          this.dialogs.set(tenant, (this.dialogs.get(tenant) ?? []).filter(d => d.id !== dialog.id)); this.push(tenant); break;
        }
        case 'settings.update': {
          const value = action.settings;
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['qualityPreference', 'clientScaleOverride', 'memorySaverEnabled', 'showStats'].includes(k))) throw new ApiError(400, '无效的设置');
          if ('qualityPreference' in value && !['quality', 'auto', 'smooth'].includes(value.qualityPreference)) throw new ApiError(400, '无效的画面质量');
          if ('clientScaleOverride' in value && value.clientScaleOverride !== null && (typeof value.clientScaleOverride !== 'number' || !Number.isFinite(value.clientScaleOverride) || value.clientScaleOverride < .5 || value.clientScaleOverride > 4)) throw new ApiError(400, '显示比例需0.5–4');
          if ('memorySaverEnabled' in value && typeof value.memorySaverEnabled !== 'boolean') throw new ApiError(400, '无效的内存设置');
          if ('showStats' in value && typeof value.showStats !== 'boolean') throw new ApiError(400, '无效的统计设置'); Object.assign(state.settings, value); break;
        }
        case 'site.set': {
          let origin: string; try { const parsed = new URL(action.origin); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin.length > 2048) throw new Error(); origin = parsed.origin; } catch { throw new ApiError(400, '站点需有效HTTP(S) origin，最长2048字符'); }
          if (typeof action.tabletUa !== 'boolean') throw new ApiError(400, '无效的站点设置');
          if (action.tabId && new URL(tab().url).origin !== origin) throw new ApiError(400, '标签页不属于该站点');
          if (!(origin in state.sites) && Object.keys(state.sites).length >= 4096) throw new ApiError(400, '站点设置已达上限');
          state.sites[origin] = { tabletUa: action.tabletUa };
          if (action.tabId) tab().pendingUaReloadOrigin = origin;
          application = { status: 'pending', reason: '设置已保存，正在应用站点身份' }; break;
        }
        default: throw new ApiError(400, '未知产品操作');
      }
      this.saveProduct(state);
      try { await this.reconcileProduct(tenant); } catch { }
      if (action.type === 'settings.update' && oldQuality !== state.settings.qualityPreference && this.connections.has(tenant)) {
        try { await this.endpoint.request('session.mediaPolicy', tenant, { ...this.qualityFor(tenant).requested, refresh: true }); } catch { }
      }
      if (action.type === 'site.set') {
        const latest = this.store.workspace(tenant), applied = this.siteApplications.get(tenant)?.applied === true;
        if (applied && (!action.tabId || !latest.tabs.find(t => t.id === action.tabId)?.pendingUaReloadOrigin)) application = undefined;
        else application = { status: 'pending', reason: '设置已保存，应用成功后刷新当前页；其他页面下次加载生效' };
      }
      this.push(tenant); return { state: this.productState(tenant), ...(application ? { application } : {}) };
    });
  }
  private removeProductTab(state: ProductWorkspace, tab: ProductTab) { state.tabs = state.tabs.filter(t => t.id !== tab.id); const w = state.windows.find(w => w.id === tab.windowId); if (w?.activeTabId === tab.id) w.activeTabId = state.tabs.find(t => t.windowId === w.id)?.id ?? null; if (state.pendingClose?.id === tab.id) state.pendingClose = null; this.hiddenSince.delete(state.tenantId + '/' + tab.webviewId); }
  private pendingClose(id: string, result: any, windowId?: string): PendingClose {
    if (typeof result.browserIncarnation !== 'string' || !result.browserIncarnation || result.instance === undefined || result.document === undefined) throw new ApiError(409, 'Endpoint关闭请求缺少页面身份');
    const nativeRequestId = result.requestId === undefined ? undefined : String(result.requestId);
    return { id, ...(windowId ? { windowId } : {}), browserIncarnation: result.browserIncarnation, instance: String(result.instance), document: String(result.document),
      ...(nativeRequestId ? { nativeRequestId, requestId: this.closeToken(result.browserIncarnation, id, String(result.instance), String(result.document), nativeRequestId) } : {}), awaiting: !nativeRequestId };
  }
  private closeToken(browser: string, tab: string, instance: string, document: string, request: string) { return createHash('sha256').update(JSON.stringify([browser, tab, instance, document, request])).digest('hex'); }
  private observePendingClose(state: { pendingClose?: PendingClose | null; pendingWindowCloseId?: string | null }, snapshot: any, view: any) {
    const pending = state.pendingClose; if (!pending) return;
    // Offline/replaced targets invalidate confirmation intent, retaining the tab/window.
    // A missing view alone provides no evidence that a close completed.
    if (snapshot.running === false || !pending.browserIncarnation || snapshot.browserIncarnation !== pending.browserIncarnation || view && (String(view.instance) !== pending.instance || String(view.document) !== pending.document)) {
      state.pendingClose = null; state.pendingWindowCloseId = null; return;
    }
    const request = view?.pending_close?.requestId ?? view?.closeRequestId ?? view?.close_request_id;
    if (request !== undefined) {
      const nativeRequestId = String(request);
      state.pendingClose = { ...pending, nativeRequestId, requestId: this.closeToken(pending.browserIncarnation, pending.id, pending.instance!, pending.document!, nativeRequestId), awaiting: false };
    }
  }
  private async replyClose(tenant: string, viewId: string, pending: PendingClose, accept: boolean) {
    if (!pending.browserIncarnation || !pending.instance || !pending.document || !pending.nativeRequestId) throw new ApiError(409, '关闭请求已失效');
    const result = await this.endpoint.request('view.close.reply', tenant, { viewId, browserIncarnation: pending.browserIncarnation, instance: pending.instance, document: pending.document, requestId: pending.nativeRequestId, accept });
    if (result?.accepted !== true || result?.browser?.ok !== true) throw new ApiError(409, 'Endpoint未确认关闭请求回复');
    return result;
  }
  private async closeProductTab(state: ProductWorkspace, tab: ProductTab) {
    if (state.pendingClose && state.pendingClose.id !== tab.id) throw new ApiError(409, '请先处理当前关闭请求');
    if (tab.popup && tab.popup.status !== 'adopted') { this.removeProductTab(state, tab); return; }
    const result = await this.endpoint.request('view.close', state.tenantId, { viewId: tab.webviewId, force: false });
    if (result.closed === true) this.removeProductTab(state, tab);
    else if (result.accepted || result.pending) state.pendingClose = this.pendingClose(tab.id, result, tab.windowId);
    else throw new ApiError(409, 'Endpoint 尚未确认页面关闭');
  }
  private async continueWindowClose(state: ProductWorkspace) {
    if (!state.pendingWindowCloseId || state.pendingClose) return;
    const id = state.pendingWindowCloseId;
    for (const tab of state.tabs.filter(t => t.windowId === id)) { await this.closeProductTab(state, tab); this.saveProduct(state); if (state.pendingClose) return; }
    state.windows = state.windows.filter(w => w.id !== id); if (state.activeWindowId === id) state.activeWindowId = state.windows[0]?.id ?? null; state.pendingWindowCloseId = null;
  }
  private async reconcileProduct(tenant: string) {
    if (this.diagnosticTenants.has(tenant)) return;
    if (!this.viewers.has(tenant) && !this.started.has(tenant)) return;
    try {
      if (!this.viewers.has(tenant)) { await this.observeOffline(tenant); return; }
      const desired = this.store.workspace(tenant);
      let resourceLimitation = this.qualityFor(tenant, desired).resourceLimitation;
      if (!resourceLimitation) {
        // This operation caches preferences without starting an offline Browser.
        await this.applySites(tenant, desired);
        await this.applyMedia(tenant);
        if (!this.viewers.has(tenant)) { if (this.started.has(tenant)) await this.observeOffline(tenant); return; }
        const ensured = await this.endpoint.request('session.ensure', tenant); this.started.add(tenant);
        if (!this.viewers.has(tenant)) { await this.observeOffline(tenant); return; }
        const applied = this.siteApplications.get(tenant)!;
        if (!applied.applied || ensured.browserPid !== undefined && applied.browserPid !== ensured.browserPid) await this.applySites(tenant, desired, true, ensured.browserPid);
        if (!this.siteApplications.get(tenant)?.applied) throw new Error('站点身份尚未应用，等待Endpoint恢复');
        const media = this.mediaApplications.get(tenant)!;
        if (!media.applied || ensured.browserPid !== undefined && media.browserPid !== ensured.browserPid) await this.applyMedia(tenant, true, ensured.browserPid);
      }
      // Native source/encoder application may finish after views or RTC exist.
      // Accepted policy is cached before their creation; stats retain unknown actuals.
      const snapshot = await this.endpoint.request('session.snapshot', tenant), state = this.store.workspace(tenant), actual: any[] = Array.isArray(snapshot?.views) ? snapshot.views : [];
      if (snapshot.stats?.mediaPolicy?.applied) this.actualMediaPolicies.set(tenant, snapshot.stats.mediaPolicy.applied);
      const closedViews = await this.consumeClosedEvents(state, snapshot);
      if (!this.viewers.has(tenant)) { await this.observeOffline(tenant); return; }
      await this.observePopups(state, snapshot);
      this.store.prunePopupReceipts(tenant);
      if (state.pendingClose) this.observePendingClose(state, snapshot, actual.find(v => String(v.viewId ?? v.view ?? v.id) === state.tabs.find(t => t.id === state.pendingClose?.id)?.webviewId));
      for (const t of [...state.tabs]) {
        const current = actual.find(v => String(v.viewId ?? v.view ?? v.id) === t.webviewId);
        if (!current) continue;
        if (t.popup?.status === 'pending') t.popup = { provisionalId: t.popup.provisionalId, status: 'adopted' };
        if (current.close_state === 'closed') { this.removeProductTab(state, t); continue; }
        // Recovery uses an initial blank WebContents, then imports/restores history.
        // Its intermediate URL/title/history are not a new product navigation.
        const recovering = current.recovery?.pending === true;
        if (!recovering) {
          for (const key of ['title', 'loading', 'canGoBack', 'canGoForward'] as const) if (typeof current[key] === (key === 'title' ? 'string' : 'boolean')) (t as any)[key] = key === 'title' ? current[key].slice(0, 120) : current[key];
          if (typeof current.url === 'string' && /^(https?:\/\/|about:blank$)/.test(current.url) && (!t.pendingUrl || current.url === t.pendingUrl || current.loading === false)) { t.url = current.url; delete t.pendingUrl; }
        }
        if (Number.isInteger(current.actual) && current.actual >= 0 && current.actual <= 3) t.residency = (['live', 'frozen', 'discarded', 'unloaded'] as const)[current.actual];
        t.restoring = recovering || !!current.pending && current.desired === 0;
      }
      await this.continueWindowClose(state); this.saveProduct(state); this.collectDialogs(tenant, state, snapshot);
      resourceLimitation = this.qualityFor(tenant, state).resourceLimitation;
      if (snapshot.running === false && !resourceLimitation) throw new Error('Browser已离线，页面保留并等待恢复');
      const viewer = this.viewers.get(tenant), viewport = viewer?.viewport ?? this.lastViewports.get(tenant);
      const wanted = (t: ProductTab) => !!viewer?.viewport?.windows.some(w => w.windowId === t.windowId && w.visible) && state.windows.some(w => w.id === t.windowId && w.activeTabId === t.id) && (state.layoutMode !== 'focused' || t.windowId === state.activeWindowId);
      const ordered = [...state.tabs].sort((a, b) => Number(wanted(a)) - Number(wanted(b)));
      for (const t of resourceLimitation ? [] : ordered) {
        if (!this.viewers.has(tenant)) { await this.observeOffline(tenant); return; }
        const current = actual.find(v => String(v.viewId ?? v.view ?? v.id) === t.webviewId), key = tenant + '/' + t.webviewId, visible = wanted(t), region = viewport?.windows.find(w => w.windowId === t.windowId), dpr = this.qualityFor(tenant, state).effectiveDpr;
        if (t.popup?.status === 'failed') continue;
        if (visible) this.hiddenSince.delete(key); else if (!this.hiddenSince.has(key)) this.hiddenSince.set(key, Date.now());
        const actualState = current?.actual ?? 0, recovering = current?.recovery?.pending === true;
        let readyToShow = actualState === 0 && !current?.pending;
        if (visible && actualState !== 0 && !current?.pending) {
          const attempt = this.transitions.get(key); if (!attempt || attempt.action !== 'restore' || Date.now() - attempt.at > 12000) { await this.endpoint.request('view.lifecycle', tenant, { viewId: t.webviewId, action: 'restore' }); this.transitions.set(key, { action: 'restore', at: Date.now() }); } readyToShow = false;
        } else if (readyToShow) this.transitions.delete(key);
        // Endpoint hides the recovering WebContents while retaining this desired
        // visibility for its final recovery step. Do not persist a temporary hide.
        const config = { viewId: t.webviewId, width: region?.width ?? 1440, height: region?.height ?? 900, device: { mode: 'desktop', deviceScaleFactor: dpr }, visible: visible && (recovering || readyToShow) };
        const encoded = JSON.stringify(config);
        if (!current && t.popup?.status === 'pending') {
          try {
            const adopted = await this.endpoint.request('view.adopt', tenant, { ...config, url: t.url, provisionalId: t.popup.provisionalId });
            if (adopted?.accepted !== true || adopted.completed !== true) throw new Error('Endpoint尚未完成新页面收养');
            t.popup = { provisionalId: t.popup.provisionalId, status: 'adopted' }; this.saveProduct(state); this.configurations.set(key, encoded);
          } catch (error) {
            // Transport failures are retried with the same binding, never with view.ensure.
            if (String(error).includes('popup_not_pending')) { t.popup = { provisionalId: t.popup.provisionalId, status: 'failed', error: '新页面已关闭或过期，请关闭后重试' }; this.saveProduct(state); }
            else throw error;
          }
          continue;
        }
        if (!current) { await this.endpoint.request('view.ensure', tenant, { ...config, url: t.pendingUrl ?? t.url }); this.configurations.set(key, encoded); }
        else if (this.configurations.get(key) !== encoded || !recovering && current.visible !== undefined && current.visible !== config.visible) { await this.endpoint.request('view.configure', tenant, config); this.configurations.set(key, encoded); }
        if (t.pendingUaReloadOrigin && readyToShow) {
          const requestedOrigin = t.pendingUaReloadOrigin;
          if (current && new URL(t.url).origin === requestedOrigin) await this.endpoint.request('view.command', tenant, { viewId: t.webviewId, command: 'reload' });
          delete t.pendingUaReloadOrigin; this.saveProduct(state);
        }
        if (!visible && state.settings.memorySaverEnabled && current?.canDiscard === true && !current.pending && actualState === 0 && !current.audible && !current.captured && !current.pending_close && !current.pageRequests?.pending?.length && current.close_state !== 'closing' && state.pendingClose?.id !== t.id && state.pendingWindowCloseId !== t.windowId && Date.now() - this.hiddenSince.get(key)! >= 120000) {
          const attempt = this.transitions.get(key); if (!attempt || attempt.action !== 'discard' || Date.now() - attempt.at > 12000) { await this.endpoint.request('view.lifecycle', tenant, { viewId: t.webviewId, action: 'discard' }); this.transitions.set(key, { action: 'discard', at: Date.now() }); }
        }
      }
      for (const v of actual) { const viewId = String(v.viewId ?? v.view ?? v.id); if (!state.tabs.some(t => t.webviewId === viewId) && !v.provisional && !closedViews.has(viewId)) await this.endpoint.request('view.close', tenant, { viewId, force: true, orphan: true }); }
      if (resourceLimitation) {
        const changed = this.errors.get(tenant) !== resourceLimitation;
        this.errors.set(tenant, resourceLimitation); if (changed) this.push(tenant);
      } else { const previousError = this.errors.delete(tenant); if (previousError) this.push(tenant); }
    } catch (error) { this.dialogs.delete(tenant); this.errors.set(tenant, error instanceof Error ? error.message : String(error)); this.push(tenant); throw error; }
  }
  private async observeOffline(tenant: string) {
    // Snapshot is read-only. Maintenance must never revive a missing Browser/view.
    const snapshot = await this.endpoint.request('session.snapshot', tenant), state = this.store.workspace(tenant);
    await this.consumeClosedEvents(state, snapshot); this.dialogs.delete(tenant);
    if (state.pendingClose) { const tab = state.tabs.find(t => t.id === state.pendingClose?.id); this.observePendingClose(state, snapshot, (snapshot.views ?? []).find((v: any) => String(v.viewId ?? v.view ?? v.id) === tab?.webviewId)); this.saveProduct(state); }
    if (snapshot.running === false) { this.started.delete(tenant); this.siteApplications.delete(tenant); this.mediaApplications.delete(tenant); this.actualMediaPolicies.delete(tenant); this.push(tenant); return; }
    for (const tab of state.tabs) {
      const current = (snapshot.views ?? []).find((view: any) => String(view.viewId ?? view.view ?? view.id) === tab.webviewId);
      if (!current) continue;
      const key = tenant + '/' + tab.webviewId; if (!this.hiddenSince.has(key)) this.hiddenSince.set(key, Date.now());
      if (current.visible !== false) { await this.endpoint.request('view.configure', tenant, { viewId: tab.webviewId, visible: false, requireRunning: true }); this.configurations.delete(key); }
      if (state.settings.memorySaverEnabled && current.canDiscard === true && !current.pending && current.actual === 0 && !current.audible && !current.captured && !current.pending_close && !current.pageRequests?.pending?.length && current.close_state !== 'closing' && state.pendingClose?.id !== tab.id && state.pendingWindowCloseId !== tab.windowId && Date.now() - this.hiddenSince.get(key)! >= 120000) {
        const attempt = this.transitions.get(key);
        if (!attempt || attempt.action !== 'discard' || Date.now() - attempt.at > 12000) { await this.endpoint.request('view.lifecycle', tenant, { viewId: tab.webviewId, action: 'discard', requireRunning: true }); this.transitions.set(key, { action: 'discard', at: Date.now() }); }
      }
    }
    const previousError = this.errors.delete(tenant); if (previousError) this.push(tenant);
  }
  private qualityController(tenant: string) { let controller = this.qualityControllers.get(tenant); if (!controller) this.qualityControllers.set(tenant, controller = new QualityController()); return controller; }
  private qualityFor(tenant: string, workspace = this.store.workspace(tenant)) { return this.qualityController(tenant).snapshot(workspace, this.viewers.get(tenant)?.viewport ?? this.lastViewports.get(tenant), Date.now(), this.diagnosticTenants.has(tenant), this.actualMediaPolicies.get(tenant) ?? null); }
  private async applyMedia(tenant: string, force = false, browserPid?: number) {
    const requested = this.qualityFor(tenant).requested, encoded = JSON.stringify(requested), previous = this.mediaApplications.get(tenant);
    if (!force && previous?.encoded === encoded && previous.applied) return;
    this.mediaApplications.set(tenant, { encoded, applied: false, browserPid });
    const result = await this.endpoint.request('session.mediaPolicy', tenant, requested as unknown as Record<string, unknown>);
    if (result?.accepted !== true) throw new Error('Endpoint未接受媒体质量策略');
    this.mediaApplications.set(tenant, { encoded, applied: result.applied === true, browserPid });
  }
  private collectDialogs(tenant: string, state: ProductWorkspace, snapshot: any) {
    const found: (PageDialog & { viewId: string; requestId: string; browserIncarnation: string; instance: string; document: string })[] = [];
    for (const view of Array.isArray(snapshot.views) ? snapshot.views : []) {
      const viewId = String(view.viewId ?? view.view ?? view.id), tab = state.tabs.find(t => t.webviewId === viewId);
      if (!tab || snapshot.running === false || typeof snapshot.browserIncarnation !== 'string' || !snapshot.browserIncarnation || view.instance === undefined || view.document === undefined) continue;
      const instance = String(view.instance), document = String(view.document);
      for (const request of Array.isArray(view.pageRequests?.pending) ? view.pageRequests.pending : []) {
        if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(request.kind) || typeof request.request !== 'string' || state.pendingClose?.id === tab.id && request.kind === 'beforeunload') continue;
        // Browser replacement may restart its local token/request counters.
        const id = createHash('sha256').update(JSON.stringify([tenant, snapshot.browserIncarnation, viewId, instance, document, request.request])).digest('hex');
        found.push({ id, tabId: tab.id, windowId: tab.windowId, viewId, browserIncarnation: snapshot.browserIncarnation, instance, document, requestId: request.request, kind: request.kind, message: String(request.message ?? ''), defaultPrompt: String(request.default_prompt ?? ''), origin: String(request.origin ?? ''), ...(typeof request.is_reload === 'boolean' ? { isReload: request.is_reload } : {}) });
      }
    }
    const changed = JSON.stringify(found) !== JSON.stringify(this.dialogs.get(tenant) ?? []); this.dialogs.set(tenant, found); if (changed) this.push(tenant);
  }
  private async applySites(tenant: string, state: ProductWorkspace, force = false, browserPid?: number) {
    const encoded = JSON.stringify(state.sites), previous = this.siteApplications.get(tenant);
    if (!force && previous?.encoded === encoded && previous.applied) return;
    this.siteApplications.set(tenant, { encoded, applied: false, browserPid });
    const result = await this.endpoint.request('session.sitePreferences', tenant, { sites: state.sites });
    if (result?.accepted !== true) throw new Error('Endpoint未接受站点身份设置');
    this.siteApplications.set(tenant, { encoded, applied: result.applied === true, browserPid });
  }
  private async consumeClosedEvents(state: ProductWorkspace, snapshot: any): Promise<Set<string>> {
    const closed = new Set<string>(), eventIds: string[] = [];
    for (const event of Array.isArray(snapshot.events) ? snapshot.events : []) {
      if (event?.type !== 'view.closed' || typeof event.eventId !== 'string' || typeof event.viewId !== 'string') continue;
      closed.add(event.viewId); eventIds.push(event.eventId);
      const tab = state.tabs.find(t => t.webviewId === event.viewId); if (tab) this.removeProductTab(state, tab);
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
      const existing = state.tabs.find(t => t.popup?.provisionalId === popup.provisionalId);
      if (existing) {
        if (existing.popup?.status === 'pending' && ['closed', 'timed_out'].includes(popup.status)) { existing.popup = { provisionalId: popup.provisionalId, status: 'failed', error: popup.status === 'timed_out' ? '新页面创建已过期' : '新页面已关闭' }; this.saveProduct(state); }
        continue;
      }
      if (popup.status !== 'pending' || popup.userGesture !== true || this.store.popupTabId(state.tenantId, popup.provisionalId) || state.tabs.length >= 32) continue;
      const opener = state.tabs.find(t => t.webviewId === popup.openerViewId); if (!opener) continue;
      let target = state.windows.find(w => w.id === opener.windowId); if (!target) continue;
      if (![3, 4, 5, 6].includes(popup.disposition)) continue;
      if ([5, 6].includes(popup.disposition)) { if (state.windows.length >= 8) continue; target = { id: randomUUID(), activeTabId: null, weight: 1 }; state.windows.push(target); }
      let address: string; try { address = url(popup.url); } catch { address = 'about:blank'; }
      const tab: ProductTab = { id: randomUUID(), windowId: target.id, webviewId: this.store.viewId(), title: '新页面', url: address, popup: { provisionalId: popup.provisionalId, status: 'pending' } };
      state.tabs.push(tab); if (popup.disposition !== 4) { target.activeTabId = tab.id; state.activeWindowId = target.id; }
      this.store.savePopupWorkspace(state, popup.provisionalId, tab.id); this.push(state.tenantId);
    }
  }
}
function url(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192) throw new ApiError(400, '无效网址');
  if (value === 'about:blank') return value;
  try { const parsed = new URL(value.includes('://') ? value : `https://${value}`); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); return parsed.href; } catch { throw new ApiError(400, '请输入 HTTP 或 HTTPS 网址'); }
}
function device(value: any): Device {
  if (!value || !['desktop', 'tablet'].includes(value.mode) || !Number.isInteger(value.width) || value.width < 320 || value.width > 4096 || !Number.isInteger(value.height) || value.height < 240 || value.height > 4096 || typeof value.deviceScaleFactor !== 'number' || value.deviceScaleFactor < .5 || value.deviceScaleFactor > 4 || value.width * value.height * value.deviceScaleFactor ** 2 > 16777216) throw new ApiError(400, '设备尺寸或像素密度超出范围');
  return { mode: value.mode, width: value.width, height: value.height, deviceScaleFactor: value.deviceScaleFactor };
}
