import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { Store } from '../server/store';
import { Control } from '../server/control';
import { createHttp } from '../server/http';
import type { Endpoint } from '../server/endpoint';

class ProductEndpoint implements Endpoint {
  calls: { method: string; tenant: string; args: any }[] = [];
  views = new Map<string, Map<string, any>>(); pending = false;
  running = false; browserPid = 10; failSites = false; failAck = false; loseAdoptReply = false;
  popups: any[] = []; events: any[] = []; onAdopt?: (args: any) => void;
  async request(method: string, tenant: string, args: any = {}) {
    this.calls.push({ method, tenant, args }); let views = this.views.get(tenant); if (!views) this.views.set(tenant, views = new Map());
    if (method === 'session.sitePreferences') { if (this.failSites) throw new Error('UA apply failed'); return { accepted: true, applied: this.running }; }
    if (method === 'session.ensure') { this.running = true; return { browserPid: this.browserPid }; }
    if (method === 'session.snapshot') return { views: [...views.values()].map(v => ({ ...v })), pendingPopups: this.popups, events: this.events };
    if (method === 'session.events.ack') { if (this.failAck) throw new Error('ack failed'); this.events = this.events.filter(e => !args.eventIds.includes(e.eventId)); return { accepted: true, remaining: this.events.length }; }
    if (method === 'view.adopt') {
      this.onAdopt?.(args);
      if (!views.has(args.viewId) && !this.popups.some(p => p.provisionalId === args.provisionalId && p.status === 'pending')) throw new Error('popup_not_pending');
      views.set(args.viewId, { ...args, actual: 0, pending: false, canDiscard: true }); this.popups = this.popups.filter(p => p.provisionalId !== args.provisionalId);
      if (this.loseAdoptReply) { this.loseAdoptReply = false; throw new Error('response lost'); }
      return { accepted: true, completed: true };
    }
    if (method === 'view.ensure') views.set(args.viewId, { ...args, actual: 0, pending: false, canDiscard: true });
    if (method === 'view.configure') Object.assign(views.get(args.viewId)!, args);
    if (method === 'view.lifecycle') { const v = views.get(args.viewId)!; if (args.action === 'restore') { v.pending = true; v.desired = 0; } else v.actual = 2; return { accepted: true, completed: false, pending: true, lifecycleGeneration: '1' }; }
    if (method === 'view.close') { if (this.pending && !args.force) return { pending: true, requestId: 'close-1' }; views.delete(args.viewId); return { closed: true }; }
    if (method === 'view.close.reply') { if (args.accept) views.delete(args.viewId); return { accepted: true }; }
    if (method === 'rtc.offer') return { sdp: 'v=0\r\n' };
    return {};
  }
}
async function fixture() {
  const store = new Store(':memory:'), endpoint = new ProductEndpoint(), control = new Control(store, endpoint);
  const user = await store.register('testuser', 'password123'); return { store, endpoint, control, user };
}

