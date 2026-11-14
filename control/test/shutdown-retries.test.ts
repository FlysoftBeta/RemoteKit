import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../server/application';
import type { EndpointLink } from '../server/endpoint/link';
import { ControlDatabase } from '../server/persistence/database';
import { RemoteKitError } from '../shared/errors';
import type { ServicePeers } from '../server/viewers/service-peers';
import { registerUser, testGateway } from './server-fixture';

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const dependency of ['faceCapabilities', 'faceStatus'] as const) {
  test(`application close drains ${dependency} and ignores its late failure`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
    const store = new ControlDatabase(':memory:', { buildId: 'test' });
    const control = createApplication(store, testGateway({ request: async () => ({ accepted: true }) }));
    const gate = deferred<Awaited<ReturnType<ServicePeers[typeof dependency]>>>();
    let attempts = 0;
    t.mock.method(control.servicePeers, dependency, () => {
      attempts++;
      return gate.promise;
    });
    let closing: Promise<void> | undefined;
    let poll: Promise<void> | undefined;
    try {
      const user = await registerUser(store, `shutdown-${dependency}`, 'password123');
      await control.viewers.attachViewer(
        user.tenantId,
        'lease',
        () => {},
        { identity: 'account', valid: () => true },
        true,
      );
      if (dependency === 'faceStatus') {
        const viewer = control.tenants.get(user.tenantId).viewer!.security;
        viewer.servicePeer = { connectionId: 'service', epoch: 1, appliedEpoch: 1, requests: 0 };
        viewer.challenge = {
          id: 'challenge',
          peer: viewer.servicePeer,
          epoch: 1,
          purpose: 'enroll',
          expires: Infinity,
          modelVersion: 'test',
          started: true,
        };
        poll = control.security.poll(user.tenantId, viewer);
      }
      assert.equal(attempts, 1);
      let closed = false;
      closing = control.close().then(() => {
        closed = true;
      });
      await settle();
      assert.equal(closed, false, 'close must join the dependency before SQLite retires');
      gate.reject(new RemoteKitError('unavailable', 'late service reply'));
      await closing;
      await poll;
      store.db.close();
      t.mock.timers.tick(86400000);
      await settle();
      assert.equal(attempts, 1);
    } finally {
      gate.reject(new RemoteKitError('canceled', 'cleanup'));
      await closing;
      await poll;
      if (store.db.open) {
        if (!closing) await control.close();
        store.db.close();
      }
    }
  });
}

for (const owner of ['reclaim', 'inventory', 'maintenance'] as const) {
  test(`application close cancels the ${owner} retry before SQLite retirement`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
    const store = new ControlDatabase(':memory:', { buildId: 'test' });
    const control = createApplication(store, testGateway({ request: async () => ({ accepted: true }) }));
    let attempts = 0;
    const fail = () => {
      attempts++;
      throw new RemoteKitError('unavailable', 'scheduled shutdown fixture', { retryAfterMs: 50 });
    };
    try {
      if (owner === 'reclaim') {
        t.mock.method(store.reclaim, 'tick', fail);
        await control.reconciler.tick();
      } else if (owner === 'inventory') {
        const node = control.endpoint.nodes.all()[0];
        const request = node.request.bind(node);
        t.mock.method(node, 'request', (...args: Parameters<typeof node.request>) =>
          args[0] === 'object.inventory' ? Promise.resolve(fail()) : request(...args),
        );
        control.endpoint.nodes.emit('ready', { nodeId: node.nodeId });
        await settle();
      } else {
        const prepare = store.db.prepare.bind(store.db);
        t.mock.method(store.db, 'prepare', (sql: string) =>
          sql.startsWith('DELETE FROM checkpoints WHERE') ? fail() : prepare(sql),
        );
        await control.objects.tick();
      }
      assert.equal(attempts, 1);
      const closing = control.close();
      assert.equal(control.close(), closing, 'concurrent retirement must share one completion');
      await closing;
      t.mock.timers.tick(86400000);
      await settle();
      assert.equal(attempts, 1, 'close must cancel scheduled work');
      store.db.close();
      t.mock.timers.tick(86400000);
      await settle();
      assert.equal(attempts, 1, 'a retired owner must not enter its dependency again');
    } finally {
      if (store.db.open) {
        await control.close();
        store.db.close();
      }
    }
  });
}

test('application close joins a pending RTC answer and its native retirement', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  let admitted!: () => void;
  const admission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  let retiring!: () => void;
  const retirement = new Promise<void>((resolve) => {
    retiring = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const endpoint: EndpointLink & { observe(): { running: boolean; views: [] } } = {
    state: { state: 'ready', incarnation: 'test', connectionEpoch: 'test' },
    observe: () => ({ running: true, views: [] }),
    request: async (method, _tenant, args = {}) => {
      if (method === 'rtc.offer') {
        admitted();
        return { accepted: true, avSync: args.avSync, connectionId: args.connectionId };
      }
      if (method === 'rtc.close') {
        retiring();
        await gate;
      }
      return { accepted: true, closed: true };
    },
  };
  const control = createApplication(store, testGateway(endpoint));
  let closing: Promise<void> | undefined;
  let offer: Promise<unknown> | undefined;
  try {
    const user = await registerUser(store, 'shutdown-answer', 'password123');
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'account', valid: () => true },
      true,
    );
    offer = assert.rejects(
      control.rtc.offer(user.tenantId, { type: 'offer', sdp: 'v=0\r\n', attemptId: 'shutdown' }, 'lease'),
    );
    await admission;
    let closed = false;
    closing = control.close().then(() => {
      closed = true;
    });
    await retirement;
    await settle();
    assert.equal(closed, false, 'close must join the private RTC queue');
    release();
    await closing;
    await offer;
    store.db.close();
  } finally {
    release();
    await closing;
    await offer;
    if (store.db.open) {
      if (!closing) await control.close();
      store.db.close();
    }
  }
});

test('service peer disposal prevents queued offers from creating another answer timer', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const admission = deferred<void>();
  const acceptance = deferred<void>();
  let offers = 0;
  const control = createApplication(
    store,
    testGateway({
      request: async (method) => {
        if (method === 'service.offer') {
          offers++;
          if (offers === 1) {
            admission.resolve();
            await acceptance.promise;
          } else throw new RemoteKitError('unavailable', 'a disposed owner entered the Endpoint');
        }
        return { accepted: true, closed: true };
      },
    }),
  );
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  try {
    const user = await registerUser(store, 'shutdown-service', 'password123');
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'account', valid: () => true },
      true,
    );
    first = assert.rejects(
      control.servicePeers.offer(
        user.tenantId,
        { type: 'offer', sdp: 'v=0\r\n', attemptId: 'first' },
        'lease',
      ),
    );
    await admission.promise;
    second = assert.rejects(
      control.servicePeers.offer(
        user.tenantId,
        { type: 'offer', sdp: 'v=0\r\n', attemptId: 'queued' },
        'lease',
      ),
    );
    disposal = control.servicePeers.dispose();
    acceptance.resolve();
    await disposal;
    await Promise.all([first, second]);
    assert.equal(offers, 1);
  } finally {
    acceptance.resolve();
    await disposal;
    await Promise.all([first, second]);
    await control.close();
    store.db.close();
  }
});
