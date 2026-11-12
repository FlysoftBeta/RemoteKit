import type { LibrarySnapshot } from '../shared/file-library';
import { registerUser } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { hkdfSync, randomBytes } from 'node:crypto';
import { createApplication } from '../server/application';
import { NodeRegistry } from '../server/cluster/node-link';
import { Placement } from '../server/cluster/placement';
import { MetricsHistory } from '../server/cluster/metrics';
import { tenantKeys } from '../server/cluster/keys';
import type { NodeLimits } from '../server/config';
import { endpointDefaults, testNode } from './node-fixture';
import { EndpointGateway } from '../server/endpoint/gateway';
import type { EndpointSnapshot } from '../server/endpoint/types';
import { ControlDatabase } from '../server/persistence/database';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { FakeNode, fakeMetrics } from './fake-node';
import { TestClock, requestViewer } from './server-fixture';
import { RemoteKitError } from '../shared/errors';
import { log } from '../server/log';

const id = (n: number) => n.toString(16).padStart(64, '0');

test('object commit batches are atomic, idempotent, bounded and repair replica rows', async () => {
  const h = await harness(null);
  try {
    const alpha = await h.connect('alpha');
    const beta = await h.connect('beta', 0.9);
    await h.gateway.snapshot('tenant');
    const objects = Array.from({ length: 1024 }, (_, i) => ({
      objectId: id(i + 1),
      size: 1,
      storedSize: 41,
      storedSha256: id(i + 2000),
    }));
    let transactions = 0;
    const transaction = h.store.transaction.bind(h.store);
    h.store.transaction = (work) => {
      transactions++;
      return transaction(work);
    };
    const handler = h.nodes.handlers.get('object.committed.batch')!;
    assert.deepEqual(handler(h.nodes.get('alpha')!, { tenantId: 'tenant', objects }), { ok: true });
    h.store.transaction = transaction;
    assert.equal(transactions, 1);
    assert.deepEqual(await alpha.request('object.committed.batch', 'tenant', { objects }), { ok: true });
    h.store.db.prepare('DELETE FROM object_replicas WHERE id=?').run(objects[0].objectId);
    await alpha.request('object.committed.batch', 'tenant', { objects });
    assert(
      h.store.db
        .prepare('SELECT 1 FROM object_replicas WHERE id=? AND node_id=?')
        .get(objects[0].objectId, 'alpha'),
    );
    const located = await alpha.request('object.locate', 'tenant', { ids: objects.map((o) => o.objectId) });
    assert.equal(Object.keys(located.sources).length, 1024);
    await beta.request('object.locate', 'tenant', { ids: [] }).then(
      () => assert.fail('unplaced node was authorized'),
      (error) => assert.equal(error.code, 'forbidden'),
    );
    await assert.rejects(beta.request('object.committed.batch', 'tenant', { objects: [objects[0]] }), {
      code: 'forbidden',
    });
    for (const invalid of [[], [...objects, objects[0]], [{ ...objects[0], kind: 'document' }]])
      await assert.rejects(alpha.request('object.committed.batch', 'tenant', { objects: invalid }), {
        code: 'invalid_request',
      });
    await assert.rejects(
      alpha.request('object.committed.batch', 'tenant', {
        objects: [objects[0]],
        padding: 'x'.repeat(256 * 1024),
      }),
      { code: 'invalid_request' },
    );
    const replica = { objects: [objects[0]] };
    await alpha.request('object.committed.batch', '', replica);
    await alpha.request('object.committed.batch', '', replica);
  } finally {
    await h.close();
  }
});

test('a commit batch rolls back metadata and claims on conflict or quota failure', async () => {
  const h = await harness(20);
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    await h.commit(alpha, 'tenant', id(1));
    const item = (n: number, size = 10) => ({
      objectId: id(n),
      size,
      storedSize: size + 40,
      storedSha256: id(1000 + n),
    });
    for (const [objects, code] of [
      [[item(2), { ...item(1), storedSha256: id(9999) }], 'conflict'],
      [[item(2), item(3)], 'limit_exceeded'],
    ] as const) {
      await assert.rejects(alpha.request('object.committed.batch', 'tenant', { objects }), { code });
      assert.equal(h.store.db.prepare('SELECT 1 FROM objects WHERE id=?').get(id(2)), undefined);
      assert.equal(
        h.store.db.prepare('SELECT 1 FROM object_claims WHERE tenant=? AND id=?').get('tenant', id(2)),
        undefined,
      );
    }
    assert.deepEqual(await alpha.request('object.committed.batch', 'tenant', { objects: [item(2)] }), {
      ok: true,
    });
  } finally {
    await h.close();
  }
});

test('hibernating placement authorizes checkpoint objects only on its assigned node', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    const beta = await h.connect('beta', 0.9);
    await h.gateway.snapshot('tenant');
    const placement = h.placement.beginHibernation('tenant');
    assert.equal(h.gateway.isPlacedOn('tenant', 'alpha'), true);
    assert.equal(h.gateway.isPlacedOn('tenant', 'beta'), false);
    await h.commit(alpha, 'tenant', id(1));
    await assert.rejects(h.commit(beta, 'tenant', id(2)), { code: 'forbidden' });
    h.placement.commitCheckpoint(placement, id(1), [id(1)], 'dev');
    assert.equal(h.gateway.isPlacedOn('tenant', 'alpha'), false);
    await assert.rejects(h.commit(alpha, 'tenant', id(3)), { code: 'forbidden' });
  } finally {
    await h.close();
  }
});

for (const resolution of ['success', 'not_found'] as const) {
  test(`uncertain hibernation reconciles ${resolution} at the same epoch and blocks resolve`, async () => {
    const h = await harness();
    try {
      const alpha = await h.connect('alpha');
      await h.gateway.snapshot('tenant');
      await h.commit(alpha, 'tenant', id(1));
      const first = h.placement.beginHibernation('tenant');
      h.placement.commitCheckpoint(first, id(1), [id(1)], 'dev');
      await h.gateway.snapshot('tenant');
      const placement = h.placement.peek('tenant')!;
      const node = h.nodes.get('alpha')!;
      const original = node.request.bind(node);
      const epochs: number[] = [];
      let attempts = 0;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      node.request = async (method, tenant, args, timeout) => {
        if (method !== 'session.hibernate') return original(method, tenant, args, timeout);
        assert.equal(timeout, 180000);
        epochs.push(args!.placementEpoch as number);
        if (++attempts === 1) throw new RemoteKitError('outcome_unknown', 'lost reply');
        await waiting;
        if (resolution === 'not_found') throw new RemoteKitError('not_found', 'crashed before journal');
        return { manifestId: id(1), objects: [id(1)], buildId: 'dev' };
      };
      await assert.rejects(h.gateway.hibernate('tenant'), { code: 'outcome_unknown' });
      assert.equal(h.placement.peek('tenant')!.state, 'hibernating');
      const opens = alpha.requests.filter((r) => r.method === 'session.open').length;
      assert.throws(() => h.placement.resolve('tenant'), {
        code: 'unavailable',
        message: '正在保存会话，请稍候',
      });
      await assert.rejects(h.gateway.ensureSession('tenant'), { code: 'unavailable' });
      assert.equal(attempts, 2);
      const pending = h.gateway.hibernate('tenant');
      assert.equal(pending, h.gateway.hibernate('tenant'));
      release();
      await pending;
      assert.equal(h.placement.peek('tenant')!.state, 'hibernated');
      assert.equal(h.placement.peek('tenant')!.checkpoint, id(1));
      assert.equal(h.placement.peek('tenant')!.placementEpoch, placement.placementEpoch);
      assert.deepEqual(epochs, [placement.placementEpoch, placement.placementEpoch]);
      assert.equal(alpha.requests.filter((r) => r.method === 'session.open').length, opens);
    } finally {
      await h.close();
    }
  });
}

