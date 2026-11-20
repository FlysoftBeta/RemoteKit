import assert from 'node:assert/strict';
import test from 'node:test';
import Sqlite from 'better-sqlite3';
import { AtRestKey } from '../server/auth/crypto';
import { baseline } from '../server/persistence/baseline';
import { migrate } from '../server/persistence/migrations';
import { decodeJson } from '../server/persistence/codec';
import { action as actionCodec } from '../server/persistence/documents';
import { creationIdFields } from '../shared/product';

test('v27 creation receipts migrate explicitly to the strict client id action format', () => {
  const db = new Sqlite(':memory:');
  db.exec(baseline);
  db.exec('DROP TABLE library_partition_ids; UPDATE schema_version SET version=27');
  const actions = [
    { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
    { type: 'window.open', appId: 'web:app', placement: { mode: 'replace', windowId: 'old' } },
    {
      type: 'window.open',
      appId: 'files',
      placement: { mode: 'split', besideWindowId: 'old', side: 'left' },
    },
    { type: 'tab.create', windowId: 'window' },
    { type: 'window.place', windowId: 'window', placement: { mode: 'space' } },
    { type: 'app.install', name: 'App', startUrl: 'https://app.test/' },
    { type: 'favorite.add', url: 'https://favorite.test/', title: 'Favorite' },
    { type: 'window.focus', windowId: 'old' },
  ];
  const insert = db.prepare('INSERT INTO operation_receipts VALUES (?,?,?,?)');
  for (const [index, action] of actions.entries())
    insert.run(
      'tenant',
      String(index),
      JSON.stringify(action),
      JSON.stringify({
        operationId: String(index),
        operationGeneration: 'generation',
        status: index % 2 ? 'applying' : 'committed',
      }),
    );
  try {
    assert.throws(() => decodeJson(JSON.stringify(actions[0]), actionCodec, 'action'), {
      reason: 'corrupt_record',
    });
    assert.throws(() => decodeJson(JSON.stringify(actions[4]), actionCodec, 'action'), {
      reason: 'corrupt_record',
    });
    const receipts = db.prepare('SELECT receipt FROM operation_receipts ORDER BY id').all();
    const options = { backupDirectory: '', buildId: 'test', atRestKey: new AtRestKey(null) };
    migrate(db, options);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version').get(), { version: 31 });
    const rows = db.prepare('SELECT payload FROM operation_receipts ORDER BY id').all() as {
      payload: string;
    }[];
    const ids = new Set<string>();
    rows.forEach((row, index) => {
      const action = decodeJson(row.payload, actionCodec, 'action');
      for (const field of creationIdFields(action)) {
        const id = (action as unknown as Record<string, string>)[field];
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert(!ids.has(id));
        ids.add(id);
      }
      assert.equal(action.type, actions[index].type);
    });
    assert.deepEqual(db.prepare('SELECT receipt FROM operation_receipts ORDER BY id').all(), receipts);
    migrate(db, options);
    assert.deepEqual(db.prepare('SELECT payload FROM operation_receipts ORDER BY id').all(), rows);
  } finally {
    db.close();
  }
});
