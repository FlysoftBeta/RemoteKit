import { accountsFor, registerUser } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ControlDatabase } from '../server/persistence/database';
import { createSchema } from '../server/persistence/schema';
function stripErrorColumns(db: import('better-sqlite3').Database) {
  db.exec(
    'DROP TABLE library_snippets; DROP TABLE download_import_failures; ALTER TABLE object_render_failures DROP COLUMN display_reason',
  );
  for (const [table, columns] of Object.entries({
    learning_downloads: ['error_code', 'error_message', 'retry_at', 'failed_usage'],
    session_imports: ['error_code', 'retry_at', 'storage_job', 'chunk_index', 'apply_counts'],
    session_deletions: ['error_code', 'error_message'],
  })) {
    for (const column of columns) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

test('version fifteen classifies existing files and enables device clipboard sync', () => {
  const store = new ControlDatabase(':memory:');
  try {
    store.db.exec(`DROP TABLE library_snippets; DROP TABLE schema_version;
      CREATE TABLE schema_version(version INTEGER NOT NULL CHECK(version=15));
      INSERT INTO schema_version VALUES (15);`);
    const entry = {
      id: 'file',
      assetId: 'asset',
      name: 'saved.txt',
      type: 'text/plain',
      size: 1,
      createdAt: 0,
      partitionId: 'saved',
      source: null,
      collected: false,
    };
    store.db.prepare('INSERT INTO file_library VALUES (?,?)').run(
      'tenant',
      JSON.stringify({
        revision: 1,
        entries: [entry],
        partitions: [{ id: 'saved', name: 'Saved' }],
        basket: [],
        sources: [],
        excludedSources: [],
        basketPartitionId: null,
      }),
    );
    store.db
      .prepare('INSERT INTO user_settings VALUES (?,?)')
      .run(
        'tenant',
        JSON.stringify({ workspace: { autoKeyboard: false }, browser: { memorySaverEnabled: true } }),
      );
    createSchema(store.db);
    const snapshot = JSON.parse(
      (store.db.prepare('SELECT snapshot FROM file_library').get() as { snapshot: string }).snapshot,
    );
    assert.deepEqual(snapshot.entries, [{ ...entry, kind: 'file' }]);
    const settings = JSON.parse(
      (store.db.prepare('SELECT data FROM user_settings').get() as { data: string }).data,
    );
    assert.equal(settings.workspace.clipboardSync, true);
    assert.equal(settings.browser.memorySaverEnabled, true);
    assert.deepEqual(
      store.library.recordSnippet('tenant', 'copied', { kind: 'device' }, 1)?.entries[0].kind,
      'snippet',
    );
  } finally {
    store.db.close();
  }
});

test('version fourteen migrates receipt codes and adds persistent scheduler evidence atomically', () => {
  const store = new ControlDatabase(':memory:');
  try {
    stripErrorColumns(store.db);
    store.db.exec(`DROP TABLE schema_version;
      CREATE TABLE schema_version(version INTEGER NOT NULL CHECK(version=14));
      INSERT INTO schema_version VALUES (14);`);
    const insert = store.db.prepare('INSERT INTO operation_receipts VALUES (?,?,?,?)');
    for (const [id, status, error] of [
      ['one', 'rejected', '原始说明'],
      ['two', 'expired', ''],
      ['three', 'unknown', '待对账'],
    ])
      insert.run(
        'tenant',
        id,
        '{}',
        JSON.stringify({ operationId: id, operationGeneration: 'generation', status, error }),
      );
    store.db
      .prepare(
        "INSERT INTO session_import_events(tenant,key_id,direction,seq,at,type,body) VALUES ('tenant','key','out',1,0,'importFailed',?)",
      )
      .run(JSON.stringify({ type: 'importFailed', reason: '旧失败说明', retryable: true }));
    createSchema(store.db);
    const event = JSON.parse(
      (store.db.prepare('SELECT body FROM session_import_events').get() as { body: string }).body,
    );
    assert.deepEqual(event, {
      type: 'importFailed',
      reason: '旧失败说明',
      retryable: false,
    });
    const rows = (
      store.db.prepare('SELECT receipt FROM operation_receipts ORDER BY id').all() as { receipt: string }[]
    ).map((row) => JSON.parse(row.receipt));
    assert.deepEqual(
      rows.map((row) => [row.status, row.error.code, row.error.message]),
      [
        ['failed', 'rejected', '原始说明'],
        ['unknown', 'outcome_unknown', '待对账'],
        ['failed', 'conflict', '操作收据代次已过期，请核对当前工作区'],
      ],
    );
    for (const [table, columns] of Object.entries({
      learning_downloads: ['error_code', 'error_message', 'retry_at', 'failed_usage'],
      session_imports: ['error_code', 'retry_at', 'storage_job', 'chunk_index', 'apply_counts'],
      session_deletions: ['error_code', 'error_message'],
    })) {
      const actual = new Set(
        (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
      );
      for (const column of columns) assert.ok(actual.has(column));
    }
    createSchema(store.db);
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').get(), { version: 16n });
  } finally {
    store.db.close();
  }
});

test('version thirteen preserves placements and checkpoints and permits hibernating', () => {
  const store = new ControlDatabase(':memory:');
  try {
    stripErrorColumns(store.db);
    store.db.exec(`DROP TABLE schema_version;
      CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=13));
      INSERT INTO schema_version VALUES (13);
      INSERT INTO checkpoints VALUES ('tenant',7,3,'manifest','dev',100);
      INSERT INTO session_placements VALUES ('tenant','session','node',3,'sealed','active',7);`);
    createSchema(store.db);
    assert.deepEqual(store.db.prepare('SELECT * FROM session_placements').get(), {
      tenant: 'tenant',
      session_id: 'session',
      node_id: 'node',
      placement_epoch: 3n,
      key_ciphertext: 'sealed',
      state: 'active',
      checkpoint_id: 7n,
    });
    store.db.exec("UPDATE session_placements SET state='hibernating'");
    assert.equal(
      (store.db.prepare('SELECT manifest_id FROM checkpoints').get() as any).manifest_id,
      'manifest',
    );
    assert.throws(() => store.db.exec("UPDATE session_placements SET state='unknown'"));
    createSchema(store.db);
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').get(), { version: 16n });
  } finally {
    store.db.close();
  }
});

test('fresh schema includes workspace spaces, installed apps, favorites and usage', () => {
  const store = new ControlDatabase(':memory:');
  try {
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 16n }]);
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
      ['newer', 'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (17)'],
      [
        'ambiguous',
        'CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (1),(1)',
      ],
    ]) {
      const path = join(directory, name + '.db');
      const db = new Database(path);
      db.exec(setup);
      db.close();
      assert.throws(
        () => new ControlDatabase(path),
        { code: 'internal', detail: 'Unsupported database schema' },
        name,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('version twelve migrates render outcomes and classifies saved study documents without losing entries', () => {
  const store = new ControlDatabase(':memory:');
  try {
    stripErrorColumns(store.db);
    store.db.exec(`DROP TABLE object_render_failures;
      DROP INDEX learning_downloads_object;
      ALTER TABLE learning_downloads DROP COLUMN document;
      DROP TABLE schema_version;
      CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=12));
      INSERT INTO schema_version VALUES (12);`);
    const entries = [
      { id: 'document', name: 'lesson.docx' },
      { id: 'image', name: 'lesson.png' },
    ];
    store.db.prepare('INSERT INTO file_library VALUES (?,?)').run('tenant', JSON.stringify({ entries }));
    for (const entry of entries)
      store.db
        .prepare("INSERT INTO learning_downloads VALUES (?,?,1,1,?,?,'saved')")
        .run('tenant', entry.id, entry.id, entry.id);
    createSchema(store.db);
    createSchema(store.db);
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').get(), { version: 16n });
    assert.deepEqual(store.db.prepare('SELECT key,document FROM learning_downloads ORDER BY key').all(), [
      { key: 'document', document: 1n },
      { key: 'image', document: 0n },
    ]);
    assert.deepEqual(store.db.prepare('SELECT * FROM object_render_failures').all(), []);
    assert.deepEqual(
      JSON.parse(
        (store.db.prepare('SELECT snapshot FROM file_library').get() as { snapshot: string }).snapshot,
      ),
      { entries: entries.map((entry) => ({ ...entry, kind: 'file' })) },
    );
  } finally {
    store.db.close();
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
