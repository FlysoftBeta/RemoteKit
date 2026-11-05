import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { RemoteKitError, httpStatus, toRemoteKitError } from '../shared/errors';
import { EndpointGateway } from '../server/endpoint/gateway';
import { LocalProcessLink } from '../server/endpoint/local-process';
import { readyTransition, type EndpointLinkState } from '../server/endpoint/link';
import { TenantRegistry } from '../server/tenants/tenant-registry';
import { KeyedSerialQueue } from '../server/util/serial-queue';
import { runtimeConfig } from '../server/config';
import { createHttp } from '../server/http/server';
import { createApplication, type DomainServices } from '../server/application';
import { TestClock } from './server-fixture';

test('gateway normalizes identity and preserves execution certainty across native errors', async () => {
  let state: EndpointLinkState = { state: 'offline' };
  let calls = 0;
  let failure: unknown;
  const gateway = new EndpointGateway({
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
    await assert.rejects(gateway.snapshot('tenant'), { code, message: '拒绝请求' });
  }
  failure = { code: 'busy', message: '繁忙' };
  await assert.rejects(gateway.snapshot('tenant'), { code: 'unavailable' });
  failure = { message: '拒绝请求' };
  await assert.rejects(gateway.snapshot('tenant'), { code: 'rejected' });
  failure = 'native diagnostic';
  await assert.rejects(gateway.snapshot('tenant'), { code: 'rejected', detail: 'native diagnostic' });
  failure = new Error('local bug');
  await assert.rejects(gateway.snapshot('tenant'), { code: 'internal' });
});

test('local process distinguishes an unsent request from a lost dispatched reply', async () => {
  const child = `process.stdin.on('data', bytes => {
    const request = JSON.parse(bytes.toString());
    if (request.method === 'view.navigate') process.exit(3);
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'rejected', message: '拒绝请求' } }) + '\\n');
  });`;
  const link = new LocalProcessLink(process.execPath, ['-e', child]);
  const gateway = new EndpointGateway(link);
  await assert.rejects(gateway.snapshot('tenant'), { code: 'unavailable' });
  const ready = once(link, 'ready');
  link.start();
  await ready;
  try {
    await assert.rejects(gateway.snapshot('tenant'), { code: 'rejected' });
    await assert.rejects(gateway.navigate('tenant', { viewId: '1', url: 'https://example.test' }), {
      code: 'outcome_unknown',
    });
    assert.equal(link.state.state, 'offline');
  } finally {
    await link.stop();
  }
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

test('configuration validates input and freezes parsed runtime values', () => {
  const config = runtimeConfig({ PORT: '0', REMOTEKIT_ENDPOINT_ARGS: '["--native"]' }, []);
  assert.equal(config.port, 0);
  assert.deepEqual(config.endpointArgs, ['--native']);
  assert.ok(
    Object.isFrozen(config) && Object.isFrozen(config.endpointArgs) && Object.isFrozen(config.origins),
  );
  for (const env of [{ PORT: '-1' }, { REMOTEKIT_ENDPOINT_ARGS: '{}' }, { REMOTEKIT_HTTPS_KEY: 'key' }])
    assert.throws(() => runtimeConfig(env, []), { code: 'invalid_request' });
  assert.throws(() => runtimeConfig({}, ['--unexpected']), { code: 'invalid_request' });
});

test('HTTP and socket boundaries expose code and message without diagnostic details', async () => {
  let failure: unknown = new RemoteKitError('forbidden', '需要权限', 'private detail');
  const control = {
    events: new EventEmitter(),
    accounts: {
      registrationStatus() {
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
    for (const [code, message, status] of [
      ['forbidden', '需要权限', 403],
      ['internal', '服务内部错误', 500],
    ] as const) {
      const response = await fetch(base + '/api/auth/registration');
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: { code, message } });
      const reply = once(socket, 'message');
      socket.send(JSON.stringify({ id: 'request', method: 'clock.ping', params: {} }));
      assert.deepEqual(JSON.parse(String((await reply)[0])), {
        type: 'error',
        id: 'request',
        error: { code, message },
      });
      failure = new Error('private local failure');
    }
  } finally {
    socket.terminate();
    await server.shutdown();
  }
});