test('reconciler discovers durable hibernation without a runtime and commits the journal', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    await h.commit(alpha, 'tenant', id(1));
    h.placement.beginHibernation('tenant');
    alpha.handler = (request) =>
      request.method === 'session.hibernate'
        ? { manifestId: id(1), objects: [id(1)], buildId: 'dev' }
        : alpha.handle(request);
    await h.control.reconciler.tick();
    assert.equal(h.placement.peek('tenant')!.state, 'hibernated');
    assert.equal(h.placement.peek('tenant')!.checkpoint, id(1));
  } finally {
    await h.close();
  }
});

test('hibernation blockers return active, malformed replies and offline reconciliation retain hibernating', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    alpha.handler = (request) => {
      if (request.method === 'session.hibernate')
        throw { code: 'conflict', message: 'hibernation blocked: rtcConnected' };
      return alpha.handle(request);
    };
    await assert.rejects(h.gateway.hibernate('tenant'), { code: 'conflict' });
    assert.equal(h.placement.peek('tenant')!.state, 'active');
    alpha.handler = (request) => (request.method === 'session.hibernate' ? {} : alpha.handle(request));
    await assert.rejects(h.gateway.hibernate('tenant'), { code: 'outcome_unknown' });
    assert.equal(h.placement.peek('tenant')!.state, 'hibernating');
    const offline = once(h.nodes.get('alpha')!, 'offline');
    alpha.close();
    await offline;
    await assert.rejects(h.gateway.hibernate('tenant'), { code: 'unavailable' });
    assert.equal(h.placement.peek('tenant')!.state, 'hibernating');
    await h.connect('alpha', 0.1, alpha);
    assert.equal(alpha.helloReply.sessions[0].placementEpoch, h.placement.peek('tenant')!.placementEpoch);
  } finally {
    await h.close();
  }
});

