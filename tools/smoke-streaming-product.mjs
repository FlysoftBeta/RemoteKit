// Run with the packaged Node and resolve ws from the package, never the source tree.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const [packageRoot, origin] = process.argv.slice(2);
const { WebSocket } = createRequire(resolve(packageRoot, 'control/dist/server.mjs'))('ws');
const timeout = setTimeout(() => { console.error('Product package smoke timed out'); process.exit(1); }, 45000);
let socket;
try {
  assert.equal((await fetch(origin + '/api/auth/me')).status, 401);
  assert.equal((await fetch(origin + '/api/state')).status, 404, 'Diagnostics must be disabled');
  const response = await fetch(origin + '/api/auth/register', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'package-smoke', password: randomBytes(24).toString('hex') }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(origin + '/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
  socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/socket', { origin, headers: { Cookie: cookie } });
  let latest, sequence = 0;
  const pending = new Map();
  const states = [];
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'state') { latest = message.state; for (const check of [...states]) check(); }
    if (message.type === 'result' || message.type === 'error') {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (waiter) message.type === 'error' ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = String(++sequence); pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const waitState = predicate => new Promise(resolve => {
    const check = () => { if (latest && predicate(latest)) { states.splice(states.indexOf(check), 1); resolve(latest); } };
    states.push(check); check();
  });
  const initial = await waitState(() => true);
  assert.equal(initial.quality.mode, 'product');
  const created = await rpc('action', { type: 'window.create', url: 'about:blank' });
  const windowId = created.state.workspace.activeWindowId;
  await rpc('viewport', { devicePixelRatio: 1, refreshHz: 60, windows: [{ windowId, width: 800, height: 600, visible: true }] });
  const state = await waitState(state => !state.endpointError && state.workspace.tabs.length === 1 && state.workspace.tabs[0].loading === false && state.workspace.tabs[0].residency === 'live');
  const viewId = state.workspace.tabs[0].webviewId;
  assert.match(viewId, /^[1-9][0-9]*$/);
  assert.equal(state.workspace.tenantId, initial.workspace.tenantId);
  assert.ok((await rpc('clock.ping', { clientTime: Date.now() })).serverTime > 0);
  console.log(JSON.stringify({ tenantId: state.workspace.tenantId, viewId, auth: 'registered-user', transport: 'websocket', diagnostics: false, qualityMode: state.quality.mode }));
} finally { clearTimeout(timeout); socket?.terminate(); }
