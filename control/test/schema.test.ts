import { accountsFor, registerUser } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ControlDatabase } from '../server/persistence/database';
import { createSchema } from '../server/persistence/schema';

test('fresh schema includes workspace spaces, installed apps, favorites and usage', () => {
  const store = new ControlDatabase(':memory:');
  try {
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 8n }]);
    const tables = new Set(
      (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const name of [
      'users',
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
  } finally {
    store.db.close();
  }
});

test('version seven cleans remembered URLs and resolves collisions per tenant', () => {
  const store = new ControlDatabase(':memory:');
  try {
    const urls = [
      'https://accounts.google.com/v3/signin/identifier?opparams=private&client_id=client&nonce=secret&state=secret&redirect_uri=private',
      'https://claude.ai/?__cf_chl_rt_tk=private',
      'https://www.google.com/search?q=chatgpt&sei=private',
      'https://example.com/callback?code=secret&extra=private',
      'https://user:password@example.com/',
      'about:blank',
      'https://example.com/page?b=2&utm_source=old&a=1',
      'https://example.com/page?a=1&b=2#fragment',
    ];
    const insertEvent = store.db.prepare(
      'INSERT INTO usage_events(tenant,at,item,window_id,context,chain,title) VALUES (?,?,?,?,?,?,?)',
    );
    const insertPreview = store.db.prepare('INSERT INTO page_previews VALUES (?,?,?,?,?)');
    const insertFavorite = store.db.prepare('INSERT INTO favorites VALUES (?,?,?,?)');
    for (const tenant of ['tenant', 'other']) {
      for (const [index, url] of urls.entries()) {
        insertEvent.run(tenant, 100 + index, 'page:' + url, 'window', 'tab:tab', 'chain', `Title ${index}`);
        insertPreview.run(
          tenant,
          'page:' + url,
          Buffer.from(`${tenant}:${index}`),
          `${tenant}-hash-${index}`,
          100 + index,
        );
        insertFavorite.run(
          tenant,
          `favorite-${index}`,
          index,
          JSON.stringify({ id: `favorite-${index}`, url, title: `Favorite ${index}`, createdAt: index }),
        );
      }
      insertEvent.run(tenant, 1, 'app:browser', 'window', 'window', 'app-chain', null);
      insertPreview.run(
        tenant,
        'page:https://claude.ai/',
        Buffer.from(tenant + ':new'),
        tenant + '-new-hash',
        200,
      );
    }
    store.db.exec(`DROP TABLE schema_version;
      CREATE TABLE schema_version(version INTEGER CHECK(version=7));
      INSERT INTO schema_version VALUES(7);`);
    createSchema(store.db);
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 8n }]);
    for (const tenant of ['tenant', 'other']) {
      const rows = store.db
        .prepare('SELECT item,at,title,window_id,context,chain FROM usage_events WHERE tenant=? ORDER BY id')
        .all(tenant) as {
        item: string;
        at: bigint;
        title: string;
        window_id: string;
        context: string;
        chain: string;
      }[];
      assert.deepEqual(
        rows.map((row) => row.item),
        [
          'page:https://accounts.google.com/v3/signin/identifier',
          'page:https://claude.ai/',
          'page:https://example.com/callback',
          'page:https://example.com/page?a=1&b=2',
          'page:https://example.com/page?a=1&b=2',
          'app:browser',
        ],
      );
      assert.deepEqual(rows[0], {
        item: 'page:https://accounts.google.com/v3/signin/identifier',
        at: 100n,
        title: 'Title 0',
        window_id: 'window',
        context: 'tab:tab',
        chain: 'chain',
      });
      const previews = store.db
        .prepare('SELECT key,hash,image FROM page_previews WHERE tenant=? ORDER BY key')
        .all(tenant) as { key: string; hash: string; image: Buffer }[];
      assert.deepEqual(
        previews.map((row) => row.key),
        [
          'page:https://accounts.google.com/v3/signin/identifier',
          'page:https://claude.ai/',
          'page:https://example.com/callback',
          'page:https://example.com/page?a=1&b=2',
        ],
      );
      assert.deepEqual(previews[1], {
        key: 'page:https://claude.ai/',
        hash: tenant + '-new-hash',
        image: Buffer.from(tenant + ':new'),
      });
      assert.deepEqual(previews[3], {
        key: 'page:https://example.com/page?a=1&b=2',
        hash: tenant + '-hash-7',
        image: Buffer.from(tenant + ':7'),
      });
      const favorites = store.workspaces.items.favorites(tenant);
      assert.deepEqual(
        favorites.map((favorite) => [favorite.id, favorite.url]),
        [
          ['favorite-0', 'https://accounts.google.com/v3/signin/identifier'],
          ['favorite-1', 'https://claude.ai/'],
          ['favorite-2', 'https://www.google.com/search?q=chatgpt&sei=private'],
          ['favorite-3', 'https://example.com/callback'],
          ['favorite-6', 'https://example.com/page?a=1&b=2'],
        ],
      );
      assert.equal(favorites[4].title, 'Favorite 6');
      assert.equal(favorites[4].createdAt, 6);
    }
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

