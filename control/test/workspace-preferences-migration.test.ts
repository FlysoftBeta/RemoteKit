import assert from 'node:assert/strict';
import test from 'node:test';
import Sqlite from 'better-sqlite3';
import { AtRestKey } from '../server/auth/crypto';
import { baseline } from '../server/persistence/baseline';
import { decodeJson } from '../server/persistence/codec';
import { action, pending, settings, space } from '../server/persistence/documents';
import { migrate } from '../server/persistence/migrations';
import { defaultSettings } from '../server/persistence/workspaces';

const options = { backupDirectory: '', buildId: 'test', atRestKey: new AtRestKey(null) };
function oldDatabase() {
  const db = new Sqlite(':memory:');
  db.exec(baseline);
  db.exec('UPDATE schema_version SET version=29');
  const { reduceMotion, ...workspace } = defaultSettings().workspace;
  const oldSettings = {
    browser: defaultSettings().browser,
    workspace: { ...workspace, topDeadZone: 'auto' },
  };
  const oldSpace = {
    id: 'space',
    windowIds: ['window'],
    weights: [1],
    focusedWindowId: 'window',
    lastActiveAt: 0,
  };
  db.prepare('INSERT INTO workspace_spaces VALUES (?,?,?,?)').run(
    'space',
    'tenant',
    0,
    JSON.stringify(oldSpace),
  );
  db.prepare('INSERT INTO user_settings VALUES (?,?)').run('tenant', JSON.stringify(oldSettings));
  db.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run(
    'tenant',
    0,
    null,
    JSON.stringify({
      pendingClose: {
        id: 'tab',
        browserIncarnation: 'browser',
        instance: '1',
        document: '1',
        awaiting: true,
      },
      pendingWindowCloseId: 'window',
    }),
  );
  for (const [id, command] of [
    ['close', { type: 'space.close', spaceId: 'space' }],
    ['settings', { type: 'settings.update', settings: { workspace: { topDeadZone: 24, uiScale: 1.5 } } }],
  ] as const)
    db.prepare('INSERT INTO operation_receipts VALUES (?,?,?,?)').run(
      'tenant',
      id,
      JSON.stringify(command),
      '{}',
    );
  return { db, oldSettings, oldSpace };
}
test('v29 spaces, settings and saved actions migrate once into strict v30 documents', () => {
  const { db, oldSettings, oldSpace } = oldDatabase();
  try {
    assert.throws(() => decodeJson(JSON.stringify(oldSettings), settings, 'settings'));
    assert.throws(() => decodeJson(JSON.stringify(oldSpace), space, 'space'));
    migrate(db, options);
    const storedPending = decodeJson(
      (db.prepare('SELECT pending FROM workspaces').get() as { pending: string }).pending,
      pending,
      'pending',
    );
    assert.equal(storedPending.pendingClose?.id, 'tab');
    assert.ok(storedPending.pendingClose!.enteredAt > 0);
    assert.equal(storedPending.pendingClose!.observationEpoch, '');
    assert.equal(storedPending.pendingClose!.observationSequence, '0');
    const storedSpace = (db.prepare('SELECT data FROM workspace_spaces').get() as { data: string }).data;
    assert.deepEqual(decodeJson(storedSpace, space, 'space'), { ...oldSpace, name: null });
    const storedSettings = (db.prepare('SELECT data FROM user_settings').get() as { data: string }).data;
    assert.deepEqual(decodeJson(storedSettings, settings, 'settings'), defaultSettings());
    const rows = db.prepare('SELECT id,payload FROM operation_receipts ORDER BY id').all() as {
      id: string;
      payload: string;
    }[];
    assert.deepEqual(
      rows.map((row) => decodeJson(row.payload, action, row.id)),
      [
        { type: 'space.close', spaceIds: ['space'] },
        { type: 'settings.update', settings: { workspace: { uiScale: 1.5 } } },
      ],
    );
    migrate(db, options);
    assert.deepEqual(db.prepare('SELECT id,payload FROM operation_receipts ORDER BY id').all(), rows);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version').get(), { version: 32 });
  } finally {
    db.close();
  }
});
for (const table of ['workspaces', 'workspace_spaces', 'user_settings', 'operation_receipts']) {
  test(`v30 migration rolls back every document when ${table} write fails, then retries`, () => {
    const { db } = oldDatabase();
    const before = ['workspaces', 'workspace_spaces', 'user_settings', 'operation_receipts'].map((name) =>
      db.prepare(`SELECT * FROM ${name}`).all(),
    );
    try {
      db.exec(
        `CREATE TRIGGER fail_migration BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'injected write failure'); END`,
      );
      assert.throws(() => migrate(db, options), { reason: 'corrupt_state' });
      assert.deepEqual(db.prepare('SELECT version FROM schema_version').get(), { version: 29 });
      assert.deepEqual(
        ['workspaces', 'workspace_spaces', 'user_settings', 'operation_receipts'].map((name) =>
          db.prepare(`SELECT * FROM ${name}`).all(),
        ),
        before,
      );
      db.exec('DROP TRIGGER fail_migration');
      migrate(db, options);
      assert.deepEqual(db.prepare('SELECT version FROM schema_version').get(), { version: 32 });
    } finally {
      db.close();
    }
  });
}
