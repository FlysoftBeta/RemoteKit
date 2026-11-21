import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { creationIdFields, type ProductAction } from '../../shared/product';
import { operationPayload } from './operations';
import Sqlite from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteKitError, type ErrorCode } from '../../shared/errors';
import { RetryUnit } from '../../shared/retry-unit';
import { log } from '../log';
import { baseline } from './baseline';
import { corruptState, decodeJson, encodeJson } from './codec';
import { space as spaceCodec, settings as settingsCodec, pending as pendingCodec } from './documents';
import { faceTemplate, sealFaceGallery } from './sealed-documents';
import type { AtRestKey } from '../auth/crypto';

export interface MigrationContext {
  atRestKey: AtRestKey;
}
export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database, context: MigrationContext): void;
}
export const migrations: Migration[] = [
  {
    version: 24,
    name: 'durable retry units',
    up(db) {
      db.exec(
        'CREATE TABLE retry_units (owner TEXT NOT NULL, unit TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(owner,unit))',
      );
      db.exec(`CREATE TABLE object_render_failures_next (
      source_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('failed','unknown')),
      reason TEXT NOT NULL, message TEXT NOT NULL, failed_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL, retry_at INTEGER, node_id TEXT, build_id TEXT NOT NULL, display_reason TEXT);
      INSERT INTO object_render_failures_next SELECT source_id, CASE WHEN reason='outcome_unknown' THEN 'unknown' ELSE state END,
        reason,message,failed_at,attempts,retry_at,node_id,build_id,display_reason FROM object_render_failures;
      DROP TABLE object_render_failures;
      ALTER TABLE object_render_failures_next RENAME TO object_render_failures;`);
      const save = db.prepare('INSERT INTO retry_units VALUES (?,?,?)');
      for (const row of db.prepare('SELECT * FROM object_render_failures').all() as {
        source_id: string;
        reason: ErrorCode;
        message: string;
        display_reason: string | null;
        failed_at: number | bigint;
        attempts: number | bigint;
        build_id: string;
      }[]) {
        const unit = new RetryUnit({
          now: () => Number(row.failed_at),
          failed: (error) =>
            log.warn('render.failure_imported', { id: row.source_id, err: error, errorId: error.errorId }),
        });
        unit.ready(row.build_id);
        for (let attempt = 0; attempt < Math.min(21, Math.max(1, Number(row.attempts))); attempt++)
          unit.fail(new RemoteKitError(row.reason, row.message, { reason: row.display_reason ?? undefined }));
        save.run('render', row.source_id, JSON.stringify(unit.record()));
      }
      db.exec(
        "UPDATE learning_downloads SET state='unknown' WHERE json_valid(failure) AND json_extract(failure,'$.code')='outcome_unknown'",
      );
    },
  },
  {
    version: 25,
    name: 'diagnostic retention settings',
    up(db) {
      db.exec(`CREATE TABLE server_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        INSERT INTO server_settings VALUES (1,'{"version":1,"logRetentionDays":30}');`);
    },
  },
  {
    version: 26,
    name: 'session node bindings',
    up(db) {
      db.exec('CREATE TABLE session_node_bindings (tenant TEXT PRIMARY KEY, node_id TEXT NOT NULL)');
    },
  },
  {
    version: 27,
    name: 'face template galleries',
    up(db, { atRestKey }) {
      const addedAt = Date.now();
      const save = db.prepare('UPDATE user_security SET face_ciphertext=? WHERE user_id=?');
      for (const row of db
        .prepare(
          'SELECT user_id,face_ciphertext,face_model FROM user_security WHERE face_ciphertext IS NOT NULL',
        )
        .all() as {
        user_id: string;
        face_ciphertext: string;
        face_model: string;
      }[]) {
        const vector = decodeJson(
          atRestKey.open(JSON.stringify([row.user_id, row.face_model]), row.face_ciphertext).toString(),
          faceTemplate,
          `user_security.face_ciphertext ${row.user_id}`,
        );
        save.run(
          sealFaceGallery(
            atRestKey,
            row.user_id,
            {
              version: 2,
              templates: [{ source: 'enrolled', vector, addedAt }],
            },
            row.face_model,
          ),
          row.user_id,
        );
      }
    },
  },
  {
    version: 28,
    name: 'client assigned product object ids',
    up(db) {
      const save = db.prepare('UPDATE operation_receipts SET payload=? WHERE tenant=? AND id=?');
      for (const row of db.prepare('SELECT tenant,id,payload FROM operation_receipts').all() as {
        tenant: string;
        id: string;
        payload: string;
      }[]) {
        const action = JSON.parse(row.payload);
        const fields = creationIdFields(action);
        if (!fields.length) continue;
        for (const field of fields) action[field] = randomUUID();
        save.run(
          operationPayload(action as ProductAction, `operation_receipts.payload ${row.tenant}/${row.id}`),
          row.tenant,
          row.id,
        );
      }
    },
  },
  {
    version: 29,
    name: 'client assigned library partition ids',
    up(db) {
      db.exec(`CREATE TABLE library_partition_ids (tenant TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(tenant,id));
        INSERT INTO library_partition_ids SELECT tenant,id FROM library_partitions;`);
    },
  },
  {
    version: 30,
    name: 'named spaces and motion preferences',
    up(db) {
      const enteredAt = Date.now();
      const savePending = db.prepare('UPDATE workspaces SET pending=? WHERE tenant=?');
      for (const row of db.prepare('SELECT tenant,pending FROM workspaces').all() as {
        tenant: string;
        pending: string;
      }[]) {
        const pending = JSON.parse(row.pending);
        if (!pending.pendingClose) continue;
        Object.assign(pending.pendingClose, {
          enteredAt,
          observationEpoch: '',
          observationSequence: '0',
        });
        savePending.run(encodeJson(pending, pendingCodec, `workspaces.pending ${row.tenant}`), row.tenant);
      }
      const saveSpace = db.prepare('UPDATE workspace_spaces SET data=? WHERE tenant=? AND id=?');
      for (const row of db.prepare('SELECT tenant,id,data FROM workspace_spaces').all() as {
        tenant: string;
        id: string;
        data: string;
      }[]) {
        const space = JSON.parse(row.data);
        saveSpace.run(
          encodeJson({ ...space, name: null }, spaceCodec, `workspace_spaces.data ${row.tenant}/${row.id}`),
          row.tenant,
          row.id,
        );
      }
      const saveSettings = db.prepare('UPDATE user_settings SET data=? WHERE tenant=?');
      for (const row of db.prepare('SELECT tenant,data FROM user_settings').all() as {
        tenant: string;
        data: string;
      }[]) {
        const settings = JSON.parse(row.data);
        delete settings.workspace.topDeadZone;
        settings.workspace.reduceMotion = false;
        saveSettings.run(encodeJson(settings, settingsCodec, `user_settings.data ${row.tenant}`), row.tenant);
      }
      const saveAction = db.prepare('UPDATE operation_receipts SET payload=? WHERE tenant=? AND id=?');
      for (const row of db.prepare('SELECT tenant,id,payload FROM operation_receipts').all() as {
        tenant: string;
        id: string;
        payload: string;
      }[]) {
        const action = JSON.parse(row.payload);
        if (action.type === 'space.close') {
          action.spaceIds = [action.spaceId];
          delete action.spaceId;
        } else if (action.type === 'settings.update' && action.settings.workspace) {
          delete action.settings.workspace.topDeadZone;
        } else continue;
        saveAction.run(
          operationPayload(action, `operation_receipts.payload ${row.tenant}/${row.id}`),
          row.tenant,
          row.id,
        );
      }
    },
  },
  {
    version: 31,
    name: 'photo object derivative kinds',
    up(db) {
      db.exec(`CREATE TABLE object_derivations_next (
        id TEXT NOT NULL, source_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('thumbnail','preview','photo','selection-transcode','document')),
        PRIMARY KEY(id,source_id,kind));
        INSERT INTO object_derivations_next SELECT id,source_id,kind FROM object_derivations;
        DROP TABLE object_derivations;
        ALTER TABLE object_derivations_next RENAME TO object_derivations;
        CREATE INDEX object_derivations_source ON object_derivations(source_id,kind);`);
    },
  },
  {
    version: 32,
    name: 'viewer occlusion generations',
    up(db) {
      db.exec(`CREATE TABLE viewer_generations (
        tenant TEXT PRIMARY KEY,
        generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 4294967295));`);
    },
  },
];

