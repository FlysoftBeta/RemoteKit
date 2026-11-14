import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ControlDatabase } from '../server/persistence/database';
import { ViewerSecurity } from '../server/auth/viewer-security';
import { SessionPurge } from '../server/cluster/session-purge';
import { RemoteKitError } from '../shared/errors';
import type { AuthState } from '../shared/security';
import type { EndpointGateway } from '../server/endpoint/gateway';
import type { NodeRegistry } from '../server/cluster/node-link';
import { configureLog } from '../server/log';

function securityFixture() {
  const records: any[] = [];
  configureLog({ write: (line) => records.push(JSON.parse(line)) });
  let failLock = false;
  let calls = 0;
  let viewer: ReturnType<ViewerSecurity['create']>;
  const endpoint = {
    invalidate() {},
    isReady: () => true,
    sessionFault: () => undefined,
    published: async () => {
      calls++;
      if (failLock && viewer.locked)
        throw new RemoteKitError('unavailable', 'native lock failed', { retryAfterMs: 10 });
      return { revision: '1' };
    },
    waitObserved: async () => ({
      authorization: {
        connectionId: viewer.peer!.connectionId,
        epoch: viewer.peer!.epoch,
        unlocked: !viewer.locked,
      },
      lastError: null,
    }),

    faceCapabilities: async () => ({ available: true, modelVersion: 'test' }),
    faceStatus: async () => {
      throw new RemoteKitError('unavailable', 'camera transport failed', { retryAfterMs: 10 });
    },
    cancelFace: async () => ({}),
  } as unknown as EndpointGateway;
  const security = new ViewerSecurity(
    {} as ControlDatabase,
    endpoint,
    endpoint as unknown as import('../server/viewers/service-peers').ServicePeers,
    () => {},
    () => true,
    () => {},
  );
  viewer = security.create({ id: 'user' } as AuthState['user'], true);
  return {
    security,
    viewer,
    records,
    fail: (value: boolean) => {
      failLock = value;
    },
    calls: () => calls,
  };
}

test('failed native lock is marked not applied and explicit restoration waits for observation', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = securityFixture();
  await f.security.bind('tenant', f.viewer, 'connection');
  assert.equal(f.viewer.peer!.appliedEpoch, 1);
  f.fail(true);
  await assert.rejects(f.security.lock('tenant', f.viewer), /native lock failed/);
  assert.equal(f.viewer.locked, true);
  assert.equal(f.viewer.peer!.appliedEpoch, 0);
  assert.notEqual(f.viewer.peer!.appliedEpoch, f.viewer.peer!.epoch);
  assert.ok(
    f.records.some((record) => record.ev === 'security.authorization_failed' && record.lvl === 'warn'),
  );
  f.fail(false);
  t.mock.timers.tick(10);
  await f.security.restore('tenant', f.viewer);
  assert.equal(f.viewer.peer!.appliedEpoch, f.viewer.peer!.epoch);
  assert.equal(f.calls(), 3);
});

test('replacement and detach revocations retain their peer until native lock is confirmed', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = securityFixture();
  await f.security.bind('tenant', f.viewer, 'old-connection');
  f.fail(true);
  await f.security.revokePeer('tenant', f.viewer);
  assert.equal(f.viewer.peer!.connectionId, 'old-connection');
  assert.equal(f.viewer.peer!.appliedEpoch, 0);
  await f.security.retryRevocations();
  assert.equal(f.viewer.peer!.connectionId, 'old-connection');
  f.fail(false);
  t.mock.timers.tick(10);
  await f.security.retryRevocations();
  assert.equal(f.viewer.peer, undefined);
  const calls = f.calls();
  await f.security.retryRevocations();
  assert.equal(f.calls(), calls);
});

test('presence query failure preserves the challenge and lock state', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = securityFixture();
  await f.security.bind('tenant', f.viewer, 'connection');
  f.viewer.servicePeer = { connectionId: 'service', epoch: 1, appliedEpoch: 1, requests: 0 };
  f.viewer.challenge = {
    id: 'challenge',
    peer: f.viewer.servicePeer!,
    epoch: f.viewer.servicePeer!.epoch,
    purpose: 'presence',
    expires: Infinity,
    modelVersion: 'test',
    started: true,
  };
  f.fail(true);
  await f.security.poll('tenant', f.viewer);
  assert.equal(f.viewer.locked, false);
  assert(f.viewer.challenge);
  assert.equal(f.viewer.face.error?.code, 'unavailable');
  assert.ok(f.records.some((record) => record.ev === 'security.face_status_failed'));
  f.fail(false);
  t.mock.timers.tick(10);
  await f.security.restore('tenant', f.viewer);
  assert.equal(f.viewer.peer!.appliedEpoch, f.viewer.peer!.epoch);
});

function purgeFixture() {
  configureLog({ write() {} });
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const db = store.db;
  const node = { nodeId: 'node', state: { state: 'ready' }, request: async () => ({}) };
  const nodes = Object.assign(new EventEmitter(), {
    all: () => [node],
    options: { buildId: 'test' },
  }) as unknown as NodeRegistry;
  const purge = new SessionPurge(store, nodes);
  purge.enqueue('session');
  return { db, node, purge };
}

test('unexpected purge failure is recorded as internal and the deletion remains pending', async (t) => {
  const f = purgeFixture();
  t.after(async () => {
    await f.purge.close();
    f.db.close();
  });
  f.node.request = async () => {
    throw new Error('unexpected purge defect');
  };
  await f.purge.flush();
  assert.equal(f.purge.pending(), 1);
  assert.equal(f.purge.failures()[0].error.code, 'internal');
});

test('unexpected post-request purge failure is recorded and follows the shared retry policy', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = purgeFixture();
  t.after(async () => {
    await f.purge.close();
    f.db.close();
  });
  let failed = false;
  const prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, 'prepare', (sql: string) => {
    if (sql.startsWith('DELETE FROM session_deletions') && !failed) {
      failed = true;
      throw new RemoteKitError('unavailable', 'retry deletion', { retryAfterMs: 10 });
    }
    return prepare(sql);
  });
  await f.purge.flush();
  assert.equal(f.purge.failures()[0].error.code, 'unavailable');
  assert.equal(f.purge.pending(), 1);
  t.mock.timers.tick(10);
  await f.purge.flush();
  assert.equal(f.purge.pending(), 0);
});
