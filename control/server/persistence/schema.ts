import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';
import { migrateLibrarySnapshots } from './library';
import { normalizedUsagePage } from '../navigation-url';
import { cleanUrl } from '../url-clean';
import type { Favorite } from '../../shared/product';
import { createAnnouncementTables } from './announcements';

const version = 9;

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

// Each entry upgrades a database written at that version to the next one.
const migrations: Record<number, (db: Database.Database) => void> = {
  8: createAnnouncementTables,
  7: (db) => {
    const events = db.prepare("SELECT id,item FROM usage_events WHERE item LIKE 'page:%'").all() as {
      id: bigint;
      item: string;
    }[];
    const updateEvent = db.prepare('UPDATE usage_events SET item=? WHERE id=?');
    const deleteEvent = db.prepare('DELETE FROM usage_events WHERE id=?');
    for (const event of events) {
      const url = normalizedUsagePage(event.item.slice(5));
      if (url) updateEvent.run('page:' + url, event.id);
      else deleteEvent.run(event.id);
    }

    const previews = db
      .prepare(
        "SELECT tenant,key,image,hash,updated_at FROM page_previews WHERE key LIKE 'page:%' ORDER BY updated_at DESC,rowid DESC",
      )
      .all() as {
      tenant: string;
      key: string;
      image: Buffer;
      hash: string;
      updated_at: bigint;
    }[];
    db.exec("DELETE FROM page_previews WHERE key LIKE 'page:%'");
    const insertPreview = db.prepare('INSERT OR IGNORE INTO page_previews VALUES (?,?,?,?,?)');
    for (const preview of previews) {
      const url = normalizedUsagePage(preview.key.slice(5));
      if (url)
        insertPreview.run(preview.tenant, 'page:' + url, preview.image, preview.hash, preview.updated_at);
    }

    const favorites = db
      .prepare('SELECT tenant,id,data FROM favorites ORDER BY tenant,position,id')
      .all() as {
      tenant: string;
      id: string;
      data: string;
    }[];
    const seen = new Map<string, Set<string>>();
    const updateFavorite = db.prepare('UPDATE favorites SET data=? WHERE tenant=? AND id=?');
    const deleteFavorite = db.prepare('DELETE FROM favorites WHERE tenant=? AND id=?');
    for (const row of favorites) {
      const favorite = JSON.parse(row.data) as Favorite;
      const url = cleanUrl(favorite.url);
      const urls = seen.get(row.tenant) ?? new Set<string>();
      seen.set(row.tenant, urls);
      if (!url || urls.has(url)) deleteFavorite.run(row.tenant, row.id);
      else {
        urls.add(url);
        updateFavorite.run(JSON.stringify({ ...favorite, url }), row.tenant, row.id);
      }
    }
  },
  // The display-scale override became an app-wide UI scale; the top dead zone is new.
  4: (db) => {
    const rows = db.prepare('SELECT tenant, data FROM user_settings').all() as {
      tenant: string;
      data: string;
    }[];
    const update = db.prepare('UPDATE user_settings SET data=? WHERE tenant=?');
    for (const row of rows) {
      const { clientScaleOverride: _, ...settings } = JSON.parse(row.data) as Record<string, unknown>;
      update.run(JSON.stringify({ ...settings, uiScale: 1, topDeadZone: 'off' }), row.tenant);
    }
  },
  6: (db) => {
    createPagePreviews(db);
    db.exec("UPDATE user_settings SET data=json_remove(data,'$.workspace.groupRail')");
  },
  5: (db) => {
    db.exec(`CREATE TABLE workspace_spaces (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE new_workspaces (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, active_space TEXT, pending TEXT);
      CREATE TABLE new_workspace_windows (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, position INTEGER NOT NULL,
        app_id TEXT NOT NULL, active_tab TEXT, state TEXT, last_active_at INTEGER NOT NULL);`);
    const workspaces = db.prepare('SELECT tenant,revision,active_window,pending FROM workspaces').all() as {
      tenant: string;
      revision: bigint;
      active_window: string | null;
      pending: string | null;
    }[];
    const insertWindow = db.prepare('INSERT INTO new_workspace_windows VALUES (?,?,?,?,?,?,?)');
    const insertSpace = db.prepare('INSERT INTO workspace_spaces VALUES (?,?,?,?)');
    const removeTab = db.prepare('DELETE FROM workspace_tabs WHERE tenant=? AND id=?');
    for (const workspace of workspaces) {
      const windows = db
        .prepare('SELECT id,position,active_tab FROM workspace_windows WHERE tenant=? ORDER BY position')
        .all(workspace.tenant) as { id: string; position: bigint; active_tab: string | null }[];
      const tabs = db
        .prepare('SELECT id,data FROM workspace_tabs WHERE tenant=? ORDER BY position')
        .all(workspace.tenant) as {
        id: string;
        data: string;
      }[];
      const retained = tabs.filter((tab) => {
        if (JSON.parse(tab.data).kind !== 'files') return true;
        removeTab.run(workspace.tenant, tab.id);
        return false;
      });
      for (const window of windows) {
        const activeTab =
          retained.find((tab) => tab.id === window.active_tab)?.id ??
          retained.find((tab) => JSON.parse(tab.data).windowId === window.id)?.id ??
          null;
        const lastActiveAt = window.id === workspace.active_window ? 1 : 0;
        insertWindow.run(
          window.id,
          workspace.tenant,
          window.position,
          'browser',
          activeTab,
          null,
          lastActiveAt,
        );
        insertSpace.run(
          `space:${window.id}`,
          workspace.tenant,
          window.position,
          JSON.stringify({
            id: `space:${window.id}`,
            windowIds: [window.id],
            weights: [1],
            focusedWindowId: window.id,
            lastActiveAt,
          }),
        );
      }
      db.prepare('INSERT INTO new_workspaces VALUES (?,?,?,?)').run(
        workspace.tenant,
        workspace.revision,
        workspace.active_window ? `space:${workspace.active_window}` : null,
        workspace.pending,
      );
    }
    db.exec(`DROP TABLE workspaces;
      ALTER TABLE new_workspaces RENAME TO workspaces;
      DROP TABLE workspace_windows;
      ALTER TABLE new_workspace_windows RENAME TO workspace_windows;`);
    const settingsRows = db.prepare('SELECT tenant,data FROM user_settings').all() as {
      tenant: string;
      data: string;
    }[];
    for (const row of settingsRows) {
      const { searchEngine, memorySaverEnabled, ...workspace } = JSON.parse(row.data);
      db.prepare('UPDATE user_settings SET data=? WHERE tenant=?').run(
        JSON.stringify({ workspace, browser: { searchEngine, memorySaverEnabled } }),
        row.tenant,
      );
    }
    createWorkspaceItems(db);
    migrateLibrarySnapshots(db);
  },
};

function writeVersion(db: Database.Database) {
  db.exec(`DROP TABLE IF EXISTS schema_version;
    CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=${version}));
    INSERT INTO schema_version(version) VALUES (${version});`);
}

export function createSchema(db: Database.Database) {
  db.transaction(() => {
    if (tableExists(db, 'schema_version')) {
      const rows = db.prepare('SELECT version FROM schema_version').all() as { version: bigint }[];
      if (rows.length !== 1) throw new RemoteKitError('internal', 'Unsupported database schema');
      let current = Number(rows[0].version);
      if (current === version) return;
      for (; current < version; current++) {
        const migrate = migrations[current];
        if (!migrate) throw new RemoteKitError('internal', 'Unsupported database schema');
        migrate(db);
      }
      if (current !== version) throw new RemoteKitError('internal', 'Unsupported database schema');
      writeVersion(db);
      return;
    }
    if (tableExists(db, 'users')) throw new RemoteKitError('internal', 'Unsupported database schema');
    db.exec(`CREATE TABLE view_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, tenant TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, last_login_at INTEGER, disabled_at INTEGER);
      CREATE TABLE auth_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
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
    writeVersion(db);
  })();
}
