import { registerUser } from './server-fixture';
import { accountsFor } from './server-fixture';
import { requestViewer } from './server-fixture';
import { TestClock, testGateway } from './server-fixture';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApplication, type DomainServices } from '../server/application';
import type { EndpointLink } from '../server/endpoint/link';
import { ControlDatabase } from '../server/persistence/database';
import type { FaceStatus } from '../shared/security';

const password = 'password123';
const template = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('detaching a Viewer retains a failed peer revocation and retries it without an active Viewer', async (t) => {
  const f = await fixture(t);
  await f.offer();
  const security = f.control.tenants.get(f.tenant).viewer!.security!;
  const request = f.endpoint.request.bind(f.endpoint);
  let failing = true;
  t.mock.method(
    f.endpoint,
    'request',
    async (method: string, tenant: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.desired' && (params.authorization as any).unlocked === false && failing)
        throw new Error('native revocation unavailable');
      return request(method, tenant, params);
    },
  );
  await f.control.viewers.detachViewer(f.tenant, 'lease');
  assert.equal(f.control.tenants.get(f.tenant).viewer, undefined);
  assert.equal(security.locked, true);
  assert.equal(security.peer!.appliedEpoch, 0);
  await f.control.viewers.pollFaceAuth();
  assert.ok(security.peer);
  failing = false;
  await f.control.viewers.pollFaceAuth();
  assert.equal(security.peer, undefined);
});

class AuthEndpoint implements EndpointLink {
  readonly state = { state: 'ready' as const, incarnation: 'test', connectionEpoch: 'test' };
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  connectionId?: string;
  faceStatus: FaceStatus = 'pending';
  faceOutcome?: 'no_matching_face' | 'camera_unavailable';
  statusGate?: ReturnType<typeof defer>;
  authGate?: ReturnType<typeof defer>;
  private signal?: Parameters<NonNullable<EndpointLink['onSignal']>>[0];
  onSignal(listener: Parameters<NonNullable<EndpointLink['onSignal']>>[0]) {
    this.signal = listener;
    return () => {
      this.signal = undefined;
    };
  }
  observe() {
    return {
      running: true,
      views: [],
      rtc: { active: !!this.connectionId, connectionId: this.connectionId },
    };
  }
  async request(method: string, _tenant: string, params: Record<string, unknown> = {}): Promise<any> {
    this.calls.push({ method, params });
    switch (method) {
      case 'session.desired':
        if ((params.authorization as any).unlocked && this.authGate) await this.authGate.promise;
        return { accepted: true };
      case 'rtc.offer':
        this.connectionId = String(params.connectionId);
        queueMicrotask(() =>
          this.signal?.({
            tenantId: _tenant,
            connectionId: String(params.connectionId),
            signal: { type: 'answer', sdp: 'v=0' },
          }),
        );
        return { accepted: true, avSync: params.avSync, connectionId: params.connectionId };
      case 'rtc.close':
        this.connectionId = undefined;
        return { closed: true };
      case 'auth.face.capabilities':
        return { available: true, modelVersion: 'test-sface' };
      case 'auth.face.begin':
        return { accepted: true };
      case 'auth.face.status':
        if (this.statusGate) await this.statusGate.promise;
        return {
          challengeId: params.challengeId,
          status: this.faceStatus,
          outcome: this.faceOutcome,
          ...(this.faceStatus === 'enrolled' ? { template } : {}),
        };
      default:
        return { accepted: true };
    }
  }
}

async function fixture(t: TestContext, path = ':memory:') {
  const clock = new TestClock(),
    store = new ControlDatabase(path, { clock, buildId: 'test' }),
    endpoint = new AuthEndpoint(),
    control = createApplication(store, testGateway(endpoint), undefined, clock);
  t.after(async () => {
    await control.close();
    store.db.close();
  });
  const { tenantId: tenant, user } = await registerUser(store, 'account-auth', password);
  const attach = (lease: string, unlocked = false) =>
    control.viewers.attachViewer(tenant, lease, () => {}, { identity: lease, valid: () => true }, unlocked);
  await attach('lease', true);
  const request = (method: string, params: object = {}, lease = 'lease') =>
    requestViewer(control, tenant, lease, method, params);
  const offer = () => request('rtc.offer', { type: 'offer', sdp: 'v=0', attemptId: randomUUID() });
  return { store, endpoint, control, tenant, user, attach, request, offer, clock };
}

