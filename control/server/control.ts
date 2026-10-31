import { randomUUID } from 'node:crypto';
import type { ControlState, Device } from '../client/types';
import type { Endpoint } from './endpoint';
import { Store } from './store';
import { LoopbackRelay, rewriteSdp, selectLocalCandidate, type NetworkSimulation } from './network-sim.mjs';
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export class Control {
  private queues = new Map<string, Promise<unknown>>();
  private errors = new Map<string, string>();
  private connections = new Map<string, string>();
  private configurations = new Map<string, string>();
  private ticking = false;
  private endpointGeneration = 0;
  private relays = new Map<string, LoopbackRelay>();
  constructor(readonly store: Store, readonly endpoint: Endpoint, private simulation?: NetworkSimulation) {}
  serial<T>(tenant: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(tenant) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(tenant, next); void next.finally(() => { if (this.queues.get(tenant) === next) this.queues.delete(tenant); }).catch(() => {});
    return next;
  }
  state(tenant: string) { return { ...this.store.state(tenant), endpointError: this.errors.get(tenant) ?? null, endpointGeneration: this.endpointGeneration, ...(this.simulation ? { networkSimulation: this.simulation } : {}) }; }
  async getState(tenant: string) {
    return this.serial(tenant, async () => {
      const state = this.store.state(tenant);
      if (state.pendingClose?.awaiting) {
        try {
          const snapshot = await this.endpoint.request('session.snapshot', tenant);
          this.observe(state, snapshot);
        } catch (error) { this.errors.set(tenant, String(error)); }
      }
      return this.state(tenant);
    });
  }
  private observe(state: ControlState, snapshot: any) {
    if (!Array.isArray(snapshot?.views)) return;
    const before = JSON.stringify(state);
    for (const tab of [...state.tabs]) {
      const view = snapshot.views.find((view: any) => String(view.viewId ?? view.id) === tab.webviewId);
      if (state.pendingClose?.id === tab.id) {
        if (!view || view.close_state === 'closed') {
          state.tabs = state.tabs.filter(item => item.id !== tab.id); state.pendingClose = null;
          if (state.activeTabId === tab.id) state.activeTabId = state.tabs[0]?.id ?? null;
          if (state.splitTabId === tab.id) state.splitTabId = null;
          continue;
        }
        const requestId = view.pending_close?.requestId ?? view.closeRequestId ?? view.close_request_id;
        if (requestId) state.pendingClose = { id: tab.id, requestId: String(requestId), awaiting: false };
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
  }
  async reconcile(tenant: string) {
    const state = this.store.state(tenant);
    try {
      await this.endpoint.request('session.ensure', tenant);
      const snapshot = await this.endpoint.request('session.snapshot', tenant);
      this.observe(state, snapshot);
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
  async tick() { if (this.ticking) return; this.ticking = true; try { await Promise.all(this.store.all().map(tenant => this.serial(tenant, () => this.reconcile(tenant)).catch(() => {}))); } finally { this.ticking = false; } }
  closeRelays() { for (const relay of this.relays.values()) relay.close(); this.relays.clear(); }
  async reconcileAll() { this.endpointGeneration++; this.closeRelays(); this.connections.clear(); this.configurations.clear(); for (const tenant of this.store.all()) await this.serial(tenant, async () => { const state = this.store.state(tenant); state.pendingClose = null; this.store.save(state); await this.reconcile(tenant); }).catch(() => {}); }
  async action(tenant: string, body: any) {
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
          if (replying && (state.pendingClose?.id !== current.id || state.pendingClose.requestId !== body.requestId)) throw new ApiError(409, '关闭请求已失效');
          const result = replying ? await this.endpoint.request('view.close.reply', tenant, { viewId: current.webviewId, accept: body.confirm === true, requestId: body.requestId }) : await this.endpoint.request('view.close', tenant, { viewId: current.webviewId, force: false });
          if (body.cancel === true) { state.pendingClose = null; this.store.save(state); return this.state(tenant); }
          if (result?.pending || result?.accepted || result?.status === 'pending' || result?.status === 'accepted') { state.pendingClose = { id: current.id, requestId: result.requestId ?? body.requestId, awaiting: body.confirm === true || !!result.accepted || result.status === 'accepted' }; this.store.save(state); return this.state(tenant); }
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
  async offer(tenant: string, body: any) {
    if (body.type !== 'offer' || typeof body.sdp !== 'string' || body.sdp.length > 900000 || !body.sdp.startsWith('v=0')) throw new ApiError(400, '无效的 SDP offer');
    return this.serial(tenant, async () => {
      await this.reconcile(tenant);
      const previous = this.connections.get(tenant);
      if (previous) { try { await this.endpoint.request('rtc.close', tenant, { connectionId: previous }); } finally { this.relays.get(previous)?.close(); this.relays.delete(previous); this.connections.delete(tenant); } }
      const connectionId = randomUUID();
      let relay: LoopbackRelay | undefined;
      try {
        let offerSdp = body.sdp;
        if (this.simulation) { relay = await new LoopbackRelay(this.simulation, selectLocalCandidate(offerSdp)).bind(); offerSdp = rewriteSdp(offerSdp, relay.serverAddress); }
        const answer = await this.endpoint.request('rtc.offer', tenant, { connectionId, sdp: offerSdp });
        if (typeof answer?.sdp !== 'string' || !answer.sdp.startsWith('v=0')) throw new ApiError(502, 'Endpoint 未返回有效 answer');
        let answerSdp = answer.sdp;
        if (relay) { relay.setServer(selectLocalCandidate(answerSdp, { requireLoopback: true })); answerSdp = rewriteSdp(answerSdp, relay.clientAddress); this.relays.set(connectionId, relay); }
        this.connections.set(tenant, connectionId);
        return { type: 'answer', sdp: answerSdp, connectionId, endpointGeneration: this.endpointGeneration, ...(relay ? { networkSimulation: relay.snapshot() } : {}) };
      } catch (error) { relay?.close(); await this.endpoint.request('rtc.close', tenant, { connectionId }).catch(() => {}); throw error; }
    });
  }
  async ice(tenant: string, body: any) {
    if (!body.connectionId || this.connections.get(tenant) !== body.connectionId) throw new ApiError(403, '连接不属于当前会话');
    if (this.simulation) throw new ApiError(400, '网络实验使用完整 gathered SDP，拒绝额外 trickle 候选');
    return this.endpoint.request('rtc.ice', tenant, { connectionId: body.connectionId, candidate: body.candidate });
  }
  async closeRtc(tenant: string, body: any) {
    return this.serial(tenant, async () => {
      if (this.connections.get(tenant) !== body.connectionId) throw new ApiError(403, '连接不属于当前会话');
      try { await this.endpoint.request('rtc.close', tenant, { connectionId: body.connectionId }); } finally { this.relays.get(body.connectionId)?.close(); this.relays.delete(body.connectionId); this.connections.delete(tenant); } return { closed: true };
    });
  }
  networkStats(tenant: string, body: any) {
    if (this.connections.get(tenant) !== body.connectionId) throw new ApiError(403, '连接不属于当前会话');
    return this.relays.get(body.connectionId)?.snapshot() ?? { enabled: false };
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
