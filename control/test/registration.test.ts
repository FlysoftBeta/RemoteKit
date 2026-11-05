import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../server/store';
import { Control } from '../server/control';
import type { Endpoint } from '../server/endpoint';

const password = 'password123',
  credential = 'registration-secret';

test('first formal registration is the only administrator under concurrency, diagnostic users do not count', async () => {
  const store = new Store(':memory:');
  try {
    const diagnostic = store.session();
    assert.equal(store.identity(diagnostic.token)?.user.isAdmin, false);
    assert.deepEqual(store.registrationStatus(), {
      hasAdmin: false,
      credentialRequired: false,
      registrationOpen: true,
    });
    const results = await Promise.allSettled([
      store.register('first-user', password),
      store.register('second-user', password),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM users WHERE is_admin=1').get() as any).n, 1n);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<Store['register']>>
    >;
    assert.equal(winner.value.user.isAdmin, true);
    assert.equal(store.identity(winner.value.token)?.user.isAdmin, true);
    assert.equal((await store.login(winner.value.user.username, password)).user.isAdmin, true);
    assert.deepEqual(store.registrationStatus(), {
      hasAdmin: true,
      credentialRequired: true,
      registrationOpen: false,
    });
    await assert.rejects(store.register('blocked', password, credential), /尚未配置/);
  } finally {
    store.db.close();
  }
});

test('registration credential persists hashed, rotates independently of account passwords, and never enters public state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rk-registration-')),
    path = join(dir, 'control.db');
  let store = new Store(path);
  try {
    const admin = await store.register('administrator', password);
    for (const value of ['', 'short', 'a'.repeat(257), null])
      await assert.rejects(store.setRegistrationCredential(admin.tenantId, value), /8–256/);
    assert.deepEqual(await store.setRegistrationCredential(admin.tenantId, credential), {
      registrationCredentialConfigured: true,
    });
    await assert.rejects(store.register('missing', password), /8–256/);
    await assert.rejects(store.register('wrong', password, 'incorrect-secret'), /口令错误/);
    const user = await store.register('ordinary', password, credential);
    assert.equal(user.user.isAdmin, false);
    await assert.rejects(store.setRegistrationCredential(user.tenantId, 'unauthorized-secret'), /管理员/);
    const stored = store.db.prepare('SELECT * FROM registration_policy').get() as any;
    assert.notEqual(stored.credential_hash, credential);
    assert.equal(stored.credential_hash.length, 128);
    assert.ok(stored.salt);
    const publicData = JSON.stringify([
      store.registrationStatus(),
      store.adminStatus(),
      store.identity(admin.token),
      user,
      store.userForTenant(admin.tenantId),
    ]);
    for (const secret of [credential, stored.salt, stored.credential_hash])
      assert.equal(publicData.includes(secret), false);
    await store.setRegistrationCredential(admin.tenantId, 'rotated-secret');
    await assert.rejects(store.register('old-secret', password, credential), /口令错误/);
    store.db.close();
    store = new Store(path);
    assert.equal(store.identity(admin.token)?.user.isAdmin, true);
    assert.equal((await store.login('ordinary', password)).user.isAdmin, false);
    assert.equal((await store.register('new-secret', password, 'rotated-secret')).user.isAdmin, false);
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('upgrade appoints earliest formal row, skips legacy rows, and reopens idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rk-admin-upgrade-')),
    path = join(dir, 'control.db');
  const old = new Database(path);
  old.exec(
    'CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,tenant TEXT NOT NULL UNIQUE,salt TEXT,password_hash TEXT,legacy INTEGER NOT NULL DEFAULT 0)',
  );
  for (const [id, legacy] of [
    ['diagnostic', 1],
    ['earliest', 0],
    ['later', 0],
  ] as const)
    old.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, id, id, null, null, legacy);
  old.close();
  let store = new Store(path);
  try {
    assert.equal(store.userForTenant('diagnostic')?.isAdmin, false);
    assert.equal(store.userForTenant('earliest')?.isAdmin, true);
    assert.equal(store.userForTenant('later')?.isAdmin, false);
    store.db.close();
    store = new Store(path);
    assert.equal(store.userForTenant('earliest')?.isAdmin, true);
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('registration revalidates policy after asynchronous password hashing', async () => {
  const store = new Store(':memory:');
  try {
    const admin = await store.register('administrator', password);
    await store.setRegistrationCredential(admin.tenantId, credential);
    const pending = store.register('stale-policy', password, credential);
    // A committed policy rotation while both scrypt operations are still pending.
    store.db.prepare('UPDATE registration_policy SET salt=? WHERE id=1').run('replaced-policy-salt');
    await assert.rejects(pending, /策略已更新/);
    assert.equal(store.db.prepare('SELECT id FROM users WHERE username=?').get('stale-policy'), undefined);
  } finally {
    store.db.close();
  }
});

test('admin methods check server role, scoped params, current lease and post-hash authentication', async () => {
  const store = new Store(':memory:'),
    endpoint = { request: async () => ({ running: false, views: [] }) } as unknown as Endpoint,
    control = new Control(store, endpoint);
  try {
    const admin = await store.register('administrator', password);
    await store.setRegistrationCredential(admin.tenantId, credential);
    const user = await store.register('ordinary', password, credential);
    let valid = true;
    await control.attachViewer(admin.tenantId, 'admin-lease', () => {}, {
      identity: 'admin-token',
      valid: () => valid,
    });
    await control.attachViewer(user.tenantId, 'user-lease', () => {});
    assert.equal(control.productState(admin.tenantId).user.isAdmin, true);
    assert.equal(control.productState(user.tenantId).user.isAdmin, false);
    for (const method of ['admin.get', 'admin.setRegistrationCredential'])
      await assert.rejects(
        control.viewerRequest(user.tenantId, 'user-lease', method, {
          serverCredential: 'unauthorized-secret',
          isAdmin: true,
        }),
        (error: any) => error.status === 403,
      );
    await assert.rejects(
      control.viewerRequest(admin.tenantId, 'stale', 'admin.get', {}),
      (error: any) => error.status === 409,
    );
    await assert.rejects(
      control.viewerRequest(admin.tenantId, 'admin-lease', 'admin.get', { tenant: user.tenantId }),
      (error: any) => error.status === 400,
    );
    assert.deepEqual(await control.viewerRequest(admin.tenantId, 'admin-lease', 'admin.get', {}), {
      registrationCredentialConfigured: true,
    });
    const pending = control.viewerRequest(admin.tenantId, 'admin-lease', 'admin.setRegistrationCredential', {
      serverCredential: 'expired-lease-secret',
    });
    valid = false;
    await assert.rejects(pending, (error: any) => error.status === 401);
    assert.equal((await store.register('still-original', password, credential)).user.isAdmin, false);
  } finally {
    store.db.close();
  }
});
