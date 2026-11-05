import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createHttp } from '../server/http';
import type { Control } from '../server/control';

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
test('shutdown closes upgraded sockets, removes listeners, and drains RPC and detach before returning', async () => {
  const rpc = gate(),
    detached = gate(),
    rpcEntered = gate();
  let detachCount = 0,
    signalsCleared = false;
  const control = Object.assign(new EventEmitter(), {
    store: { identity: () => ({ tenantId: 'tenant' }) },
    attachViewer: async () => ({ workspace: { revision: 1 } }),
    productEpoch: () => undefined,
    productAllowed: () => true,
    pollFaceAuth: async () => {},
    detachViewer: async () => {
      detachCount++;
      await detached.promise;
    },
    viewerRequest: async () => {
      rpcEntered.resolve();
      await rpc.promise;
      return {};
    },
    clearSignals: () => {
      signalsCleared = true;
    },
  }) as unknown as Control;
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
  clients[0].send(JSON.stringify({ id: '1', method: 'clock.ping', params: {} }));
  await rpcEntered.promise;
  const closed = clients.map((client) => once(client, 'close'));
  let complete = false;
  const shutdown = server.shutdown();
  assert.equal(server.shutdown(), shutdown);
  void shutdown.then(() => {
    complete = true;
  });
  assert.equal(control.listenerCount('state'), 0);
  assert.equal(control.listenerCount('rtc.signal'), 0);
  await Promise.all(closed);
  assert.equal(complete, false);
  assert.equal(detachCount, 2);
  rpc.resolve();
  detached.resolve();
  await shutdown;
  assert.equal(signalsCleared, true);
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
