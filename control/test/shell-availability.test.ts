import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/application';
import { ControlDatabase } from '../server/persistence/database';
import { RemoteKitError } from '../shared/errors';
import { AuthorizationScope } from '../client/auth/authorization-scope';
import { WorkspaceSession } from '../client/control/workspace-session';
import { productSnapshot } from './client-fixture';
import { registerUser, requestViewer, TestClock, testGateway } from './server-fixture';
import type { EndpointLink } from '../server/endpoint/link';
import type { ProductAction } from '../shared/product';
import { ServicePeers } from '../server/viewers/service-peers';

class ServiceEndpoint {
  state: EndpointLink['state'] = { state: 'ready', incarnation: 'node', connectionEpoch: 'node-1' };
  readonly calls: { method: string; params: any }[] = [];
  readonly signals = new Set<Parameters<NonNullable<EndpointLink['onSignal']>>[0]>();
  faceStatus = 'pending';
  statusGate?: Promise<void>;
  onSignal(listener: Parameters<NonNullable<EndpointLink['onSignal']>>[0]) {
    this.signals.add(listener);
    return () => {
      this.signals.delete(listener);
    };
  }
  async request(method: string, tenantId: string, params: any = {}) {
    this.calls.push({ method, params });
    if (method === 'service.offer') {
      queueMicrotask(() => {
        for (const listener of this.signals)
          listener({ tenantId, connectionId: params.connectionId, signal: { type: 'answer', sdp: 'v=0' } });
      });
      return { accepted: true, connectionId: params.connectionId };
    }
    if (method === 'service.authorize') return { applied: true, epoch: params.epoch };
    if (method === 'service.face.capabilities') return { available: true, modelVersion: 'models' };
    if (method === 'service.face.status') {
      await this.statusGate;
      return {
        challengeId: params.challengeId,
        status: this.faceStatus,
        ...(this.faceStatus === 'enrolled'
          ? { template: Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0)) }
          : {}),
      };
    }
    return { accepted: true };
  }
}

async function fixture(t: TestContext, unlocked = true) {
  const store = new ControlDatabase(':memory:', { clock: new TestClock(), buildId: 'test' });
  const endpoint = new ServiceEndpoint();
  const gateway = testGateway(endpoint);
  gateway.placement.resolve = () => {
    throw new RemoteKitError('unavailable', 'Session data is offline', {
      reason: 'session_data_on_offline_node',
    });
  };
  const control = createApplication(store, gateway);
  const { tenantId: tenant, user } = await registerUser(store, 'shell-user', 'password123');
  await control.viewers.attachViewer(
    tenant,
    'lease',
    () => {},
    { identity: 'viewer', valid: () => true },
    unlocked,
  );
  const request = (method: string, params: any = {}) =>
    requestViewer(control, tenant, 'lease', method, params);
  const serviceOffer = () => request('service.offer', { type: 'offer', sdp: 'v=0', attemptId: randomUUID() });
  t.after(async () => {
    await control.close();
    store.db.close();
  });
  return { store, endpoint, gateway, control, tenant, user, request, serviceOffer };
}

test('RTC epoch loss preserves Control authorization, authoritative snapshot and shell readiness', () => {
  const authorization = new AuthorizationScope({
    endpoint: {
      channel: { readyState: 'open' } as RTCDataChannel,
    },
  });
  let state: ReturnType<typeof productSnapshot> | null = null;
  const rtc = {
    connect: async () => {},
    disconnect() {},
    restart() {},
    observeEndpointGeneration() {},
    confirmedAvSync: undefined,
    getSnapshot: () => ({ phase: 'idle' as const }),
  };
  const session = new WorkspaceSession({
    authorization,
    rtc,
    serviceRtc: rtc,
    operations: {
      acceptSnapshot: (next) => {
        state = next;
      },
      getSnapshot: () => ({ state, authoritative: state, pending: [] }),
    },
    control: { request: async () => undefined as never, reconnect() {}, connect() {}, close() {} },
    viewport: { observe() {}, reset() {} },
    setAudioChannels() {},
  });
  session.acceptStatus('online');
  session.acceptAuth({
    user: productSnapshot().user,
    locked: false,
    epoch: 1,
    peerEpoch: 0,
    serviceEpoch: 0,
    endpointGeneration: 0,
    methods: { password: true, pin: false, face: false },
    settings: {
      lockOnHidden: true,
      lockOnIdle: true,
      idleSeconds: 300,
      lockOnDeparture: false,
      faceEnabled: false,
    },
    face: { available: false, enrolled: false },
  });
  const snapshot = productSnapshot();
  session.acceptState(snapshot);
  assert.equal(session.shellReady, true);
  assert.equal(authorization.browserReady, false);
  authorization.observePeerAuthorization(2);
  assert.equal(authorization.browserReady, true);
  authorization.onRtc({ type: 'closed' });
  assert.equal(session.shellReady, true);
  assert.equal(authorization.productLocked, false);
  assert.equal(authorization.browserReady, false);
  assert.equal(state, snapshot);
});

