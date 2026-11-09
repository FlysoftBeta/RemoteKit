import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';
import { createAnnouncementTables } from './announcements';
import { createLearningTables } from './learning';
import { createObjectRenderTables } from './object-renders';

const version = 16;

function createSnippetTable(db: Database.Database) {
  db.exec(`CREATE TABLE library_snippets (
    entry_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, text TEXT NOT NULL,
    hash TEXT NOT NULL, origin TEXT NOT NULL, copied_at INTEGER NOT NULL,
    UNIQUE(tenant,hash));`);
}

function addErrorColumns(db: Database.Database) {
  db.exec(`CREATE TABLE download_import_failures (tenant TEXT NOT NULL, event_id TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL, error TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(tenant,event_id));
    ALTER TABLE object_render_failures ADD COLUMN display_reason TEXT;
    ALTER TABLE learning_downloads ADD COLUMN error_code TEXT;
    ALTER TABLE learning_downloads ADD COLUMN error_message TEXT;
    ALTER TABLE learning_downloads ADD COLUMN retry_at INTEGER;
    ALTER TABLE learning_downloads ADD COLUMN failed_usage INTEGER;
    ALTER TABLE session_imports ADD COLUMN error_code TEXT;
    ALTER TABLE session_imports ADD COLUMN retry_at INTEGER;
    ALTER TABLE session_imports ADD COLUMN storage_job TEXT;
    ALTER TABLE session_imports ADD COLUMN apply_counts TEXT;
    ALTER TABLE session_imports ADD COLUMN chunk_index INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_deletions ADD COLUMN error_code TEXT;
    ALTER TABLE session_deletions ADD COLUMN error_message TEXT;`);
}
const migrations: Record<number, (db: Database.Database) => void> = {
  15: (db) => {
    createSnippetTable(db);
    for (const row of db.prepare('SELECT tenant,data FROM user_settings').all() as {
      tenant: string;
      data: string;
    }[]) {
      const settings = JSON.parse(row.data);
      settings.workspace.clipboardSync = true;
      db.prepare('UPDATE user_settings SET data=? WHERE tenant=?').run(JSON.stringify(settings), row.tenant);
    }
    for (const row of db.prepare('SELECT tenant,snapshot FROM file_library').all() as {
      tenant: string;
      snapshot: string;
    }[]) {
      const snapshot = JSON.parse(row.snapshot);
      for (const entry of snapshot.entries) entry.kind = 'file';
      db.prepare('UPDATE file_library SET snapshot=? WHERE tenant=?').run(
        JSON.stringify(snapshot),
        row.tenant,
      );
    }
  },
  14: (db) => {
    for (const row of db.prepare('SELECT tenant,id,receipt FROM operation_receipts').all() as {
      tenant: string;
      id: string;
      receipt: string;
    }[]) {
      const receipt = JSON.parse(row.receipt);
      if (receipt.status === 'rejected' || receipt.status === 'expired') {
        receipt.error = {
          code: receipt.status === 'expired' ? 'conflict' : 'rejected',
          message: receipt.error || '操作收据代次已过期，请核对当前工作区',
        };
        receipt.status = 'failed';
      } else if (typeof receipt.error === 'string') {
        receipt.error = { code: 'outcome_unknown', message: receipt.error };
      }
      db.prepare('UPDATE operation_receipts SET receipt=? WHERE tenant=? AND id=?').run(
        JSON.stringify(receipt),
        row.tenant,
        row.id,
      );
    }
    for (const row of db
      .prepare("SELECT rowid,body FROM session_import_events WHERE type='importFailed'")
      .all() as { rowid: bigint; body: string }[]) {
      const event = JSON.parse(row.body);
      event.retryable = false;
      db.prepare('UPDATE session_import_events SET body=? WHERE rowid=?').run(
        JSON.stringify(event),
        row.rowid,
      );
    }
    addErrorColumns(db);
  },
  13: (db) => {
    db.exec(`ALTER TABLE session_placements RENAME TO session_placements_old;
      CREATE TABLE session_placements (
        tenant TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, node_id TEXT NOT NULL,
        placement_epoch INTEGER NOT NULL, key_ciphertext TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','hibernating','hibernated')),
        checkpoint_id INTEGER);
      INSERT INTO session_placements SELECT * FROM session_placements_old;
      DROP TABLE session_placements_old;`);
  },
  12: (db) => {
    const settingsRows = db.prepare('SELECT tenant, data FROM user_settings').all() as {
      tenant: string;
      data: string;
    }[];
    const updateSettings = db.prepare('UPDATE user_settings SET data=? WHERE tenant=?');
    for (const row of settingsRows) {
      const settings = JSON.parse(row.data);
      if (settings.workspace.autoKeyboard === undefined) settings.workspace.autoKeyboard = false;
      updateSettings.run(JSON.stringify(settings), row.tenant);
    }
    const siteRows = db.prepare('SELECT tenant, origin, data FROM site_preferences').all() as {
      tenant: string;
      origin: string;
      data: string;
    }[];
    const updateSite = db.prepare('UPDATE site_preferences SET data=? WHERE tenant=? AND origin=?');
    const deleteSite = db.prepare('DELETE FROM site_preferences WHERE tenant=? AND origin=?');
    for (const row of siteRows) {
      const site = JSON.parse(row.data);
      delete site.manualKeyboard;
      if (!site.tabletUa) delete site.tabletUa;
      if (!Object.keys(site.permissions ?? {}).length) delete site.permissions;
      if (!site.protocolHandlers?.length) delete site.protocolHandlers;
      if (Object.keys(site).length) updateSite.run(JSON.stringify(site), row.tenant, row.origin);
      else deleteSite.run(row.tenant, row.origin);
    }
    createLearningTables(db);
    createObjectRenderTables(db);
  },
};

