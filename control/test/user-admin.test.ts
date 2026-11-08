import { accountsFor, registerUser, requestViewer, testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/application';
import { ControlDatabase } from '../server/persistence/database';
import type { EndpointLink } from '../server/endpoint/link';
import { importEvent, devicePublic, deviceKeyId, pairEvent } from './session-import-fixture';

const password = 'password123';

async function stack() {
  const store = new ControlDatabase(':memory:');
  const requests: { method: string; args: any }[] = [];
  const endpoint = {
    request: async (method: string, _tenant: string, args: any) => {
      requests.push({ method, args });
      return method === 'session.snapshot' ? { running: false, views: [] } : {};
    },
  } as unknown as EndpointLink;
  const control = createApplication(store, testGateway(endpoint));
  const admin = await registerUser(store, 'administrator', password);
  const revoked: string[] = [];
  const attach = async (account: { tenantId: string; token: string }, lease = account.tenantId) =>
    control.viewers.attachViewer(
      account.tenantId,
      lease,
      (reason) => revoked.push(account.tenantId + ':' + reason),
      { identity: account.token, valid: () => true },
      true,
    );
  await attach(admin);
  const call = (method: string, params: Record<string, unknown> = {}) =>
    requestViewer(control, admin.tenantId, admin.tenantId, method, params);
  return {
    store,
    control,
    admin,
    requests,
    revoked,
    attach,
    call,
    async close() {
      await control.close();
      store.db.close();
    },
  };
}

test('setup creates only the first account, as administrator, and then closes', async () => {
  const store = new ControlDatabase(':memory:');
  try {
    assert.deepEqual(accountsFor(store).setupStatus(), { setupRequired: true });
    const results = await Promise.allSettled([
      accountsFor(store).setup('first-user', password),
      accountsFor(store).setup('second-user', password),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM users').get() as any).n, 1n);
    const winner = (results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<any>)
      .value;
    assert.equal(winner.user.isAdmin, true);
    assert.ok(store.accounts.byUsername(winner.user.username)!.lastLoginAt);
    assert.deepEqual(accountsFor(store).setupStatus(), { setupRequired: false });
    await assert.rejects(accountsFor(store).setup('late-user', password), { code: 'forbidden' });
    for (const table of ['registration_policy'])
      assert.equal(store.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table), undefined);
  } finally {
    store.db.close();
  }
});

test('admin methods check the server role, reject scoped params and need the current lease', async () => {
  const h = await stack();
  try {
    await h.call('admin.createUser', { username: 'ordinary', password });
    const user = await accountsFor(h.store).login('ordinary', password);
    assert.equal(user.user.isAdmin, false);
    await h.attach(user);
    for (const method of [
      'admin.overview',
      'admin.users',
      'admin.createUser',
      'admin.deleteUser',
      'admin.storage',
    ])
      await assert.rejects(
        requestViewer(h.control, user.tenantId, user.tenantId, method, {
          username: 'administrator',
          password,
        }),
        { code: 'forbidden' },
      );
    await assert.rejects(requestViewer(h.control, h.admin.tenantId, 'stale', 'admin.users', {}), {
      code: 'conflict',
    });
    await assert.rejects(h.call('admin.users', { tenant: user.tenantId }), { code: 'invalid_request' });
    await assert.rejects(h.call('admin.createUser', { username: 'Ordinary', password }), {
      code: 'conflict',
    });
    await assert.rejects(h.call('admin.createUser', { username: 'x', password }), {
      code: 'invalid_request',
    });
    const users = await h.call('admin.users');
    assert.deepEqual(
      users.map((entry: any) => [entry.username, entry.isAdmin, entry.online, entry.session.state]),
      [
        ['administrator', true, true, 'active'],
        ['ordinary', false, true, 'active'],
      ],
    );
    const overview = await h.call('admin.overview');
    assert.deepEqual(overview.users, { total: 2, online: 2, disabled: 0 });
    assert.equal(overview.nodes.ready, 1);
  } finally {
    await h.close();
  }
});

test('password reset, sign-out and disabling revoke every login of that user only', async () => {
  const h = await stack();
  try {
    await h.call('admin.createUser', { username: 'ordinary', password });
    const first = await accountsFor(h.store).login('ordinary', password);
    const id = h.store.accounts.byUsername('ordinary')!.id;
    const second = { token: h.store.accounts.issueToken(id) };
    await h.attach(first);
    await h.call('admin.resetPassword', { username: 'ordinary', password: 'replacement-secret' });
    assert.deepEqual(h.revoked, [first.tenantId + ':logout']);
    for (const token of [first.token, second.token])
      assert.equal(h.store.accounts.identity(token), undefined);
    await assert.rejects(accountsFor(h.store).login('ordinary', password), { code: 'unauthenticated' });
    await accountsFor(h.store).login('ordinary', 'replacement-secret');
    const third = { token: h.store.accounts.issueToken(id) };
    assert.ok(h.store.accounts.identity(h.admin.token));

    await h.call('admin.signOut', { username: 'ordinary' });
    assert.equal(h.store.accounts.identity(third.token), undefined);

    const fourth = { token: h.store.accounts.issueToken(id) };
    await h.call('admin.setDisabled', { username: 'ordinary', disabled: true });
    assert.equal(h.store.accounts.identity(fourth.token), undefined);
    await assert.rejects(accountsFor(h.store).login('ordinary', 'replacement-secret'), {
      code: 'forbidden',
      message: '账户已停用',
    });
    assert.equal((await h.call('admin.users'))[1].disabled, true);
    await h.call('admin.setDisabled', { username: 'ordinary', disabled: false });
    await accountsFor(h.store).login('ordinary', 'replacement-secret');

    for (const method of ['admin.resetPassword', 'admin.signOut', 'admin.setDisabled', 'admin.deleteUser'])
      await assert.rejects(h.call(method, { username: 'administrator', password, disabled: true }), {
        code: 'forbidden',
      });
    await assert.rejects(h.call('admin.signOut', { username: 'missing' }), { code: 'not_found' });
  } finally {
    await h.close();
  }
});

test('clearing second factors removes PIN and face and disables face verification', async () => {
  const h = await stack();
  try {
    await h.call('admin.createUser', { username: 'ordinary', password });
    const id = h.store.accounts.byUsername('ordinary')!.id;
    const record = h.store.security.security(id);
    h.store.security.saveSecurity(id, {
      settings: { ...record.settings, faceEnabled: true },
      pin: { salt: 'salt', hash: 'hash' },
      face: { sealed: 'sealed', modelVersion: 'model' },
    });
    assert.deepEqual((await h.call('admin.users'))[1].secondFactors, { pin: true, face: true });
    await h.call('admin.clearSecondFactors', { username: 'ordinary' });
    const cleared = h.store.security.security(id);
    assert.equal(cleared.pin, undefined);
    assert.equal(cleared.face, undefined);
    assert.equal(cleared.settings.faceEnabled, false);
  } finally {
    await h.close();
  }
});

test('transferring the administrator role demotes the current administrator', async () => {
  const h = await stack();
  try {
    await h.call('admin.createUser', { username: 'successor', password });
    const successor = await accountsFor(h.store).login('successor', password);
    await h.attach(successor);
    await h.call('admin.transferAdmin', { username: 'successor' });
    assert.equal(h.control.viewers.productState(h.admin.tenantId).user.isAdmin, false);
    assert.equal(h.control.viewers.productState(successor.tenantId).user.isAdmin, true);
    await assert.rejects(h.call('admin.users'), { code: 'forbidden' });
    assert.equal(
      (await requestViewer(h.control, successor.tenantId, successor.tenantId, 'admin.users', {})).length,
      2,
    );
  } finally {
    await h.close();
  }
});

test('reset browser data refuses a running Session, then clears clipboard and purges once hibernated', async () => {
  const h = await stack();
  try {
    await h.call('admin.createUser', { username: 'reset-user', password });
    const user = h.store.accounts.byUsername('reset-user')!;
    const placement = h.control.endpoint.placement.resolve(user.tenant);
    h.store.clipboards.record(user.id, { text: 'private clipboard', html: '<p>private</p>' });
    h.store.clipboards.record(user.id, { text: 'latest clipboard', html: '' });
    await assert.rejects(h.call('admin.resetSession', { username: user.username }), /需先休眠/);
    assert.equal(h.store.clipboards.latest(user.id)?.text, 'latest clipboard');
    assert.equal(h.control.endpoint.placement.peek(user.tenant)?.sessionId, placement.sessionId);
    placement.state = 'hibernated';
    await h.call('admin.resetSession', { username: user.username });
    assert.equal(h.store.clipboards.latest(user.id), undefined);
    assert.equal(h.control.endpoint.placement.peek(user.tenant), undefined);
    await h.control.sessionPurge.flush();
    assert.ok(
      h.requests.some(
        (request) => request.method === 'session.delete' && request.args.sessionId === placement.sessionId,
      ),
    );
  } finally {
    await h.close();
  }
});

test('reset browser data clears clipboard without starting an absent or hibernated Session', async () => {
  const h = await stack();
  try {
    for (const username of ['absent-user', 'hibernated-user']) {
      await h.call('admin.createUser', { username, password });
      const user = h.store.accounts.byUsername(username)!;
      h.store.clipboards.record(user.id, { text: 'private clipboard', html: '' });
      if (username === 'hibernated-user')
        h.control.endpoint.placement.resolve(user.tenant).state = 'hibernated';
      const before = h.requests.length;
      await h.call('admin.resetSession', { username });
      assert.equal(h.store.clipboards.latest(user.id), undefined);
      assert.equal(
        h.requests.slice(before).some((request) => request.method === 'session.ensure'),
        false,
      );
    }
  } finally {
    await h.close();
  }
});

test('deleting a user removes every row of its tenant and queues node data deletion', async () => {
  const h = await stack();
  try {
    await h.call('admin.createUser', { username: 'leaving', password });
    const leaving = await accountsFor(h.store).login('leaving', password);
    await h.attach(leaving);
    const user = h.store.accounts.byUsername('leaving')!;
    h.store.clipboards.record(user.id, { text: 'private clipboard', html: '<p>private</p>' });
    h.store.sessionImports.openPairing(user.tenant, pairEvent().code, Date.now());
    h.store.sessionImports.addDevice(deviceKeyId, user.tenant, devicePublic, 'phone', Date.now());
    h.store.sessionImports.incoming(user.tenant, deviceKeyId, devicePublic, 'phone', pairEvent(), Date.now());
    h.store.sessionImports.reply(
      user.tenant,
      deviceKeyId,
      { type: 'paired', ref: 1, username: user.username },
      Date.now(),
    );
    h.store.sessionImports.saveImport(user.tenant, deviceKeyId, importEvent(), Date.now(), null);
    const placement = h.control.endpoint.placement.resolve(leaving.tenantId);
    h.store.db
      .prepare('INSERT INTO user_security VALUES (?,?,?,?,?,?)')
      .run(user.id, '{}', null, null, null, null);
    h.store.db.prepare('INSERT INTO file_library VALUES (?,?)').run(leaving.tenantId, '{"entries":[]}');
    h.store.db
      .prepare('INSERT INTO objects VALUES (?,?,?,?,?,?,?)')
      .run(leaving.tenantId, 'a'.repeat(64), 10, 50, 'b'.repeat(64), 0, null);
    h.store.db
      .prepare('INSERT INTO object_replicas VALUES (?,?,?)')
      .run(leaving.tenantId, 'a'.repeat(64), 'fixture');
    const users = await h.call('admin.deleteUser', { username: 'leaving' });
    assert.deepEqual(
      users.map((entry: any) => entry.username),
      ['administrator'],
    );
    assert.ok(h.revoked.includes(leaving.tenantId + ':logout'));
    assert.equal(h.control.sessionImporter.outbox.status().pending, 2);
    assert.equal(h.store.accounts.identity(leaving.token), undefined);
    const tables = h.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    for (const { name } of tables) {
      const columns = (h.store.db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(
        (column) => column.name,
      );
      for (const [column, value] of [
        ['tenant', leaving.tenantId],
        ['user_id', user.id],
        ['id', user.id],
      ])
        if (columns.includes(column) && name !== 'object_inventory_orphans')
          assert.equal(
            h.store.db.prepare(`SELECT 1 FROM ${name} WHERE ${column}=?`).get(value),
            undefined,
            name,
          );
    }
    await h.control.objects.tick();
    assert.ok(
      h.requests.some(
        (request) => request.method === 'object.delete' && request.args.ids[0] === 'a'.repeat(64),
      ),
    );
    assert.equal(
      h.store.db.prepare('SELECT 1 FROM object_inventory_orphans WHERE tenant=?').get(leaving.tenantId),
      undefined,
    );
    await h.control.sessionPurge.flush();
    assert.ok(
      h.requests.some(
        (request) => request.method === 'session.delete' && request.args.sessionId === placement.sessionId,
      ),
    );
    assert.equal(h.control.sessionPurge.pending(), 0);
    await assert.rejects(accountsFor(h.store).login('leaving', password), { code: 'unauthenticated' });
  } finally {
    await h.close();
  }
});
