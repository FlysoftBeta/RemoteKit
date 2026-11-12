import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import Sqlite from 'better-sqlite3';
import { AtRestKey } from '../server/auth/crypto';
import { baseline } from '../server/persistence/baseline';
import { baselineV12 } from '../server/persistence/baseline-v12';
import { migrations } from '../server/persistence/migrations';

test('v23 baseline exactly matches sqlite_master produced by the numbered path', () => {
  const numbered = new Sqlite(':memory:');
  const fresh = new Sqlite(':memory:');
  try {
    numbered.exec(baselineV12);
    for (const step of migrations) step.up(numbered, { atRestKey: new AtRestKey(null) });
    fresh.exec(baseline);
    const schema = (db: Sqlite.Database) =>
      db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all();
    assert.deepEqual(schema(fresh), schema(numbered));
    mkdirSync('../develop/tmp/strict', { recursive: true });
    writeFileSync(
      '../develop/tmp/strict/baseline-equivalence.json',
      JSON.stringify(
        {
          equal: true,
          sqliteMaster: schema(fresh),
        },
        null,
        2,
      ),
    );
  } finally {
    numbered.close();
    fresh.close();
  }
});