test('v1 migration preserves tab/webview IDs, split windows, token and allocation; reopening is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rk-migrate-')), path = join(dir, 'control.db');
  const old = new Database(path); old.exec('CREATE TABLE tenants(id TEXT PRIMARY KEY,state TEXT NOT NULL); CREATE TABLE sessions(token TEXT PRIMARY KEY,tenant TEXT NOT NULL); CREATE TABLE view_ids(id INTEGER PRIMARY KEY AUTOINCREMENT)');
  old.prepare('INSERT INTO tenants VALUES (?,?)').run('old-tenant', JSON.stringify({ tenantId: 'old-tenant', tabs: [{ id: 'a', webviewId: '801', title: 'A', url: 'https://a.test/' }, { id: 'b', webviewId: '802', title: 'B', url: 'https://b.test/' }], activeTabId: 'a', splitTabId: 'b', device: { mode: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2 } })); old.prepare('INSERT INTO sessions VALUES (?,?)').run('old-token', 'old-tenant'); old.close();
  let store = new Store(path);
  try { const ws = store.workspace('old-tenant'); assert.equal(ws.windows.length, 2); assert.deepEqual(ws.tabs.map(t => t.webviewId), ['801', '802']); assert.notEqual(ws.tabs[0].windowId, ws.tabs[1].windowId); assert.equal(ws.settings.clientScaleOverride, null); assert.deepEqual(ws.sites, {}); assert.equal(store.authenticated('old-token'), 'old-tenant'); assert.ok(BigInt(store.viewId()) > 802n); const ids = ws.windows.map(w => w.id); store.db.close(); store = new Store(path); assert.deepEqual(store.workspace('old-tenant').windows.map(w => w.id), ids); }
  finally { store.db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('offline startup does not create Browsers; multi-window mutations preserve tab ownership and empty windows', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.reconcileAll(); await control.tick(); assert.equal(endpoint.calls.length, 0);
    await control.attachViewer(user.tenantId, 'lease', () => {});
    let result = await control.productAction(user.tenantId, { type: 'window.create', url: 'https://a.test/' }, 'lease'); const a = result.state.workspace.windows[0], tabA = result.state.workspace.tabs[0];
    result = await control.productAction(user.tenantId, { type: 'window.create' }, 'lease'); const b = result.state.workspace.windows[1], tabB = result.state.workspace.tabs[1];
    await control.viewerRequest(user.tenantId, 'lease', 'viewport', { devicePixelRatio: 2, windows: [{ windowId: a.id, width: 800, height: 600, visible: true }, { windowId: b.id, width: 700, height: 600, visible: true }] });
    assert.equal(endpoint.views.get(user.tenantId)!.get(tabA.webviewId).visible, true); assert.equal(endpoint.views.get(user.tenantId)!.get(tabB.webviewId).width, 700);
    const next = await control.productAction(user.tenantId, { type: 'tab.move', tabId: tabA.id, windowId: b.id }, 'lease');
    assert.equal(next.state.workspace.windows.find(w => w.id === a.id)!.activeTabId, null); assert.equal(next.state.workspace.tabs.find(t => t.id === tabA.id)!.webviewId, tabA.webviewId);
    await control.productAction(user.tenantId, { type: 'tab.close', tabId: tabA.id }, 'lease'); await control.productAction(user.tenantId, { type: 'tab.close', tabId: tabB.id }, 'lease');
    assert.equal(store.workspace(user.tenantId).windows.length, 2); assert.equal(store.workspace(user.tenantId).tabs.length, 0);
    await control.productAction(user.tenantId, { type: 'window.close', windowId: a.id }, 'lease'); assert.equal(store.workspace(user.tenantId).windows.length, 1);
    await control.tick(); const revision = store.workspace(user.tenantId).revision; await control.tick(); assert.equal(store.workspace(user.tenantId).revision, revision);
    const invalid = store.workspace(user.tenantId); invalid.windows[0].activeTabId = 'foreign-tab'; assert.throws(() => store.saveWorkspace(invalid), /归属/);
  } finally { await control.detachViewer(user.tenantId, 'lease'); store.db.close(); }
});

