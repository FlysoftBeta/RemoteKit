import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Control } from '../server/control';
import type { Endpoint } from '../server/endpoint';
import { Store } from '../server/store';
import type { FaceStatus } from '../shared/security';

const password = 'password123';
const template = Array.from({ length: 128 }, (_, i) => i === 0 ? 1 : 0);
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

class AuthEndpoint implements Endpoint {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  connectionId?: string;
  faceStatus: FaceStatus = 'pending';
  faceReason?: string;
  statusGate?: ReturnType<typeof defer>;
  authGate?: ReturnType<typeof defer>;
  async request(method: string, _tenant: string, params: Record<string, unknown> = {}): Promise<any> {
    this.calls.push({ method, params });
    switch (method) {
      case 'session.snapshot': return { running: true, views: [], rtc: { active: !!this.connectionId, connectionId: this.connectionId } };
      case 'session.sitePreferences': return { applied: true, accepted: true };
      case 'rtc.offer': this.connectionId = String(params.connectionId); return { sdp: 'v=0' };
      case 'rtc.close': this.connectionId = undefined; return { closed: true };
      case 'rtc.authorize':
        if (params.unlocked && this.authGate) await this.authGate.promise;
        return { applied: true, epoch: params.epoch };
      case 'auth.face.capabilities': return { available: true, modelVersion: 'test-sface' };
      case 'auth.face.begin': return { accepted: true };
      case 'auth.face.status':
        if (this.statusGate) await this.statusGate.promise;
        return { challengeId: params.challengeId, status: this.faceStatus, reason: this.faceReason, ...(this.faceStatus === 'enrolled' ? { template } : {}) };
      default: return { accepted: true };
    }
  }
}

async function fixture(t: TestContext, path = ':memory:') {
  const store = new Store(path), endpoint = new AuthEndpoint(), control = new Control(store, endpoint);
  t.after(async () => { await control.close(); store.db.close(); });
  const { tenantId: tenant, user } = await store.register('account-auth', password);
  const attach = (lease: string, unlocked = false) => control.attachViewer(tenant, lease, () => {}, { identity: lease, valid: () => true }, unlocked);
  await attach('lease', true);
  const request = (method: string, params: object = {}, lease = 'lease') => control.viewerRequest(tenant, lease, method, params);
  const offer = () => request('rtc.offer', { type: 'offer', sdp: 'v=0' });
  return { store, endpoint, control, tenant, user, attach, request, offer };
}

test('locks existing peer, rejects product actions and uploads, and resumes with fresh peer epoch', async t => {
  const f = await fixture(t), { connectionId } = await f.offer();
  const first = await f.request('auth.get');
  assert.equal(first.peerEpoch, 1);
  assert.equal(f.endpoint.calls.find(c => c.method === 'rtc.offer')?.params.authRequired, true);
  const locked = await f.request('auth.lock');
  assert.equal(locked.locked, true);
  assert.equal(locked.peerEpoch, 2);
  for (const method of ['admin.get', 'operation.status', 'files.begin', 'viewport', 'action'])
    await assert.rejects(f.request(method), { status: 423 });
  await assert.rejects(f.control.receiveFileUpload(f.tenant, 'lease', 'fake-ticket', Readable.from([])), { status: 423 });
  const op = { tenantId: f.tenant, connectionId, operationId: randomUUID(), operationGeneration: f.store.operationGeneration(f.tenant), action: { type: 'window.create' as const } };
  await f.control.handleEndpointAction({ ...op, authEpoch: 1 });
  assert.equal(f.store.workspace(f.tenant).windows.length, 0);
  assert.equal(typeof (await f.request('clock.ping')).serverTime, 'number');
  const unlocked = await f.request('auth.verify', { method: 'password', secret: password });
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.peerEpoch, 3);
  assert.equal(f.endpoint.connectionId, connectionId);
  assert.equal(f.endpoint.calls.some(c => c.method === 'rtc.close'), false);
  await f.control.handleEndpointAction({ ...op, authEpoch: 1 });
  assert.equal(f.store.workspace(f.tenant).windows.length, 0);
  await f.control.handleEndpointAction({ ...op, authEpoch: 3 });
  assert.equal(f.store.workspace(f.tenant).windows.length, 1);
  assert.equal(f.endpoint.calls.find(c => c.method === 'rtc.actionResult')?.params.authEpoch, 3);
  f.control.endpointOffline();
  assert.equal((await f.request('auth.get')).locked, true);
  assert.equal((await f.request('auth.get')).peerEpoch, 0);
  await f.control.endpointReady({ processChanged: false });
  assert.equal((await f.request('auth.get')).peerEpoch, 4);
});

