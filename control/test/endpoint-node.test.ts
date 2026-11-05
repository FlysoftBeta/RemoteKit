import { accountsFor } from './server-fixture';
import { requestViewer } from './server-fixture';
import { RemoteKitError } from '../shared/errors';
import { testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { createHttp } from '../server/http/server';
import { RemoteNodeLink, type RemoteNodeOptions } from '../server/endpoint/remote-node';
import { createApplication, type DomainServices } from '../server/application';
import { ControlDatabase } from '../server/persistence/database';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

async function harness(options: Partial<RemoteNodeOptions> = {}, enabled = true) {
  const endpoint = new RemoteNodeLink({ nodeId: 'compute-1', token: 'test-node-secret', ...options });
  const control = {
    events: new EventEmitter(),
    accounts: { identity: () => undefined },
    viewers: { pollFaceAuth: async () => {} },
    rtc: { clearSignals() {} },
  } as unknown as DomainServices;
  const server = createHttp(control, {
    origins: ['http://test.local'],
    clientDir: '.',
    endpointNode: enabled ? endpoint : undefined,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/endpoint`;
  const clients: WebSocket[] = [];
  async function connect(hello = true, headers: Record<string, string> = {}, autoPong = true) {
    const socket = new WebSocket(url, {
      headers: { authorization: 'Bearer test-node-secret', ...headers },
      autoPong,
    });
    clients.push(socket);
    await once(socket, 'open');
    if (hello) {
      const ready = once(socket, 'message');
      socket.send(
        JSON.stringify({
          type: 'node.hello',
          version: 1,
          nodeId: 'compute-1',
          endpointIncarnation: 'test-incarnation-0001',
        }),
      );
      const message = JSON.parse(String((await ready)[0]));
      assert.equal(message.type, 'node.ready');
      assert.equal(message.version, 1);
      assert.ok(message.connectionEpoch);
    }
    return socket;
  }
  async function close() {
    endpoint.stop();
    for (const client of clients) client.terminate();
    await server.shutdown();
  }
  return { endpoint, control, server, connect, close, url };
}

test('configured node authenticates without viewer origin and carries existing RPC, signal and heartbeat messages', async () => {
  const h = await harness();
  try {
    let readyCount = 0;
    h.endpoint.on('ready', () => readyCount++);
    const socket = await h.connect();
    assert.equal(readyCount, 1);
    const request = once(socket, 'message'),
      result = h.endpoint.request('session.snapshot', 'tenant-A', { detail: true });
    const message = JSON.parse(String((await request)[0]));
    assert.equal(message.method, 'session.snapshot');
    assert.equal(message.tenantId, 'tenant-A');
    assert.equal(message.detail, true);
    socket.send(JSON.stringify({ id: message.id, ok: true, result: { running: true } }));
    assert.deepEqual(await result, { running: true });
    const signal = once(h.endpoint, 'rtc.signal');
    socket.send(
      JSON.stringify({
        event: 'rtc.signal',
        tenantId: 'tenant-A',
        connectionId: 'rtc-A',
        signal: { type: 'complete' },
      }),
    );
    assert.equal((await signal)[0].connectionId, 'rtc-A');
    const pong = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'node.ping' }));
    assert.deepEqual(JSON.parse(String((await pong)[0])), { type: 'node.pong' });
  } finally {
    await h.close();
  }
});

test('socket replacement rejects old pending and ignores queued old replies/signals without replay', async () => {
  const h = await harness();
  try {
    const a = await h.connect();
    const oldServerSocket = (h.endpoint as any).current.socket as WebSocket;
    const oldRequest = once(a, 'message');
    const oldResult = assert.rejects(h.endpoint.request('view.ensure', 'tenant'), {
      code: 'outcome_unknown',
    });
    await oldRequest;
    const b = await h.connect();
    await oldResult;
    let signals = 0;
    h.endpoint.onSignal(() => signals++);
    const request = once(b, 'message'),
      result = h.endpoint.request('session.snapshot', 'tenant');
    const message = JSON.parse(String((await request)[0]));
    // An already queued old-socket callback must not resolve a new generation.
    oldServerSocket.emit(
      'message',
      Buffer.from(JSON.stringify({ id: message.id, ok: true, result: 'old' })),
      false,
    );
    oldServerSocket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'rtc.signal',
          tenantId: 'tenant',
          connectionId: 'old',
          signal: { type: 'complete' },
        }),
      ),
      false,
    );
    assert.equal(signals, 0);
    b.send(JSON.stringify({ id: message.id, ok: true, result: 'new' }));
    assert.equal(await result, 'new');
    const received = once(h.endpoint, 'rtc.signal');
    b.send(
      JSON.stringify({
        event: 'rtc.signal',
        tenantId: 'tenant',
        connectionId: 'new',
        signal: { type: 'complete' },
      }),
    );
    await received;
    assert.equal(signals, 1);
  } finally {
    await h.close();
  }
});

test('disconnect fails pending immediately; reconnect emits ready and does not replay mutations', async () => {
  const h = await harness();
  try {
    await assert.rejects(h.endpoint.request('view.ensure', 'tenant'), { code: 'unavailable' });
    const a = await h.connect();
    const request = once(a, 'message');
    const pending = assert.rejects(h.endpoint.request('view.ensure', 'tenant'), { code: 'outcome_unknown' });
    await request;
    const offline = once(h.endpoint, 'offline');
    a.terminate();
    await offline;
    await pending;
    await assert.rejects(h.endpoint.request('view.ensure', 'tenant'), { code: 'unavailable' });
    const ready = once(h.endpoint, 'ready');
    const b = await h.connect();
    await ready;
    const requestB = once(b, 'message'),
      result = h.endpoint.request('session.snapshot', 'tenant');
    const message = JSON.parse(String((await requestB)[0]));
    assert.equal(message.method, 'session.snapshot');
    b.send(
      JSON.stringify({ id: message.id, ok: false, error: { code: 'unavailable', message: 'not running' } }),
    );
    await assert.rejects(result, { code: 'unavailable' });
  } finally {
    await h.close();
  }
});

test('request timeout and size/pending bounds reject without replaying', async () => {
  const h = await harness({ requestTimeoutMs: 20 });
  try {
    const socket = await h.connect();
    await assert.rejects(h.endpoint.request('view.navigate', 'tenant'), { code: 'outcome_unknown' });
    await assert.rejects(h.endpoint.request('view.ensure', 'tenant', { value: 'x'.repeat(1024 * 1024) }), {
      code: 'limit_exceeded',
    });
    // The production bound is independent of transport writability.
    const pending = Array.from({ length: 256 }, () =>
      h.endpoint.request('session.snapshot', 'tenant').catch((error) => error),
    );
    await assert.rejects(h.endpoint.request('session.snapshot', 'tenant'), { code: 'unavailable' });
    socket.terminate();
    await Promise.all(pending);
  } finally {
    await h.close();
  }
});

test('bad identity and missing hello never become ready; handshake timeout closes socket', async () => {
  const h = await harness({ handshakeTimeoutMs: 20 });
  try {
    let ready = 0;
    h.endpoint.on('ready', () => ready++);
    const invalid = await h.connect(false);
    const invalidClosed = once(invalid, 'close');
    invalid.send(JSON.stringify({ type: 'node.hello', version: 1, nodeId: 'other-node' }));
    await invalidClosed;
    const silent = await h.connect(false);
    await once(silent, 'close');
    assert.equal(ready, 0);
  } finally {
    await h.close();
  }
});

test('invalid replacement hello leaves the current node online; oversized inbound message fails pending', async () => {
  const h = await harness();
  try {
    const current = await h.connect();
    const invalid = await h.connect(false),
      closed = once(invalid, 'close');
    invalid.send(
      JSON.stringify({
        type: 'node.hello',
        version: 2,
        nodeId: 'compute-1',
        endpointIncarnation: 'test-incarnation-0001',
      }),
    );
    await closed;
    const request = once(current, 'message');
    const result = assert.rejects(h.endpoint.request('session.snapshot', 'tenant'), {
      code: 'outcome_unknown',
    });
    await request;
    current.send('x'.repeat(1024 * 1024 + 1));
    await result;
  } finally {
    await h.close();
  }
});

test('unconfigured gateway and invalid credentials reject WebSocket upgrade', async () => {
  for (const enabled of [false, true]) {
    const h = await harness({}, enabled);
    try {
      const socket = new WebSocket(h.url, { headers: { authorization: 'Bearer incorrect' } });
      const error = await new Promise<Error>((resolve) => socket.once('error', resolve));
      assert.match(error.message, enabled ? /401/ : /404/);
      socket.terminate();
    } finally {
      await h.close();
    }
  }
});

test('explicit TLS proxy mode rejects plaintext without forwarded HTTPS', async () => {
  const h = await harness({ tlsProxy: true });
  try {
    await assert.rejects(h.connect(), /403/);
    const socket = await h.connect(true, { 'x-forwarded-proto': 'https' });
    assert.equal(socket.readyState, WebSocket.OPEN);
  } finally {
    await h.close();
  }
});

test(
  'server shutdown fails remote RPC before draining tracked handlers and never sends native shutdown',
  { timeout: 2000 },
  async () => {
    const h = await harness();
    try {
      const socket = await h.connect();
      const request = once(socket, 'message');
      let rejected: Error | undefined;
      Object.assign(h.control.accounts, { identity: () => ({ tenantId: 'tenant' }) });
      Object.assign(h.control.viewers, {
        attachViewer: async () => ({ workspace: { revision: 1 } }),
        productEpoch: () => undefined,
        productAllowed: () => true,
        detachViewer: async () => {},
        assertViewer() {},
      });
      Object.assign(h.control.rtc, {
        offer: () =>
          h.endpoint.request('session.snapshot', 'tenant').catch((error) => {
            rejected = error;
            throw error;
          }),
      });
      // Viewer work is tracked by createHttp and awaits the remote management RPC.
      const viewer = new WebSocket(h.url.replace('/api/endpoint', '/api/socket'), {
        origin: 'http://test.local',
        headers: { cookie: 'rk_session=test' },
      });
      await once(viewer, 'open');
      viewer.send(JSON.stringify({ id: 'rpc', method: 'rtc.offer', params: {} }));
      await request;
      const messages: string[] = [];
      socket.on('message', (data) => messages.push(String(data)));
      await h.server.shutdown();
      assert.equal((rejected as RemoteKitError).code, 'outcome_unknown');
      assert.deepEqual(messages, []);
      await assert.rejects(h.endpoint.request('shutdown', ''), { code: 'unavailable' });
    } finally {
      await h.close();
    }
  },
);

test('missing pong retires a dead management socket', async () => {
  const h = await harness({ heartbeatMs: 20 });
  try {
    await h.connect(true, {}, false);
    await once(h.endpoint, 'offline');
    await assert.rejects(h.endpoint.request('session.snapshot', 'tenant'), { code: 'unavailable' });
  } finally {
    await h.close();
  }
});

test(
  'real gateway ready preserves same-process media authority, isolates missing RTC, and retires a new process',
  { timeout: 10000 },
  async () => {
    const endpoint = new RemoteNodeLink({ nodeId: 'compute-1', token: 'test-secret' });
    const store = new ControlDatabase(':memory:'),
      control = createApplication(store, testGateway(endpoint));
    const server = createServer();
    server.on('upgrade', (req, socket, head) => endpoint.handleUpgrade(req, socket, head));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/endpoint`;
    const peers = new Map<string, string>(),
      views = new Map<string, any[]>(),
      calls: any[] = [],
      sockets: WebSocket[] = [];
    const identities: any[] = [];
    let reconciliation = Promise.resolve(),
      loseNavigationReply = false,
      failSnapshotTenant: string | undefined;
    endpoint.on('ready', (identity) => {
      identities.push(identity);
      reconciliation = control.reconciler.endpointReady(identity);
    });
    async function connect(incarnation = 'endpoint-process-0001') {
      const socket = new WebSocket(url, { headers: { authorization: 'Bearer test-secret' } });
      sockets.push(socket);
      socket.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (!message.method) return;
        calls.push(message);
        const tenant = message.tenantId;
        let result: any = { accepted: true, applied: true };
        if (message.method === 'session.snapshot' && failSnapshotTenant === tenant) {
          failSnapshotTenant = undefined;
          socket.send(
            JSON.stringify({ id: message.id, ok: false, error: 'snapshot temporarily unavailable' }),
          );
          return;
        }
        if (message.method === 'session.snapshot')
          result = {
            running: true,
            browserIncarnation: 'browser-' + tenant,
            views: views.get(tenant) ?? [],
            rtc: { active: peers.has(tenant), connectionId: peers.get(tenant) ?? null },
          };
        if (message.method === 'rtc.offer') {
          peers.set(tenant, message.connectionId);
          result = { accepted: true, avSync: message.avSync, connectionId: message.connectionId };
          socket.send(
            JSON.stringify({
              event: 'rtc.signal',
              tenantId: tenant,
              connectionId: message.connectionId,
              signal: { type: 'answer', sdp: 'v=0\r\n' },
            }),
          );
        }
        if (message.method === 'rtc.authorize') result = { applied: true, epoch: message.epoch };
        if (message.method === 'rtc.close' && peers.get(tenant) === message.connectionId)
          peers.delete(tenant);
        if (message.method === 'view.ensure') {
          const list = views.get(tenant) ?? [];
          list.push({ viewId: message.viewId, url: message.url, instance: '1', document: '1', actual: 0 });
          views.set(tenant, list);
        }
        if (message.method === 'view.navigate' && loseNavigationReply) {
          socket.terminate();
          return;
        }
        socket.send(JSON.stringify({ id: message.id, ok: true, result }));
      });
      await once(socket, 'open');
      const ready = once(endpoint, 'ready');
      socket.send(
        JSON.stringify({
          type: 'node.hello',
          version: 1,
          nodeId: 'compute-1',
          endpointIncarnation: incarnation,
        }),
      );
      await ready;
      await reconciliation;
      return socket;
    }
    const operation = (tenant: string, action: any = { type: 'window.create' }) => ({
      operationId: randomUUID(),
      operationGeneration: store.operations.operationGeneration(tenant),
      action,
    });
    try {
      let socket = await connect();
      assert.equal(identities[0].processChanged, true);
      const a = (await accountsFor(store).register('reconnect-a', 'password123')).tenantId;
      await accountsFor(store).setRegistrationCredential(a, 'registration-test');
      const b = (await accountsFor(store).register('reconnect-b', 'password123', 'registration-test'))
        .tenantId;
      await control.viewers.attachViewer(
        a,
        'lease-a',
        () => {},
        { identity: 'test-account', valid: () => true },
        true,
      );
      await control.viewers.attachViewer(
        b,
        'lease-b',
        () => {},
        { identity: 'test-account', valid: () => true },
        true,
      );
      const offer = async (tenant: string, lease: string) =>
        control.rtc.offer(tenant, { type: 'offer', sdp: 'v=0\r\n', attemptId: randomUUID() }, lease);
      const aa = await offer(a, 'lease-a'),
        bb = await offer(b, 'lease-b');
      const generation = control.viewers.productState(a).endpointGeneration;
      const firstEpoch = endpoint.state.state === 'ready' ? endpoint.state.connectionEpoch : undefined;
      const auth = (tenant: string, lease: string) => requestViewer(control, tenant, lease, 'auth.get', {});
      const offline = once(endpoint, 'offline');
      socket.terminate();
      await offline;
      control.rtc.endpointOffline();
      assert.equal(control.viewers.productAllowed(a, 'lease-a'), false);
      socket = await connect();
      await requestViewer(control, a, 'lease-a', 'auth.verify', {
        method: 'password',
        secret: 'password123',
      });
      await requestViewer(control, b, 'lease-b', 'auth.verify', {
        method: 'password',
        secret: 'password123',
      });
      assert.equal(identities[identities.length - 1].processChanged, false);
      assert.notEqual(
        endpoint.state.state === 'ready' ? endpoint.state.connectionEpoch : undefined,
        firstEpoch,
      );
      assert.equal(control.viewers.productState(a).endpointGeneration, generation);
      assert.ok((await auth(a, 'lease-a')).peerEpoch > 0);
      control.viewers.assertViewer(a, 'lease-a');
      const op = operation(a),
        receipt = once(socket, 'message');
      // Use the authenticated remote socket event, not a direct DomainServices method.
      socket.send(
        JSON.stringify({
          ...op,
          event: 'client.action',
          tenantId: a,
          connectionId: aa.connectionId,
          authEpoch: (await auth(a, 'lease-a')).peerEpoch,
        }),
      );
      // Reconciliation is serialized with the action; await its receipt publication.
      for (let i = 0; i < 50 && !store.operations.operation(a, op.operationId); i++)
        await new Promise((resolve) => setImmediate(resolve));
      await control.tenants.serial(a, async () => {});
      await receipt;
      assert.equal(control.operations.operationStatus(a, op).status, 'committed');
      peers.delete(a);
      failSnapshotTenant = a;
      socket = await connect();
      assert.equal(control.viewers.productState(a).endpointGeneration, generation);
      assert.ok((await auth(a, 'lease-a')).peerEpoch > 0);
      await control.reconciler.tick();
      assert.equal(control.viewers.productState(b).endpointGeneration, generation);
      assert.ok(control.viewers.productState(a).endpointGeneration > generation);
      assert.equal(control.viewers.productState(b).endpointGeneration, generation);
      assert.equal((await auth(a, 'lease-a')).peerEpoch, 0);
      assert.ok((await auth(b, 'lease-b')).peerEpoch > 0);
      const restored = await offer(a, 'lease-a');
      await control.operations.productAction(
        a,
        { type: 'window.create', url: 'https://before.test/' },
        'lease-a',
      );
      const tab = store.workspaces.workspace(a).tabs.find((tab) => tab.kind === 'remote')!;
      const lost = operation(a, { type: 'tab.navigate', tabId: tab.id, url: 'https://after.test/' });
      loseNavigationReply = true;
      const unknown = await control.operations.submitOperation(a, lost, 'lease-a');
      assert.equal(unknown.status, 'unknown');
      loseNavigationReply = false;
      socket = await connect();
      assert.equal(control.operations.operationStatus(a, lost).status, 'unknown');
      assert.equal(calls.filter((call) => call.method === 'view.navigate').length, 1);
      assert.ok((await auth(a, 'lease-a')).peerEpoch > 0);
      socket = await connect('endpoint-process-0002');
      assert.equal(identities[identities.length - 1].processChanged, true);
      assert.equal((await auth(a, 'lease-a')).peerEpoch, 0);
      assert.equal((await auth(b, 'lease-b')).peerEpoch, 0);
      assert.ok(control.viewers.productState(a).endpointGeneration > restored.endpointGeneration);
      assert.equal(
        control.viewers.productState(a).endpointGeneration,
        control.viewers.productState(b).endpointGeneration,
      );
      const fresh = await offer(a, 'lease-a');
      assert.notEqual(fresh.connectionId, restored.connectionId);
    } finally {
      endpoint.stop();
      for (const socket of sockets) socket.terminate();
      await control.close();
      store.db.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
