import { accountsFor, registerUser } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ControlDatabase } from '../server/persistence/database';

test('fresh schema is version 5 with account and session import state', () => {
  const store = new ControlDatabase(':memory:');
  try {
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 5n }]);
    const tables = new Set(
      (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const name of [
      'users',
      'auth_tokens',
      'workspaces',
      'file_library',
      'session_deletions',
      'session_imports',
      'session_import_keys',
      'session_import_pairing',
      'session_import_devices',
      'session_import_events',
    ])
      assert.ok(tables.has(name), name);
    assert.equal(tables.has('registration_policy'), false);
    const columns = (store.db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    for (const name of ['last_login_at', 'disabled_at']) assert.ok(columns.includes(name), name);
  } finally {
    store.db.close();
  }
});

test('reopening keeps accounts, workspace and the view allocator', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-schema-'));
  const path = join(directory, 'control.db');
  let store = new ControlDatabase(path);
  try {
    const account = await registerUser(store, 'schema-user', 'schema-password123');
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
    store.db.close();
    store = new ControlDatabase(path);
    assert.equal(store.accounts.identity(account.token)?.user.id, account.user.id);
    assert.equal(store.workspaces.workspace(account.tenantId).tabs[0].webviewId, firstView);
    assert.ok(BigInt(store.workspaces.viewId()) > BigInt(firstView));
    assert.equal(
      (await accountsFor(store).login('schema-user', 'schema-password123')).user.id,
      account.user.id,
    );
  } finally {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a version 4 database migrates the display-scale override to the UI scale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-schema-v4-'));
  const path = join(directory, 'control.db');
  try {
    let store = new ControlDatabase(path);
    const account = await registerUser(store, 'v4-user', 'v4-password1234');
    const {
      uiScale: _,
      topDeadZone: __,
      ...settings
    } = store.workspaces.workspace(account.tenantId).settings;
    store.db.exec(`DROP TABLE schema_version;
      CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=4));
      INSERT INTO schema_version(version) VALUES (4);`);
    store.db
      .prepare('INSERT OR REPLACE INTO user_settings VALUES (?,?)')
      .run(account.tenantId, JSON.stringify({ ...settings, clientScaleOverride: 1.5, showStats: true }));
    store.db.close();
    store = new ControlDatabase(path);
    try {
      assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 5n }]);
      const migrated = store.workspaces.workspace(account.tenantId).settings;
      assert.equal('clientScaleOverride' in migrated, false);
      assert.equal(migrated.uiScale, 1);
      assert.equal(migrated.topDeadZone, 'off');
      assert.equal(migrated.showStats, true);
      assert.throws(() => store.db.exec('UPDATE schema_version SET version=4'));
    } finally {
      store.db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('databases without a migration path are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-schema-other-'));
  try {
    for (const [name, setup] of [
      ['unversioned', 'CREATE TABLE users (id TEXT)'],
      ['v3', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (3)'],
      ['older', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (1)'],
      ['newer', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (6)'],
      [
        'ambiguous',
        'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (1),(1)',
      ],
    ]) {
      const path = join(directory, name + '.db');
      const db = new Database(path);
      db.exec(setup);
      db.close();
      assert.throws(() => new ControlDatabase(path), /Unsupported database schema/, name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
