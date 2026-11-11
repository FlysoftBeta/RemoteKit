import type Database from 'better-sqlite3';
import { isDocument } from '../learning/document-type';
import { writeLibrary } from './relational-library';
import type { LibrarySnapshot } from '../../shared/file-library';
import { defaultAuthSettings, type AtRestKey } from '../auth/crypto';
import { decodeJson, encodeJson, jsonValue, object, string } from './codec';
import { authSettings, selection, action, librarySnapshot } from './documents';
import { learningKeyInfo, openLearningDocument } from './sealed-documents';

export interface MigrationContext {
  atRestKey: AtRestKey;
}

export const migrations: {
  version: number;
  name: string;
  up(db: Database.Database, context: MigrationContext): void;
}[] = [
  {
    version: 13,
    name: 'keyboard-and-document-renders',
    up(db) {
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
      db.exec(`CREATE TABLE object_render_failures (
    source_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state='failed'),
    reason TEXT NOT NULL, message TEXT NOT NULL, failed_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL, retry_at INTEGER, node_id TEXT);
    CREATE INDEX learning_downloads_object ON learning_downloads(object_id);
    ALTER TABLE learning_downloads ADD COLUMN document INTEGER NOT NULL DEFAULT 0;`);
      const update = db.prepare('UPDATE learning_downloads SET document=? WHERE tenant=? AND key=?');
      const entries = db
        .prepare(
          `SELECT d.tenant,d.key,json_extract(e.value,'$.name') AS name
    FROM learning_downloads d JOIN file_library l ON l.tenant=d.tenant,
    json_each(l.snapshot,'$.entries') e WHERE json_extract(e.value,'$.id')=d.entry_id`,
        )
        .all() as {
        tenant: string;
        key: string;
        name: string;
      }[];
      for (const entry of entries)
        update.run(Number(isDocument(entry.name, Buffer.alloc(0))), entry.tenant, entry.key);
    },
  },
  {
    version: 14,
    name: 'placement-state-constraint',
    up(db) {
      db.exec(`ALTER TABLE session_placements RENAME TO session_placements_old;
      CREATE TABLE session_placements (
        tenant TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, node_id TEXT NOT NULL,
        placement_epoch INTEGER NOT NULL, key_ciphertext TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','hibernating','hibernated')),
        checkpoint_id INTEGER);
      INSERT INTO session_placements SELECT * FROM session_placements_old;
      DROP TABLE session_placements_old;`);
    },
  },
  {
    version: 15,
    name: 'structured-errors',
    up(db) {
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
    },
  },
  {
    version: 16,
    name: 'clipboard-snippets',
    up(db) {
      db.exec(`CREATE TABLE library_snippets (
    entry_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, text TEXT NOT NULL,
    hash TEXT NOT NULL, origin TEXT NOT NULL, copied_at INTEGER NOT NULL,
    UNIQUE(tenant,hash));`);
      for (const row of db.prepare('SELECT tenant,data FROM user_settings').all() as {
        tenant: string;
        data: string;
      }[]) {
        const settings = JSON.parse(row.data);
        settings.workspace.clipboardSync = true;
        db.prepare('UPDATE user_settings SET data=? WHERE tenant=?').run(
          JSON.stringify(settings),
          row.tenant,
        );
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
  },
  {
    version: 17,
    name: 'typed-documents-and-relational-library',
    up(db, { atRestKey }) {
      const accounts = db.prepare('SELECT tenant,provider,sealed FROM learning_accounts').all() as {
        tenant: string;
        provider: string;
        sealed: string;
      }[];
      const accountKey = accounts.length ? atRestKey.derive(learningKeyInfo) : undefined;
      const xinjiaoyuSession = object(
        { token: string(), accessToken: string() },
        {
          cookie: string(),
          clientSessionId: string(),
          safeCode: string(),
          device: string(),
          deviceType: string(),
          userAgent: string(),
          acceptLanguage: string(),
          secChUa: string(),
          secChUaMobile: string(),
          secChUaPlatform: string(),
        },
      );
      db.exec(`ALTER TABLE learning_accounts RENAME TO learning_accounts_old;
        CREATE TABLE learning_accounts (
          tenant TEXT NOT NULL, provider TEXT NOT NULL, sealed TEXT,
          display_name TEXT NOT NULL, username TEXT NOT NULL, status TEXT NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY(tenant,provider),
          CHECK(sealed IS NOT NULL OR status='expired'));
        INSERT INTO learning_accounts SELECT * FROM learning_accounts_old;
        DROP TABLE learning_accounts_old;`);
      for (const row of accounts) {
        if (row.provider !== 'xinjiaoyu') continue;
        const session = openLearningDocument(
          accountKey!,
          row.tenant,
          'xinjiaoyu',
          row.sealed,
          xinjiaoyuSession,
        );
        if (session.device === undefined || session.deviceType === undefined) {
          db.prepare(
            "UPDATE learning_accounts SET sealed=NULL,status='expired' WHERE tenant=? AND provider=?",
          ).run(row.tenant, row.provider);
        }
      }
      for (const row of db.prepare('SELECT user_id,settings FROM user_security').all() as {
        user_id: string;
        settings: string;
      }[]) {
        const value = decodeJson(row.settings, jsonValue, `user_security.settings ${row.user_id}`);
        db.prepare('UPDATE user_security SET settings=? WHERE user_id=?').run(
          encodeJson(
            { ...defaultAuthSettings(), ...(value as object) },
            authSettings,
            `user_security.settings ${row.user_id}`,
          ),
          row.user_id,
        );
      }
      for (const row of db
        .prepare('SELECT tenant,pending FROM workspaces WHERE pending IS NOT NULL')
        .all() as { tenant: string; pending: string }[]) {
        const value = JSON.parse(row.pending);
        value.pendingClose ??= null;
        value.pendingWindowCloseId ??= null;
        db.prepare('UPDATE workspaces SET pending=? WHERE tenant=?').run(JSON.stringify(value), row.tenant);
      }
      db.prepare(
        'UPDATE workspaces SET pending=\'{"pendingClose":null,"pendingWindowCloseId":null}\' WHERE pending IS NULL',
      ).run();
      for (const row of db.prepare('SELECT tenant,id,manifest FROM file_library_selections').all() as {
        tenant: string;
        id: string;
        manifest: string;
      }[]) {
        const manifest = decodeJson(
          row.manifest,
          jsonValue,
          `file_library_selections.manifest ${row.tenant}/${row.id}`,
        ) as Record<string, unknown>;
        if (manifest.limits === undefined) {
          manifest.limits = { maxFileBytes: 268435456, maxBatchBytes: 536870912, maxFiles: 64 };
          db.prepare('UPDATE file_library_selections SET manifest=? WHERE tenant=? AND id=?').run(
            encodeJson(
              manifest,
              selection as import('./codec').Codec<unknown>,
              `file_library_selections.manifest ${row.tenant}/${row.id}`,
            ),
            row.tenant,
            row.id,
          );
        }
      }
      for (const row of db.prepare('SELECT tenant,id,payload FROM operation_receipts').all() as {
        tenant: string;
        id: string;
        payload: string;
      }[]) {
        const payload = decodeJson(
          row.payload,
          jsonValue,
          `operation_receipts.payload ${row.tenant}/${row.id}`,
        ) as Record<string, any>;
        if (payload.type === 'settings.update' && payload.settings?.memorySaverEnabled !== undefined) {
          payload.settings.browser = {
            ...payload.settings.browser,
            memorySaverEnabled: payload.settings.memorySaverEnabled,
          };
          delete payload.settings.memorySaverEnabled;
          db.prepare('UPDATE operation_receipts SET payload=? WHERE tenant=? AND id=?').run(
            encodeJson(
              payload,
              action as import('./codec').Codec<unknown>,
              `operation_receipts.payload ${row.tenant}/${row.id}`,
            ),
            row.tenant,
            row.id,
          );
        }
      }
      const renderColumns = db.pragma('table_info(object_render_failures)') as { name: string }[];
      const buildId = renderColumns.some((column) => column.name === 'build_id') ? 'build_id' : "'unknown'";
      db.exec(`ALTER TABLE object_render_failures RENAME TO object_render_failures_old;
      CREATE TABLE object_render_failures (
        source_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state='failed'),
        reason TEXT NOT NULL, message TEXT NOT NULL, failed_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL, retry_at INTEGER, node_id TEXT, build_id TEXT NOT NULL, display_reason TEXT);
      INSERT INTO object_render_failures SELECT source_id,state,reason,message,failed_at,attempts,retry_at,node_id,${buildId},display_reason FROM object_render_failures_old;
      DROP TABLE object_render_failures_old;`);

      db.exec(`CREATE TABLE library_state (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, basket_partition_id TEXT);
    CREATE TABLE library_entries (tenant TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(tenant,id));
    CREATE TABLE library_entry_objects (tenant TEXT NOT NULL, entry_id TEXT NOT NULL, object_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(tenant,entry_id,object_id,role), FOREIGN KEY(tenant,entry_id) REFERENCES library_entries(tenant,id) ON DELETE CASCADE);
    CREATE INDEX library_entry_objects_object ON library_entry_objects(object_id);
    CREATE INDEX library_entries_order ON library_entries(tenant,created_at DESC,position);
    CREATE TABLE library_partitions (tenant TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,id));
    CREATE TABLE library_basket (tenant TEXT NOT NULL, position INTEGER NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(tenant,position));
    CREATE TABLE library_excluded_sources (tenant TEXT NOT NULL, source TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(tenant,source));`);
      for (const row of db.prepare('SELECT tenant,snapshot FROM file_library').all() as {
        tenant: string;
        snapshot: string;
      }[]) {
        const value = decodeJson(
          row.snapshot,
          jsonValue,
          `file_library.snapshot ${row.tenant}`,
        ) as LibrarySnapshot;
        // Materialize fields written optionally by historical library producers.
        for (const entry of value.entries) {
          entry.kind ??= 'file';
          entry.partitionId ??= null;
          if (entry.kind === 'snippet' && !entry.id) throw new Error('Snippet without entry id');
        }
        writeLibrary(
          db,
          row.tenant,
          decodeJson(JSON.stringify(value), librarySnapshot, `file_library.snapshot ${row.tenant}`),
        );
      }
      db.exec('DROP TABLE file_library');

      db.exec(
        'ALTER TABLE library_snippets DROP COLUMN origin; ALTER TABLE download_import_failures DROP COLUMN error; DROP TABLE schema_version; CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (16);',
      );
    },
  },
];
