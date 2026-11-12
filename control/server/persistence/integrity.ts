import type Database from 'better-sqlite3';
import { RemoteKitError, wireError, type WireError } from '../../shared/errors';
import type { LearningProvider } from '../../shared/learning';
import { FaceVault, type AtRestKey } from '../auth/crypto';
import { reportError } from '../log';
import { corruptRecord, decodeJson, type Codec } from './codec';
import * as codecs from './documents';
import { learningKeyInfo, openLearningSession } from './sealed-documents';

export interface IntegrityProblem {
  kind: 'integrity' | 'foreign_key' | 'corrupt_record';
  table: string;
  key: string;
  detail: string;
  error: WireError;
}
export interface IntegrityResult {
  checkedAt: number;
  problems: IntegrityProblem[];
}
const documents: [string, string, Codec<unknown>][] = [
  ['workspace_tabs', 'data', codecs.tab],
  ['workspace_spaces', 'data', codecs.space],
  ['workspace_windows', 'state', codecs.windowState],
  ['workspaces', 'pending', codecs.pending],
  ['user_settings', 'data', codecs.settings],
  ['site_preferences', 'data', codecs.site],
  ['installed_apps', 'data', codecs.app],
  ['favorites', 'data', codecs.favorite],
  ['operation_receipts', 'payload', codecs.action],
  ['operation_receipts', 'receipt', codecs.receipt],
  ['user_security', 'settings', codecs.authSettings],
  ['library_entries', 'data', codecs.libraryEntry],
  ['library_partitions', 'data', codecs.partition],
  ['library_excluded_sources', 'source', codecs.librarySource],
  ['file_library_selections', 'manifest', codecs.selection],
  ['session_imports', 'sites', codecs.sites],
  ['session_imports', 'storage_job', codecs.storageJob],
  ['session_imports', 'apply_counts', codecs.applyCounts],
  ['session_import_events', 'body', codecs.eventBody],
];

export function checkIntegrity(
  db: Database.Database,
  key: AtRestKey,
  checkedAt = Date.now(),
): IntegrityResult {
  const problems: IntegrityProblem[] = [];
  const add = (problem: Omit<IntegrityProblem, 'error'>) => {
    if (problems.length < 200)
      problems.push({
        ...problem,
        error: wireError(
          reportError(
            new RemoteKitError('internal', '持久化记录未能通过校验', { detail: problem.detail }),
            'store.integrity_problem',
            { table: problem.table, key: problem.key },
          ),
        ),
      });
  };
  const quick = db.pragma('quick_check') as Record<string, unknown>[];
  for (const row of quick) {
    const detail = String(Object.values(row)[0]);
    if (detail !== 'ok') add({ kind: 'integrity', table: 'sqlite', key: '', detail });
  }
  if (problems.length)
    throw new RemoteKitError('internal', '数据库完整性检查失败', {
      reason: 'integrity_check',
      detail: problems.map((problem) => problem.detail).join('; '),
    });
  for (const row of db.pragma('foreign_key_check') as {
    table: string;
    rowid: number | bigint;
    parent: string;
    fkid: number | bigint;
  }[])
    add({
      kind: 'foreign_key',
      table: row.table,
      key: String(row.rowid),
      detail: `parent=${row.parent} foreign_key=${row.fkid}`,
    });
  function inspect(table: string, rowKey: string, read: () => unknown) {
    try {
      read();
    } catch (error) {
      add({
        kind: 'corrupt_record',
        table,
        key: rowKey,
        detail: error instanceof RemoteKitError ? (error.detail ?? error.message) : (error as Error).message,
      });
    }
  }
  for (const [table, column, codec] of documents) {
    const keys = (db.pragma(`table_info(${table})`) as { name: string; pk: number | bigint }[])
      .filter((field) => Number(field.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((field) => field.name);
    for (const row of db
      .prepare(
        `SELECT rowid AS _rowid,* FROM ${table}${table === 'workspaces' ? '' : ` WHERE ${column} IS NOT NULL`}`,
      )
      .iterate() as Iterable<Record<string, any>>) {
      const rowKey = keys.length ? keys.map((field) => String(row[field])).join('/') : String(row._rowid);
      inspect(table, rowKey, () => decodeJson(row[column], codec, `${table}.${column} ${rowKey}`));
    }
  }
  for (const row of db
    .prepare('SELECT * FROM user_security WHERE face_ciphertext IS NOT NULL')
    .iterate() as Iterable<any>)
    inspect('user_security', row.user_id, () =>
      new FaceVault(key).open(row.user_id, row.face_ciphertext, row.face_model),
    );
  for (const row of db
    .prepare('SELECT tenant,code FROM session_import_pairing WHERE code IS NOT NULL')
    .iterate() as Iterable<any>)
    inspect('session_import_pairing', row.tenant, () =>
      decodeJson(
        key.open('session-import-pairing:' + row.tenant, row.code).toString('utf8'),
        codecs.pairingCode,
        `session_import_pairing.code ${row.tenant}`,
      ),
    );
  for (const row of db
    .prepare('SELECT tenant,id,payload FROM session_imports WHERE payload IS NOT NULL')
    .iterate() as Iterable<any>)
    inspect('session_imports', `${row.tenant}/${row.id}`, () =>
      decodeJson(
        key.open(JSON.stringify(['session-import', row.tenant, row.id]), row.payload).toString('utf8'),
        codecs.importPayload,
        `session_imports.payload ${row.tenant}/${row.id}`,
      ),
    );
  for (const row of db
    .prepare('SELECT tenant,provider,sealed FROM learning_accounts WHERE sealed IS NOT NULL')
    .iterate() as Iterable<any>)
    inspect('learning_accounts', `${row.tenant}/${row.provider}`, () => {
      if (row.provider !== 'changyan' && row.provider !== 'xinjiaoyu')
        throw corruptRecord(
          `learning_accounts.sealed ${row.tenant}/${row.provider}`,
          new Error('$ expected known provider'),
        );
      return openLearningSession(
        key.derive(learningKeyInfo),
        row.tenant,
        row.provider as LearningProvider,
        row.sealed,
      );
    });
  return { checkedAt, problems };
}
