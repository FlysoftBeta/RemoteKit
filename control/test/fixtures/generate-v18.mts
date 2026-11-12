import Sqlite from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrations } from '../../server/persistence/migrations';
import { AtRestKey } from '../../server/auth/crypto';

const db = new Sqlite(':memory:');
db.exec(readFileSync(new URL('./control-v16.sql', import.meta.url), 'utf8'));
const keyPath = fileURLToPath(new URL('../../../develop/tmp/fixture-v18.key', import.meta.url));
mkdirSync(dirname(keyPath), { recursive: true });
writeFileSync(keyPath, Buffer.alloc(32, 7));
const key = new AtRestKey(keyPath);
for (const step of migrations) if (step.version > 16 && step.version <= 18) step.up(db, { atRestKey: key });
db.exec('UPDATE schema_version SET version=18');
const quote = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
};
const tables = db
  .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string; sql: string }[];
let sql = 'PRAGMA foreign_keys=OFF;\n' + tables.map((table) => table.sql + ';').join('\n') + '\n';
for (const table of tables)
  for (const row of db.prepare(`SELECT * FROM ${table.name}`).all() as Record<string, unknown>[])
    sql += `INSERT INTO ${table.name} VALUES (${Object.values(row).map(quote).join(',')});\n`;
for (const row of db
  .prepare(
    "SELECT sql FROM sqlite_schema WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name",
  )
  .all() as { sql: string }[])
  sql += row.sql + ';\n';
writeFileSync(new URL('./control-v18.sql', import.meta.url), sql + 'PRAGMA foreign_keys=ON;\n');
db.close();
