import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { computeFrecency, type UsageEvent } from '../../../control/server/workspace/frecency.ts';
const Database = createRequire(new URL('../../../control/package.json', import.meta.url))(
  'better-sqlite3',
) as typeof DatabaseType;
const db = new Database(process.argv[2], { readonly: true });
const rows = db
  .prepare('SELECT at,item,window_id windowId,chain,title FROM usage_events ORDER BY at,id')
  .all() as UsageEvent[];
const now = Date.now();
const scores = computeFrecency(rows, now);
console.log('EVENTS');
let last = rows[0]?.at ?? 0;
for (const row of rows) {
  console.log(
    `+${((row.at - last) / 1000).toFixed(1).padStart(6)}s ${row.chain.slice(0, 6)} ${row.item.slice(0, 70)} | ${row.title ?? ''}`,
  );
  last = row.at;
}
console.log('\nSCORES (item, score, returns, listed?)');
for (const [item, s] of [...scores].sort((a, b) => b[1].score - a[1].score))
  console.log(
    `${s.score.toFixed(3).padStart(7)} r=${s.returns} ${s.returns >= 2 || !item.startsWith('page:') ? 'LISTED' : 'hidden'} ${item.slice(0, 80)}`,
  );

db.close();