test('an open in flight finishes before hibernation and a blocked save keeps its open tracking', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    alpha.handler = async (request) => {
      if (request.method === 'session.open') await waiting;
      if (request.method === 'session.hibernate') throw { code: 'busy', message: 'busy before delivery' };
      return alpha.handle(request);
    };
    const opening = h.gateway.snapshot('tenant');
    const saving = h.gateway.hibernate('tenant');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      alpha.requests.some((request) => request.method === 'session.hibernate'),
      false,
    );
    await assert.rejects(h.gateway.snapshot('tenant'), {
      code: 'unavailable',
      message: '正在保存会话，请稍候',
    });
    release();
    await opening;
    await assert.rejects(saving, { code: 'busy' });
    assert.equal(h.placement.peek('tenant')!.state, 'active');
    await h.gateway.snapshot('tenant');
    assert.equal(alpha.requests.filter((request) => request.method === 'session.open').length, 1);
  } finally {
    await h.close();
  }
});
const clearSnapshot = (): EndpointSnapshot => ({
  running: true,
  views: [],
  hibernation: {
    unacknowledgedClosedEvents: 0,
    pendingNativeSelections: 0,
    inFlightUploads: 0,
    pendingPageRequests: 0,
    downloadsInProgress: 0,
    pendingDownloadImports: 0,
    rtcConnected: false,
    lifecycleUncertain: false,
  },
});
async function harness(quota: number | null = 4096, nodeLimits: Partial<NodeLimits> = {}) {
  const key = randomBytes(32);
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const nodes = new NodeRegistry({
    privateKey: key.toString('base64'),
    buildId: 'dev',
    requestTimeoutMs: 1000,
    nodes: Object.fromEntries(
      ['alpha', 'beta'].map((nodeId) => [
        nodeId,
        {
          ...testNode(nodeId),
          limits: { maxSessions: 8, diskReserveBytes: 100, sessionMemoryBytes: 100, ...nodeLimits },
          config: {
            ...endpointDefaults,
            nodeId,
            peer: { listen: '0.0.0.0:3101', address: nodeId + ':3101' },
            rtc: { ports: null, address: null },
          },
        },
      ]),
    ),
  });
  const placement = new Placement(store, nodes);
  const gateway = new EndpointGateway(nodes, placement);
  const clock = new TestClock();
  const control = createApplication(store, gateway, undefined, clock, quota);
  const server = createServer();
  server.on('upgrade', (req, socket, head) => nodes.handleUpgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/node`;
  const clients = new Map<string, FakeNode>();
  async function connect(nodeId: string, cpu = 0.1, client = new FakeNode()) {
    client.metrics = fakeMetrics({
      cpu,
      memory: { total: 10000, available: 9000 },
      disk: { total: 10000, free: 9000 },
    });
    client.fetchObject = (objectId) =>
      [...clients.values()].map((source) => source.objects.get(objectId)).find(Boolean);
    clients.set(nodeId, client);
    await client.connect(url, key, { nodeId });
    if (client.helloReply.type === 'node.ready') await nodes.get(nodeId)!.request('fixture.barrier', '');
    return client;
  }
  async function commit(client: FakeNode, tenant: string, objectId: string, size = 10, derivedFrom?: string) {
    const object = {
      tenantId: tenant,
      id: objectId,
      size,
      storedSize: size + 40,
      storedSha256: id(1000 + Number.parseInt(objectId.slice(-5), 16)),
      ...(derivedFrom ? { derivedFrom, kind: 'thumbnail' as const } : {}),
    };
    client.objects.set(objectId, object);
    await client.request('object.committed', tenant, {
      objectId,
      size,
      storedSize: object.storedSize,
      storedSha256: object.storedSha256,
      ...(derivedFrom ? { derivedFrom, kind: 'thumbnail' as const } : {}),
    });
    return object;
  }
  return {
    store,
    nodes,
    placement,
    gateway,
    clock,
    control,
    url,
    key,
    client: (nodeId: string) => clients.get(nodeId),
    connect,
    commit,
    async close() {
      nodes.stop();
      for (const client of clients.values()) client.close();
      await control.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.db.close();
    },
  };
}

test('session events reach learning and acknowledge without interrupting the node connection', async () => {
  const h = await harness();
  try {
    const client = await h.connect('alpha');
    const account = await registerUser(h.store, 'learning-events', 'learning-events-password');
    const placement = h.placement.resolve(account.tenantId);
    const node = h.nodes.get(placement.nodeId)!;
    const received = once(node, 'session.events');
    const acknowledged = new Promise<void>((resolve) => {
      const listener = (request: Record<string, any>) => {
        if (request.method !== 'session.events.ack') return;
        client.off('request', listener);
        resolve();
      };
      client.on('request', listener);
    });
    client.send({
      event: 'session.events',
      tenantId: account.tenantId,
      sessionId: placement.sessionId,
      browserIncarnation: 'browser',
      events: [{ type: 'view.signIn', version: 1, eventId: 'sign-in', provider: 'xinjiaoyu' }],
    });
    assert.equal((await received)[0].events[0].eventId, 'sign-in');
    await acknowledged;
    await node.request('fixture.barrier', '');
    assert.ok(
      client.requests.some(
        (request) => request.method === 'session.events.ack' && request.eventIds.includes('sign-in'),
      ),
    );
    assert.equal(node.state.state, 'ready');
    await h.control.viewers.attachViewer(
      account.tenantId,
      'learning-viewer',
      () => {},
      {
        identity: 'test',
        valid: () => true,
      },
      true,
    );
    const changed = once(h.control.events, 'state');
    h.control.learning.accounts.setState(account.tenantId, 'changyan', {
      status: 'signing_in',
      step: 'credentials',
    });
    const [tenant, state] = await changed;
    assert.equal(tenant, account.tenantId);
    assert.equal(state.learning.accounts.changyan.status, 'signing_in');
    const other = await registerUser(h.store, 'learning-other', 'learning-other-password');
    assert.equal(
      h.control.viewers.productState(other.tenantId).learning.accounts.changyan.status,
      'signed_out',
    );
  } finally {
    await h.close();
  }
});

test('tenant derivations use independent HKDF domains and erase the opened DEK', () => {
  const dek = Buffer.alloc(32, 7),
    copy = Buffer.from(dek);
  const keys = tenantKeys(dek);
  for (const [name, info] of Object.entries({
    profileKey: 'remotekit profile cookie key 1',
  }))
    assert.equal(
      keys[name as keyof typeof keys],
      Buffer.from(hkdfSync('sha256', copy, Buffer.alloc(0), info, 32)).toString('base64'),
    );
  assert.equal(new Set(Object.values(keys)).size, 1);
  assert.ok(dek.every((byte) => byte === 0));
});

test('metrics pressure includes every resource, requires a full continuous window, expires and rejects malformed samples', () => {
  for (const metrics of [
    fakeMetrics({ cpu: 0.9 }),
    fakeMetrics({ memory: { total: 100, available: 10 } }),
    fakeMetrics({ disk: { total: 100, free: 10 } }),
    fakeMetrics({ sessions: 9 }),
    fakeMetrics({
      gpus: [
        {
          luid: 'gpu',
          name: 'gpu',
          engine3d: 0.9,
          engineVideoEncode: 0.2,
          dedicatedUsed: 1,
          dedicatedTotal: 10,
        },
      ],
    }),
    fakeMetrics({
      gpus: [
        {
          luid: 'gpu',
          name: 'gpu',
          engine3d: 0.2,
          engineVideoEncode: 0.9,
          dedicatedUsed: 1,
          dedicatedTotal: 10,
        },
      ],
    }),
  ]) {
    const history = new MetricsHistory(10);
    for (let time = 0; time <= 25000; time += 5000) history.record(metrics, time);
    assert.equal(history.underPressure(25000), false);
    history.record(metrics, 30000);
    assert.equal(history.latest(30000)!.pressure, 0.9);
    assert.equal(history.underPressure(30000), true);
    history.record(fakeMetrics(), 35000);
    assert.equal(history.underPressure(35000), false);
    assert.equal(history.latest(65001), undefined);
  }
  const history = new MetricsHistory(10);
  history.record(fakeMetrics({ cpu: 1 }), 0);
  history.record(fakeMetrics({ cpu: 1 }), 30000);
  assert.equal(history.underPressure(30000), false);
  assert.throws(() => history.record(fakeMetrics({ cpu: 2 })), { code: 'invalid_request' });
});

test('two nodes place by pressure, checkpoint, wake at epoch+1, fence reconnects, replicate, collect and remove', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha', 0.2),
      beta = await h.connect('beta', 0.6);
    await h.gateway.snapshot('tenant');
    const first = h.placement.peek('tenant')!;
    assert.equal(first.nodeId, 'alpha');
    const opening = alpha.requests.find((request) => request.method === 'session.open')!;
    assert.equal(opening.checkpoint, null);
    assert.equal(opening.objectKey, undefined);
    assert.equal(Buffer.from(alpha.helloReply.objectKey, 'base64').length, 32);
    assert.notEqual(alpha.helloReply.objectKey, alpha.helloReply.objectIdKey);
    await h.commit(alpha, 'tenant', id(1));
    await h.commit(alpha, 'tenant', id(2));
    await h.control.objects.replicate();
    assert.ok(beta.objects.has(id(1)));
    assert.deepEqual(await alpha.request('object.locate', 'tenant', { ids: [id(1)] }), {
      sources: {
        [id(1)]: [
          { nodeId: 'alpha', address: 'alpha:3101' },
          { nodeId: 'beta', address: 'beta:3101' },
        ],
      },
    });
    alpha.handler = (request) =>
      request.method === 'session.hibernate'
        ? { manifestId: id(2), objects: [id(1), id(2)], buildId: 'dev' }
        : alpha.handle(request);
    assert.equal(await h.gateway.hibernate('tenant'), 1);
    assert.equal(h.placement.peek('tenant')!.state, 'hibernated');
    assert.equal(h.placement.peek('tenant')!.checkpointId, 1);
    alpha.metrics.cpu = 0.8;
    beta.metrics.cpu = 0.1;
    alpha.publishMetrics();
    beta.publishMetrics();
    await Promise.all([alpha.barrier(), beta.barrier()]);
    await h.gateway.snapshot('tenant');
    const awakened = h.placement.peek('tenant')!;
    assert.equal(awakened.nodeId, 'beta');
    assert.equal(awakened.placementEpoch, first.placementEpoch + 1);
    const restored = beta.requests.find((request) => request.method === 'session.open')!;
    assert.equal(restored.checkpoint, id(2));
    assert.equal(restored.sessionId, first.sessionId);
    assert.equal(restored.profileKey, opening.profileKey);
    const offline = once(h.nodes.get('alpha')!, 'offline');
    alpha.close();
    await offline;
    alpha.sessions.set('tenant', opening);
    await h.connect('alpha', 0.8, alpha);
    assert.deepEqual(alpha.helloReply.sessions, []);
    assert.equal(alpha.sessions.size, 0);
    const betaOffline = once(h.nodes.get('beta')!, 'offline');
    beta.close();
    await betaOffline;
    await h.connect('beta', 0.1, beta);
    assert.deepEqual(beta.helloReply.sessions, [
      { tenantId: 'tenant', sessionId: first.sessionId, placementEpoch: 2 },
    ]);
    await h.commit(beta, 'tenant', id(3));
    await h.control.objects.replicate();
    h.store.db.exec(
      'UPDATE objects SET created_at=0; UPDATE object_claims SET claimed_at=0; DELETE FROM object_gc',
    );
    await h.control.objects.gc();
    assert.equal(beta.objects.has(id(3)), false);
    assert.equal(alpha.objects.has(id(3)), false);
    assert.ok(h.store.db.prepare('SELECT 1 FROM objects WHERE id=?').get(id(1)));
    assert.throws(() => h.control.nodeAdmin.remove('beta'), { code: 'conflict' });
    const gone = once(h.nodes.get('beta')!, 'offline');
    beta.close();
    await gone;
    h.control.nodeAdmin.remove('beta');
    assert.equal(h.placement.peek('tenant')!.state, 'hibernated');
    assert.equal(h.placement.peek('tenant')!.placementEpoch, 3);
    assert.equal(h.placement.peek('tenant')!.checkpoint, id(2));
    assert.equal(h.store.db.prepare('SELECT 1 FROM object_replicas WHERE node_id=?').get('beta'), undefined);
    await assert.rejects(h.connect('beta'), /Handshake closed/);
    assert.throws(() => h.control.nodeAdmin.readd('missing'), { code: 'not_found' });
    h.control.nodeAdmin.readd('beta');
    assert.equal((await h.connect('beta')).helloReply.type, 'node.ready');
    assert.equal(h.control.nodeAdmin.list().find((node) => node.nodeId === 'beta')!.state, 'ready');
  } finally {
    await h.close();
  }
});

test('object quota is disabled by null and usage reports null', async () => {
  const h = await harness(null);
  try {
    const alpha = await h.connect('alpha');
    h.placement.resolve('tenant');
    await h.commit(alpha, 'tenant', id(1), 100000);
    h.control.objects.checkQuota('tenant');
    assert.deepEqual(h.control.objects.tenantUsage('tenant'), {
      objects: 1,
      bytes: 100000,
      quotaBytes: null,
    });
  } finally {
    await h.close();
  }
});

test('object requests enforce ownership, idempotence, conflicts, quotas and the exact fetch exception', async () => {
  const h = await harness(30);
  try {
    const alpha = await h.connect('alpha'),
      beta = await h.connect('beta', 0.6);
    await h.gateway.snapshot('tenant');
    const object = await h.commit(alpha, 'tenant', id(1), 20);
    const { id: objectId, tenantId, ...metadata } = object;
    await alpha.request('object.committed', tenantId, { objectId, ...metadata });
    assert.equal(h.control.objects.bytes('tenant'), 20);
    await assert.rejects(
      alpha.request('object.committed', tenantId, { objectId, ...metadata, storedSha256: id(999) }),
      { code: 'conflict' },
    );
    await assert.rejects(beta.request('object.committed', tenantId, { objectId, ...metadata }), {
      code: 'forbidden',
    });
    await assert.rejects(beta.request('object.locate', tenantId, { ids: [objectId] }), { code: 'forbidden' });
    await assert.rejects(alpha.request('object.locate', tenantId, { ids: ['bad'] }), {
      code: 'invalid_request',
    });
    await assert.rejects(alpha.request('missing', tenantId), { code: 'invalid_request' });
    await assert.rejects(h.commit(alpha, 'tenant', id(2), 11), { code: 'limit_exceeded' });
    await h.control.objects.replicate();
    assert.ok(
      h.store.db.prepare('SELECT 1 FROM object_replicas WHERE id=? AND node_id=?').get(objectId, 'beta'),
    );
    await assert.rejects(beta.request('object.committed', tenantId, { objectId, ...metadata }), {
      code: 'forbidden',
    });
  } finally {
    await h.close();
  }
});

test('document derivations authorize the source and are shared across tenant claims', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    const beta = await h.connect('beta', 0.6);
    await h.gateway.snapshot('tenant');
    await h.commit(alpha, 'tenant', id(801));
    const params = { id: id(801), kind: 'document' };
    assert.equal(await alpha.request('object.derivation', 'tenant', { params }), null);
    await assert.rejects(beta.request('object.derivation', 'tenant', { params }), { code: 'forbidden' });
    await assert.rejects(
      alpha.request('object.derivation', 'tenant', {
        params: { id: id(999), kind: 'document' },
      }),
      { code: 'forbidden' },
    );
    await assert.rejects(
      alpha.request('object.derivation', 'tenant', {
        params: { id: id(801), kind: 'thumbnail' },
      }),
      { code: 'invalid_request' },
    );
    await alpha.request('object.committed', 'tenant', {
      objectId: id(802),
      size: 10,
      storedSize: 50,
      storedSha256: id(803),
      derivedFrom: id(801),
      kind: 'document',
    });
    assert.deepEqual(await alpha.request('object.derivation', 'tenant', { params }), { id: id(802) });
    await h.gateway.snapshot('second');
    const second = h.client(h.placement.peek('second')!.nodeId)!;
    await h.commit(second, 'second', id(801));
    assert.deepEqual(await second.request('object.derivation', 'second', { params }), { id: id(802) });
    assert.equal(
      (
        h.store.db.prepare('SELECT count(*) AS n FROM object_derivations WHERE kind=?').get('document') as {
          n: bigint;
        }
      ).n,
      1n,
    );
    h.control.objects.require('second', id(802));
  } finally {
    await h.close();
  }
});

test('pre-render chooses a source replica, authorizes only its operation and creates no tenant claim', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha', 0.6);
    const beta = await h.connect('beta', 0.1);
    await h.gateway.snapshot('tenant');
    const owner = h.client(h.placement.peek('tenant')!.nodeId)!;
    await h.commit(owner, 'tenant', id(811));
    h.store.db.prepare('DELETE FROM object_replicas WHERE id=?').run(id(811));
    h.store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(id(811), 'alpha');
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    alpha.handler = async (message) => {
      if (message.method !== 'object.render') return alpha.handle(message);
      assert.deepEqual(message.params, { id: id(811) });
      const params = { id: id(811), kind: 'document' };
      assert.equal(await alpha.request('object.derivation', '', { params }), null);
      await assert.rejects(beta.request('object.derivation', '', { params }), { code: 'forbidden' });
      await alpha.request('object.locate', '', { renderSource: id(811), ids: [id(811)] });
      await assert.rejects(alpha.request('object.locate', '', { renderSource: id(811), ids: [id(999)] }), {
        code: 'forbidden',
      });
      await alpha.request('object.committed', '', {
        objectId: id(812),
        size: 10,
        storedSize: 50,
        storedSha256: id(813),
        derivedFrom: id(811),
        kind: 'document',
      });
      finish();
      return { documentId: id(812) };
    };
    h.control.objects.render(id(811));
    h.control.objects.render(id(811));
    await finished;
    await h.nodes.get('alpha')!.request('fixture.barrier', '');
    assert.equal(alpha.requests.filter((request) => request.method === 'object.render').length, 1);
    assert.equal(h.store.db.prepare('SELECT 1 FROM object_claims WHERE id=?').get(id(812)), undefined);
    assert.equal(h.control.objects.derived(id(811), 'document'), id(812));
    h.control.objects.require('tenant', id(812));
    h.control.objects.render(id(811));
    assert.equal(alpha.requests.filter((request) => request.method === 'object.render').length, 1);
    h.store.db.exec(
      'UPDATE object_claims SET claimed_at=0; UPDATE objects SET created_at=0; DELETE FROM object_gc',
    );
    await h.control.objects.gc();
    assert.equal(h.store.db.prepare('SELECT 1 FROM objects WHERE id=?').get(id(811)), undefined);
    assert.equal(h.store.db.prepare('SELECT 1 FROM objects WHERE id=?').get(id(812)), undefined);
  } finally {
    await h.close();
  }
});

test('pre-render without a replica uses the least loaded ready node and logs failure once', async (t) => {
  const h = await harness();
  const failures: unknown[][] = [];
  t.mock.method(log, 'error', (...args: unknown[]) => failures.push(args));
  try {
    const alpha = await h.connect('alpha', 0.6);
    const beta = await h.connect('beta', 0.1);
    await h.gateway.snapshot('tenant');
    await h.commit(h.client(h.placement.peek('tenant')!.nodeId)!, 'tenant', id(821));
    h.store.db.prepare('DELETE FROM object_replicas WHERE id=?').run(id(821));
    beta.handler = (message) => {
      if (message.method === 'object.render')
        throw { code: 'invalid_request', message: 'unsupported document type' };
      return beta.handle(message);
    };
    const requested = once(beta, 'request');
    h.control.objects.render(id(821));
    await requested;
    await h.nodes.get('beta')!.request('fixture.barrier', '');
    assert.equal(beta.requests.filter((request) => request.method === 'object.render').length, 1);
    assert.equal(alpha.requests.filter((request) => request.method === 'object.render').length, 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0][0], 'render.failed');
  } finally {
    await h.close();
  }
});

test('inventory pages restore matching replicas, drop missing or corrupt copies and age unknown objects from first observation', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    const first = await h.commit(alpha, 'tenant', id(1)),
      missing = await h.commit(alpha, 'tenant', id(2));
    const corrupt = await h.commit(alpha, 'tenant', id(3));
    h.store.db.prepare('DELETE FROM object_replicas WHERE id=?').run(first.id);
    alpha.objects.delete(missing.id);
    alpha.objects.set(corrupt.id, { ...corrupt, storedSha256: id(99) });
    alpha.objects.set(id(4), { ...first, id: id(4) });
    let pages = 0;
    alpha.handler = (request) => {
      if (request.method !== 'object.inventory') return alpha.handle(request);
      pages++;
      const values = [...alpha.objects.values()];
      return {
        objects: request.cursor === null ? values.slice(0, 1) : values.slice(1),
        next: request.cursor === null ? 'page-2' : null,
      };
    };
    await h.control.objects.reconcile(h.nodes.get('alpha')!);
    assert.equal(pages, 2);
    assert.ok(h.store.db.prepare('SELECT 1 FROM object_replicas WHERE id=?').get(first.id));
    assert.equal(h.store.db.prepare('SELECT 1 FROM object_replicas WHERE id=?').get(missing.id), undefined);
    assert.equal(alpha.objects.has(corrupt.id), false);
    assert.equal(alpha.objects.has(id(4)), true);
    h.store.db.exec('UPDATE object_inventory_orphans SET first_seen=0');
    await h.control.objects.gc();
    assert.equal(alpha.objects.has(id(4)), false);
  } finally {
    await h.close();
  }
});

test('GC follows library and selection references, derivatives and only the newest two checkpoints', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    for (let n = 1; n <= 7; n++) await h.commit(alpha, 'tenant', id(n), 1, n === 2 ? id(1) : undefined);
    h.store.library.save('tenant', {
      revision: 0,
      entries: [
        {
          id: 'entry',
          kind: 'file' as const,
          assetId: id(1),
          name: 'file',
          type: 'text/plain',
          size: 1,
          createdAt: 0,
          partitionId: null,
          collected: true,
          source: { app: 'files', channel: 'upload' },
        },
      ],
      basket: [],
      partitions: [],
      sources: [],
      excludedSources: [],
      basketPartitionId: null,
    });
    h.store.db.prepare('INSERT INTO file_library_selections (tenant,id,manifest) VALUES (?,?,?)').run(
      'tenant',
      'selection',
      JSON.stringify({
        selectionId: 'selection',
        requestId: 'request',
        binding: {
          browserIncarnation: 'browser',
          view: '1',
          instance: 'instance',
          document: 'document',
          request: 'request',
        },
        entryIds: [],
        files: [{ assetId: id(3), name: 'file', type: 'text/plain' }],
        limits: { maxFileBytes: 1024, maxBatchBytes: 2048, maxFiles: 2 },
        prepared: true,
      }),
    );
    for (let n = 1; n <= 3; n++) {
      h.store.db
        .prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?)')
        .run('tenant', n, n, id(n + 3), 'dev', 0);
      h.store.db.prepare('INSERT INTO checkpoint_objects VALUES (?,?,?)').run('tenant', id(n + 3), id(n + 3));
    }
    h.store.db.exec(
      'UPDATE objects SET created_at=0; UPDATE object_claims SET claimed_at=0; DELETE FROM object_gc',
    );
    await h.control.objects.gc();
    for (const n of [1, 2, 3, 5, 6]) assert.ok(alpha.objects.has(id(n)));
    for (const n of [4, 7]) assert.equal(alpha.objects.has(id(n)), false);
    h.store.library.save('tenant', {
      revision: 1,
      entries: [],
      basket: [],
      partitions: [],
      sources: [],
      excludedSources: [],
      basketPartitionId: null,
    });
    h.store.db.exec("UPDATE file_library_selections SET terminal='cancelled'");
    await h.control.objects.gc();
    await h.control.objects.gc(Date.now() + 2 * 60 * 60 * 1000 + 1);
    for (const n of [1, 2, 3]) assert.equal(alpha.objects.has(id(n)), false);
  } finally {
    await h.close();
  }
});

test('hibernation policy respects Memory Saver, ten-minute viewer absence, every blocker and receipts', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    h.store.workspaces.writeWorkspace(emptyWorkspace('tenant'));
    const runtime = h.control.tenants.get('tenant');
    runtime.started = true;
    const snapshot = clearSnapshot();
    assert.equal(await h.control.lifecycle.hibernate('tenant', snapshot), false);
    h.clock.advance(120000);
    assert.equal(await h.control.lifecycle.hibernate('tenant', snapshot), false);
    const now = Date.now();
    h.nodes.get('alpha')!.metrics.clear();
    for (let offset = 30000; offset >= 0; offset -= 5000)
      h.nodes.get('alpha')!.metrics.record(fakeMetrics({ cpu: 0.95 }), now - offset);
    const workspace = h.store.workspaces.workspace('tenant');
    workspace.settings.browser.memorySaverEnabled = false;
    h.store.workspaces.writeWorkspace(workspace);
    assert.equal(await h.control.lifecycle.hibernate('tenant', snapshot), false);
    workspace.settings.browser.memorySaverEnabled = true;
    h.store.workspaces.writeWorkspace(workspace);
    for (const field of Object.keys(snapshot.hibernation!)) {
      const blocked = structuredClone(snapshot);
      (blocked.hibernation as any)[field] =
        field === 'rtcConnected' || field === 'lifecycleUncertain' ? true : 1;
      assert.equal(await h.control.lifecycle.hibernate('tenant', blocked), false, field);
    }
    assert.equal(await h.control.lifecycle.hibernate('tenant', { views: [] }), false);
    h.store.db
      .prepare('INSERT INTO operation_receipts VALUES (?,?,?,?)')
      .run(
        'tenant',
        'op',
        JSON.stringify({ type: 'window.focus', windowId: 'window' }),
        JSON.stringify({ operationId: 'op', operationGeneration: 'generation', status: 'applying' }),
      );
    assert.equal(await h.control.lifecycle.hibernate('tenant', snapshot), false);
    h.store.db.exec('DELETE FROM operation_receipts');
    assert.equal(await h.control.lifecycle.hibernate('tenant', snapshot), false);
    h.clock.advance(480000);
    h.nodes.get('alpha')!.metrics.clear();
    h.nodes.get('alpha')!.metrics.record(fakeMetrics());
    await h.commit(alpha, 'tenant', id(1));
    alpha.handler = (request) =>
      request.method === 'session.hibernate'
        ? { manifestId: id(1), objects: [id(1)], buildId: 'dev' }
        : alpha.handle(request);
    assert.equal(await h.control.lifecycle.hibernate('tenant', snapshot), true);
    assert.equal(runtime.started, false);
    const before = alpha.requests.length;
    await h.control.reconciler.observeOffline('tenant');
    assert.equal(alpha.requests.length, before);
  } finally {
    await h.close();
  }
});

test('disk pressure deletes cold copies, relocates replicas before deletion and prevents new placement', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha'),
      beta = await h.connect('beta', 0.6);
    await h.gateway.snapshot('tenant');
    await h.commit(alpha, 'tenant', id(1), 200);
    alpha.metrics.disk.free = 50;
    alpha.publishMetrics();
    await alpha.barrier();
    await h.control.objects.tick();
    assert.ok(alpha.requests.some((request) => request.method === 'session.cold.delete'));
    assert.ok(beta.objects.has(id(1)));
    assert.equal(alpha.objects.has(id(1)), false);
    await h.gateway.snapshot('new-tenant');
    assert.equal(h.placement.peek('new-tenant')!.nodeId, 'beta');
    assert.equal(h.placement.peek('tenant')!.nodeId, 'alpha');
  } finally {
    await h.close();
  }
});

test('null limits reach nodes and automatic disk floors drain cold copies and relocate replicas', async () => {
  const h = await harness(null, { maxSessions: null, diskReserveBytes: null, sessionMemoryBytes: null });
  try {
    const alpha = await h.connect('alpha');
    const beta = await h.connect('beta');
    for (const client of [alpha, beta]) {
      assert.ok(!('maxSessions' in client.helloReply.config));
      assert.ok(!('diskReserveBytes' in client.helloReply.config));
      assert.ok(!('sessionMemoryBytes' in client.helloReply.config));
      client.metrics = fakeMetrics();
      client.publishMetrics();
    }
    await Promise.all([alpha.barrier(), beta.barrier()]);
    await h.control.objects.tick();
    await h.gateway.snapshot('tenant');
    await h.commit(alpha, 'tenant', id(1), 200);
    alpha.metrics.disk.free = 4 * 1024 ** 3;
    alpha.publishMetrics();
    await alpha.barrier();
    await h.control.objects.tick();
    assert.equal(h.nodes.get('alpha')!.diskDraining, true);
    assert.ok(alpha.requests.some((request) => request.method === 'session.cold.delete'));
    assert.ok(beta.objects.has(id(1)));
    assert.equal(alpha.objects.has(id(1)), false);
    const views = h.control.nodeAdmin.list();
    assert.equal(views[0].maxSessions, null);
    assert.equal(views[0].headroom, 1 - h.nodes.get('alpha')!.metrics.predicted()!);
    alpha.metrics.disk.free = 9 * 1024 ** 3;
    alpha.publishMetrics();
    await alpha.barrier();
    assert.equal(h.nodes.get('alpha')!.diskDraining, true);
    alpha.metrics.disk.free = 10 * 1024 ** 3;
    alpha.publishMetrics();
    await alpha.barrier();
    assert.equal(h.nodes.get('alpha')!.diskDraining, false);
  } finally {
    await h.close();
  }
});

test('replication limits each destination to four simultaneous fetches', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    for (let n = 1; n <= 9; n++) await h.commit(alpha, 'tenant', id(n));
    const beta = new FakeNode();
    let active = 0,
      peak = 0;
    beta.handler = async (request) => {
      if (request.method !== 'object.fetch') return beta.handle(request);
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      try {
        return await beta.handle(request);
      } finally {
        active--;
      }
    };
    await h.connect('beta', 0.1, beta);
    for (let n = 0; n < 4; n++) await h.control.objects.tick();
    assert.equal(peak, 4);
    assert.equal(beta.objects.size, 9);
  } finally {
    await h.close();
  }
});

test('checkpoint commit fences stale epochs and rejects incomplete object sets', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    const placement = h.placement.peek('tenant')!;
    await h.commit(alpha, 'tenant', id(1));
    assert.throws(() => h.placement.commitCheckpoint(placement, id(2), [id(2)], 'dev'), { code: 'conflict' });
    assert.throws(
      () => h.placement.commitCheckpoint({ ...placement, placementEpoch: 0 }, id(1), [id(1)], 'dev'),
      { code: 'conflict' },
    );
    assert.equal(h.placement.peek('tenant')!.state, 'active');
  } finally {
    await h.close();
  }
});

test('admin node methods enforce role, show metrics and persist removal until re-add', async () => {
  const h = await harness();
  try {
    const admin = await registerUser(h.control.store, 'administrator', 'password123');
    const user = await registerUser(h.control.store, 'ordinary', 'password123');
    for (const account of [admin, user])
      await h.control.viewers.attachViewer(
        account.tenantId,
        account.tenantId,
        () => {},
        { identity: account.token, valid: () => true },
        true,
      );
    for (const method of ['admin.nodes', 'admin.removeNode', 'admin.readdNode'])
      await assert.rejects(
        requestViewer(h.control, user.tenantId, user.tenantId, method, { nodeId: 'alpha' }),
        { code: 'forbidden' },
      );
    assert.equal(
      (await requestViewer(h.control, admin.tenantId, admin.tenantId, 'admin.nodes', {})).length,
      2,
    );
    const removed = await requestViewer(h.control, admin.tenantId, admin.tenantId, 'admin.removeNode', {
      nodeId: 'alpha',
    });
    assert.equal(removed[0].state, 'removed');
    assert.ok(h.store.db.prepare('SELECT 1 FROM removed_nodes WHERE node_id=?').get('alpha'));
    const restored = await requestViewer(h.control, admin.tenantId, admin.tenantId, 'admin.readdNode', {
      nodeId: 'alpha',
    });
    assert.equal(restored[0].state, 'offline');
  } finally {
    await h.close();
  }
});

test('node details record rejections; a deleted session is purged from nodes as they reconnect', async () => {
  const h = await harness();
  try {
    const admin = await registerUser(h.control.store, 'administrator', 'password123');
    await h.control.viewers.attachViewer(
      admin.tenantId,
      admin.tenantId,
      () => {},
      { identity: admin.token, valid: () => true },
      true,
    );
    const call = (method: string, params: Record<string, unknown> = {}) =>
      requestViewer(h.control, admin.tenantId, admin.tenantId, method, params);
    assert.equal((await h.connect('beta')).helloReply.type, 'node.ready');
    const mismatched = new FakeNode();
    await mismatched.connect(h.url, h.key, { nodeId: 'alpha', buildId: 'stale-build' });
    assert.equal(mismatched.helloReply.code, 'build_mismatch');
    const alpha = (await call('admin.nodes')).find((node: any) => node.nodeId === 'alpha');
    assert.deepEqual(
      { code: alpha.rejected.code, buildId: alpha.rejected.buildId, state: alpha.state },
      { code: 'build_mismatch', buildId: 'stale-build', state: 'offline' },
    );
    const beta = (await call('admin.nodes')).find((node: any) => node.nodeId === 'beta');
    assert.equal(beta.state, 'ready');
    assert.ok(beta.metrics.cpu >= 0 && beta.connectedAt);

    await call('admin.createUser', { username: 'leaving', password: 'password123' });
    const tenant = h.store.accounts.byUsername('leaving')!.tenant;
    const placement = h.placement.resolve(tenant);
    assert.equal(placement.nodeId, 'beta');
    await call('admin.deleteUser', { username: 'leaving' });
    await h.control.sessionPurge.flush();
    const betaClient = h.client('beta')!;
    assert.ok(
      betaClient.requests.some((r) => r.method === 'session.delete' && r.sessionId === placement.sessionId),
    );
    assert.deepEqual(h.store.db.prepare('SELECT node_id FROM session_deletions').all(), [
      { node_id: 'alpha' },
    ]);
    assert.equal((await call('admin.storage')).pendingSessionDeletions, 1);
    const alphaClient = await h.connect('alpha');
    await h.control.sessionPurge.flush();
    assert.ok(
      alphaClient.requests.some((r) => r.method === 'session.delete' && r.sessionId === placement.sessionId),
    );
    assert.equal(h.control.sessionPurge.pending(), 0);
  } finally {
    await h.close();
  }
});

test('placement excludes missing metrics, exhausted capacity, disk and memory; prefers healthy nodes and warm copies', async () => {
  const h = await harness();
  try {
    await h.connect('alpha');
    await h.connect('beta');
    const alpha = h.nodes.get('alpha')!,
      beta = h.nodes.get('beta')!;
    const record = (node: typeof alpha, cpu: number, fields: Parameters<typeof fakeMetrics>[0] = {}) => {
      node.metrics.clear();
      node.metrics.record(fakeMetrics({ cpu, ...fields }));
    };
    alpha.metrics.clear();
    beta.metrics.clear();
    assert.throws(() => h.placement.resolve('missing-metrics'), { code: 'unavailable' });
    record(alpha, 0.1, { disk: { total: 10000, free: 99 } });
    record(beta, 0.1, { memory: { total: 10000, available: 99 } });
    assert.throws(() => h.placement.resolve('no-space'), { code: 'unavailable' });
    record(alpha, 0.1, { sessions: 8 });
    assert.throws(() => h.placement.resolve('full'), { code: 'unavailable' });
    record(beta, 0.7);
    assert.equal(h.placement.resolve('healthy').nodeId, 'beta');
    const now = Date.now();
    alpha.metrics.clear();
    for (let offset = 30000; offset >= 0; offset -= 5000)
      alpha.metrics.record(fakeMetrics({ cpu: 0.9 }), now - offset);
    assert.equal(h.placement.resolve('healthy-first').nodeId, 'beta');
    beta.metrics.clear();
    for (let offset = 30000; offset >= 0; offset -= 5000)
      beta.metrics.record(fakeMetrics({ cpu: 0.95 }), now - offset);
    assert.equal(h.placement.resolve('pressure-fallback').nodeId, 'alpha');
    record(alpha, 0.5);
    record(beta, 0.4);
    const sleeping = h.placement.resolve('warm');
    h.store.db
      .prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?)')
      .run('warm', 1, sleeping.placementEpoch, id(1), 'dev', 0);
    h.store.db
      .prepare("UPDATE session_placements SET state='hibernated',checkpoint_id=1 WHERE tenant='warm'")
      .run();
    h.store.db
      .prepare('INSERT INTO warm_session_copies VALUES (?,?,?,?)')
      .run('warm', 'alpha', id(1), Date.now());
    assert.equal(h.placement.resolve('warm').nodeId, 'alpha');
  } finally {
    await h.close();
  }
});

test('normal hibernation waits ten minutes and fails without committing a checkpoint after Endpoint shutdown failure', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    h.store.workspaces.writeWorkspace(emptyWorkspace('tenant'));
    h.control.tenants.get('tenant').started = true;
    h.clock.advance(599999);
    assert.equal(await h.control.lifecycle.hibernate('tenant', clearSnapshot()), false);
    h.clock.advance(1);
    alpha.handler = (request) => {
      if (request.method === 'session.hibernate') throw { code: 'unavailable', message: 'unclean' };
      return alpha.handle(request);
    };
    await assert.rejects(h.control.lifecycle.hibernate('tenant', clearSnapshot()), { code: 'unavailable' });
    assert.equal(h.placement.peek('tenant')!.state, 'active');
    assert.equal(h.store.db.prepare('SELECT 1 FROM checkpoints').get(), undefined);
    await h.commit(alpha, 'tenant', id(1));
    alpha.handler = (request) =>
      request.method === 'session.hibernate'
        ? { manifestId: id(1), objects: [id(1)], buildId: 'dev' }
        : request.method === 'session.snapshot'
          ? { ...clearSnapshot(), running: false }
          : alpha.handle(request);
    await h.control.reconciler.observeOffline('tenant');
    assert.equal(h.placement.peek('tenant')!.state, 'hibernated');
  } finally {
    await h.close();
  }
});

test('library imports require indexed object ids and deduplicated derivatives stay pinned by either source', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    for (const n of [1, 2]) await h.commit(alpha, 'tenant', id(n));
    const thumb = await h.commit(alpha, 'tenant', id(3), 10, id(1));
    await alpha.request('object.committed', 'tenant', {
      objectId: thumb.id,
      size: thumb.size,
      storedSize: thumb.storedSize,
      storedSha256: thumb.storedSha256,
      derivedFrom: id(2),
      kind: 'thumbnail',
    });
    alpha.handler = (request) =>
      request.method === 'session.library.describe'
        ? {
            assetId: request.assetId,
            size: alpha.objects.get(request.assetId)!.size,
            type: 'image/png',
          }
        : alpha.handle(request);
    const request = (assetId: string, operationId: string) =>
      h.control.library.request(
        'tenant',
        'library.import',
        {
          operationId,
          assetId,
          name: 'image.png',
          destination: 'library',
          origin: { kind: 'files', channel: 'upload', partitionId: null },
        },
        () => {},
        () => undefined,
      );
    await assert.rejects(request('old-asset-id', 'invalid'), { code: 'invalid_request' });
    await assert.rejects(request(id(99), 'missing'), { code: 'forbidden' });
    await request(id(2), 'import');
    h.store.db.exec(
      'UPDATE objects SET created_at=0; UPDATE object_claims SET claimed_at=0; DELETE FROM object_gc',
    );
    await h.control.objects.gc();
    assert.equal(alpha.objects.has(id(1)), false);
    assert.ok(alpha.objects.has(id(3)));
    assert.equal(
      alpha.requests.some((request) =>
        ['session.library.references', 'session.library.retain'].includes(request.method),
      ),
      false,
    );
  } finally {
    await h.close();
  }
});

test('GC rechecks references after asynchronous deletes and checkpoints cannot adopt objects being deleted', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    await h.commit(alpha, 'tenant', id(1));
    await h.commit(alpha, 'tenant', id(2));
    h.store.db.exec(
      'UPDATE objects SET created_at=0; UPDATE object_claims SET claimed_at=0; DELETE FROM object_gc',
    );
    let release!: () => void;
    let deleting!: () => void;
    const started = new Promise<void>((resolve) => {
      deleting = resolve;
    });
    alpha.handler = async (request) => {
      if (request.method === 'object.delete' && request.ids.includes(id(1))) {
        deleting();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return alpha.handle(request);
    };
    const collection = h.control.objects.gc();
    await started;
    assert.throws(() => h.placement.commitCheckpoint(h.placement.peek('tenant')!, id(1), [id(1)], 'dev'), {
      code: 'conflict',
    });
    h.store.library.save('tenant', {
      revision: 0,
      basket: [],
      partitions: [],
      sources: [],
      excludedSources: [],
      basketPartitionId: null,
      entries: [
        {
          id: 'entry',
          kind: 'file' as const,
          assetId: id(2),
          name: 'file',
          type: 'text/plain',
          size: 10,
          createdAt: 0,
          partitionId: null,
          collected: true,
          source: { app: 'files', channel: 'upload' },
        },
      ],
    });
    release();
    await collection;
    assert.ok(alpha.objects.has(id(2)));
  } finally {
    await h.close();
  }
});

test('cluster object keys persist and match every node while session opens carry only a profile key', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha'),
      beta = await h.connect('beta');
    assert.equal(alpha.helloReply.objectKey, beta.helloReply.objectKey);
    assert.equal(alpha.helloReply.objectIdKey, beta.helloReply.objectIdKey);
    const row = h.store.db.prepare('SELECT ciphertext FROM cluster_object_secret').get() as {
      ciphertext: string;
    };
    const secret = h.store.atRestKey.open('cluster-object-secret', row.ciphertext);
    for (const [key, domain] of [
      ['objectKey', 'remotekit object key 2'],
      ['objectIdKey', 'remotekit object id key 2'],
    ])
      assert.equal(
        alpha.helloReply[key],
        Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), domain, 32)).toString('base64'),
      );
    await h.gateway.snapshot('tenant');
    const opened = alpha.requests.find((r) => r.method === 'session.open')!;
    assert.ok(opened.profileKey);
    assert.equal(opened.objectKey, undefined);
    assert.equal(opened.objectIdKey, undefined);
  } finally {
    await h.close();
  }
});

test('streamed Control puts deduplicate across tenants, authorize references, charge each tenant and preserve shared objects until grace', async () => {
  const h = await harness(100);
  try {
    const alpha = await h.connect('alpha');
    const chunks = async function* () {
      yield Buffer.from('class ');
      yield Buffer.from('attachment');
    };
    const first = await h.control.objects.put('first', chunks(), { maxBytes: 100 });
    const second = await h.control.objects.put('second', chunks(), { maxBytes: 100 });
    assert.deepEqual(second, first);
    assert.equal(h.control.objects.usage().objects, 1);
    assert.equal(h.control.objects.tenantUsage('first').bytes, first.size);
    assert.equal(h.control.objects.tenantUsage('second').bytes, first.size);
    assert.equal(
      (h.store.db.prepare('SELECT count(*) AS n FROM object_claims').get() as { n: bigint }).n,
      2n,
    );
    alpha.handler = (r) =>
      r.method === 'session.library.describe'
        ? { assetId: r.assetId, size: alpha.objects.get(r.assetId)!.size, type: 'text/plain' }
        : alpha.handle(r);
    const call = (tenant: string, method: string, params: object) =>
      h.control.library.request(
        tenant,
        'library.' + method,
        params,
        () => {},
        () => undefined,
      ) as Promise<LibrarySnapshot>;
    const imported: LibrarySnapshot[] = [];
    for (const tenant of ['first', 'second'])
      imported.push(
        await call(tenant, 'import', {
          operationId: 'import',
          assetId: first.id,
          name: 'attachment.txt',
          destination: 'library',
          origin: { kind: 'files', channel: 'upload', partitionId: null },
        }),
      );
    await h.gateway.snapshot('stranger');
    await assert.rejects(alpha.request('object.locate', 'stranger', { ids: [first.id] }), {
      code: 'forbidden',
    });
    h.store.db.exec('UPDATE object_claims SET claimed_at=0');
    await h.control.objects.gc();
    await call('first', 'delete', { operationId: 'delete', ids: [imported[0].entries[0].id] });
    await h.control.objects.gc();
    assert.equal(h.control.objects.usage().objects, 1);
    assert.equal(h.control.objects.bytes('first'), 0);
    assert.equal(h.control.objects.bytes('second'), first.size);
    await call('second', 'delete', { operationId: 'delete', ids: [imported[1].entries[0].id] });
    const now = Date.now();
    await h.control.objects.gc(now);
    assert.equal(h.control.objects.usage().objects, 1);
    await h.control.objects.gc(now + 2 * 60 * 60 * 1000 + 1);
    assert.equal(h.control.objects.usage().objects, 0);
    assert.equal(alpha.objects.has(first.id), false);
  } finally {
    await h.close();
  }
});

test('Control puts enforce stream bounds and quota, cancel blocked producers, and correlate simultaneous completions', async () => {
  const h = await harness(4 * 1024 * 1024);
  try {
    const alpha = await h.connect('alpha');
    const chunks = async function* (text: string) {
      yield Buffer.from(text);
    };
    const [a, b] = await Promise.all([
      h.control.objects.put('tenant', chunks('one'), { maxBytes: 3 }),
      h.control.objects.put('tenant', chunks('two'), { maxBytes: 3 }),
    ]);
    assert.notEqual(a.id, b.id);
    await assert.rejects(h.control.objects.put('tenant', chunks('oversize'), { maxBytes: 2 }), {
      code: 'limit_exceeded',
    });
    const big = await h.control.objects.put(
      'large',
      (async function* () {
        yield Buffer.alloc(2 * 1024 * 1024 + 7, 2);
      })(),
      { maxBytes: 3 * 1024 * 1024 },
    );
    assert.equal(big.size, 2 * 1024 * 1024 + 7);
    const controller = new AbortController();
    const entered = once(alpha, 'request');
    const blocked: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    };
    const pending = h.control.objects.put('cancelled', blocked, { maxBytes: 100, signal: controller.signal });
    await entered;
    const rejection = assert.rejects(pending, { code: 'canceled' });
    controller.abort();
    await rejection;
    assert.ok(alpha.requests.some((r) => r.method === 'object.put.cancel'));
    h.store.db.prepare('INSERT OR REPLACE INTO object_claims VALUES (?,?,?)').run('full', big.id, Date.now());
    const tooMuch = (async function* () {
      yield Buffer.alloc(2 * 1024 * 1024, 3);
    })();
    await assert.rejects(h.control.objects.put('full', tooMuch, { maxBytes: 3 * 1024 * 1024 }), {
      code: 'limit_exceeded',
    });
    assert.equal(
      (
        h.store.db.prepare('SELECT count(*) AS n FROM object_claims WHERE tenant=?').get('full') as {
          n: bigint;
        }
      ).n,
      1n,
    );
  } finally {
    await h.close();
  }
});

test('durable reference removal starts its own grace even without a GC tick while referenced', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect('alpha');
    await h.gateway.snapshot('tenant');
    await h.commit(alpha, 'tenant', id(1));
    h.store.db.exec(
      'UPDATE objects SET created_at=0; UPDATE object_claims SET claimed_at=0; DELETE FROM object_gc',
    );
    const snapshot = {
      revision: 0,
      entries: [
        {
          id: 'entry',
          kind: 'file' as const,
          assetId: id(1),
          name: 'file',
          type: 'text/plain',
          size: 10,
          createdAt: 0,
          partitionId: null,
          collected: true,
          source: { app: 'files', channel: 'upload' },
        },
      ],
      basket: [],
      partitions: [],
      sources: [],
      excludedSources: [],
      basketPartitionId: null,
    };
    h.store.library.save('tenant', snapshot);
    h.store.library.save('tenant', { ...snapshot, entries: [] });
    const now = Date.now();
    await h.control.objects.gc(now);
    assert.equal(h.control.objects.usage().objects, 1);
    await h.control.objects.gc(now + 2 * 60 * 60 * 1000 + 1);
    assert.equal(h.control.objects.usage().objects, 0);
  } finally {
    await h.close();
  }
});
