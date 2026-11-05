import { accountsFor } from './server-fixture';
import { requestViewer } from './server-fixture';
import { testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication, type DomainServices } from '../server/application';
import type { EndpointLink } from '../server/endpoint/link';

const password = 'password123',
  credential = 'registration-secret';

test('first registration is the only administrator under concurrency', async () => {
  const store = new ControlDatabase(':memory:');
  try {
    assert.deepEqual(accountsFor(store).registrationStatus(), {
      hasAdmin: false,
      credentialRequired: false,
      registrationOpen: true,
    });
    const results = await Promise.allSettled([
      accountsFor(store).register('first-user', password),
      accountsFor(store).register('second-user', password),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM users WHERE is_admin=1').get() as any).n, 1n);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<ReturnType<typeof accountsFor>['register']>>
    >;
    assert.equal(winner.value.user.isAdmin, true);
    assert.equal(store.accounts.identity(winner.value.token)?.user.isAdmin, true);
    assert.equal((await accountsFor(store).login(winner.value.user.username, password)).user.isAdmin, true);
    assert.deepEqual(accountsFor(store).registrationStatus(), {
      hasAdmin: true,
      credentialRequired: true,
      registrationOpen: false,
    });
    await assert.rejects(accountsFor(store).register('blocked', password, credential), {
      code: 'unavailable',
    });
  } finally {
    store.db.close();
  }
});

test('registration credential persists hashed, rotates independently of account passwords, and never enters public state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rk-registration-')),
    path = join(dir, 'control.db');
  let store = new ControlDatabase(path);
  try {
    const admin = await accountsFor(store).register('administrator', password);
    for (const value of ['', 'short', 'a'.repeat(257), null])
      await assert.rejects(accountsFor(store).setRegistrationCredential(admin.tenantId, value), {
        code: 'invalid_request',
      });
    assert.deepEqual(await accountsFor(store).setRegistrationCredential(admin.tenantId, credential), {
      registrationCredentialConfigured: true,
    });
    await assert.rejects(accountsFor(store).register('missing', password), { code: 'invalid_request' });
    await assert.rejects(accountsFor(store).register('wrong', password, 'incorrect-secret'), {
      code: 'forbidden',
    });
    const user = await accountsFor(store).register('ordinary', password, credential);
    assert.equal(user.user.isAdmin, false);
    await assert.rejects(accountsFor(store).setRegistrationCredential(user.tenantId, 'unauthorized-secret'), {
      code: 'forbidden',
    });
    const stored = store.db.prepare('SELECT * FROM registration_policy').get() as any;
    assert.notEqual(stored.credential_hash, credential);
    assert.equal(stored.credential_hash.length, 128);
    assert.ok(stored.salt);
    const publicData = JSON.stringify([
      accountsFor(store).registrationStatus(),
      accountsFor(store).adminStatus(),
      store.accounts.identity(admin.token),
      user,
      store.accounts.userForTenant(admin.tenantId),
    ]);
    for (const secret of [credential, stored.salt, stored.credential_hash])
      assert.equal(publicData.includes(secret), false);
    await accountsFor(store).setRegistrationCredential(admin.tenantId, 'rotated-secret');
    await assert.rejects(accountsFor(store).register('old-secret', password, credential), {
      code: 'forbidden',
    });
    store.db.close();
    store = new ControlDatabase(path);
    assert.equal(store.accounts.identity(admin.token)?.user.isAdmin, true);
    assert.equal((await accountsFor(store).login('ordinary', password)).user.isAdmin, false);
    assert.equal(
      (await accountsFor(store).register('new-secret', password, 'rotated-secret')).user.isAdmin,
      false,
    );
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('registration revalidates policy after asynchronous password hashing', async () => {
  const store = new ControlDatabase(':memory:');
  try {
    const admin = await accountsFor(store).register('administrator', password);
    await accountsFor(store).setRegistrationCredential(admin.tenantId, credential);
    const pending = accountsFor(store).register('stale-policy', password, credential);
    // A committed policy rotation while both scrypt operations are still pending.
    store.db.prepare('UPDATE registration_policy SET salt=? WHERE id=1').run('replaced-policy-salt');
    await assert.rejects(pending, { code: 'conflict' });
    assert.equal(store.db.prepare('SELECT id FROM users WHERE username=?').get('stale-policy'), undefined);
  } finally {
    store.db.close();
  }
});

test('admin methods check server role, scoped params, current lease and post-hash authentication', async () => {
  const store = new ControlDatabase(':memory:'),
    endpoint = { request: async () => ({ running: false, views: [] }) } as unknown as EndpointLink,
    control = createApplication(store, testGateway(endpoint));
  try {
    const admin = await accountsFor(store).register('administrator', password);
    await accountsFor(store).setRegistrationCredential(admin.tenantId, credential);
    const user = await accountsFor(store).register('ordinary', password, credential);
    let valid = true;
    await control.viewers.attachViewer(
      admin.tenantId,
      'admin-lease',
      () => {},
      {
        identity: 'admin-token',
        valid: () => valid,
      },
      true,
    );
    await control.viewers.attachViewer(
      user.tenantId,
      'user-lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.equal(control.viewers.productState(admin.tenantId).user.isAdmin, true);
    assert.equal(control.viewers.productState(user.tenantId).user.isAdmin, false);
    for (const method of ['admin.get', 'admin.setRegistrationCredential'])
      await assert.rejects(
        requestViewer(control, user.tenantId, 'user-lease', method, {
          serverCredential: 'unauthorized-secret',
          isAdmin: true,
        }),
        (error: any) => error.code === 'forbidden',
      );
    await assert.rejects(
      requestViewer(control, admin.tenantId, 'stale', 'admin.get', {}),
      (error: any) => error.code === 'conflict',
    );
    await assert.rejects(
      requestViewer(control, admin.tenantId, 'admin-lease', 'admin.get', { tenant: user.tenantId }),
      (error: any) => error.code === 'invalid_request',
    );
    assert.deepEqual(await requestViewer(control, admin.tenantId, 'admin-lease', 'admin.get', {}), {
      registrationCredentialConfigured: true,
    });
    const pending = requestViewer(control, admin.tenantId, 'admin-lease', 'admin.setRegistrationCredential', {
      serverCredential: 'expired-lease-secret',
    });
    valid = false;
    await assert.rejects(pending, (error: any) => error.code === 'unauthenticated');
    assert.equal(
      (await accountsFor(store).register('still-original', password, credential)).user.isAdmin,
      false,
    );
  } finally {
    await control.close();
    store.db.close();
  }
});
