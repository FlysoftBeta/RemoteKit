import { buildAction } from '../client/control/action-builder';
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
import { RemoteKitError } from '../shared/errors';
import { configureLog } from '../server/log';
import { readFaceStatus } from '../server/endpoint/face-status';
import { faceHints } from '../shared/security';

const password = 'password123';
const template = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
const templates = [template, [0, 1, ...Array(126).fill(0)], [0, 0, 1, ...Array(125).fill(0)]];
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('detaching a Viewer retains a failed peer revocation and retries it without an active Viewer', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
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
        throw new RemoteKitError('unavailable', 'native revocation unavailable', { retryAfterMs: 10 });
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
  t.mock.timers.tick(10);
  await f.control.viewers.pollFaceAuth();
  assert.equal(security.peer, undefined);
});

class AuthEndpoint implements EndpointLink {
  readonly state = { state: 'ready' as const, incarnation: 'test', connectionEpoch: 'test' };
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  connectionId?: string;
  faceStatus: FaceStatus = 'pending';
  faceFields: Record<string, unknown> = {};
  facePurpose?: string;
  faceOutcome?: 'no_matching_face' | 'camera_unavailable';
  statusGate?: ReturnType<typeof defer>;
  authGate?: ReturnType<typeof defer>;
  private readonly signals = new Set<Parameters<NonNullable<EndpointLink['onSignal']>>[0]>();
  private signal?: Parameters<NonNullable<EndpointLink['onSignal']>>[0];
  onFaceChanged() {
    return () => {};
  }
  onSignal(listener: Parameters<NonNullable<EndpointLink['onSignal']>>[0]) {
    this.signals.add(listener);
    return () => {
      this.signals.delete(listener);
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
      case 'service.offer':
        queueMicrotask(() => {
          for (const listener of this.signals)
            listener({
              tenantId: _tenant,
              connectionId: String(params.connectionId),
              signal: { type: 'answer', sdp: 'v=0' },
            });
        });
        return { accepted: true, connectionId: params.connectionId };
      case 'service.authorize':
        return { applied: true, epoch: params.epoch };
      case 'rtc.offer':
        this.connectionId = String(params.connectionId);
        queueMicrotask(() =>
          this.signals.forEach((listener) =>
            listener({
              tenantId: _tenant,
              connectionId: String(params.connectionId),
              signal: { type: 'answer', sdp: 'v=0' },
            }),
          ),
        );
        return { accepted: true, avSync: params.avSync, connectionId: params.connectionId };
      case 'rtc.close':
        this.connectionId = undefined;
        return { closed: true };
      case 'service.face.capabilities':
        return { available: true, modelVersion: 'test-sface' };
      case 'service.face.begin':
        this.facePurpose = String(params.purpose);
        return { accepted: true };
      case 'service.face.status':
        if (this.statusGate) await this.statusGate.promise;
        return {
          challengeId: params.challengeId,
          status: this.faceStatus,
          outcome: this.faceOutcome,
          ...(this.faceStatus === 'enrolled' ? { templates } : {}),
          ...(this.facePurpose === 'enroll' && this.faceStatus === 'pending' ? { progress: 0.25 } : {}),
          ...this.faceFields,
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
  const serviceOffer = () => request('service.offer', { type: 'offer', sdp: 'v=0', attemptId: randomUUID() });
  const offer = async () => {
    await serviceOffer();
    return request('rtc.offer', { type: 'offer', sdp: 'v=0', attemptId: randomUUID() });
  };
  return { store, endpoint, control, tenant, user, attach, request, offer, serviceOffer, clock };
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
  for (const method of ['admin.overview', 'operation.status', 'viewport', 'operation.submit'])
    await assert.rejects(f.request(method), { code: 'locked' });
  const op = {
    operationId: randomUUID(),
    operationGeneration: f.store.operations.operationGeneration(f.tenant),
    action: buildAction({
      type: 'window.open' as const,
      appId: 'browser',
      placement: { mode: 'space' as const },
    }),
  };
  await assert.rejects(f.request('operation.submit', op), { code: 'locked' });
  assert.equal(f.store.workspaces.workspace(f.tenant).windows.length, 0);
  assert.equal(typeof (await f.request('clock.ping')).serverTime, 'number');
  const unlocked = await f.request('auth.verify', { method: 'password', secret: password });
  assert.equal(unlocked.locked, false);
  await f.control.servicePeers.authorize(f.tenant);
  assert.equal(f.endpoint.connectionId, connectionId);
  assert.equal(
    f.endpoint.calls.some((c) => c.method === 'rtc.close'),
    false,
  );
  await f.request('operation.submit', op);
  assert.equal(f.store.workspaces.workspace(f.tenant).windows.length, 1);
  f.control.rtc.endpointOffline();
  assert.equal((await f.request('auth.get')).locked, false);
  assert.equal((await f.request('auth.get')).peerEpoch, 0);
  await f.control.reconciler.endpointReady({ processChanged: false });
});

test('late unlock acknowledgement cannot restore rights after a subsequent lock', async (t) => {
  const f = await fixture(t);
  await f.offer();
  await f.request('auth.lock');
  f.endpoint.authGate = defer();
  const pending = f.request('auth.verify', { method: 'password', secret: password });
  await pending;
  while (
    !f.endpoint.calls.some(
      (c) => c.method === 'session.desired' && (c.params.authorization as any).epoch === 3,
    )
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  await f.request('auth.lock');
  f.endpoint.authGate.resolve();
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
    assert.deepEqual(reopened.security.faceVault.open(f.user.id, stored.sealed, stored.modelVersion), {
      version: 2,
      templates: templates.map((vector) => ({ source: 'enrolled', vector, addedAt: f.clock.wallMs() })),
    });
  } finally {
    reopened.db.close();
  }
  await f.request('auth.lock');
  const verify = await f.request('auth.face.begin', { purpose: 'verify' });
  assert.equal(JSON.stringify(verify).includes(JSON.stringify(template)), false);
  const begin = f.endpoint.calls.filter((c) => c.method === 'service.face.begin').slice(-1)[0];
  assert.deepEqual(begin?.params.templates, templates);
  assert.equal(begin?.params.epoch, verify.serviceEpoch);
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

async function enrolledFixture(t: TestContext) {
  const f = await fixture(t);
  await f.serviceOffer();
  await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: password });
  assert.equal(
    'templates' in
      f.endpoint.calls.filter((call) => call.method === 'service.face.begin').slice(-1)[0]!.params,
    false,
  );
  f.endpoint.faceStatus = 'enrolled';
  await f.control.viewers.pollFaceAuth();
  const gallery = () => {
    const face = f.store.security.security(f.user.id).face!;
    return f.store.security.faceVault.open(f.user.id, face.sealed, face.modelVersion);
  };
  const verify = async () => {
    f.endpoint.faceStatus = 'pending';
    f.endpoint.faceFields = {};
    await f.request('auth.lock');
    await f.control.servicePeers.authorize(f.tenant);
    await f.request('auth.face.begin', { purpose: 'verify' });
  };
  return { ...f, gallery, verify };
}

const learnedVector = [0, 0, 0, 1, ...Array(124).fill(0)];

test('enrollment progress and hints reach AuthState while vectors stay private', async (t) => {
  const f = await fixture(t);
  await f.serviceOffer();
  const started = await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: password });
  assert.equal(started.face.progress, 0);
  for (const hint of faceHints) {
    f.endpoint.faceFields = { progress: 0.75, hint };
    await f.control.viewers.pollFaceAuth();
    const state = await f.request('auth.get');
    assert.equal(state.face.progress, 0.75);
    assert.equal(state.face.hint, hint);
    assert.equal('templates' in state.face || 'learn' in state.face, false);
  }
  f.endpoint.faceFields = {};
  await f.control.viewers.pollFaceAuth();
  assert.equal((await f.request('auth.get')).face.hint, undefined);
  f.endpoint.faceFields = { progress: 2, templates };
  await f.control.viewers.pollFaceAuth();
  const failed = await f.request('auth.get');
  assert.equal(failed.face.status, 'failed');
  assert.equal(failed.face.progress, undefined);
  assert.equal(failed.face.hint, undefined);
  assert.equal(f.store.security.security(f.user.id).face, undefined);
});

