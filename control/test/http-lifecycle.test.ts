import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createHttp } from '../server/http/server';
import { createApplication, type DomainServices } from '../server/application';
import { ControlDatabase } from '../server/persistence/database';
import { registerUser, testGateway } from './server-fixture';
import { configureLog } from '../server/log';

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test('self sign-out closes its socket after revoking all logins without a request failure', async (t) => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const control = createApplication(store, testGateway({ request: async () => ({}) }));
  const account = await registerUser(store, 'logout-admin', 'logout-password');
  const otherToken = store.accounts.issueToken(account.user.id);
  const failures: unknown[] = [];
  configureLog({
    write: (line) => {
      const record = JSON.parse(line);
      if (record.ev === 'viewer.request_failed') failures.push(record);
    },
  });
  t.after(() =>
    configureLog({
      write: (line) => {
        process.stderr.write(line);
      },
    }),
  );
  const server = createHttp(control, { origins: ['http://test.local'], clientDir: '.' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/socket`, {
    origin: 'http://test.local',
    headers: { cookie: 'rk_session=' + account.token },
  });
  const messages: any[] = [];
  const unlocked = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === 'auth' && !message.auth.locked) resolve();
    });
  });
  try {
    await once(ws, 'open');
    ws.send(
      JSON.stringify({
        id: 'unlock',
        method: 'auth.verify',
        params: { method: 'password', secret: 'logout-password' },
      }),
    );
    await unlocked;
    const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) });
    ws.send(JSON.stringify({ id: 'logout', method: 'admin.signOut', params: { username: 'logout-admin' } }));
    assert.equal((await closed)[0], 4002);
    await server.shutdown();
    assert.equal(store.accounts.identity(account.token), undefined);
    assert.equal(store.accounts.identity(otherToken), undefined);
    assert.equal(control.tenants.get(account.tenantId).viewer, undefined);
    assert(messages.some((message) => message.type === 'lease' && message.outcome === 'logged_out'));
    assert.deepEqual(failures, []);
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await control.close();
    store.db.close();
  }
});
test('shutdown closes upgraded sockets, removes listeners, and drains RPC and detach before returning', async () => {
  const rpc = gate(),
    detached = gate(),
    rpcEntered = gate();
  let detachCount = 0,
    signalsCleared = false;
  const control = {
    events: new EventEmitter(),
    accounts: { identity: () => ({ tenantId: 'tenant' }) },
    viewers: {
      attachViewer: async () => ({ workspace: { revision: 1 } }),
      productEpoch: () => undefined,
      productAllowed: () => true,
      pollFaceAuth: async () => {},
      assertViewer() {},
      detachViewer: async () => {
        detachCount++;
        await detached.promise;
      },
    },
    rtc: {
      offer: async () => {
        rpcEntered.resolve();
        await rpc.promise;
        return {};
      },
      clearSignals: () => {
        signalsCleared = true;
      },
    },
  } as unknown as DomainServices;
  const server = createHttp(control, { origins: ['http://test.local'], clientDir: '.' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const clients = [
    new WebSocket(`ws://127.0.0.1:${port}/api/socket`, {
      origin: 'http://test.local',
      headers: { cookie: 'rk_session=token' },
    }),
    new WebSocket(`ws://127.0.0.1:${port}/api/socket`, {
      origin: 'http://test.local',
      headers: { cookie: 'rk_session=token' },
      autoPong: false,
    }),
  ];
  await Promise.all(clients.map((client) => once(client, 'open')));
  clients[0].send(JSON.stringify({ id: '1', method: 'rtc.offer', params: {} }));
  await rpcEntered.promise;
  const closed = clients.map((client) => once(client, 'close'));
  let complete = false;
  const shutdown = server.shutdown();
  assert.equal(server.shutdown(), shutdown);
  void shutdown.then(() => {
    complete = true;
  });
  assert.equal(control.events.listenerCount('state'), 0);
  assert.equal(control.events.listenerCount('rtc.signal'), 0);
  await Promise.all(closed);
  assert.equal(complete, false);
  assert.equal(detachCount, 2);
  rpc.resolve();
  detached.resolve();
  await shutdown;
  assert.equal(signalsCleared, true);
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
