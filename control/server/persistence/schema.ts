import type Database from 'better-sqlite3';

export function createSchema(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL CHECK(version=1));
      CREATE TABLE IF NOT EXISTS view_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
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
      CREATE INDEX IF NOT EXISTS file_library_open ON file_library_selections(tenant,terminal,checked);
      INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);`);
    const rows = db.prepare('SELECT version FROM schema_version').all() as { version: bigint }[];
    if (rows.length !== 1 || Number(rows[0].version) !== 1) throw new Error('Unsupported database schema');
  })();
}