test('window beforeunload cancellation retains remaining tabs; settings and site rules persist independently of viewport', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.attachViewer(user.tenantId, 'lease', () => {}); let state = (await control.productAction(user.tenantId, { type: 'window.create', url: 'https://EXAMPLE.com/path' }, 'lease')).state;
    const w = state.workspace.windows[0], tab = state.workspace.tabs[0]; endpoint.pending = true;
    state = (await control.productAction(user.tenantId, { type: 'window.close', windowId: w.id }, 'lease')).state;
    assert.equal(state.workspace.tabs.length, 1); assert.equal(state.workspace.pendingClose?.requestId, 'close-1');
    state = (await control.productAction(user.tenantId, { type: 'tab.close', tabId: tab.id, requestId: 'close-1', cancel: true }, 'lease')).state;
    assert.equal(state.workspace.windows.length, 1); assert.equal(state.workspace.pendingWindowCloseId, null);
    const site = await control.productAction(user.tenantId, { type: 'site.set', origin: 'https://EXAMPLE.com:443/foo', tabletUa: true }, 'lease'); assert.equal(site.application, undefined); assert.deepEqual(site.state.workspace.sites, { 'https://example.com': { tabletUa: true } });
    state = (await control.productAction(user.tenantId, { type: 'settings.update', settings: { clientScaleOverride: 1.5, qualityPreference: 'smooth' } }, 'lease')).state;
    assert.equal(state.workspace.settings.clientScaleOverride, 1.5); assert.ok(endpoint.calls.filter(c => c.method === 'view.configure').every(c => c.args.device.mode === 'desktop'));
    await assert.rejects(control.productAction(user.tenantId, { type: 'settings.update', settings: { clientScaleOverride: 5 } }, 'lease'));
  } finally { await control.detachViewer(user.tenantId, 'lease'); store.db.close(); }
});

test('memory saver uses hidden age and canDiscard; activating a discarded page waits for actual live completion', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.attachViewer(user.tenantId, 'lease', () => {}); const created = await control.productAction(user.tenantId, { type: 'window.create' }, 'lease'), tab = created.state.workspace.tabs[0], w = created.state.workspace.windows[0];
    (control as any).hiddenSince.set(user.tenantId + '/' + tab.webviewId, Date.now() - 121000);
    const view = endpoint.views.get(user.tenantId)!.get(tab.webviewId); view.canDiscard = false; await control.tick(); assert.equal(endpoint.calls.filter(c => c.method === 'view.lifecycle').length, 0);
    view.canDiscard = true; await control.tick(); assert.equal(view.actual, 2);
    await control.viewerRequest(user.tenantId, 'lease', 'viewport', { devicePixelRatio: 1, windows: [{ windowId: w.id, width: 1200, height: 800, visible: true }] });
    assert.equal(view.visible, false); assert.equal(view.pending, true); assert.equal(endpoint.calls.filter(c => c.method === 'view.lifecycle' && c.args.action === 'restore').length, 1);
    await control.tick(); assert.equal(view.visible, false); view.actual = 0; view.pending = false; await control.tick(); assert.equal(view.visible, true);
    await control.detachViewer(user.tenantId, 'lease'); assert.equal(view.visible, false); assert.equal(view.width, 1200); assert.equal(view.height, 800);
  } finally { store.db.close(); }
});

test('showStats defaults on migration and old v2 settings, persists as a boolean and rejects other values', async () => {
  const { store, control, user } = await fixture();
  try {
    assert.equal(store.workspace(user.tenantId).settings.showStats, false);
    store.db.prepare('UPDATE user_settings SET data=? WHERE tenant=?').run(JSON.stringify({ qualityPreference: 'auto', clientScaleOverride: null, memorySaverEnabled: true }), user.tenantId);
    assert.equal(store.workspace(user.tenantId).settings.showStats, false);
    const result = await control.productAction(user.tenantId, { type: 'settings.update', settings: { showStats: true } }); assert.equal(result.state.workspace.settings.showStats, true);
    await assert.rejects(control.productAction(user.tenantId, { type: 'settings.update', settings: { showStats: 'true' } } as any));
  } finally { store.db.close(); }
});

