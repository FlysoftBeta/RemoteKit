import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { RemoteKitError, httpStatus, toRemoteKitError } from '../shared/errors';
import { readyTransition, type EndpointLinkState } from '../server/endpoint/link';
import { TenantRegistry } from '../server/tenants/tenant-registry';
import { KeyedSerialQueue } from '../server/util/serial-queue';
import { createHttp } from '../server/http/server';
import { createApplication, type DomainServices } from '../server/application';
import { TestClock, testGateway } from './server-fixture';

test('gateway normalizes identity and preserves execution certainty across native errors', async () => {
  let state: EndpointLinkState = { state: 'offline' };
  let calls = 0;
  let failure: unknown;
  const gateway = testGateway({
    get state() {
      return state;
    },
    async request() {
      calls++;
      if (failure) throw failure;
      return { views: [{ viewId: '1' }, { view: 2 }, { id: '3' }] };
    },
  });
  await assert.rejects(gateway.snapshot('tenant'), { code: 'unavailable' });
  assert.equal(calls, 0);
  const initial = readyTransition(undefined, 'process-a', 'connection-a');
  state = initial.state;
  assert.equal(initial.processChanged, true);
  assert.equal(readyTransition('process-a', 'process-a', 'connection-b').processChanged, false);
  assert.equal(readyTransition('process-a', 'process-b', 'connection-c').processChanged, true);
  assert.deepEqual((await gateway.snapshot('tenant')).views, [
    { viewId: '1' },
    { viewId: '2' },
    { viewId: '3' },
  ]);
  for (const code of Object.keys(httpStatus)) {
    failure = { code, message: '拒绝请求' };
    await assert.rejects(gateway.snapshot('tenant'), {
      code,
      detail: '拒绝请求',
    });
  }
  failure = { code: 'busy', message: '繁忙' };
  await assert.rejects(gateway.snapshot('tenant'), { code: 'busy' });
  failure = { message: '拒绝请求' };
  await assert.rejects(gateway.snapshot('tenant'), { code: 'outcome_unknown' });
  failure = 'native diagnostic';
  await assert.rejects(gateway.snapshot('tenant'), { code: 'outcome_unknown', detail: 'native diagnostic' });
  failure = new Error('local bug');
  await assert.rejects(gateway.snapshot('tenant'), { code: 'internal' });
});

test('tenant disposal cancels pending signaling and queues isolate keys after a rejection', async () => {
  const registry = new TenantRegistry(new TestClock());
  const runtime = registry.get('one');
  assert.equal(registry.get('one'), runtime);
  assert.notEqual(registry.get('two'), runtime);
  runtime.beginRtc('connection', 'attempt', 'lease');
  let cancelled: unknown;
  runtime.rtc.signal = {
    tenant: 'one',
    lease: 'lease',
    attemptId: 'attempt',
    answered: false,
    resolve() {},
    reject(error) {
      cancelled = error;
    },
    timer: setTimeout(() => {}, 60000),
  };
  runtime.activateRtc('connection', 'lease');
  runtime.disconnectRtc();
  assert.equal(runtime.rtc.connection.phase, 'idle');
  assert.equal(toRemoteKitError(cancelled).code, 'unavailable');
  runtime.resetEndpoint();
  assert.equal(runtime.rtc.disconnectedPeer, undefined);
  registry.dispose('one');
  assert.notEqual(registry.get('one'), runtime);
  const queue = new KeyedSerialQueue();
  let release!: () => void;
  const blocked = queue.run(
    'one',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const events: string[] = [];
  const second = queue.run('one', async () => {
    events.push('one');
  });
  await queue.run('two', async () => {
    events.push('two');
  });
  assert.deepEqual(events, ['two']);
  release();
  await Promise.all([blocked, second]);
  await assert.rejects(
    queue.run('one', async () => {
      throw new RemoteKitError('conflict', '冲突');
    }),
    { code: 'conflict' },
  );
  await queue.run('one', async () => {
    events.push('recovered');
  });
  assert.deepEqual(events, ['two', 'one', 'recovered']);
  await Promise.all([queue.drain(), registry.close()]);
});

test('HTTP and socket boundaries expose code and message without diagnostic details', async () => {
  let failure: unknown = new RemoteKitError('forbidden', '需要权限', { detail: 'private detail' });
  const control = {
    events: new EventEmitter(),
    accounts: {
      setupStatus() {
        throw failure;
      },
      me() {
        throw failure;
      },
      identity: () => ({ tenantId: 'tenant' }),
    },
    viewers: {
      attachViewer: async () => {},
      detachViewer: async () => {},
      pollFaceAuth: async () => {},
      productEpoch: () => 1,
      productAllowed: () => true,
      assertViewer: () => {
        throw failure;
      },
    },
    rtc: { clearSignals() {} },
  } as unknown as DomainServices;
  const server = createHttp(control, { origins: ['http://test.local'], clientDir: '.' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/socket', {
    origin: 'http://test.local',
    headers: { cookie: 'rk_session=token' },
  });
  try {
    await once(socket, 'open');
    const denied = await fetch(base + '/api/socket/check?origin=http://denied.test');
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'forbidden');
    for (const [code, message, status] of [
      ['forbidden', '需要权限', 403],
      ['internal', '服务内部错误', 500],
    ] as const) {
      const response = await fetch(base + '/api/auth/setup');
      assert.equal(response.status, status);
      const httpBody = await response.json();
      if (code === 'internal') assert.match(httpBody.error.errorId, /^c-[0-9a-f]{10}$/);
      const { errorId: httpErrorId, ...httpError } = httpBody.error;
      assert.deepEqual(httpError, { code, message });
      const reply = once(socket, 'message');
      socket.send(JSON.stringify({ id: 'request', method: 'clock.ping', params: {} }));
      const socketBody = JSON.parse(String((await reply)[0]));
      if (code === 'internal') assert.match(socketBody.error.errorId, /^c-[0-9a-f]{10}$/);
      const { errorId: socketErrorId, ...socketError } = socketBody.error;
      assert.deepEqual(
        { ...socketBody, error: socketError },
        {
          type: 'error',
          id: 'request',
          error: { code, message },
        },
      );
      failure = new Error('private local failure');
    }
    failure = new RemoteKitError('rate_limited', '请求过于频繁', { retryAfterMs: 1500 });
    const throttled = await fetch(base + '/api/socket/check?origin=http://test.local');
    assert.equal(throttled.headers.get('Retry-After'), '2');
    assert.deepEqual(await throttled.json(), {
      error: { code: 'rate_limited', message: '请求过于频繁', retryAfterMs: 1500 },
    });
  } finally {
    socket.terminate();
    await server.shutdown();
  }
});
