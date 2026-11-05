import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';

test('fresh schema contains accounts and basket tables at version 1', () => {
  const store = new Store(':memory:');
  try {
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 1n }]);
    const tables = new Set(
      (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const name of ['users', 'auth_tokens', 'workspaces', 'file_library', 'file_library_selections'])
      assert.ok(tables.has(name));
    for (const name of ['tenants', 'sessions', 'diagnostic_devices']) assert.equal(tables.has(name), false);
    const columns = store.db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    assert.equal(
      columns.some((column) => column.name === 'legacy'),
      false,
    );
  } finally {
    store.db.close();
  }
});

test('current tables without a schema version reopen with accounts, workspace and allocator intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-current-schema-'));
  const path = join(directory, 'control.db');
  let store = new Store(path);
  try {
    const account = await store.register('schema-user', 'schema-password123');
    const firstView = store.viewId();
    const workspace = store.workspace(account.tenantId);
    workspace.windows.push({ id: 'window', activeTabId: 'tab', weight: 1 });
    workspace.activeWindowId = 'window';
    workspace.tabs.push({
      id: 'tab',
      windowId: 'window',
      webviewId: firstView,
      kind: 'remote',
      title: 'Page',
      url: 'about:blank',
    });
    store.saveWorkspace(workspace);
    store.db.exec('DROP TABLE schema_version');
    store.db.close();
    store = new Store(path);
    assert.equal(store.identity(account.token)?.user.id, account.user.id);
    assert.equal(store.userForTenant(account.tenantId)?.isAdmin, true);
    assert.equal(store.workspace(account.tenantId).tabs[0].webviewId, firstView);
    assert.ok(BigInt(store.viewId()) > BigInt(firstView));
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 1n }]);
    store.db.close();
    store = new Store(path);
    assert.equal((await store.login('schema-user', 'schema-password123')).user.id, account.user.id);
    assert.equal(
      (store.db.prepare('SELECT count(*) AS count FROM schema_version').get() as { count: bigint }).count,
      1n,
    );
  } finally {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