test('UA table precedes Browser/view creation; failed application persists desired and retries before current-tab-only reload', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.attachViewer(user.tenantId, 'lease', () => {});
    const firstSites = endpoint.calls.findIndex(c => c.method === 'session.sitePreferences'), ensure = endpoint.calls.findIndex(c => c.method === 'session.ensure'); assert.ok(firstSites >= 0 && firstSites < ensure);
    const created = await control.productAction(user.tenantId, { type: 'window.create', url: 'https://example.test/a' }, 'lease'), w = created.state.workspace.windows[0], a = created.state.workspace.tabs[0];
    const second = await control.productAction(user.tenantId, { type: 'tab.create', windowId: w.id, url: 'https://example.test/b' }, 'lease'), b = second.state.workspace.tabs[1];
    endpoint.calls = []; endpoint.failSites = true;
    const pending = await control.productAction(user.tenantId, { type: 'site.set', origin: 'https://example.test', tabletUa: true, tabId: b.id }, 'lease');
    assert.equal(pending.application?.status, 'pending'); assert.equal(store.workspace(user.tenantId).sites['https://example.test'].tabletUa, true); assert.equal(endpoint.calls.filter(c => c.method === 'view.command').length, 0);
    endpoint.failSites = false; endpoint.calls = []; await control.tick();
    const applied = endpoint.calls.findIndex(c => c.method === 'session.sitePreferences'), reloaded = endpoint.calls.findIndex(c => c.method === 'view.command'); assert.ok(applied >= 0 && reloaded > applied); assert.deepEqual(endpoint.calls.filter(c => c.method === 'view.command').map(c => c.args.viewId), [b.webviewId]); assert.notEqual(a.webviewId, b.webviewId);
    assert.equal(store.workspace(user.tenantId).tabs.find(t => t.id === b.id)!.pendingUaReloadOrigin, undefined);
    endpoint.calls = []; endpoint.browserPid++; await control.tick(); assert.ok(endpoint.calls.some(c => c.method === 'session.sitePreferences'));
    endpoint.calls = []; await control.reconcileAll(); assert.equal(endpoint.calls[0].method, 'session.sitePreferences');
  } finally { await control.detachViewer(user.tenantId, 'lease'); store.db.close(); }
});

test('popup adoption persists identity first; background stays unfocused, new windows are independent, replay is idempotent', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.attachViewer(user.tenantId, 'lease', () => {}); const initial = (await control.productAction(user.tenantId, { type: 'window.create', url: 'https://opener.test' }, 'lease')).state.workspace, opener = initial.tabs[0];
    endpoint.onAdopt = args => { const persisted = store.workspace(user.tenantId).tabs.find(t => t.webviewId === args.viewId); assert.equal(persisted?.popup?.provisionalId, args.provisionalId); assert.equal(persisted?.popup?.status, 'pending'); };
    endpoint.popups = [{ provisionalId: 'background', openerViewId: opener.webviewId, url: 'https://child.test/b', disposition: 4, userGesture: true, status: 'pending' }]; endpoint.calls = []; await control.tick();
    let state = store.workspace(user.tenantId), child = state.tabs.find(t => t.popup?.provisionalId === 'background')!; assert.ok(child); assert.equal(child.popup!.status, 'adopted'); assert.equal(child.windowId, opener.windowId); assert.equal(state.windows[0].activeTabId, opener.id); assert.equal(state.activeWindowId, initial.activeWindowId); assert.equal(endpoint.calls.filter(c => c.method === 'view.ensure').length, 0);
    endpoint.popups = [{ provisionalId: 'background', openerViewId: opener.webviewId, url: child.url, disposition: 4, userGesture: true, status: 'pending' }]; await control.tick(); assert.equal(store.workspace(user.tenantId).tabs.length, 2);
    endpoint.popups = [{ provisionalId: 'new-window', openerViewId: opener.webviewId, url: 'https://child.test/w', disposition: 6, userGesture: true, status: 'pending' }]; endpoint.loseAdoptReply = true; await control.tick();
    state = store.workspace(user.tenantId); const newWindow = state.tabs.find(t => t.popup?.provisionalId === 'new-window')!; assert.notEqual(newWindow.windowId, opener.windowId); assert.equal(state.windows.length, 2);
    endpoint.calls = []; await control.tick(); state = store.workspace(user.tenantId); assert.equal(state.tabs.find(t => t.id === newWindow.id)!.popup!.status, 'adopted'); assert.equal(endpoint.calls.filter(c => c.method === 'view.ensure').length, 0); assert.equal(state.tabs.length, 3);
    endpoint.popups = [{ provisionalId: 'no-gesture', openerViewId: opener.webviewId, url: 'https://child.test/', disposition: 6, userGesture: false, status: 'pending' }]; await control.tick(); assert.equal(store.workspace(user.tenantId).tabs.length, 3);
  } finally { await control.detachViewer(user.tenantId, 'lease'); store.db.close(); }
});

