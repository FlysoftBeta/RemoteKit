import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Sqlite from 'better-sqlite3';
import { ControlDatabase } from '../server/persistence/database';
import { migrations } from '../server/persistence/migrations';
import { RemoteKitError } from '../shared/errors';
import { checkIntegrity } from '../server/persistence/integrity';
import { migrate } from '../server/persistence/schema';
import { registerUser } from './server-fixture';
import { LearningAccounts } from '../server/learning/accounts';
import { createCipheriv, randomBytes } from 'node:crypto';
import { learningKey } from '../server/persistence/sealed-documents';

const fixture = (version: number) =>
  readFileSync(new URL(`./fixtures/control-v${version}.sql`, import.meta.url), 'utf8');

test('v19 migrates automatic reclaim settings, receipt payloads, tab defaults and statistics tables', () => {
  const db = new Sqlite(':memory:');
  const store = new ControlDatabase(':memory:', { buildId: 'fixture' });
  try {
    db.exec(fixture(19));
    migrate(db, { backupDirectory: '', buildId: 'fixture', atRestKey: store.atRestKey });
    const settings = JSON.parse(
      (db.prepare("SELECT data FROM user_settings WHERE tenant='tenant'").get() as any).data,
    );
    assert.deepEqual(settings.browser, { searchEngine: 'google' });
    const payload = JSON.parse(
      (db.prepare("SELECT payload FROM operation_receipts WHERE id='settings'").get() as any).payload,
    );
    assert.deepEqual(payload, { type: 'settings.update', settings: { browser: {} } });
    const tab = JSON.parse((db.prepare("SELECT data FROM workspace_tabs WHERE id='tab'").get() as any).data);
    assert.equal(tab.idleKeepAlive, false);
    assert.equal(db.prepare('SELECT * FROM viewer_presence').all().length, 0);
    assert.equal(db.prepare('SELECT * FROM page_dwell').all().length, 0);
  } finally {
    store.db.close();
    db.close();
  }
});