export const currentVersion = 32;
export interface MigrationOptions extends MigrationContext {
  backupDirectory: string;
  buildId: string;
}

function backup(db: Database.Database, from: number, options: MigrationOptions) {
  if (!db.name || db.name === ':memory:') return;
  mkdirSync(options.backupDirectory, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const buildId = options.buildId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = join(
    options.backupDirectory,
    `control-v${from}-to-v${migrations[migrations.length - 1]?.version ?? currentVersion}-${buildId}-${timestamp}.db`,
  );
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  const copy = new Sqlite(path, { readonly: true, fileMustExist: true });
  try {
    const versions = copy.prepare('SELECT version FROM schema_version').all() as { version: number }[];
    if (
      copy.pragma('quick_check', { simple: true }) !== 'ok' ||
      versions.length !== 1 ||
      versions[0].version !== from
    )
      throw new Error('Migration backup verification failed');
  } finally {
    copy.close();
  }
  const files = readdirSync(options.backupDirectory)
    .filter((name) => /^control-v.*\.db$/.test(name))
    .map((name) => ({
      path: join(options.backupDirectory, name),
      time: statSync(join(options.backupDirectory, name)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time || b.path.localeCompare(a.path));
  for (const file of files.slice(3)) unlinkSync(file.path);
}

function foreignKeyViolations(db: Database.Database) {
  const counts = new Map<string, number>();
  for (const row of db.pragma('foreign_key_check') as { table: string; parent: string; fkid: number }[]) {
    const key = `${row.table}\0${row.parent}\0${row.fkid}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// Runs inside the step's transaction so a failed check rolls the version back too.
// Violations already present before migrating are reported by the startup integrity
// scan; a step may only not add to them. No step disables foreign_keys, which SQLite
// cannot toggle inside a transaction.
function verify(db: Database.Database, existing: Map<string, number>) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok')
    throw new Error('Database integrity check failed');
  for (const [key, count] of foreignKeyViolations(db))
    if (count > (existing.get(key) ?? 0))
      throw new Error(`Foreign key check failed: ${key.split('\0').join(' -> ')}`);
}

export function migrate(db: Database.Database, options: MigrationOptions) {
  const target = migrations[migrations.length - 1]?.version ?? currentVersion;
  try {
    const empty = !db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get();
    if (empty) db.transaction(() => db.exec(baseline))();
    const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number | bigint }[];
    if (rows.length !== 1 || !['number', 'bigint'].includes(typeof rows[0].version))
      throw new Error('schema_version must contain one integer');
    let version = Number(rows[0].version);
    if (!Number.isSafeInteger(version)) throw new Error('schema_version must be a safe integer');
    const pending = migrations.filter((step) => step.version > version);
    // A database created a moment ago holds nothing worth a backup.
    if (pending.length && !empty) backup(db, version, options);
    db.transaction(() => {
      const existingViolations = foreignKeyViolations(db);
      for (const step of pending) {
        if (step.version !== version + 1) throw new Error('Migration numbers must be consecutive');
        try {
          step.up(db, options);
          db.prepare('UPDATE schema_version SET version=?').run(step.version);
          verify(db, existingViolations);
        } catch (cause) {
          throw new RemoteKitError('internal', 'Database migration failed', {
            reason: 'corrupt_state',
            errorId: 'c-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10),
            detail: `Migration ${step.version} (${step.name}): ${(cause as Error).message}`,
            cause,
          });
        }
        version = step.version;
      }
      if (version !== target) throw new Error('Invalid schema_version');
    })();
  } catch (cause) {
    if (cause instanceof RemoteKitError) throw cause;
    throw corruptState('control.db', cause);
  }
}
