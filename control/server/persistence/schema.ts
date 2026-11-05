import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';

const version = 2;

const migrations: Record<number, (db: Database.Database) => void> = {
  // v2: settings.avSync is required; existing users keep sync off.
  1: (db) =>
    db.exec(
      `UPDATE user_settings SET data=json_set(data,'$.avSync',json('false')) WHERE json_type(data,'$.avSync') IS NULL`,
    ),
};

function tableExists(db: Database.Database, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export function createSchema(db: Database.Database) {
  db.transaction(() => {
    // Tables that predate schema_version hold version 1 data.
    const versioned = tableExists(db, 'schema_version');
    let current = tableExists(db, 'users') ? 1 : version;
    if (versioned) {
      const rows = db.prepare('SELECT version FROM schema_version').all() as { version: bigint }[];
      if (rows.length !== 1) throw new RemoteKitError('internal', 'Unsupported database schema');
      current = Number(rows[0].version);
    }
    if (current < 1 || current > version) throw new RemoteKitError('internal', 'Unsupported database schema');
    const stored = versioned ? current : 0;
    db.exec(`CREATE TABLE IF NOT EXISTS view_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, tenant TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS auth_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, active_window TEXT, layout_mode TEXT NOT NULL, pending TEXT);
      CREATE TABLE IF NOT EXISTS workspace_windows (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, position INTEGER NOT NULL, active_tab TEXT, weight REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_tabs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, window_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_settings (tenant TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS site_preferences (tenant TEXT NOT NULL, origin TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,origin));
      CREATE TABLE IF NOT EXISTS registration_policy (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, credential_hash TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS single_admin ON users(is_admin) WHERE is_admin=1;
      CREATE TABLE IF NOT EXISTS operation_sequences (tenant TEXT PRIMARY KEY, sequence TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_generations (tenant TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_receipts (tenant TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS user_security (user_id TEXT PRIMARY KEY REFERENCES users(id), settings TEXT NOT NULL, pin_salt TEXT, pin_hash TEXT, face_ciphertext TEXT, face_model TEXT);
      CREATE TABLE IF NOT EXISTS popup_receipts (tenant TEXT NOT NULL, provisional_id TEXT NOT NULL, tab_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,provisional_id));
      CREATE TABLE IF NOT EXISTS file_library (tenant TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_library_operations (
        tenant TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, selection_id TEXT, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS file_library_selections (
        tenant TEXT NOT NULL, id TEXT NOT NULL, manifest TEXT NOT NULL, terminal TEXT, checked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(tenant,id));
      CREATE INDEX IF NOT EXISTS file_library_open ON file_library_selections(tenant,terminal,checked);`);
    for (; current < version; ++current) migrations[current](db);
    if (stored === version) return;
    db.exec(`DROP TABLE IF EXISTS schema_version;
      CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=${version}));
      INSERT INTO schema_version(version) VALUES (${version});`);
  })();
}