test('WS envelopes dedupe and reject changed payloads without a Session; browser actions return unavailable', async (t) => {
  const f = await fixture(t);
  const submit = (action: ProductAction, operationId = randomUUID()) =>
    f.request('operation.submit', {
      operationId,
      operationGeneration: f.store.operations.operationGeneration(f.tenant),
      action,
    });
  const id = randomUUID();
  const action: ProductAction = { type: 'window.open', appId: 'settings', placement: { mode: 'space' } };
  const receipt = await submit(action, id);
  assert.equal(receipt.status, 'committed');
  assert.deepEqual(await submit(action, id), receipt);
  await assert.rejects(async () => submit({ ...action, appId: 'files' }, id), { code: 'conflict' });
  assert.equal(
    (
      await f.request('operation.status', {
        operationId: randomUUID(),
        operationGeneration: receipt.operationGeneration,
      })
    ).status,
    'unknown',
  );
  await submit({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
  const window = f.store.workspaces.workspace(f.tenant).windows.find((win) => win.appId === 'browser')!;
  const tab = f.store.workspaces.workspace(f.tenant).tabs.find((tab) => tab.id === window.activeTabId)!;
  const failed = await submit({ type: 'tab.navigate', tabId: tab.id, url: 'https://example.test/' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'unavailable');
  await submit({ type: 'window.close', windowId: window.id });
  assert(!f.store.workspaces.workspace(f.tenant).windows.some((win) => win.id === window.id));
  assert(!f.endpoint.calls.some((call) => call.method === 'rtc.offer' || call.method === 'view.close'));
});

test('password and PIN unlock complete with no peer and with a failing browser peer', async (t) => {
  const f = await fixture(t, false);
  assert.equal((await f.request('auth.verify', { method: 'password', secret: 'password123' })).locked, false);
  await f.request('auth.settings', { currentPassword: 'password123', pin: '123456' });
  await f.request('auth.lock');
  assert.equal((await f.request('auth.verify', { method: 'pin', secret: '123456' })).locked, false);
  const security = f.control.tenants.get(f.tenant).viewer!.security;
  security.peer = { connectionId: 'unreachable', epoch: 1, appliedEpoch: 0, requests: 0 };
  await f.control.security.lock(f.tenant, security, false, false);
  assert.equal((await f.request('auth.verify', { method: 'password', secret: 'password123' })).locked, false);
  assert.equal(security.peer.appliedEpoch, 0);
});

test('service peer admits files and face enroll, verify and presence without opening a Session', async (t) => {
  const f = await fixture(t);
  const node = f.gateway.nodes.get('fixture')!;
  const id = 'a'.repeat(64);
  f.store.db.prepare('INSERT INTO objects VALUES (?,?,?,?,?)').run(id, 1, 1, 'b'.repeat(64), Date.now());
  f.store.db.prepare('INSERT INTO object_claims VALUES (?,?,?)').run(f.tenant, id, Date.now());
  f.store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(id, 'fixture');
  assert.throws(() => f.control.objects.locate(node, { tenantId: f.tenant, ids: [id] }), {
    code: 'forbidden',
  });
  const peer = await f.serviceOffer();
  assert.equal(f.gateway.placement.peek(f.tenant), undefined);
  assert.equal(f.control.objects.locate(node, { tenantId: f.tenant, ids: [id] }).sources[id].length, 1);
  await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: 'password123' });
  f.endpoint.faceStatus = 'enrolled';
  await f.control.viewers.pollFaceAuth();
  assert(f.store.security.security(f.user.id).face?.sealed);
  await f.request('auth.lock');
  await f.control.servicePeers.authorize(f.tenant);
  assert.equal((await f.request('auth.get')).methods.face, true);
  await f.request('auth.face.begin', { purpose: 'verify' });
  f.endpoint.faceStatus = 'matched';
  await f.control.viewers.pollFaceAuth();
  assert.equal((await f.request('auth.get')).locked, false);
  await f.control.servicePeers.authorize(f.tenant);
  await f.request('auth.settings', { currentPassword: 'password123', settings: { lockOnDeparture: true } });
  await f.request('auth.face.begin', { purpose: 'presence' });
  f.endpoint.faceStatus = 'absent';
  await f.control.viewers.pollFaceAuth();
  assert.equal((await f.request('auth.get')).locked, true);
  assert(
    f.endpoint.calls
      .filter((call) => call.method === 'service.face.begin')
      .every((call) => call.params.connectionId === peer.connectionId),
  );
  assert.equal(f.gateway.placement.peek(f.tenant), undefined);
});

test('a late face result cannot authorize a re-signaled service peer', async (t) => {
  const f = await fixture(t);
  await f.serviceOffer();
  await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: 'password123' });
  let release!: () => void;
  f.endpoint.statusGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.endpoint.faceStatus = 'enrolled';
  const pending = f.control.viewers.pollFaceAuth();
  await new Promise((resolve) => setImmediate(resolve));
  await f.serviceOffer();
  release();
  await pending;
  assert.equal(f.store.security.security(f.user.id).face, undefined);
});