test('v18 placements migrate run/data states and persist a fresh commit identity', () => {
  const db = new Sqlite(':memory:');
  try {
    db.exec(fixture(18));
    db.prepare('DELETE FROM session_placements').run();
    for (const [index, state] of ['active', 'hibernating', 'hibernated'].entries())
      db.prepare('INSERT INTO session_placements VALUES (?,?,?,?,?,?,?)').run(
        `tenant-${index}`,
        `${index}`.repeat(32),
        'node',
        4,
        'key',
        state,
        null,
      );
    const store = new ControlDatabase(':memory:', { buildId: 'fixture' });
    try {
      migrate(db, { backupDirectory: '', buildId: 'fixture', atRestKey: store.atRestKey });
      const rows = db
        .prepare('SELECT run_state,data_state,pending_commit FROM session_placements ORDER BY tenant')
        .all() as any[];
      assert.deepEqual(
        rows.map((row) => [row.run_state, row.data_state]),
        [
          ['running', 'dirty'],
          ['stopped', 'dirty'],
          ['stopped', 'clean'],
        ],
      );
      assert.equal(rows[0].pending_commit, null);
      assert.match(rows[1].pending_commit, /^[a-f0-9-]{36}$/);
      assert.equal(rows[2].pending_commit, null);
      migrate(db, { backupDirectory: '', buildId: 'fixture', atRestKey: store.atRestKey });
      assert.equal(
        (db.prepare("SELECT pending_commit FROM session_placements WHERE tenant='tenant-1'").get() as any)
          .pending_commit,
        rows[1].pending_commit,
      );
    } finally {
      store.db.close();
    }
  } finally {
    db.close();
  }
});
function schema(db: Sqlite.Database) {
  return (
    db.prepare('SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name').all() as {
      name: string;
      sql: string;
    }[]
  ).map((row) => ({ name: row.name, sql: row.sql.replace(/\s+/g, ' ').trim() }));
}
for (const version of [12, 13, 14, 15, 16, 18, 19]) {
  test(`historical v${version} migrates with a verified backup and the fresh schema`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'rk-migration-'));
    const path = join(directory, 'control.db');
    const old = new Sqlite(path);
    old.exec(fixture(version));
    const originalSession = (
      old.prepare("SELECT sealed FROM learning_accounts WHERE provider='xinjiaoyu'").get() as {
        sealed: string;
      }
    ).sealed;
    old.close();
    writeFileSync(path + '.key', Buffer.alloc(32, 7));
    const store = new ControlDatabase(path, { buildId: 'fixture' });
    const fresh = new ControlDatabase(':memory:', { buildId: 'fixture' });
    try {
      assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 20n }]);
      assert.deepEqual(store.integrity.problems, []);
      assert.deepEqual(schema(store.db), schema(fresh.db));
      const backups = readdirSync(join(directory, 'backups'));
      assert.equal(backups.length, 1);
      assert.match(backups[0], new RegExp(`^control-v${version}-to-v20-fixture-\\d{8}T\\d{6}Z\\.db$`));
      const backup = new Sqlite(join(directory, 'backups', backups[0]), { readonly: true });
      try {
        assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
        assert.deepEqual(backup.prepare('SELECT version FROM schema_version').get(), { version });
      } finally {
        backup.close();
      }
      const snapshot = store.library.snapshot('tenant');
      assert.equal(snapshot.entries.find((entry) => entry.id === 'entry')?.kind, 'file');
      assert.equal(snapshot.basket[0], 'entry');
      assert.equal(
        (store.db.prepare('SELECT count(*) AS count FROM library_entry_objects').get() as { count: bigint })
          .count,
        3n,
      );
      assert.equal(store.security.security('user').settings.lockOnDeparture, false);
      assert.equal(
        (
          store.db.prepare("SELECT document FROM learning_downloads WHERE key='lesson'").get() as {
            document: bigint;
          }
        ).document,
        version === 12 ? 1n : 0n,
      );
      assert.equal(store.workspaces.workspace('tenant').settings.workspace.autoKeyboard, false);
      assert.equal(store.operations.operation('tenant', 'failed')!.receipt.status, 'failed');
      const accounts = new LearningAccounts(store, () => {});
      const xinjiaoyu = store.db
        .prepare(
          "SELECT sealed,status,display_name,username,updated_at FROM learning_accounts WHERE provider='xinjiaoyu'",
        )
        .get() as {
        sealed: string | null;
        status: string;
        display_name: string;
        username: string;
        updated_at: bigint;
      };
      assert.equal(xinjiaoyu.display_name, 'Xinjiaoyu Student');
      assert.equal(xinjiaoyu.username, 'xinjiaoyu-student');
      assert.equal(xinjiaoyu.updated_at, 101n);
      if (version === 12) {
        assert.equal(xinjiaoyu.sealed, null);
        assert.deepEqual(accounts.state('tenant', 'xinjiaoyu'), {
          status: 'expired',
          displayName: 'Xinjiaoyu Student',
        });
        assert.throws(() => accounts.session('tenant', 'xinjiaoyu'), { code: 'unauthenticated' });
      } else {
        assert.equal(xinjiaoyu.sealed, originalSession);
        assert.equal(xinjiaoyu.status, 'signed_in');
        assert.equal(accounts.session('tenant', 'xinjiaoyu').device, 'fixture-device');
      }
    } finally {
      fresh.db.close();
      store.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('legacy sessions missing either device field expire and permit a fresh sign-in', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-expired-session-'));
  const path = join(directory, 'control.db');
  const old = new Sqlite(path);
  const key = learningKey(Buffer.alloc(32, 7));
  const full = {
    token: 'token',
    accessToken: 'access',
    clientSessionId: 'client',
    device: 'device',
    deviceType: 'type',
  };
  old.exec(fixture(16));
  for (const [index, missing] of ['device', 'deviceType'].entries()) {
    const tenant = `tenant-${index}`;
    const session: Record<string, string> = { ...full };
    delete session[missing];
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([tenant, 'xinjiaoyu'])));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    old
      .prepare('INSERT INTO learning_accounts VALUES (?,?,?,?,?,?,?)')
      .run(tenant, 'xinjiaoyu', sealed, 'Student', 'student', 'signed_in', 102);
  }
  old.close();
  writeFileSync(path + '.key', Buffer.alloc(32, 7));
  let store = new ControlDatabase(path, { buildId: 'expired' });
  try {
    assert.deepEqual(store.integrity.problems, []);
    store.db.close();
    store = new ControlDatabase(path, { buildId: 'expired' });
    const accounts = new LearningAccounts(store, () => {});
    for (const tenant of ['tenant-0', 'tenant-1']) {
      assert.deepEqual(accounts.state(tenant, 'xinjiaoyu'), { status: 'expired', displayName: 'Student' });
      assert.equal(
        (
          store.db.prepare('SELECT sealed FROM learning_accounts WHERE tenant=?').get(tenant) as {
            sealed: null;
          }
        ).sealed,
        null,
      );
      accounts.save(tenant, 'xinjiaoyu', full);
      assert.deepEqual(accounts.session(tenant, 'xinjiaoyu'), full);
      assert.equal(accounts.state(tenant, 'xinjiaoyu').status, 'signed_in');
    }
    assert.deepEqual(checkIntegrity(store.db, store.atRestKey).problems, []);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const provider of ['changyan', 'xinjiaoyu']) {
  test(`missing at-rest key refuses migration with ${provider} accounts and leaves credentials untouched`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'rk-missing-key-'));
    const path = join(directory, 'control.db');
    const old = new Sqlite(path);
    old.exec(fixture(12));
    old.prepare('DELETE FROM learning_accounts WHERE provider<>?').run(provider);
    const before = old.prepare('SELECT * FROM learning_accounts').all();
    const beforeSchema = schema(old);
    old.close();
    try {
      assert.throws(
        () => new ControlDatabase(path, { buildId: 'missing-key' }),
        (error: unknown) =>
          error instanceof RemoteKitError &&
          error.detail!.includes('17 (typed-documents-and-relational-library)') &&
          (error.cause as NodeJS.ErrnoException).code === 'ENOENT',
      );
      assert.equal(existsSync(path + '.key'), false);
      const reopened = new Sqlite(path);
      try {
        assert.deepEqual(reopened.prepare('SELECT version FROM schema_version').get(), { version: 12 });
        assert.deepEqual(reopened.prepare('SELECT * FROM learning_accounts').all(), before);
        assert.deepEqual(schema(reopened), beforeSchema);
      } finally {
        reopened.close();
      }
      assert.equal(readdirSync(join(directory, 'backups')).length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('a wrong at-rest key refuses migration instead of expiring an unreadable session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-wrong-key-'));
  const path = join(directory, 'control.db');
  const old = new Sqlite(path);
  old.exec(fixture(12));
  const before = old.prepare('SELECT * FROM learning_accounts').all();
  old.close();
  writeFileSync(path + '.key', Buffer.alloc(32, 8));
  try {
    assert.throws(
      () => new ControlDatabase(path, { buildId: 'wrong-key' }),
      (error: unknown) =>
        error instanceof RemoteKitError && (error.cause as RemoteKitError).reason === 'corrupt_record',
    );
    const reopened = new Sqlite(path);
    try {
      assert.deepEqual(reopened.prepare('SELECT * FROM learning_accounts').all(), before);
      assert.deepEqual(reopened.prepare('SELECT version FROM schema_version').get(), { version: 12 });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a corrupt tab remains untouched, is reported at startup, and fails only its tenant request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-corrupt-'));
  const path = join(directory, 'control.db');
  let store = new ControlDatabase(path, { buildId: 'test' });
  try {
    const broken = await registerUser(store, 'broken', 'password123');
    const other = await registerUser(store, 'healthy', 'password123');
    const bad = '{"id":"tab","windowId":12}';
    store.db
      .prepare('INSERT INTO workspace_tabs VALUES (?,?,?,?,?)')
      .run('tab', broken.tenantId, 'window', 0, bad);
    store.db.close();
    store = new ControlDatabase(path, { buildId: 'test' });
    assert.equal(store.integrity.problems[0].table, 'workspace_tabs');
    assert.match(store.integrity.problems[0].detail, /workspace_tabs\.data.*expected/);
    assert.throws(
      () => store.workspaces.workspace(broken.tenantId),
      (error: unknown) => error instanceof RemoteKitError && error.reason === 'corrupt_record',
    );
    assert.equal(store.workspaces.workspace(other.tenantId).tenantId, other.tenantId);
    assert.equal(
      (store.db.prepare('SELECT data FROM workspace_tabs WHERE id=?').get('tab') as { data: string }).data,
      bad,
    );
    store.db.prepare('INSERT INTO operation_receipts VALUES (?,?,?,?)').run(broken.tenantId, 'bad', '{', '{');
    store.db.close();
    store = new ControlDatabase(path, { buildId: 'test' });
    assert.equal(store.workspaces.workspace(other.tenantId).tenantId, other.tenantId);
    assert.throws(() => store.operations.operation(broken.tenantId, 'bad'), { reason: 'corrupt_record' });
    assert.equal(
      (
        store.db.prepare('SELECT receipt FROM operation_receipts WHERE id=?').get('bad') as {
          receipt: string;
        }
      ).receipt,
      '{',
    );
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unsupported versions and nonempty unversioned databases are refused', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-unsupported-'));
  try {
    for (const [index, ddl] of [
      'CREATE TABLE anything (id TEXT)',
      ...[11, 21].map(
        (version) =>
          `CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES (${version})`,
      ),
      'CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES (17),(17)',
    ].entries()) {
      const path = join(directory, `${index}.db`);
      const db = new Sqlite(path);
      db.exec(ddl);
      db.close();
      assert.throws(() => new ControlDatabase(path, { buildId: 'test' }), { reason: 'unsupported_schema' });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed step rolls back all DDL, data, and version while retaining the backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-rollback-'));
  const path = join(directory, 'control.db');
  const db = new Sqlite(path);
  db.exec(fixture(12));
  const before = schema(db);
  db.close();
  const step = migrations.find((migration) => migration.version === 16)!;
  const original = step.up;
  const cause = new Error('fixture failure');
  step.up = (database) => {
    database.exec('CREATE TABLE failed_step(id TEXT)');
    throw cause;
  };
  try {
    assert.throws(
      () => new ControlDatabase(path, { buildId: 'test' }),
      (error: unknown) =>
        error instanceof RemoteKitError &&
        error.cause === cause &&
        error.detail!.includes('16 (clipboard-snippets)'),
    );
    const reopened = new Sqlite(path);
    try {
      assert.deepEqual(schema(reopened), before);
      assert.deepEqual(reopened.prepare('SELECT version FROM schema_version').get(), { version: 12 });
    } finally {
      reopened.close();
    }
    assert.equal(readdirSync(join(directory, 'backups')).length, 1);
  } finally {
    step.up = original;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration retains the three newest backups and leaves other files alone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-backups-'));
  const path = join(directory, 'control.db');
  const backupDirectory = join(directory, 'backups');
  const db = new Sqlite(path);
  db.exec(fixture(16));
  db.close();
  mkdirSync(backupDirectory);
  for (let index = 0; index < 5; index++) {
    const backup = join(backupDirectory, `control-v16-to-v17-old-${index}.db`);
    copyFileSync(path, backup);
    utimesSync(backup, index + 1, index + 1);
  }
  writeFileSync(join(backupDirectory, 'keep.txt'), 'keep');
  writeFileSync(path + '.key', Buffer.alloc(32, 7));
  try {
    const store = new ControlDatabase(path, { buildId: 'retention' });
    store.db.close();
    const files = readdirSync(backupDirectory);
    assert.equal(files.filter((file) => file.endsWith('.db')).length, 3);
    assert.ok(files.includes('control-v16-to-v17-old-4.db'));
    assert.ok(files.includes('control-v16-to-v17-old-3.db'));
    assert.ok(files.includes('keep.txt'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('current-schema opens do no DDL and foreign-key problems are reported', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    const schemaVersion = store.db.pragma('schema_version', { simple: true });
    migrate(store.db, { backupDirectory: '', buildId: 'test', atRestKey: store.atRestKey });
    assert.equal(store.db.pragma('schema_version', { simple: true }), schemaVersion);
    store.db.pragma('foreign_keys=OFF');
    store.db.prepare('INSERT INTO user_security(user_id,settings) VALUES (?,?)').run(
      'missing',
      JSON.stringify({
        lockOnHidden: true,
        lockOnIdle: true,
        idleSeconds: 300,
        lockOnDeparture: false,
        faceEnabled: false,
      }),
    );
    store.db.pragma('foreign_keys=ON');
    assert.ok(
      checkIntegrity(store.db, store.atRestKey).problems.some(
        (problem) => problem.kind === 'foreign_key' && problem.table === 'user_security',
      ),
    );
  } finally {
    store.db.close();
  }
});