test('matched verification learns once, replaces oldest learned entry, and re-enrollment replaces the gallery', async (t) => {
  const f = await enrolledFixture(t);
  const record = f.store.security.security(f.user.id);
  const gallery = f.gallery();
  gallery.templates.push(
    ...[40, 10, 30, 20].map((addedAt) => ({ source: 'learned' as const, vector: template, addedAt })),
  );
  record.face!.sealed = f.store.security.faceVault.seal(f.user.id, gallery, 'test-sface');
  f.store.security.saveSecurity(f.user.id, record);
  await f.verify();
  const begin = f.endpoint.calls.filter((call) => call.method === 'service.face.begin').slice(-1)[0]!;
  assert.deepEqual(
    begin.params.templates,
    gallery.templates.map((entry) => entry.vector),
  );
  assert.equal('template' in begin.params, false);
  f.endpoint.faceStatus = 'matched';
  f.endpoint.faceFields = { learn: learnedVector };
  await f.control.viewers.pollFaceAuth();
  assert.equal((await f.request('auth.get')).locked, false);
  assert.deepEqual(
    f
      .gallery()
      .templates.filter((entry) => entry.source === 'learned')
      .map((entry) => entry.addedAt),
    [40, 30, 20, f.clock.wallMs()],
  );
  assert.deepEqual(f.gallery().templates.slice(-1)[0]!.vector, learnedVector);
  await f.request('auth.verify', { method: 'password', secret: password });
  await f.control.viewers.pollFaceAuth();
  assert.equal(f.gallery().templates.length, 7);
  f.endpoint.faceFields = {};
  await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: password });
  f.endpoint.faceStatus = 'enrolled';
  await f.control.viewers.pollFaceAuth();
  assert.equal(f.gallery().templates.length, 3);
  assert(f.gallery().templates.every((entry) => entry.source === 'enrolled'));
  await f.request('auth.face.remove', { currentPassword: password });
  assert.equal(f.store.security.security(f.user.id).face, undefined);
});

