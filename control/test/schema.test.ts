import { accountsFor } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlDatabase } from '../server/persistence/database';
import { createSchema } from '../server/persistence/schema';

test('fresh schema contains accounts and basket tables at version 2', () => {
  const store = new ControlDatabase(':memory:');
  try {
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 2n }]);
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
  let store = new ControlDatabase(path);
  try {
    const account = await accountsFor(store).register('schema-user', 'schema-password123');
    const firstView = store.workspaces.viewId();
    const workspace = store.workspaces.workspace(account.tenantId);
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
    store.workspaces.saveWorkspace(workspace);
    store.db.exec('DROP TABLE schema_version');
    store.db.close();
    store = new ControlDatabase(path);
    assert.equal(store.accounts.identity(account.token)?.user.id, account.user.id);
    assert.equal(store.accounts.userForTenant(account.tenantId)?.isAdmin, true);
    assert.equal(store.workspaces.workspace(account.tenantId).tabs[0].webviewId, firstView);
    assert.ok(BigInt(store.workspaces.viewId()) > BigInt(firstView));
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 2n }]);
    store.db.close();
    store = new ControlDatabase(path);
    assert.equal(
      (await accountsFor(store).login('schema-user', 'schema-password123')).user.id,
      account.user.id,
    );
    assert.equal(
      (store.db.prepare('SELECT count(*) AS count FROM schema_version').get() as { count: bigint }).count,
      1n,
    );
  } finally {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('version 1 settings migrate to version 2 with avSync off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-schema-v1-'));
  const path = join(directory, 'control.db');
  let store = new ControlDatabase(path);
  try {
    const account = await accountsFor(store).register('v1-user', 'v1-password123');
    const { avSync: _, ...settings } = store.workspaces.workspace(account.tenantId).settings;
    settings.audioChannels = { left: false, right: true };
    store.db
      .prepare('UPDATE user_settings SET data=? WHERE tenant=?')
      .run(JSON.stringify(settings), account.tenantId);
    store.db.exec(`DROP TABLE schema_version;
      CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=1));
      INSERT INTO schema_version(version) VALUES (1);`);
    store.db.close();
    store = new ControlDatabase(path);
    const loaded = store.workspaces.workspace(account.tenantId).settings;
    assert.equal(loaded.avSync, false);
    assert.deepEqual(loaded.audioChannels, { left: false, right: true });
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 2n }]);
  } finally {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('newer schema versions are rejected', () => {
  const store = new ControlDatabase(':memory:');
  try {
    store.db.exec(`DROP TABLE schema_version;
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (3);`);
    assert.throws(() => createSchema(store.db), /Unsupported database schema/);
  } finally {
    store.db.close();
  }
});
