import Sqlite from 'better-sqlite3';
import { migrate } from '../server/persistence/migrations';
import { baseline } from '../server/persistence/baseline';
import { AtRestKey } from '../server/auth/crypto';
import type { OwnerFactory } from './retry-loop-boundary';

export const driveFailureMigration: OwnerFactory = (boundary, t) => {
  let db: Sqlite.Database;
  let error: unknown;
  const run = () => {
    db = new Sqlite(':memory:');
    db.defaultSafeIntegers(true);
    db.exec(baseline);
    db.exec('DROP TABLE retry_units; UPDATE schema_version SET version=23');
    const prepare = db.prepare.bind(db);
    t.mock.method(db, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (sql !== 'SELECT * FROM object_render_failures') return statement;
      return Object.assign(statement, {
        all: () =>
          boundary.readStoredFailure({ query: sql }, (code) =>
            code
              ? [
                  {
                    source_id: 'a'.repeat(64),
                    reason: code,
                    message: 'stored failure',
                    display_reason: null,
                    failed_at: Date.now(),
                    attempts: 2,
                    build_id: 'build',
                  },
                ]
              : [],
          ),
      });
    });
    migrate(db, { backupDirectory: '', buildId: 'build', atRestKey: new AtRestKey(null) });
    const row = db.prepare('SELECT record FROM retry_units').get() as { record: string } | undefined;
    error = row ? JSON.parse(row.record).error : undefined;
  };
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      db.close();
      run();
    },
    error: () => error,
    dispose: () => {
      db.close();
    },
  };
};
