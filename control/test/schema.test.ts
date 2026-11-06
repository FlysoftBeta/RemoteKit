import { accountsFor, registerUser } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ControlDatabase } from '../server/persistence/database';

test('fresh schema is version 1 with account state and no registration credential', () => {
  const store = new ControlDatabase(':memory:');
  try {
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 1n }]);
    const tables = new Set(
      (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const name of ['users', 'auth_tokens', 'workspaces', 'file_library', 'session_deletions'])
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

test('databases of any other schema are rejected rather than migrated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-schema-other-'));
  try {
    for (const [name, setup] of [
      ['unversioned', 'CREATE TABLE users (id TEXT)'],
      ['older', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (0)'],
      ['newer', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (2)'],
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
