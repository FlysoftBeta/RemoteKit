import type Sqlite from 'better-sqlite3';
import { corruptRecord } from './codec';
import { decodeSealedRecord } from './sealed-documents';

const sealedColumns = new Set([
  'cluster_object_secret.ciphertext',
  'session_placements.key_ciphertext',
  'user_security.face_ciphertext',
  'session_import_keys.private_key',
  'learning_accounts.sealed',
  'session_import_pairing.code',
  'session_imports.payload',
  'session_event_inbox.payload',
]);

const enumerations: Record<string, readonly (string | bigint)[]> = {
  'users.is_admin': [0n, 1n],
  'session_placements.run_state': ['running', 'stopped'],
  'session_placements.data_state': ['clean', 'dirty'],
  'session_placements.transfer_pending': [0n, 1n],
  'session_imports.state': ['pending', 'applied', 'failed', 'discarded'],
  'session_import_events.direction': ['in', 'out'],
  'learning_accounts.provider': ['changyan', 'xinjiaoyu'],
  'learning_accounts.status': ['signed_in', 'expired'],
  'learning_downloads.state': ['saved', 'retained', 'dismissed', 'failed', 'pending'],
  'learning_downloads.document': [0n, 1n],
  'library_entries.kind': ['file', 'snippet'],
  'file_library_selections.terminal': ['selected', 'cancelled'],
  'file_library_selections.checked': [0n, 1n],
  'object_derivations.kind': ['thumbnail', 'document'],
  'object_render_failures.state': ['failed'],
};

// SQLite affinity does not constrain the stored type. Validate native rows before repositories use them.
export function strictSqlite(db: Sqlite.Database): void {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!statement.reader) return statement;
    const columns = statement.columns();
    const validate = (row: unknown) => {
      if (row === undefined) return row;
      const input = row as Record<string, unknown>;
      for (const column of columns) {
        const value = input[column.name];
        if (value === null || column.type === null) continue;
        const type = column.type.toUpperCase();
        const where = `${column.table}.${column.column}`;
        const dwellDuration = where === 'page_dwell.visible_ms';
        const valid = dwellDuration
          ? (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) ||
            (typeof value === 'number' &&
              Number.isFinite(value) &&
              value >= 0 &&
              value <= Number.MAX_SAFE_INTEGER)
          : type === 'TEXT'
            ? typeof value === 'string'
            : type === 'INTEGER'
              ? typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value))
              : type === 'REAL'
                ? typeof value === 'number' && Number.isFinite(value)
                : type === 'BLOB'
                  ? Buffer.isBuffer(value)
                  : false;
        const maximum =
          column.table === 'clipboards' && column.column === 'revision'
            ? 9223372036854775807n
            : BigInt(Number.MAX_SAFE_INTEGER);
        if (typeof value === 'bigint' && (value < 0n || value > maximum))
          throw corruptRecord(
            `${column.table}.${column.column}`,
            new Error('integer outside safe nonnegative bounds'),
          );
        const choices = enumerations[where];
        if (!valid || (choices && !choices.includes(value as string | bigint)))
          throw corruptRecord(where, new Error(`expected ${choices ? choices.map(String).join('|') : type}`));
        if (sealedColumns.has(where)) {
          try {
            decodeSealedRecord(value);
          } catch (error) {
            throw corruptRecord(where, error);
          }
        }
      }
      return row;
    };
    const get = statement.get.bind(statement);
    const all = statement.all.bind(statement);
    const iterate = statement.iterate.bind(statement);
    statement.get = (...args: unknown[]) => validate(get(...args));
    statement.all = (...args: unknown[]) => all(...args).map(validate);
    statement.iterate = function* (...args: unknown[]) {
      for (const row of iterate(...args)) yield validate(row);
    };
    return statement;
  }) as typeof db.prepare;
}