test('locks existing peer, rejects product actions and uploads, and resumes with fresh peer epoch', async (t) => {
  const f = await fixture(t),
    { connectionId } = await f.offer();
  const first = await f.request('auth.get');
  assert.equal(first.peerEpoch, 1);
  assert.equal(f.endpoint.calls.find((c) => c.method === 'rtc.offer')?.params.trickle, true);
  const locked = await f.request('auth.lock');
  assert.equal(locked.locked, true);
  assert.equal(locked.peerEpoch, 2);
  for (const method of ['admin.overview', 'operation.status', 'viewport', 'action'])
    await assert.rejects(f.request(method), { code: 'locked' });
  const op = {
    tenantId: f.tenant,
    connectionId,
    operationId: randomUUID(),
    operationGeneration: f.store.operations.operationGeneration(f.tenant),
    action: { type: 'window.open' as const, appId: 'browser', placement: { mode: 'space' as const } },
  };
  await f.control.operations.handleEndpointAction({ ...op, authEpoch: 1 });
  assert.equal(f.store.workspaces.workspace(f.tenant).windows.length, 0);
  assert.equal(typeof (await f.request('clock.ping')).serverTime, 'number');
  const unlocked = await f.request('auth.verify', { method: 'password', secret: password });
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.peerEpoch, 3);
  assert.equal(f.endpoint.connectionId, connectionId);
  assert.equal(
    f.endpoint.calls.some((c) => c.method === 'rtc.close'),
    false,
  );
  await f.control.operations.handleEndpointAction({ ...op, authEpoch: 1 });
  assert.equal(f.store.workspaces.workspace(f.tenant).windows.length, 0);
  await f.control.operations.handleEndpointAction({ ...op, authEpoch: 3 });
  assert.equal(f.store.workspaces.workspace(f.tenant).windows.length, 1);
  assert.equal(f.endpoint.calls.find((c) => c.method === 'rtc.actionResult')?.params.authEpoch, 3);
  f.control.rtc.endpointOffline();
  assert.equal((await f.request('auth.get')).locked, true);
  assert.equal((await f.request('auth.get')).peerEpoch, 0);
  await f.control.reconciler.endpointReady({ processChanged: false });
  assert.equal((await f.request('auth.get')).peerEpoch, 4);
});