test('late unlock acknowledgement cannot restore rights after a subsequent lock', async t => {
  const f = await fixture(t);
  await f.offer();
  await f.request('auth.lock');
  f.endpoint.authGate = defer();
  const pending = f.request('auth.verify', { method: 'password', secret: password });
  const rejected = assert.rejects(pending, { status: 409 });
  while (!f.endpoint.calls.some(c => c.method === 'rtc.authorize' && c.params.epoch === 3))
    await new Promise(resolve => setTimeout(resolve, 5));
  await f.request('auth.lock');
  f.endpoint.authGate.resolve();
  await rejected;
  const state = await f.request('auth.get');
  assert.equal(state.locked, true);
  assert.equal(state.peerEpoch, 4);
});

test('settings require current password, PIN is hashed and failures are limited across leases', async t => {
  const f = await fixture(t);
  const initial = await f.request('auth.get');
  assert.equal(initial.settings.lockOnIdle, true);
  assert.equal(initial.settings.idleSeconds, 300);
  assert.equal(initial.settings.lockOnHidden, true);
  await assert.rejects(f.request('auth.settings', { currentPassword: 'wrong', pin: '123456' }), { status: 403 });
  assert.equal(f.store.security(f.user.id).pin, undefined);
  await assert.rejects(f.request('auth.settings', { currentPassword: password, pin: '1234' }), { status: 400 });
  await f.request('auth.settings', { currentPassword: password, pin: '123456', settings: { lockOnHidden: false, idleSeconds: 60 } });
  assert.notEqual(f.store.security(f.user.id).pin?.hash, '123456');
  await f.request('auth.password', { currentPassword: password, newPassword: 'changed-password' });
  await f.request('auth.lock');
  for (let i = 0; i < 6; i++) await assert.rejects(f.request('auth.verify', { method: 'pin', secret: '654321' }), { status: 403 });
  await f.attach('replacement');
  await assert.rejects(f.request('auth.verify', { method: 'pin', secret: '123456' }, 'replacement'), { status: 429 });
  await assert.rejects(f.request('auth.verify', { method: 'password', secret: password }, 'replacement'), { status: 403 });
  const state = await f.request('auth.verify', { method: 'password', secret: 'changed-password' }, 'replacement');
  assert.equal(state.locked, false);
  assert.equal(state.settings.lockOnHidden, false);
  assert.equal(state.settings.idleSeconds, 60);
});

test('face template is encrypted and late matches or enrollment results cannot commit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-auth-')), path = join(directory, 'control.db');
  const f = await fixture(t, path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await f.offer();
  await assert.rejects(f.request('auth.face.begin', { purpose: 'enroll', currentPassword: 'wrong' }), { status: 403 });
  const first = await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: password });
  assert.equal(first.face.status, 'pending');
  const expire = () => (f.control as any).viewers.get(f.tenant).security.challenge.expires = Date.now() - 1;
  expire();
  f.endpoint.faceStatus = 'enrolled';
  await f.control.pollFaceAuth();
  assert.equal((await f.request('auth.get')).face.status, 'expired');
  assert.equal(f.store.security(f.user.id).face, undefined);
  await f.request('auth.face.begin', { purpose: 'enroll', currentPassword: password });
  await f.control.pollFaceAuth();
  const stored = f.store.security(f.user.id).face!;
  assert.ok(stored && !stored.sealed.includes(JSON.stringify(template)));
  assert.equal(readFileSync(path + '.face-key').length, 32);
  const reopened = new Store(path);
  try { assert.deepEqual(reopened.faceVault.open(f.user.id, stored.sealed, stored.modelVersion), template); }
  finally { reopened.db.close(); }
  await f.request('auth.lock');
  const verify = await f.request('auth.face.begin', { purpose: 'verify' });
  assert.equal(JSON.stringify(verify).includes(JSON.stringify(template)), false);
  const begin = f.endpoint.calls.filter(c => c.method === 'auth.face.begin').slice(-1)[0];
  assert.deepEqual(begin?.params.template, template);
  assert.equal(begin?.params.epoch, verify.peerEpoch);
  f.endpoint.faceStatus = 'matched';
  f.endpoint.statusGate = defer();
  const status = f.control.pollFaceAuth();
  expire();
  f.endpoint.statusGate.resolve();
  await status;
  assert.equal((await f.request('auth.get')).locked, true);
  assert.equal((await f.request('auth.get')).face.status, 'expired');
  await f.request('auth.face.begin', { purpose: 'presence' });
  f.endpoint.faceStatus = 'absent';
  f.endpoint.faceReason = 'no-matching-face';
  await f.control.pollFaceAuth();
  const absent = await f.request('auth.get');
  assert.equal(absent.locked, true);
  assert.equal(absent.face.status, 'absent');
  assert.equal(absent.face.reason, 'no-matching-face');
  await f.request('auth.face.begin', { purpose: 'presence' });
  assert.equal((await f.request('auth.get')).face.reason, undefined);
  f.endpoint.faceReason = 'private endpoint error path';
  await f.control.pollFaceAuth();
  assert.equal((await f.request('auth.get')).face.reason, undefined);
  await f.request('auth.face.begin', { purpose: 'verify' });
  f.endpoint.faceStatus = 'matched';
  await f.control.pollFaceAuth();
  assert.equal((await f.request('auth.get')).locked, false);
});
