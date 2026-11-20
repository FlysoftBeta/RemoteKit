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
import { AtRestKey } from '../server/auth/crypto';
import { ControlDatabase } from '../server/persistence/database';
import { migrations, migrate } from '../server/persistence/migrations';
import { RemoteKitError } from '../shared/errors';
import { checkIntegrity } from '../server/persistence/integrity';
import { registerUser } from './server-fixture';
import { FaceVault, defaultAuthSettings } from '../server/auth/crypto';
const fixture = readFileSync(new URL('./fixtures/control-v23.sql', import.meta.url), 'utf8');
const schema = (db: Sqlite.Database) =>
  db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();

test('v23 face vectors migrate once with the existing key and AAD to strict v2 galleries', () => {
  const db = new Sqlite(':memory:');
  const key = new AtRestKey(null);
  const vault = new FaceVault(key);
  const vector = [1, ...Array(127).fill(0)];
  const sealed = key.seal(JSON.stringify(['user', 'model']), Buffer.from(JSON.stringify(vector)));
  db.exec(fixture);
  db.prepare('INSERT INTO users(id,username,tenant,salt,password_hash) VALUES (?,?,?,?,?)').run(
    'user',
    'user',
    'tenant',
    'salt',
    'hash',
  );
  db.prepare('INSERT INTO user_security VALUES (?,?,NULL,NULL,?,?)').run(
    'user',
    JSON.stringify(defaultAuthSettings()),
    sealed,
    'model',
  );
  const before = Date.now();
  try {
    assert.throws(() => vault.open('user', sealed, 'model'), { reason: 'corrupt_record' });
    migrate(db, { backupDirectory: '', buildId: 'test', atRestKey: key });
    const row = db.prepare('SELECT face_ciphertext FROM user_security').get() as { face_ciphertext: string };
    const gallery = vault.open('user', row.face_ciphertext, 'model');
    assert.deepEqual(gallery, {
      version: 2,
      templates: [{ source: 'enrolled', vector, addedAt: gallery.templates[0].addedAt }],
    });
    assert(gallery.templates[0].addedAt >= before && gallery.templates[0].addedAt <= Date.now());
    assert.throws(() => vault.open('other', row.face_ciphertext, 'model'), { reason: 'corrupt_record' });
    migrate(db, { backupDirectory: '', buildId: 'test', atRestKey: key });
    assert.deepEqual(db.prepare('SELECT face_ciphertext FROM user_security').get(), row);
    for (const malformed of [
      vector,
      { ...gallery, version: 1 },
      { ...gallery, extra: true },
      { ...gallery, templates: [] },
      { ...gallery, templates: [{ source: 'learned', vector, addedAt: 1 }] },
      { ...gallery, templates: [{ source: 'enrolled', vector, addedAt: 1.5 }] },
      { ...gallery, templates: [{ source: 'enrolled', vector, addedAt: 1, extra: true }] },
      { ...gallery, templates: [{ source: 'enrolled', vector: vector.map((n) => n * 1.002), addedAt: 1 }] },
      { ...gallery, templates: Array(6).fill(gallery.templates[0]) },
      {
        ...gallery,
        templates: [gallery.templates[0], ...Array(5).fill({ source: 'learned', vector, addedAt: 1 })],
      },
    ]) {
      const invalid = key.seal(JSON.stringify(['user', 'model']), Buffer.from(JSON.stringify(malformed)));
      assert.throws(() => vault.open('user', invalid, 'model'), { reason: 'corrupt_record' });
      assert.throws(() => vault.seal('user', malformed as never, 'model'), { reason: 'corrupt_record' });
    }
  } finally {
    db.close();
  }
});

