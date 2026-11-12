import type Database from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteKitError } from '../../shared/errors';
import { baselineV12 } from './baseline-v12';
import { migrations, type MigrationContext } from './migrations';

export const currentVersion = 19;
export interface MigrationOptions extends MigrationContext {
  backupDirectory: string;
  buildId: string;
}

function unsupported(detail: string): never {
  throw new RemoteKitError('internal', '数据库版本不受支持', { reason: 'unsupported_schema', detail });
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
    `control-v${from}-to-v${currentVersion}-${buildId}-${timestamp}.db`,
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
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const fresh = tables.length === 0;
  let version = 12;
  if (!fresh) {
    if (!tables.some((table) => table.name === 'schema_version'))
      unsupported('Non-empty database without schema_version');
    const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number | bigint }[];
    if (rows.length !== 1) unsupported('schema_version must have exactly one row');
    version = Number(rows[0].version);
    if (!Number.isInteger(version) || version < 12 || version > currentVersion)
      unsupported(`schema_version=${version}`);
    if (version === currentVersion) return;
    backup(db, version, options);
  }
  db.transaction(() => {
    if (fresh) db.exec(baselineV12);
    for (const step of migrations) {
      if (step.version <= version) continue;
      try {
        step.up(db, options);
      } catch (cause) {
        throw new RemoteKitError('internal', '数据库迁移失败', {
          detail: `Migration ${step.version} (${step.name}): ${(cause as Error).message}`,
          cause,
        });
      }
    }
    db.prepare('UPDATE schema_version SET version=?').run(currentVersion);
  })();
  if (db.pragma('integrity_check', { simple: true }) !== 'ok')
    throw new RemoteKitError('internal', '数据库完整性检查失败', { reason: 'integrity_check' });
}
