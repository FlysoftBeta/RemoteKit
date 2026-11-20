import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminResourceStore } from '../client/app/admin/resource-store';
import { projectUsers, type UserMethod } from '../client/app/admin/user-operations';
import type { AdminUser } from '../shared/admin';
import { RemoteKitError } from '../shared/errors';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const user: AdminUser = {
  username: 'target',
  isAdmin: false,
  disabled: false,
  online: true,
  lastLoginAt: 1,
  session: {
    state: 'running',
    nodeId: 'alpha',
    boundNodeId: 'alpha',
    dataState: 'dirty',
    nodeOffline: false,
    checkpointAt: 1,
  },
  secondFactors: { pin: true, face: true },
  storage: { bytes: 50, quotaBytes: null },
};

test('admin overlays apply immediately, survive polling, and reconcile without losing later edits', async () => {
  let server = [user];
  const store = new AdminResourceStore(async () => server);
  await store.refresh();
  const first = deferred<AdminUser[]>();
  const second = deferred<AdminUser[]>();
  let calls = 0;
  const disable = store.mutate(
    (users) => projectUsers(users, 'admin.setDisabled', { username: 'target', disabled: true }, 'self'),
    () => {
      calls++;
      return first.promise;
    },
  );
  const factors = store.mutate(
    (users) => projectUsers(users, 'admin.clearSecondFactors', { username: 'target' }, 'self'),
    () => {
      calls++;
      return second.promise;
    },
  );
  assert.equal(store.getSnapshot().data![0].disabled, true);
  assert.deepEqual(store.getSnapshot().data![0].secondFactors, { pin: false, face: false });
  await store.refresh();
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().data![0].online, false);
  server = [{ ...user, disabled: true, online: false }];
  first.resolve(server);
  await disable;
  assert.deepEqual(store.getSnapshot().data![0].secondFactors, { pin: false, face: false });
  await flush();
  assert.equal(calls, 2);
  server = [{ ...server[0], secondFactors: { pin: false, face: false } }];
  second.resolve(server);
  await factors;
  assert.deepEqual(store.getSnapshot().data, server);
  assert.equal(user.disabled, false);
});

test('admin rollback reloads partial server effects and keeps the coded failure visible', async () => {
  let server = [user];
  const store = new AdminResourceStore(async () => server);
  await store.refresh();
  const reply = deferred<AdminUser[]>();
  const result = store.mutate(
    (users) => users.filter((item) => item.username !== user.username),
    () => reply.promise,
  );
  assert.deepEqual(store.getSnapshot().data, []);
  await flush();
  server = [{ ...user, online: false, disabled: true }];
  reply.reject(new RemoteKitError('forbidden', 'irrelevant message'));
  await result;
  assert.deepEqual(store.getSnapshot().data, server);
  assert.equal(store.getSnapshot().error?.code, 'forbidden');
  await store.refresh();
  assert.equal(store.getSnapshot().error?.code, 'forbidden');
});

test('a read started before an admin mutation cannot undo its accepted result', async () => {
  let load = async () => [user];
  const store = new AdminResourceStore(() => load());
  await store.refresh();
  const stale = deferred<AdminUser[]>();
  load = () => stale.promise;
  const read = store.refresh();
  await store.mutate(
    () => [],
    async () => [],
  );
  stale.resolve([user]);
  await read;
  assert.deepEqual(store.getSnapshot().data, []);
});

test('admin projections cover account, factors, session, role, creation and deletion outcomes', () => {
  const project = (method: UserMethod, params: Record<string, unknown> = {}) =>
    projectUsers([user], method, { username: user.username, ...params }, 'self');
  assert.equal(project('admin.signOut')[0].online, false);
  assert.equal(project('admin.resetPassword')[0].online, false);
  assert.equal(
    projectUsers([user], 'admin.resetPassword', { username: user.username }, user.username)[0].online,
    true,
  );
  assert.equal(project('admin.setDisabled', { disabled: false })[0].disabled, false);
  assert.deepEqual(project('admin.clearSecondFactors')[0].secondFactors, { pin: false, face: false });
  assert.equal(project('admin.stop')[0].session.state, 'stopped');
  assert.deepEqual(project('admin.resetSession')[0].session, { state: 'none', boundNodeId: 'alpha' });
  const moved = project('admin.transfer', { nodeId: 'beta', bind: true })[0].session;
  assert.equal(moved.boundNodeId, 'beta');
  assert(moved.state !== 'none');
  assert.equal(moved.nodeId, 'beta');
  const automatic = project('admin.transfer', { bind: false })[0].session;
  assert(automatic.state !== 'none');
  assert.equal(automatic.nodeId, 'alpha');
  assert.equal(automatic.boundNodeId, null);
  assert.equal(project('admin.transferAdmin')[0].isAdmin, true);
  const roles = projectUsers(
    [{ ...user, username: 'self', isAdmin: true }, user],
    'admin.transferAdmin',
    { username: user.username },
    'self',
  );
  assert.deepEqual(
    roles.map((item) => item.isAdmin),
    [false, true],
  );
  assert.deepEqual(project('admin.deleteUser'), []);
  const created = project('admin.createUser', { username: 'new-user' });
  assert.equal(created.length, 2);
  assert.equal(created[1].username, 'new-user');
  assert.equal(created[1].online, false);
});

test('admin list insert/edit/delete and settings overlays reconcile server-only fields', async () => {
  type Item = { id: string; title: string; reads?: number };
  const store = new AdminResourceStore<Item[]>(async () => [{ id: 'old', title: 'Old', reads: 2 }]);
  await store.refresh();
  const reply = deferred<Item[]>();
  const pending = store.mutate(
    (items) => [{ id: 'new', title: 'New' }, ...items.filter((item) => item.id !== 'old')],
    () => reply.promise,
  );
  assert.deepEqual(store.getSnapshot().data, [{ id: 'new', title: 'New' }]);
  reply.resolve([{ id: 'new', title: 'New', reads: 5 }]);
  await pending;
  assert.equal(store.getSnapshot().data![0].reads, 5);
  const settings = new AdminResourceStore(async () => ({ days: 30 }));
  await settings.refresh();
  const settingReply = deferred<{ days: number }>();
  const save = settings.mutate(
    () => ({ days: 7 }),
    () => settingReply.promise,
  );
  assert.equal(settings.getSnapshot().data?.days, 7);
  settingReply.resolve({ days: 7 });
  await save;
});

test('admin recovery rolls back while waiting and reapplies only the retry attempt', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const store = new AdminResourceStore(async () => [user]);
  await store.refresh();
  let attempts = 0;
  const reply = deferred<AdminUser[]>();
  const result = store.mutate(
    () => [],
    async () => {
      if (++attempts === 1) throw new RemoteKitError('unavailable', 'any text');
      return reply.promise;
    },
    { retry: true, identity: 'delete' },
  );
  assert.deepEqual(store.getSnapshot().data, []);
  await flush();
  assert.deepEqual(store.getSnapshot().data, [user]);
  assert.equal(store.getSnapshot().error?.code, 'unavailable');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(attempts, 2);
  assert.deepEqual(store.getSnapshot().data, []);
  reply.resolve([]);
  await result;
  assert.equal(store.getSnapshot().error, undefined);
});