test('late unlock acknowledgement cannot restore rights after a subsequent lock', async (t) => {
  const f = await fixture(t);
  await f.offer();
  await f.request('auth.lock');
  f.endpoint.authGate = defer();
  const pending = f.request('auth.verify', { method: 'password', secret: password });
  const rejected = assert.rejects(pending, { code: 'outcome_unknown' });
  while (
    !f.endpoint.calls.some(
      (c) => c.method === 'session.desired' && (c.params.authorization as any).epoch === 3,
    )
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  await f.request('auth.lock');
  f.endpoint.authGate.resolve();
  await rejected;
  const state = await f.request('auth.get');
  assert.equal(state.locked, true);
  assert.equal(state.peerEpoch, 4);
});

test('settings require current password, PIN is hashed and failures are limited across leases', async (t) => {
  const f = await fixture(t);
  const initial = await f.request('auth.get');
  assert.equal(initial.settings.lockOnIdle, true);
  assert.equal(initial.settings.idleSeconds, 300);
  assert.equal(initial.settings.lockOnHidden, true);
  await assert.rejects(f.request('auth.settings', { currentPassword: 'wrong', pin: '123456' }), {
    code: 'forbidden',
  });
  assert.equal(f.store.security.security(f.user.id).pin, undefined);
  await assert.rejects(f.request('auth.settings', { currentPassword: password, pin: '1234' }), {
    code: 'invalid_request',
  });
  await f.request('auth.settings', {
    currentPassword: password,
    pin: '123456',
    settings: { lockOnHidden: false, idleSeconds: 60 },
  });
  assert.notEqual(f.store.security.security(f.user.id).pin?.hash, '123456');
  await f.request('auth.password', { currentPassword: password, newPassword: 'changed-password' });
  await f.request('auth.lock');
  for (let i = 0; i < 6; i++)
    await assert.rejects(f.request('auth.verify', { method: 'pin', secret: '654321' }), {
      code: 'forbidden',
    });
  await f.attach('replacement');
  await assert.rejects(f.request('auth.verify', { method: 'pin', secret: '123456' }, 'replacement'), {
    code: 'rate_limited',
  });
  await assert.rejects(f.request('auth.verify', { method: 'password', secret: password }, 'replacement'), {
    code: 'forbidden',
  });
  const state = await f.request(
    'auth.verify',
    { method: 'password', secret: 'changed-password' },
    'replacement',
  );
  assert.equal(state.locked, false);
  assert.equal(state.settings.lockOnHidden, false);
  assert.equal(state.settings.idleSeconds, 60);
});

test('face template is encrypted and late matches or enrollment results cannot commit', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-auth-')),
    path = join(directory, 'control.db');
  const f = await fixture(t, path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await f.offer();
  await assert.rejects(f.request('auth.face.begin', { purpose: 'enroll', currentPassword: 'wrong' }), {
    code: 'forbidden',
  });
  const first = await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: password });
  assert.equal(first.face.status, 'pending');
  const expire = () => f.clock.advance(120001);
  expire();
  f.endpoint.faceStatus = 'enrolled';
  await f.control.viewers.pollFaceAuth();
  assert.equal((await f.request('auth.get')).face.status, 'expired');
  assert.equal(f.store.security.security(f.user.id).face, undefined);
  await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: password });
  await f.control.viewers.pollFaceAuth();
  const stored = f.store.security.security(f.user.id).face!;
  assert.ok(stored && !stored.sealed.includes(JSON.stringify(template)));
  assert.equal(readFileSync(path + '.key').length, 32);
  const reopened = new ControlDatabase(path, { buildId: 'test' });
  try {
    assert.deepEqual(
      reopened.security.faceVault.open(f.user.id, stored.sealed, stored.modelVersion),
      template,
    );
  } finally {
    reopened.db.close();
  }
  await f.request('auth.lock');
  const verify = await f.request('auth.face.begin', { purpose: 'verify' });
  assert.equal(JSON.stringify(verify).includes(JSON.stringify(template)), false);
  const begin = f.endpoint.calls.filter((c) => c.method === 'auth.face.begin').slice(-1)[0];
  assert.deepEqual(begin?.params.template, template);
  assert.equal(begin?.params.epoch, verify.peerEpoch);
  f.endpoint.faceStatus = 'matched';
  f.endpoint.statusGate = defer();
  const status = f.control.viewers.pollFaceAuth();
  expire();
  f.endpoint.statusGate.resolve();
  await status;
  assert.equal((await f.request('auth.get')).locked, true);
  assert.equal((await f.request('auth.get')).face.status, 'expired');
  await f.request('auth.face.begin', { purpose: 'presence' });
  f.endpoint.faceStatus = 'absent';
  f.endpoint.faceOutcome = 'no_matching_face';
  await f.control.viewers.pollFaceAuth();
  const absent = await f.request('auth.get');
  assert.equal(absent.locked, true);
  assert.equal(absent.face.status, 'absent');
  assert.equal(absent.face.outcome, 'no_matching_face');
  await f.request('auth.face.begin', { purpose: 'presence' });
  assert.equal((await f.request('auth.get')).face.reason, undefined);
  f.endpoint.faceOutcome = undefined;
  await f.control.viewers.pollFaceAuth();
  assert.equal((await f.request('auth.get')).face.reason, undefined);
  await f.request('auth.face.begin', { purpose: 'verify' });
  f.endpoint.faceStatus = 'matched';
  await f.control.viewers.pollFaceAuth();
  assert.equal((await f.request('auth.get')).locked, false);
});