test('legacy workspaces migrate in order, drop files tabs and split settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-schema-v4-'));
  const path = join(directory, 'control.db');
  try {
    let store = new ControlDatabase(path);
    const account = await registerUser(store, 'v4-user', 'v4-password1234');
    const settings = store.workspaces.workspace(account.tenantId).settings;
    store.db.exec(`DROP TABLE workspace_spaces;
      DROP TABLE installed_apps;
      DROP TABLE favorites;
      DROP TABLE usage_events;
      DROP TABLE workspace_windows;
      DROP TABLE workspaces;
      CREATE TABLE workspaces (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, active_window TEXT, layout_mode TEXT NOT NULL, pending TEXT);
      CREATE TABLE workspace_windows (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, position INTEGER NOT NULL, active_tab TEXT, weight REAL NOT NULL);
      DROP TABLE IF EXISTS page_previews;
      DROP TABLE schema_version;
      CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=4));
      INSERT INTO schema_version(version) VALUES (4);`);
    store.db
      .prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)')
      .run(account.tenantId, 8, 'second', 'side-by-side', '{}');
    store.db
      .prepare('INSERT INTO workspace_windows VALUES (?,?,?,?,?)')
      .run('first', account.tenantId, 0, 'files', 0.4);
    store.db
      .prepare('INSERT INTO workspace_windows VALUES (?,?,?,?,?)')
      .run('second', account.tenantId, 1, 'page', 0.6);
    for (const [position, tab] of [
      { id: 'files', kind: 'files', windowId: 'first' },
      {
        id: 'page',
        kind: 'remote',
        windowId: 'second',
        url: 'https://example.com',
        title: 'Page',
        webviewId: '1',
      },
    ].entries())
      store.db
        .prepare('INSERT INTO workspace_tabs VALUES (?,?,?,?,?)')
        .run(tab.id, account.tenantId, tab.windowId, position, JSON.stringify(tab));
    store.db.prepare('INSERT OR REPLACE INTO user_settings VALUES (?,?)').run(
      account.tenantId,
      JSON.stringify({
        ...settings.workspace,
        ...settings.browser,
        clientScaleOverride: 1.5,
        showStats: true,
      }),
    );
    store.db.prepare('INSERT INTO file_library VALUES (?,?)').run(
      account.tenantId,
      JSON.stringify({
        revision: 1,
        entries: [{ id: 'entry', groupId: 'group', archived: true }],
        basket: [],
        groups: [{ id: 'group', name: 'Photos' }],
      }),
    );
    store.db.close();
    store = new ControlDatabase(path);
    try {
      assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 8n }]);
      const migrated = store.workspaces.workspace(account.tenantId);
      assert.equal('clientScaleOverride' in migrated.settings.workspace, false);
      assert.equal(migrated.settings.workspace.uiScale, 1);
      assert.equal(migrated.settings.workspace.topDeadZone, 'off');
      assert.equal(migrated.settings.workspace.showStats, true);
      assert.equal(migrated.settings.browser.searchEngine, 'google');
      assert.deepEqual(
        migrated.windows.map((window) => [window.id, window.appId, window.activeTabId]),
        [
          ['first', 'browser', null],
          ['second', 'browser', 'page'],
        ],
      );
      assert.deepEqual(
        migrated.spaces.map((space) => space.windowIds),
        [['first'], ['second']],
      );
      assert.equal(migrated.activeSpaceId, migrated.spaces[1].id);
      assert.deepEqual(
        migrated.tabs.map((tab) => tab.id),
        ['page'],
      );
      const library = store.library.snapshot(account.tenantId);
      assert.deepEqual(library.partitions, [{ id: 'group', name: 'Photos' }]);
      assert.equal(library.entries[0].partitionId, 'group');
      assert.equal(library.entries[0].collected, true);
      assert.deepEqual(library.entries[0].source, { app: 'files', channel: 'upload' });
      assert.deepEqual(library.excludedSources, []);
      assert.equal(library.basketPartitionId, null);
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
      ['newer', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (9)'],
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

test('version six migrates previews without changing workspace state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-schema-previews-'));
  const path = join(directory, 'control.db');
  let store = new ControlDatabase(path);
  try {
    const account = await registerUser(store, 'preview-migration', 'schema-password123');
    const workspace = store.workspaces.workspace(account.tenantId);
    store.db
      .prepare("UPDATE user_settings SET data=json_set(data,'$.workspace.groupRail',1) WHERE tenant=?")
      .run(account.tenantId);
    store.db.exec(`DROP TABLE page_previews;
      DROP TABLE schema_version;
      CREATE TABLE schema_version(version INTEGER CHECK(version=6));
      INSERT INTO schema_version VALUES(6);`);
    store.db.close();
    store = new ControlDatabase(path);
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 8n }]);
    assert.deepEqual(store.workspaces.workspace(account.tenantId), workspace);
    store.workspaces.items.savePreview(account.tenantId, 'page:https://example.com/', Buffer.from('jpeg'), 1);
    assert.equal(store.workspaces.items.previewHashes(account.tenantId).size, 1);
  } finally {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
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
