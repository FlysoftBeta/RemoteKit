import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';

const version = 1;

function tableExists(db: Database.Database, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export function createSchema(db: Database.Database) {
  db.transaction(() => {
    if (tableExists(db, 'schema_version')) {
      const rows = db.prepare('SELECT version FROM schema_version').all() as { version: bigint }[];
      if (rows.length !== 1 || Number(rows[0].version) !== version)
        throw new RemoteKitError('internal', 'Unsupported database schema');
      return;
    }
    if (tableExists(db, 'users')) throw new RemoteKitError('internal', 'Unsupported database schema');
    db.exec(`CREATE TABLE view_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, tenant TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, last_login_at INTEGER, disabled_at INTEGER);
      CREATE TABLE auth_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE workspaces (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, active_window TEXT, layout_mode TEXT NOT NULL, pending TEXT);
      CREATE TABLE workspace_windows (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, position INTEGER NOT NULL, active_tab TEXT, weight REAL NOT NULL);
      CREATE TABLE workspace_tabs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, window_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE user_settings (tenant TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE site_preferences (tenant TEXT NOT NULL, origin TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,origin));
      CREATE UNIQUE INDEX single_admin ON users(is_admin) WHERE is_admin=1;
      CREATE TABLE operation_sequences (tenant TEXT PRIMARY KEY, sequence TEXT NOT NULL);
      CREATE TABLE operation_generations (tenant TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE operation_receipts (tenant TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(tenant,id));
      CREATE TABLE user_security (user_id TEXT PRIMARY KEY REFERENCES users(id), settings TEXT NOT NULL, pin_salt TEXT, pin_hash TEXT, face_ciphertext TEXT, face_model TEXT);
      CREATE TABLE popup_receipts (tenant TEXT NOT NULL, provisional_id TEXT NOT NULL, tab_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,provisional_id));
      CREATE TABLE file_library (tenant TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE file_library_operations (
        tenant TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, selection_id TEXT, PRIMARY KEY(tenant,id));
      CREATE TABLE file_library_selections (
        tenant TEXT NOT NULL, id TEXT NOT NULL, manifest TEXT NOT NULL, terminal TEXT, checked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(tenant,id));
      CREATE INDEX file_library_open ON file_library_selections(tenant,terminal,checked);`);
    db.exec(`CREATE TABLE session_placements (
  tenant TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, node_id TEXT NOT NULL,
  placement_epoch INTEGER NOT NULL, key_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', checkpoint_id INTEGER);
      CREATE TABLE objects (
      tenant TEXT NOT NULL, id TEXT NOT NULL, size INTEGER NOT NULL, stored_size INTEGER NOT NULL,
      stored_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, derived_from TEXT, PRIMARY KEY(tenant,id));
      CREATE TABLE object_derivations (
        tenant TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(tenant,id,source_id));
      CREATE TABLE object_replicas (
        tenant TEXT NOT NULL, id TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(tenant,id,node_id));
      CREATE TABLE checkpoints (
        tenant TEXT NOT NULL, id INTEGER NOT NULL, placement_epoch INTEGER NOT NULL, manifest_id TEXT NOT NULL,
        build_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,id));
      CREATE TABLE checkpoint_objects (
        tenant TEXT NOT NULL, checkpoint_id INTEGER NOT NULL, object_id TEXT NOT NULL,
        PRIMARY KEY(tenant,checkpoint_id,object_id));
      CREATE TABLE warm_session_copies (
        tenant TEXT NOT NULL, node_id TEXT NOT NULL, manifest_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,node_id));
      CREATE TABLE removed_nodes (node_id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL);
      CREATE TABLE session_deletions (
        session_id TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(session_id,node_id));
      CREATE TABLE object_inventory_orphans (
        node_id TEXT NOT NULL, tenant TEXT NOT NULL, id TEXT NOT NULL, first_seen INTEGER NOT NULL,
        PRIMARY KEY(node_id,tenant,id));`);
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=${version}));
      INSERT INTO schema_version(version) VALUES (${version});`);
  })();
}
