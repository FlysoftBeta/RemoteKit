import type Database from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteKitError, type ErrorCode } from '../../shared/errors';
import { RetryUnit } from '../../shared/retry-unit';
import { log } from '../log';
import { baseline } from './baseline';
import { corruptState } from './codec';
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
];

export const currentVersion = 24;
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
    if (pending.length) backup(db, version, options);
    db.transaction(() => {
      for (const step of pending) {
        if (step.version !== version + 1) throw new Error('Migration numbers must be consecutive');
        try {
          step.up(db, options);
        } catch (cause) {
          throw new RemoteKitError('internal', 'Database migration failed', {
            reason: 'corrupt_state',
            errorId: 'c-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10),
            detail: `Migration ${step.version} (${step.name}): ${(cause as Error).message}`,
            cause,
          });
        }
        version = step.version;
        db.prepare('UPDATE schema_version SET version=?').run(version);
      }
      if (version !== target) throw new Error('Invalid schema_version');
    })();
    if (db.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error('Database integrity check failed');
  } catch (cause) {
    if (cause instanceof RemoteKitError) throw cause;
    throw corruptState('control.db', cause);
  }
}
