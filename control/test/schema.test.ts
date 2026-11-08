import { accountsFor, registerUser } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ControlDatabase } from '../server/persistence/database';

test('fresh schema includes workspace spaces, installed apps, favorites and usage', () => {
  const store = new ControlDatabase(':memory:');
  try {
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 12n }]);
    const tables = new Set(
      (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const name of [
      'users',
      'clipboards',
      'auth_tokens',
      'workspaces',
      'workspace_spaces',
      'installed_apps',
      'favorites',
      'usage_events',
      'page_previews',
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
    assert.deepEqual(
      (store.db.prepare('PRAGMA table_info(clipboards)').all() as { name: string }[]).map(
        (column) => column.name,
      ),
      ['user_id', 'revision', 'text', 'html', 'updated_at'],
    );
    const foreignKey = store.db.prepare('PRAGMA foreign_key_list(clipboards)').get() as any;
    assert.equal(foreignKey.table, 'users');
    assert.equal(foreignKey.on_delete, 'CASCADE');
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
    store.clipboards.record(account.user.id, { text: 'persisted clipboard', html: '<b>persisted</b>' });
    const firstView = store.workspaces.viewId();
    const workspace = store.workspaces.workspace(account.tenantId);
    workspace.windows.push({ id: 'window', appId: 'browser', activeTabId: 'tab', lastActiveAt: 100 });
    workspace.spaces.push({
      id: 'space',
      windowIds: ['window'],
      weights: [1],
      focusedWindowId: 'window',
      lastActiveAt: 100,
    });
    workspace.activeSpaceId = 'space';
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
    assert.deepEqual(store.clipboards.latest(account.user.id), {
      revision: '1',
      text: 'persisted clipboard',
      html: '<b>persisted</b>',
    });
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

test('databases at another schema version are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-schema-other-'));
  try {
    for (const [name, setup] of [
      ['unversioned', 'CREATE TABLE users (id TEXT)'],
      ['previous', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (11)'],
      ['older', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (1)'],
      ['newer', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (13)'],
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

test('usage merges app focus, isolates tabs, starts launcher chains and clears scopes', () => {
  const store = new ControlDatabase(':memory:');
  try {
    const items = store.workspaces.items;
    const app = { item: 'app:browser', windowId: 'window' };
    const first = items.recordUsage('tenant', app, 100000);
    assert.deepEqual(items.recordUsage('tenant', app, 110000), first);
    items.recordUsage('tenant', { item: 'file:preview', windowId: 'window' }, 110500);
    assert.deepEqual(items.recordUsage('tenant', app, 110600), first);
    const launcher = items.recordUsage('tenant', { ...app, source: 'launcher' }, 111000);
    assert.notEqual(launcher.chain, first.chain);
    const page = items.recordUsage(
      'tenant',
      { item: 'page:https://example.com', windowId: 'window', tabId: 'one', title: 'First' },
      112000,
    );
    const next = items.recordUsage(
      'tenant',
      { item: 'page:https://example.com/next', windowId: 'window', tabId: 'one', title: 'Next' },
      113000,
    );
    const otherTab = items.recordUsage(
      'tenant',
      { item: 'page:https://example.com', windowId: 'window', tabId: 'two' },
      114000,
    );
    assert.equal(page.chain, next.chain);
    assert.notEqual(page.chain, otherTab.chain);
    assert.notEqual(page.chain, launcher.chain);
    items.updateUsageTitle('tenant', 'page:https://example.com/next', 'Settled title');
    assert.equal(
      items.usage('tenant', 2000000).find((event) => event.item === 'page:https://example.com/next')!.title,
      'Settled title',
    );
    const expiredChain = items.recordUsage('tenant', { ...app, source: undefined }, 111000 + 30 * 60 * 1000);
    assert.notEqual(expiredChain.chain, launcher.chain);
    items.clearUsage('tenant', 'pages');
    assert.ok(items.usage('tenant', 2000000).every((event) => !event.item.startsWith('page:')));
    items.clearUsage('tenant', 'all');
    assert.deepEqual(items.usage('tenant', 2000000), []);
  } finally {
    store.db.close();
  }
});

test('usage retention deletes events older than ninety days and caps each tenant at twenty thousand', () => {
  const store = new ControlDatabase(':memory:');
  try {
    const now = Date.now();
    store.workspaces.items.recordUsage(
      'tenant',
      { item: 'file:old', windowId: 'files' },
      now - 91 * 24 * 60 * 60 * 1000,
    );
    const insert = store.db.prepare(
      'INSERT INTO usage_events(tenant,at,item,window_id,context,chain) VALUES (?,?,?,?,?,?)',
    );
    store.transaction(() => {
      for (let index = 0; index < 20000; index++)
        insert.run('tenant', now - 30000 + index, `file:${index}`, 'files', 'window', 'chain');
      insert.run('other', now, 'file:other', 'files', 'window', 'other-chain');
    });
    store.workspaces.items.recordUsage('tenant', { item: 'file:latest', windowId: 'files' }, now);
    const events = store.workspaces.items.usage('tenant');
    assert.equal(events.length, 20000);
    assert.equal(events[0].item, 'file:1');
    assert.equal(events[events.length - 1].item, 'file:latest');
    assert.equal(store.workspaces.items.usage('other').length, 1);
  } finally {
    store.db.close();
  }
});

test('installed app metadata survives icon updates and tenant deletion removes workspace-owned rows', async () => {
  const store = new ControlDatabase(':memory:');
  try {
    const account = await registerUser(store, 'app-user', 'app-password123');
    const workspace = store.workspaces.workspace(account.tenantId);
    workspace.apps.push({
      id: 'app',
      name: 'App',
      startUrl: 'https://example.com',
      scope: 'https://example.com/',
      display: 'standalone',
      createdAt: 1,
      updatedAt: 1,
    });
    workspace.favorites.push({ id: 'favorite', title: 'Home', url: 'https://example.com', createdAt: 1 });
    store.transaction(() => {
      store.workspaces.saveWorkspace(workspace);
      const hash = store.workspaces.items.setAppIcon(account.tenantId, 'app', Buffer.from('png'))!;
      workspace.apps[0].iconHash = hash;
      workspace.apps[0].iconUrl = `/api/apps/app/icon?h=${hash}`;
      store.workspaces.saveWorkspace(workspace);
    });
    const restored = store.workspaces.workspace(account.tenantId);
    assert.deepEqual(restored.apps, workspace.apps);
    assert.deepEqual(restored.favorites, workspace.favorites);
    assert.deepEqual(store.workspaces.items.appIcon(account.tenantId, 'app')?.png, Buffer.from('png'));
    store.workspaces.items.recordUsage(account.tenantId, { item: 'app:web:app', windowId: 'app-window' });
    store.workspaces.items.savePreview(account.tenantId, 'page:https://example.com/', Buffer.from('jpeg'), 1);
    store.workspaces.deleteTenant(account.tenantId);
    for (const table of ['workspace_spaces', 'installed_apps', 'favorites', 'usage_events', 'page_previews'])
      assert.deepEqual(store.db.prepare(`SELECT * FROM ${table} WHERE tenant=?`).all(account.tenantId), []);
  } finally {
    store.db.close();
  }
});

test('previews update by key, evict oldest within each tenant, and clear with both usage scopes', () => {
  const store = new ControlDatabase(':memory:');
  try {
    const items = store.workspaces.items;
    items.savePreview('other', 'page:https://other.test/', Buffer.from('other'), 0);
    for (let index = 0; index < 200; index++)
      items.savePreview('tenant', 'page:https://example.test/' + index, Buffer.from(String(index)), index);
    items.savePreview('tenant', 'page:https://example.test/0', Buffer.from('updated'), 201);
    items.savePreview('tenant', 'page:https://example.test/200', Buffer.from('new'), 202);
    const hashes = items.previewHashes('tenant');
    assert.equal(hashes.size, 200);
    assert.equal(hashes.has('page:https://example.test/1'), false);
    assert.deepEqual(
      items.preview('tenant', hashes.get('page:https://example.test/0')!),
      Buffer.from('updated'),
    );
    assert.equal(items.preview('other', hashes.get('page:https://example.test/0')!), undefined);
    items.clearUsage('tenant', 'pages');
    assert.equal(items.previewHashes('tenant').size, 0);
    assert.equal(items.previewHashes('other').size, 1);
    items.clearUsage('other', 'all');
    assert.equal(items.previewHashes('other').size, 0);
  } finally {
    store.db.close();
  }
});