function createWorkspaceItems(db: Database.Database) {
  db.exec(`CREATE TABLE installed_apps (
      tenant TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
      icon BLOB, icon_hash TEXT, PRIMARY KEY(tenant,id));
    CREATE TABLE favorites (
      tenant TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(tenant,id));
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, at INTEGER NOT NULL,
      item TEXT NOT NULL, window_id TEXT NOT NULL, context TEXT NOT NULL, chain TEXT NOT NULL, title TEXT);
    CREATE INDEX usage_events_tenant ON usage_events(tenant,at,id);
    CREATE INDEX usage_events_context ON usage_events(tenant,window_id,context,at,id);`);
}

function createPagePreviews(db: Database.Database) {
  db.exec(`CREATE TABLE page_previews (
    tenant TEXT NOT NULL, key TEXT NOT NULL, image BLOB NOT NULL, hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY(tenant,key));
    CREATE INDEX page_previews_hash ON page_previews(tenant,hash);
    CREATE INDEX page_previews_updated ON page_previews(tenant,updated_at);`);
}

function tableExists(db: Database.Database, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function writeVersion(db: Database.Database) {
  db.exec(`DROP TABLE IF EXISTS schema_version;
    CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=${version}));
    INSERT INTO schema_version(version) VALUES (${version});`);
}

export function createSchema(db: Database.Database) {
  db.transaction(() => {
    if (tableExists(db, 'schema_version')) {
      const rows = db.prepare('SELECT version FROM schema_version').all() as { version: bigint }[];
      if (rows.length !== 1)
        throw new RemoteKitError('internal', '数据库版本不受支持', { detail: 'Unsupported database schema' });
      let storedVersion = Number(rows[0].version);
      while (storedVersion !== version) {
        const migrate = migrations[storedVersion];
        if (!migrate)
          throw new RemoteKitError('internal', '数据库版本不受支持', {
            detail: 'Unsupported database schema',
          });
        migrate(db);
        storedVersion++;
      }
      if (Number(rows[0].version) !== version) writeVersion(db);
      createLearningTables(db);
      return;
    }
    if (tableExists(db, 'users'))
      throw new RemoteKitError('internal', '数据库版本不受支持', { detail: 'Unsupported database schema' });
    db.exec(`CREATE TABLE view_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
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
      CREATE INDEX file_library_open ON file_library_selections(tenant,terminal,checked);`);
    createSnippetTable(db);
    db.exec(`CREATE TABLE session_placements (
  tenant TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, node_id TEXT NOT NULL,
  placement_epoch INTEGER NOT NULL, key_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','hibernating','hibernated')), checkpoint_id INTEGER);
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
        PRIMARY KEY(node_id,id));`);
    db.exec(`CREATE TABLE session_import_keys (
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
      CREATE INDEX session_imports_retention ON session_imports(finished_at) WHERE state!='pending';`);
    createWorkspaceItems(db);
    createPagePreviews(db);
    createAnnouncementTables(db);
    createLearningTables(db);
    createObjectRenderTables(db);
    addErrorColumns(db);
    writeVersion(db);
  })();
}