test('invalid v1 faces roll back the entire numbered migration', () => {
  const db = new Sqlite(':memory:');
  db.exec(fixture);
  db.prepare('INSERT INTO users(id,username,tenant,salt,password_hash) VALUES (?,?,?,?,?)').run(
    'user',
    'user',
    'tenant',
    'salt',
    'hash',
  );
  db.prepare('INSERT INTO user_security VALUES (?,?,NULL,NULL,?,?)').run(
    'user',
    JSON.stringify(defaultAuthSettings()),
    'broken',
    'model',
  );
  try {
    assert.throws(
      () => migrate(db, { backupDirectory: '', buildId: 'test', atRestKey: new AtRestKey(null) }),
      /migration failed/i,
    );
    assert.deepEqual(db.prepare('SELECT version FROM schema_version').get(), { version: 23 });
    assert.deepEqual(db.prepare('SELECT face_ciphertext FROM user_security').get(), {
      face_ciphertext: 'broken',
    });
  } finally {
    db.close();
  }
});

test('v25 migrates bindings as an empty table and rejects malformed schema versions', () => {
  const db = new Sqlite(':memory:');
  const options = { backupDirectory: '', buildId: 'test', atRestKey: new AtRestKey(null) };
  try {
    db.exec(
      'CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (25); CREATE TABLE user_security (user_id TEXT, face_ciphertext TEXT, face_model TEXT)',
    );
    migrate(db, options);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version').all(), [{ version: 27 }]);
    assert.deepEqual(db.prepare('SELECT * FROM session_node_bindings').all(), []);
    db.prepare('UPDATE schema_version SET version=?').run('26bad');
    assert.throws(() => migrate(db, options), { reason: 'corrupt_state' });
  } finally {
    db.close();
  }
});

test('release v23 migrates durable retry state and keeps a verified backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-v23-'));
  const path = join(directory, 'control.db');
  const release = new Sqlite(path);
  release.exec(fixture);
  const before = schema(release);
  const version = release.pragma('schema_version', { simple: true });
  release.close();
  try {
    const store = new ControlDatabase(path, { buildId: 'test' });
    try {
      assert(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='retry_units'").get());
      assert.equal(schema(store.db).length, before.length + 3);
      assert(Number(store.db.pragma('schema_version', { simple: true })) > Number(version));
      assert.deepEqual(store.db.prepare('SELECT version FROM schema_version').all(), [{ version: 27n }]);
      assert.equal(existsSync(join(directory, 'backups')), true);
    } finally {
      store.db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('numbered runner backs up, retains three copies, and rolls back a failed future step', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rk-runner-'));
  const path = join(directory, 'control.db');
  const backupDirectory = join(directory, 'backups');
  const db = new Sqlite(path);
  db.exec(fixture);
  const before = schema(db);
  mkdirSync(backupDirectory);
  for (let index = 0; index < 4; index++) {
    const backup = join(backupDirectory, `control-v23-to-v24-test-${index}.db`);
    copyFileSync(path, backup);
    utimesSync(backup, index + 1, index + 1);
  }
  writeFileSync(join(backupDirectory, 'keep.txt'), 'keep');
  migrations.push({
    version: 28,
    name: 'future-test',
    up(database) {
      database.exec('CREATE TABLE future_step(id TEXT)');
      throw new Error('fixture failure');
    },
  });
  try {
    const options = { backupDirectory, buildId: 'test', atRestKey: new AtRestKey(null) };
    assert.throws(() => migrate(db, options), /migration failed/i);
    assert.deepEqual(schema(db), before);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version').get(), { version: 23 });
    assert.equal(readdirSync(backupDirectory).filter((name) => name.endsWith('.db')).length, 3);
    assert.ok(existsSync(join(backupDirectory, 'keep.txt')));
    const copy = new Sqlite(
      join(
        backupDirectory,
        readdirSync(backupDirectory).find((name) => /^control-v23-to-v28-test-.*T.*Z\.db$/.test(name))!,
      ),
      { readonly: true },
    );
    try {
      assert.equal(copy.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(schema(copy), before);
    } finally {
      copy.close();
    }
  } finally {
    migrations.pop();
    db.close();
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
