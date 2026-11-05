// Run with the packaged Node and resolve ws from the package, never the source tree.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

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
  assert.equal((await fetch(origin + '/api/state')).status, 404, 'Diagnostics must be disabled');
  assert.deepEqual(await (await fetch(origin + '/api/auth/registration')).json(), {
    hasAdmin: false,
    credentialRequired: false,
    registrationOpen: true,
  });
  const password = randomBytes(24).toString('hex');
  const response = await fetch(origin + '/api/auth/register', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'package-smoke', password }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).user.isAdmin, true, 'The first registered user must be administrator');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(origin + '/api/auth/registration')).json(), {
    hasAdmin: true,
    credentialRequired: true,
    registrationOpen: false,
  });
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
  const initial = await waitState(() => true);
  assert.equal(auth?.locked, false, 'Registration must grant initial access');
  assert.equal(initial.quality.mode, 'product');
  assert.equal(initial.endpointError, null, 'Endpoint management reconciliation must be reachable');
  const face = await waitAuth((state) => state.face.available || state.face.reason);
  assert.equal(face.face.available, true, face.face.reason);
  assert.deepEqual(await rpc('admin.get', {}), { registrationCredentialConfigured: false });
  await assert.rejects(
    rpc('action', { type: 'window.create', url: 'about:blank' }),
    (error) => error.code === 400 && /WebRTC/.test(error.message),
    'Browser actions must be rejected over WebSocket',
  );
  const clientTime = Date.now();
  const clock = await rpc('clock.ping', { clientTime });
  assert.ok(clock.serverTime > 0);
  assert.equal(clock.clientTime, clientTime);
  // A fresh authenticated snapshot proves the rejected action did not mutate
  // persisted product state; a lack of push messages alone would not prove it.
  await new Promise((resolve) => {
    socket.once('close', resolve);
    socket.close();
  });
  latest = undefined;
  await connect();
  assert.equal((await rpc('auth.get', {})).locked, true, 'Reattached Viewer must begin locked');
  assert.equal(latest, undefined, 'Locked Viewer must receive no product snapshot');
  assert.equal((await rpc('auth.verify', { method: 'password', secret: password })).locked, false);
  const state = await waitState(() => true);
  assert.deepEqual(
    state.workspace,
    initial.workspace,
    'Rejected WebSocket action must leave workspace unchanged',
  );
  assert.equal(state.endpointError, null);
  console.log(
    JSON.stringify({
      tenantId: state.workspace.tenantId,
      auth: 'registered-first-administrator',
      transport: 'authenticated-websocket',
      diagnostics: false,
      qualityMode: state.quality.mode,
      endpointManagementReachable: true,
      webSocketProductActionRejected: true,
      workspaceUnchanged: true,
      faceModelsAvailable: true,
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
