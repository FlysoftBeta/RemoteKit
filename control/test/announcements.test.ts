import { randomUUID } from 'node:crypto';
import { accountsFor, registerUser, requestViewer, testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/application';
import { ControlDatabase } from '../server/persistence/database';
import type { EndpointLink } from '../server/endpoint/link';

const password = 'password123';

async function stack() {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const endpoint = {
    request: async () => ({}),
  } as unknown as EndpointLink;
  const control = createApplication(store, testGateway(endpoint));
  const admin = await registerUser(store, 'administrator', password);
  const attach = (account: { tenantId: string; token: string }) =>
    control.viewers.attachViewer(
      account.tenantId,
      account.tenantId,
      () => {},
      { identity: account.token, valid: () => true },
      true,
    );
  await attach(admin);
  const call = (tenant: string, method: string, params: Record<string, unknown> = {}) =>
    requestViewer(control, tenant, tenant, method, params);
  await call(admin.tenantId, 'admin.createUser', { username: 'ordinary', password });
  const user = await accountsFor(store).login('ordinary', password);
  await attach(user);
  return {
    store,
    control,
    admin,
    user,
    call,
    async close() {
      await control.close();
      store.db.close();
    },
  };
}

const openAdmin = { type: 'window.open', appId: 'admin', placement: { mode: 'space' } } as const;
const adminWindows = (h: Awaited<ReturnType<typeof stack>>, tenant: string) =>
  h.store.workspaces.workspace(tenant).windows.filter((win) => win.appId === 'admin');

test('a publication identity returns the existing announcement after a lost reply', async (t) => {
  const h = await stack();
  t.after(() => h.close());
  const draft = { id: randomUUID(), title: '维护通知', body: '今晚维护' };
  const first = await h.call(h.admin.tenantId, 'admin.publishAnnouncement', draft);
  const second = await h.call(h.admin.tenantId, 'admin.publishAnnouncement', draft);
  assert.deepEqual(second, first);
  assert.equal(h.control.announcements.list().length, 1);
  await assert.rejects(
    h.call(h.admin.tenantId, 'admin.publishAnnouncement', { ...draft, body: '不同内容' }),
    { code: 'conflict' },
  );
});

test('the admin App opens only for the administrator, once, and closes when the role moves', async () => {
  const h = await stack();
  try {
    await assert.rejects(h.control.operations.productAction(h.user.tenantId, openAdmin), {
      code: 'forbidden',
    });
    assert.equal(adminWindows(h, h.user.tenantId).length, 0);
    const launcher = (tenant: string) =>
      h.control.workspace.launcher(tenant).items.some((item) => item.appId === 'admin');
    assert.equal(launcher(h.admin.tenantId), true);
    assert.equal(launcher(h.user.tenantId), false);

    await h.control.operations.productAction(h.admin.tenantId, openAdmin);
    await h.control.operations.productAction(h.admin.tenantId, openAdmin);
    assert.equal(adminWindows(h, h.admin.tenantId).length, 1);

    await h.call(h.admin.tenantId, 'admin.transferAdmin', { username: 'ordinary' });
    assert.equal(adminWindows(h, h.admin.tenantId).length, 0);
    await assert.rejects(h.control.operations.productAction(h.admin.tenantId, openAdmin), {
      code: 'forbidden',
    });
    await h.control.operations.productAction(h.user.tenantId, openAdmin);
    assert.equal(adminWindows(h, h.user.tenantId).length, 1);
  } finally {
    await h.close();
  }
});

test('announcements reach every user, track reads per publication and are admin-only to manage', async () => {
  const h = await stack();
  try {
    const announcements = (tenant: string) => h.control.viewers.productState(tenant).announcements;
    await assert.rejects(
      h.call(h.user.tenantId, 'admin.publishAnnouncement', { id: randomUUID(), title: 't', body: 'b' }),
      {
        code: 'forbidden',
      },
    );
    await assert.rejects(
      h.call(h.admin.tenantId, 'admin.publishAnnouncement', { id: randomUUID(), title: ' ', body: 'b' }),
      {
        code: 'invalid_request',
      },
    );
    await assert.rejects(
      h.call(h.admin.tenantId, 'admin.publishAnnouncement', {
        id: randomUUID(),
        title: 't',
        body: 'x'.repeat(5001),
      }),
      { code: 'limit_exceeded' },
    );

    const published = await h.call(h.admin.tenantId, 'admin.publishAnnouncement', {
      id: randomUUID(),
      title: ' 维护通知 ',
      body: '今晚\n停机一小时',
    });
    assert.equal(published.length, 1);
    const [item] = published;
    assert.deepEqual(
      { title: item.title, body: item.body, reads: item.reads, recipients: item.recipients },
      { title: '维护通知', body: '今晚\n停机一小时', reads: 1, recipients: 2 },
    );
    assert.deepEqual(
      announcements(h.user.tenantId).map((a) => [a.id, a.read]),
      [[item.id, false]],
    );

    assert.deepEqual(await h.call(h.user.tenantId, 'announcement.read', { id: item.id }), { read: true });
    assert.deepEqual(await h.call(h.user.tenantId, 'announcement.read', { id: item.id }), { read: true });
    assert.equal(announcements(h.user.tenantId)[0].read, true);
    assert.equal(announcements(h.admin.tenantId)[0].read, true);
    await assert.rejects(h.call(h.user.tenantId, 'announcement.read', { id: 'missing' }), {
      code: 'not_found',
    });

    let [edited] = await h.call(h.admin.tenantId, 'admin.updateAnnouncement', {
      id: item.id,
      title: '维护通知',
      body: '今晚停机',
      republish: false,
    });
    assert.equal(edited.reads, 2);
    assert.equal(edited.publishedAt, item.publishedAt);
    assert.equal(announcements(h.user.tenantId)[0].read, true);

    [edited] = await h.call(h.admin.tenantId, 'admin.updateAnnouncement', {
      id: item.id,
      title: '维护通知',
      body: '改到明晚',
      republish: true,
    });
    assert.equal(edited.reads, 1);
    assert.equal(announcements(h.user.tenantId)[0].read, false);
    await h.call(h.user.tenantId, 'announcement.read', { id: item.id });
    const userId = h.store.accounts.byUsername('ordinary')!.id;
    await h.call(h.user.tenantId, 'announcement.read', { id: item.id });
    await h.call(h.admin.tenantId, 'admin.deleteUser', { username: 'ordinary' });
    const reads = h.store.db
      .prepare('SELECT count(*) AS n FROM announcement_reads WHERE user_id=?')
      .get(userId) as { n: bigint };
    assert.equal(reads.n, 0n);

    assert.deepEqual(await h.call(h.admin.tenantId, 'admin.deleteAnnouncement', { id: item.id }), []);
    assert.deepEqual(announcements(h.admin.tenantId), []);
    await assert.rejects(h.call(h.admin.tenantId, 'admin.deleteAnnouncement', { id: item.id }), {
      code: 'not_found',
    });
  } finally {
    await h.close();
  }
});
