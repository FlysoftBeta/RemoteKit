// Frozen schema from commit 0752935.
export const baselineV12 = `CREATE TABLE view_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, tenant TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, last_login_at INTEGER, disabled_at INTEGER);
      CREATE TABLE auth_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE clipboards (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, text TEXT NOT NULL, html TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE workspaces (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, active_space TEXT, pending TEXT);
      CREATE TABLE workspace_windows (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, position INTEGER NOT NULL, app_id TEXT NOT NULL, active_tab TEXT, state TEXT, last_active_at INTEGER NOT NULL);
      CREATE TABLE workspace_spaces (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
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
      CREATE INDEX file_library_open ON file_library_selections(tenant,terminal,checked);
CREATE TABLE session_placements (
  tenant TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, node_id TEXT NOT NULL,
  placement_epoch INTEGER NOT NULL, key_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', checkpoint_id INTEGER);
      CREATE TABLE cluster_object_secret (id INTEGER PRIMARY KEY CHECK(id=1), ciphertext TEXT NOT NULL);
      CREATE TABLE objects (
        id TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_size INTEGER NOT NULL,
        stored_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE object_derivations (
        id TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('thumbnail','document')),
        PRIMARY KEY(id,source_id,kind));
      CREATE INDEX object_derivations_source ON object_derivations(source_id,kind);
      CREATE TABLE object_replicas (
        id TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(id,node_id));
      CREATE TABLE object_claims (
        tenant TEXT NOT NULL, id TEXT NOT NULL, claimed_at INTEGER NOT NULL, PRIMARY KEY(tenant,id));
      CREATE TABLE object_gc (id TEXT PRIMARY KEY, unreferenced_at INTEGER NOT NULL);
      CREATE TABLE checkpoints (
        tenant TEXT NOT NULL, id INTEGER NOT NULL, placement_epoch INTEGER NOT NULL, manifest_id TEXT NOT NULL,
        build_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,id));
      CREATE TABLE checkpoint_objects (
        tenant TEXT NOT NULL, manifest_id TEXT NOT NULL, id TEXT NOT NULL,
        PRIMARY KEY(tenant,manifest_id,id));
      CREATE TABLE warm_session_copies (
        tenant TEXT NOT NULL, node_id TEXT NOT NULL, manifest_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,node_id));
      CREATE TABLE removed_nodes (node_id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL);
      CREATE TABLE session_deletions (
        session_id TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(session_id,node_id));
      CREATE TABLE object_inventory_orphans (
        node_id TEXT NOT NULL, id TEXT NOT NULL, first_seen INTEGER NOT NULL,
        PRIMARY KEY(node_id,id));
CREATE TABLE session_import_keys (
      id INTEGER PRIMARY KEY CHECK(id=1), public_key BLOB NOT NULL, private_key TEXT NOT NULL, key_id TEXT NOT NULL);
      CREATE TABLE session_import_mailbox (
        id INTEGER PRIMARY KEY CHECK(id=1), since INTEGER NOT NULL, uid_validity TEXT, uid INTEGER);
      CREATE TABLE session_import_pairing (
        tenant TEXT PRIMARY KEY, code TEXT, opened_at INTEGER, expires_at INTEGER,
        failures INTEGER NOT NULL, closed_reason TEXT);
      CREATE TABLE session_import_devices (
        key_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, public_key BLOB NOT NULL, name TEXT NOT NULL,
        paired_at INTEGER NOT NULL, in_seq INTEGER NOT NULL, out_seq INTEGER NOT NULL,
        acked_seq INTEGER NOT NULL, resent_at INTEGER);
      CREATE TABLE session_import_events (
        tenant TEXT NOT NULL, key_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('in','out')),
        seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, ref INTEGER, body TEXT NOT NULL, mailed_at INTEGER);
      CREATE INDEX session_import_events_stream ON session_import_events(key_id,direction,seq);
      CREATE INDEX session_import_events_tenant ON session_import_events(tenant,direction);
      CREATE INDEX session_import_events_retention ON session_import_events(CASE WHEN direction='in' THEN json_extract(body,'$.receivedAt') ELSE at END);
      CREATE INDEX session_import_events_outbox ON session_import_events(mailed_at) WHERE direction='out';
      CREATE TABLE session_imports (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, key_id TEXT NOT NULL, sites TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','applied','failed','discarded')), payload TEXT,
        cookies INTEGER NOT NULL, origins INTEGER NOT NULL, rejected_items INTEGER NOT NULL,
        error TEXT, received_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE INDEX session_imports_tenant ON session_imports(tenant,state,received_at);
      CREATE INDEX session_imports_retention ON session_imports(finished_at) WHERE state!='pending';
CREATE TABLE installed_apps (
      tenant TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
      icon BLOB, icon_hash TEXT, PRIMARY KEY(tenant,id));
    CREATE TABLE favorites (
      tenant TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(tenant,id));
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, at INTEGER NOT NULL,
      item TEXT NOT NULL, window_id TEXT NOT NULL, context TEXT NOT NULL, chain TEXT NOT NULL, title TEXT);
    CREATE INDEX usage_events_tenant ON usage_events(tenant,at,id);
    CREATE INDEX usage_events_context ON usage_events(tenant,window_id,context,at,id);
CREATE TABLE page_previews (
    tenant TEXT NOT NULL, key TEXT NOT NULL, image BLOB NOT NULL, hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY(tenant,key));
    CREATE INDEX page_previews_hash ON page_previews(tenant,hash);
    CREATE INDEX page_previews_updated ON page_previews(tenant,updated_at);
CREATE TABLE announcements (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      published_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE announcement_reads (
      announcement_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(announcement_id,user_id));
    CREATE INDEX announcement_reads_user ON announcement_reads(user_id);
CREATE TABLE IF NOT EXISTS learning_accounts (
    tenant TEXT NOT NULL, provider TEXT NOT NULL, sealed TEXT NOT NULL,
    display_name TEXT NOT NULL, username TEXT NOT NULL, status TEXT NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY(tenant,provider));
    CREATE TABLE IF NOT EXISTS learning_settings (
    tenant TEXT PRIMARY KEY, retention_days INTEGER NOT NULL DEFAULT 7,
    last_sync_at INTEGER);
    CREATE TABLE IF NOT EXISTS learning_downloads (
    tenant TEXT NOT NULL, key TEXT NOT NULL, published_at INTEGER NOT NULL,
    saved_at INTEGER NOT NULL, entry_id TEXT, object_id TEXT, state TEXT NOT NULL,
    PRIMARY KEY(tenant,key));
    CREATE TABLE IF NOT EXISTS document_progress (
    tenant TEXT NOT NULL, asset_id TEXT NOT NULL, page INTEGER NOT NULL,
    offset REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(tenant,asset_id));
    CREATE INDEX IF NOT EXISTS document_progress_recent ON document_progress(tenant,updated_at);
CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=12)); INSERT INTO schema_version VALUES (12);`;