test('expired pending popup is never URL-recreated; closing its product tab does not resurface it', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.attachViewer(user.tenantId, 'lease', () => {}); const opener = (await control.productAction(user.tenantId, { type: 'window.create' }, 'lease')).state.workspace.tabs[0];
    const popup = { provisionalId: 'expired', openerViewId: opener.webviewId, url: 'https://expired.test/', disposition: 3, userGesture: true, status: 'pending' };
    endpoint.popups = [popup]; endpoint.onAdopt = () => { throw new Error('temporary transport failure'); }; await control.tick(); const pending = store.workspace(user.tenantId).tabs.find(t => t.popup?.provisionalId === popup.provisionalId)!;
    endpoint.onAdopt = undefined; popup.status = 'timed_out'; endpoint.calls = []; await control.tick(); assert.equal(store.workspace(user.tenantId).tabs.find(t => t.id === pending.id)!.popup!.status, 'failed'); assert.equal(endpoint.calls.filter(c => c.method === 'view.ensure' || c.method === 'view.adopt').length, 0);
    await control.productAction(user.tenantId, { type: 'tab.close', tabId: pending.id }, 'lease'); popup.status = 'pending'; await control.tick(); assert.equal(store.workspace(user.tenantId).tabs.length, 1);
  } finally { await control.detachViewer(user.tenantId, 'lease'); store.db.close(); }
});

test('natural close commits removal before ack, retries failed ack and never recreates the closed view', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.attachViewer(user.tenantId, 'lease', () => {}); const tab = (await control.productAction(user.tenantId, { type: 'window.create' }, 'lease')).state.workspace.tabs[0];
    endpoint.views.get(user.tenantId)!.delete(tab.webviewId); endpoint.events = [{ eventId: 'closed-1', type: 'view.closed', viewId: tab.webviewId, reason: 'window.close' }]; endpoint.failAck = true; await control.tick(); assert.equal(store.workspace(user.tenantId).tabs.length, 0); assert.equal(endpoint.events.length, 1);
    endpoint.failAck = false; endpoint.calls = []; await control.tick(); assert.equal(endpoint.events.length, 0); assert.equal(store.workspace(user.tenantId).windows.length, 1); assert.equal(endpoint.calls.filter(c => c.method === 'view.ensure').length, 0);
    endpoint.events = [{ eventId: 'closed-1', type: 'view.closed', viewId: tab.webviewId, reason: 'window.close' }]; await control.tick(); assert.equal(store.workspace(user.tenantId).tabs.length, 0); assert.equal(endpoint.events.length, 0);
  } finally { await control.detachViewer(user.tenantId, 'lease'); store.db.close(); }
});

