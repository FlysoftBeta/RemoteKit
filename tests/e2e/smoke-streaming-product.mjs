// Run with the packaged Node and resolve ws from the package, never the source tree.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const [packageRoot, origin] = process.argv.slice(2);
const { WebSocket } = createRequire(resolve(packageRoot, 'control/dist/server.mjs'))('ws');
// Startup/authentication contract only. Browser actions and media require a real
// Viewer WebRTC check against the extracted package during release validation.
const timeout = setTimeout(() => {
  console.error('Package startup smoke timed out');
  process.exit(1);
}, 45000);
let socket;
try {
  assert.equal((await fetch(origin + '/api/auth/me')).status, 401);
  assert.deepEqual(await (await fetch(origin + '/api/auth/setup')).json(), { setupRequired: true });
  const password = randomBytes(24).toString('hex');
  const response = await fetch(origin + '/api/auth/setup', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'package-smoke', password }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).user.isAdmin, true, 'The first account must be administrator');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(origin + '/api/auth/setup')).json(), { setupRequired: false });
  assert.equal((await fetch(origin + '/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
  let latest,
    auth,
    sequence = 0;
  const pending = new Map();
  const states = [],
    authStates = [];
  const receive = (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'auth') {
      auth = message.auth;
      for (const check of [...authStates]) check();
    }
    if (message.type === 'state') {
      latest = message.state;
      for (const check of [...states]) check();
    }
    if (message.type === 'result' || message.type === 'error') {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (waiter)
        message.type === 'error'
          ? waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
          : waiter.resolve(message.result);
    }
  };
  const connect = () =>
    new Promise((resolve, reject) => {
      socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/socket', {
        origin,
        headers: { Cookie: cookie },
      });
      socket.on('message', receive);
      socket.once('open', resolve);
      socket.once('error', reject);
    });
  await connect();
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const waitState = (predicate) =>
    new Promise((resolve) => {
      const check = () => {
        if (latest && predicate(latest)) {
          states.splice(states.indexOf(check), 1);
          resolve(latest);
        }
      };
      states.push(check);
      check();
    });
  const waitAuth = (predicate) =>
    new Promise((resolve) => {
      const check = () => {
        if (auth && predicate(auth)) {
          authStates.splice(authStates.indexOf(check), 1);
          resolve(auth);
        }
      };
      authStates.push(check);
      check();
    });
  const initial = await waitState((state) => state.endpointError === null);
  assert.equal(auth?.locked, false, 'Registration must grant initial access');
  assert.equal(initial.quality.mode, 'product');
  assert.deepEqual((await rpc('admin.users', {})).map((user) => user.username), ['package-smoke']);
  // Product operations travel over the WebSocket as receipts; this one needs no browser.
  const showStats = !initial.workspace.settings.workspace.showStats;
  const receipt = await rpc('operation.submit', {
    operationId: randomUUID(),
    operationGeneration: initial.operationGeneration,
    action: { type: 'settings.update', settings: { workspace: { showStats } } },
  });
  assert.equal(receipt.status, 'committed', JSON.stringify(receipt));
  await assert.rejects(
    rpc('action', { type: 'window.create', url: 'about:blank' }),
    (error) => error.code === 'invalid_request',
    'Retired WebSocket action route must not exist',
  );
  const clientTime = Date.now();
  const clock = await rpc('clock.ping', { clientTime });
  assert.ok(clock.serverTime > 0);
  assert.equal(clock.clientTime, clientTime);
  // A fresh authenticated snapshot proves the committed operation persisted.
  await new Promise((resolve) => {
    socket.once('close', resolve);
    socket.close();
  });
  latest = undefined;
  auth = undefined;
  await connect();
  assert.equal((await rpc('auth.get', {})).locked, true, 'Reattached Viewer must begin locked');
  assert.equal(latest, undefined, 'Locked Viewer must receive no product snapshot');
  assert.equal((await rpc('auth.verify', { method: 'password', secret: password })).locked, false);
  const state = await waitState(() => true);
  assert.equal(state.workspace.settings.workspace.showStats, showStats, 'Committed operation must persist');
  assert.equal(state.endpointError, null);
  console.log(
    JSON.stringify({
      tenantId: state.workspace.tenantId,
      auth: 'setup-first-administrator',
      transport: 'authenticated-websocket',
      qualityMode: state.quality.mode,
      endpointManagementReachable: true,
      webSocketOperationCommitted: true,
      adminReachable: true,
      clockChecked: true,
      browserProductOperationsTested: false,
      rtcMediaTested: false,
    }),
  );
} finally {
  clearTimeout(timeout);
  socket?.terminate();
}