test('a service authorization epoch change rejects a pending face result', async (t) => {
  const f = await fixture(t);
  await f.serviceOffer();
  await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: 'password123' });
  let release!: () => void;
  f.endpoint.statusGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.endpoint.faceStatus = 'enrolled';
  const pending = f.control.viewers.pollFaceAuth();
  await new Promise((resolve) => setImmediate(resolve));
  await f.request('auth.lock');
  await f.control.servicePeers.authorize(f.tenant);
  release();
  await pending;
  assert.equal(f.store.security.security(f.user.id).face, undefined);
  assert.equal((await f.request('auth.get')).locked, true);
});

test('catalog availability follows ready replicas and candidate objects while retaining entries', async (t) => {
  const f = await fixture(t);
  const id = 'a'.repeat(64),
    candidate = 'c'.repeat(64);
  for (const object of [id, candidate]) {
    f.store.db
      .prepare('INSERT INTO objects VALUES (?,?,?,?,?)')
      .run(object, 1, 1, 'b'.repeat(64), Date.now());
    f.store.db.prepare('INSERT INTO object_claims VALUES (?,?,?)').run(f.tenant, object, Date.now());
    f.store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(object, 'fixture');
  }
  f.store.library.change(f.tenant, randomUUID(), 'entry', (snapshot) =>
    snapshot.entries.push({
      kind: 'file',
      available: true,
      id: 'entry',
      assetId: id,
      name: 'file.jpg',
      type: 'image/jpeg',
      size: 1,
      photo: { mode: 'photo', candidateAssetIds: [candidate] },
      createdAt: Date.now(),
      source: null,
      partitionId: null,
      collected: true,
    }),
  );
  const get = () => f.request('library.get');
  f.control.library.refreshAvailability(f.tenant);
  assert.equal((await get()).entries[0].available, true);
  f.store.db.prepare('DELETE FROM object_replicas WHERE id=?').run(candidate);
  f.control.library.refreshAvailability(f.tenant);
  assert.equal((await get()).entries[0].available, false);
  f.store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(candidate, 'fixture');
  f.control.library.refreshAvailability(f.tenant);
  assert.equal((await get()).entries[0].available, true);
  f.endpoint.state = { state: 'offline' };
  f.control.library.refreshAvailability(f.tenant);
  assert.equal((await get()).entries[0].available, false);
  assert.equal((await get()).entries.length, 1);
});

test('queued WS operations recheck the Control authorization epoch', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = f.control.tenants.serial(f.tenant, () => gate);
  const pending = f.request('operation.submit', {
    operationId: randomUUID(),
    operationGeneration: f.store.operations.operationGeneration(f.tenant),
    action: { type: 'window.open', appId: 'settings', placement: { mode: 'space' } },
  });
  const rejected = assert.rejects(pending, { code: 'locked' });
  await f.control.security.lock(f.tenant, f.control.tenants.get(f.tenant).viewer!.security, false, false);
  release();
  await blocker;
  await rejected;
  assert.equal(f.store.workspaces.workspace(f.tenant).windows.length, 0);
});

test('service peers choose the running Session node or least loaded ready node and re-signal after node loss', async (t) => {
  const f = await fixture(t);
  const first = f.gateway.nodes.get('fixture')!;
  const secondEndpoint = new ServiceEndpoint();
  const second = Object.assign(Object.create(first), {
    nodeId: 'second',
    metrics: { predicted: () => 0.1 },
    request: secondEndpoint.request.bind(secondEndpoint),
    onSignal: secondEndpoint.onSignal.bind(secondEndpoint),
  });
  Object.defineProperty(second, 'state', { get: () => secondEndpoint.state });
  t.mock.method(first.metrics, 'predicted', () => 0.8);
  t.mock.method(f.gateway.nodes, 'all', () => [first, second]);
  const peers = new ServicePeers(f.control, f.control);

  assert.equal(peers.chooseNode(f.tenant)?.nodeId, 'second');
  const peek = t.mock.method(
    f.gateway.placement,
    'peek',
    () => ({ nodeId: 'fixture', runState: 'running' }) as never,
  );
  assert.equal(peers.chooseNode(f.tenant)?.nodeId, 'fixture');
  peek.mock.restore();
  const offer = () => peers.offer(f.tenant, { type: 'offer', sdp: 'v=0', attemptId: randomUUID() }, 'lease');
  const old = await offer();
  assert.equal(peers.hasGrant(f.tenant, 'second'), true);
  secondEndpoint.state = { state: 'offline' };
  await peers.tick();
  assert.equal(peers.hasGrant(f.tenant, 'second'), false);
  const current = await offer();
  assert.notEqual(current.connectionId, old.connectionId);
  assert.equal(peers.hasGrant(f.tenant, 'fixture'), true);
  await peers.dispose();
});