for (const method of ['pin', 'password'] as const) {
  test(`${method} unlock learns only from the most recent, fresh verify poll`, async (t) => {
    const f = await enrolledFixture(t);
    if (method === 'pin') await f.request('auth.settings', { currentPassword: password, pin: '123456' });
    const unlock = () => f.request('auth.verify', { method, secret: method === 'pin' ? '123456' : password });
    await f.verify();
    f.endpoint.faceFields = { learn: learnedVector };
    await f.control.viewers.pollFaceAuth();
    const state = await f.request('auth.get');
    assert.equal(
      'learn' in state.face || 'templates' in state.face || 'progress' in state.face || 'hint' in state.face,
      false,
    );
    f.clock.advance(2000);
    await unlock();
    assert.equal(f.gallery().templates.length, 4);
    for (const invalidation of [
      'age',
      'new-poll',
      'new-challenge',
      'cancel',
      'expired',
      'poll-error',
      'presence',
    ]) {
      f.clock.advance(61000);
      await f.verify();
      f.endpoint.faceFields = { learn: learnedVector };
      await f.control.viewers.pollFaceAuth();
      if (invalidation === 'age') f.clock.advance(2001);
      if (invalidation === 'expired') f.clock.advance(30001);
      if (invalidation === 'new-poll') {
        f.endpoint.faceFields = {};
        await f.control.viewers.pollFaceAuth();
      }
      if (['new-challenge', 'cancel', 'presence'].includes(invalidation)) {
        const challengeId = (await f.request('auth.get')).face.challengeId;
        await f.request('auth.face.cancel', { challengeId });
        if (invalidation !== 'cancel')
          await f.request('auth.face.begin', {
            purpose: invalidation === 'presence' ? 'presence' : 'verify',
          });
      }
      if (invalidation === 'poll-error') {
        const original = f.endpoint.request.bind(f.endpoint);
        const mock = t.mock.method(
          f.endpoint,
          'request',
          async (name: string, tenant: string, params?: Record<string, unknown>) => {
            if (name === 'service.face.status') throw new RemoteKitError('unavailable', 'poll failed');
            return original(name, tenant, params);
          },
        );
        await f.control.viewers.pollFaceAuth();
        mock.mock.restore();
      }
      if (invalidation === 'presence') await f.control.viewers.pollFaceAuth();
      await unlock();
      assert.equal(f.gallery().templates.length, 4, invalidation);
    }
  });
}

