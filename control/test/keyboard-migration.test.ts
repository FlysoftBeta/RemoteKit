import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSchema } from '../server/persistence/schema';

function version12Database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=12));
    INSERT INTO schema_version VALUES (12);
    CREATE TABLE operation_receipts (tenant TEXT,id TEXT,receipt TEXT);
    CREATE TABLE session_imports (id TEXT);
    CREATE TABLE session_import_events (type TEXT,body TEXT);
    CREATE TABLE session_deletions (session_id TEXT,node_id TEXT);
    CREATE TABLE file_library (tenant TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
    CREATE TABLE session_placements (
      tenant TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, node_id TEXT NOT NULL,
      placement_epoch INTEGER NOT NULL, key_ciphertext TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active', checkpoint_id INTEGER);
    CREATE TABLE user_settings (tenant TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE site_preferences (tenant TEXT NOT NULL, origin TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(tenant,origin));`);
  return db;
}

test('version 12 migration adds global keyboard default and removes per-site keyboard preferences', () => {
  const db = version12Database();
  try {
    const settings = { workspace: { uiScale: 1.5 }, browser: { searchEngine: 'bing' } };
    const insertSettings = db.prepare('INSERT INTO user_settings VALUES (?,?)');
    insertSettings.run('tenant', JSON.stringify(settings));
    insertSettings.run('other', JSON.stringify({ workspace: { autoKeyboard: true } }));
    const insertSite = db.prepare('INSERT INTO site_preferences VALUES (?,?,?)');
    insertSite.run('tenant', 'https://keyboard.test', JSON.stringify({ manualKeyboard: true }));
    insertSite.run('tenant', 'https://tablet.test', JSON.stringify({ tabletUa: true, manualKeyboard: true }));
    insertSite.run(
      'other',
      'https://empty.test',
      JSON.stringify({
        manualKeyboard: false,
        tabletUa: false,
        permissions: {},
        protocolHandlers: [],
      }),
    );
    const permissions = {
      permissions: { geolocation: 'allow' },
      protocolHandlers: [{ protocol: 'mailto', url: 'https://permissions.test/%s', allowed: true }],
    };
    insertSite.run(
      'other',
      'https://permissions.test',
      JSON.stringify({ ...permissions, manualKeyboard: true }),
    );
    createSchema(db);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version').get(), { version: 15 });
    const readSettings = (tenant: string) =>
      JSON.parse(
        (db.prepare('SELECT data FROM user_settings WHERE tenant=?').get(tenant) as { data: string }).data,
      );
    assert.deepEqual(readSettings('tenant'), {
      ...settings,
      workspace: { ...settings.workspace, autoKeyboard: false },
    });
    assert.equal(readSettings('other').workspace.autoKeyboard, true);
    const rows = db
      .prepare('SELECT tenant, origin, data FROM site_preferences ORDER BY tenant, origin')
      .all() as { tenant: string; origin: string; data: string }[];
    assert.deepEqual(
      rows.map((row) => ({ ...row, data: JSON.parse(row.data) })),
      [
        { tenant: 'other', origin: 'https://permissions.test', data: permissions },
        { tenant: 'tenant', origin: 'https://tablet.test', data: { tabletUa: true } },
      ],
    );
    createSchema(db);
    assert.deepEqual(
      db.prepare('SELECT tenant, origin, data FROM site_preferences ORDER BY tenant, origin').all(),
      rows,
    );
  } finally {
    db.close();
  }
});

test('failed migration rolls back data and version together', () => {
  const db = version12Database();
  try {
    const settings = JSON.stringify({ workspace: {} });
    db.prepare('INSERT INTO user_settings VALUES (?,?)').run('tenant', settings);
    db.prepare('INSERT INTO site_preferences VALUES (?,?,?)').run('tenant', 'https://broken.test', '{');
    assert.throws(() => createSchema(db), SyntaxError);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version').get(), { version: 12 });
    assert.deepEqual(db.prepare('SELECT data FROM user_settings').get(), { data: settings });
  } finally {
    db.close();
  }
});