function connect(url: string, cookie: string, origin = 'http://product.test') {
  const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } }), messages: any[] = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString()))); ws.on('error', () => {});
  const wait = async (predicate: (m: any) => boolean) => { for (let i = 0; i < 300; i++) { const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for socket response'); };
  return { ws, wait, request: async (id: string, method: string, params: unknown) => { ws.send(JSON.stringify({ id, method, params })); return wait(m => m.id === id); } };
}

test('HTTP auth and WS isolate users, reject origin/scope, revoke a replaced Viewer and hide on disconnect', async () => {
  const store = new Store(':memory:'), endpoint = new ProductEndpoint(), control = new Control(store, endpoint), server = createHttp(control, { origins: ['http://product.test'], clientDir: '.', metricsDir: '.' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address() as any, base = `http://127.0.0.1:${address.port}`, socketUrl = base.replace('http:', 'ws:') + '/api/socket';
  const post = (path: string, body: unknown, cookie?: string) => fetch(base + path, { method: 'POST', headers: { Origin: 'http://product.test', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const peers: ReturnType<typeof connect>[] = [];
  try {
    assert.equal((await fetch(base + '/api/state?diagnostics=1', { headers: { 'X-RemoteKit-Diagnostics': '1' } })).status, 404);
    assert.equal((await fetch(base + '/api/auth/me')).status, 401);
    const register = await post('/api/auth/register', { username: 'alice', password: 'password123' }); assert.equal(register.status, 200); const cookieA = register.headers.get('set-cookie')!.split(';')[0]; assert.match(register.headers.get('set-cookie')!, /HttpOnly.*SameSite=Strict/);
    const registerB = await post('/api/auth/register', { username: 'bob', password: 'password123' }); const cookieB = registerB.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await post('/api/auth/login', { username: 'alice', password: 'wrong-pass' })).status, 401);
    assert.equal((await post('/api/actions', { type: 'tab.create', url: 'about:blank' }, cookieA)).status, 404);
    const a = connect(socketUrl, cookieA); peers.push(a); await a.wait(m => m.type === 'state');
    const created = await a.request('1', 'action', { type: 'window.create' }); const stateA = created.result.state, win = stateA.workspace.windows[0], tab = stateA.workspace.tabs[0];
    const b = connect(socketUrl, cookieB); peers.push(b); const initialB = await b.wait(m => m.type === 'state'); assert.equal(initialB.state.workspace.tabs.length, 0);
    const foreign = await b.request('2', 'action', { type: 'tab.activate', tabId: tab.id }); assert.equal(foreign.error.code, 404);
    const scope = await b.request('3', 'action', { type: 'window.create', tenantId: stateA.workspace.tenantId }); assert.equal(scope.error.code, 400);
    await a.request('4', 'viewport', { devicePixelRatio: 1, windows: [{ windowId: win.id, width: 900, height: 700, visible: true }] }); assert.equal(endpoint.views.get(stateA.workspace.tenantId)!.get(tab.webviewId).visible, true);
    const replacement = connect(socketUrl, cookieA); peers.push(replacement); const revoked = await a.wait(m => m.type === 'lease'); assert.equal(revoked.reason, 'another-viewer'); await replacement.wait(m => m.type === 'state');
    await assert.rejects(control.viewerRequest(stateA.workspace.tenantId, 'stale-lease', 'action', { type: 'window.create' }));
    await replacement.request('5', 'viewport', { devicePixelRatio: 1, windows: [{ windowId: win.id, width: 901, height: 700, visible: true }] });
    const detached = new Promise<void>(resolve => { const observed = (tenant: string, state: any) => { if (tenant === stateA.workspace.tenantId && !state.viewer.connected) { control.off('state', observed); resolve(); } }; control.on('state', observed); });
    replacement.ws.close(); await once(replacement.ws, 'close'); await detached;
    assert.equal(endpoint.views.get(stateA.workspace.tenantId)!.get(tab.webviewId).visible, false);
    const badOrigin = connect(socketUrl, cookieB, 'http://evil.test'); await once(badOrigin.ws, 'error'); assert.notEqual(badOrigin.ws.readyState, WebSocket.OPEN);
    const logout = await post('/api/auth/logout', {}, cookieB); assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/); assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: cookieB } })).status, 401);
    const hashes = store.db.prepare('SELECT password_hash,salt FROM users WHERE legacy=0').all() as any[]; assert.equal(hashes.length, 2); assert.notEqual(hashes[0].salt, hashes[1].salt); assert.ok(hashes.every(h => h.password_hash !== 'password123'));
  } finally {
    for (const { ws } of peers) { if (ws.readyState !== WebSocket.CLOSED) { const closed = once(ws, 'close'); ws.terminate(); await closed; } }
    for (const tenant of store.all()) await control.serial(tenant, async () => {});
    await new Promise<void>(resolve => server.close(() => resolve())); store.db.close();
  }
});