test('learning save failures are logged with an error id and never fail either unlock path', async (t) => {
  const f = await enrolledFixture(t);
  const records: any[] = [];
  configureLog({ write: (line) => records.push(JSON.parse(line)) });
  for (const matched of [false, true]) {
    await f.verify();
    f.endpoint.faceFields = { learn: learnedVector };
    f.endpoint.faceStatus = matched ? 'matched' : 'pending';
    if (!matched) await f.control.viewers.pollFaceAuth();
    const mock = t.mock.method(f.store.security, 'saveSecurity', () => {
      throw new Error('disk failed');
    });
    if (matched) await f.control.viewers.pollFaceAuth();
    else await f.request('auth.verify', { method: 'password', secret: password });
    mock.mock.restore();
    assert.equal((await f.request('auth.get')).locked, false);
    assert.equal(f.gallery().templates.length, 3);
  }
  assert.equal(
    records.filter(
      (record) => record.ev === 'security.save_face_learning_failed' && /^c-/.test(record.errorId),
    ).length,
    2,
  );
});

test('malformed faceStatus shapes fail before learning or enrollment can commit', async (t) => {
  const f = await enrolledFixture(t);
  for (const fields of [
    { template },
    { templates },
    { learn: Array(128).fill(0) },
    { learn: template.map((n) => n * 1.002) },
    { learn: [NaN, ...Array(127).fill(0)] },
    { learn: template, progress: 0.5 },
    { learn: template, hint: 'no_face' },
    { learn: template, unknown: true },
    { challengeId: 'other', learn: template },
  ]) {
    f.clock.advance(61000);
    await f.verify();
    f.endpoint.faceStatus = 'matched';
    f.endpoint.faceFields = fields;
    await f.control.viewers.pollFaceAuth();
    const state = await f.request('auth.get');
    assert.equal(state.locked, true);
    assert.equal(state.face.status, 'failed');
    assert.equal(f.gallery().templates.length, 3);
  }
  for (const fields of [
    { status: 'pending' },
    { status: 'pending', progress: -0.1 },
    { status: 'pending', progress: NaN },
    { status: 'pending', progress: 0.5, hint: 'unknown' },
    { status: 'enrolled', templates: templates.slice(0, 2) },
    { status: 'enrolled', templates: [...templates, ...templates] },
    { status: 'enrolled', templates, learn: template },
    { status: 'enrolled', templates, progress: 1 },
    { status: 'enrolled', templates: [template, template, Array(128).fill(0)] },
  ])
    assert.throws(() => readFaceStatus({ challengeId: 'id', ...fields }, 'enroll', 'id'));
  assert.throws(() =>
    readFaceStatus({ challengeId: 'id', status: 'matched', learn: template }, 'presence', 'id'),
  );
});
