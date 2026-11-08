import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AtRestKey, FaceVault, hashSecret } from '../server/auth/crypto';
import { ControlDatabase } from '../server/persistence/database';
import { applyRecovery, planRecovery } from '../server/recovery/credentials';
import { accountsFor, registerUser } from './server-fixture';

const template = Array.from({ length: 128 }, (_, index) => (index === 0 ? 1 : 0));

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'rk-recovery-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Overwrites the first page of every listed table so whole-database reads fail.
function damage(path: string, tables: string[]) {
  const db = new Database(path);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const size = db.pragma('page_size', { simple: true }) as number;
  const pages = tables.map(
    (name) =>
      (db.prepare('SELECT rootpage FROM sqlite_master WHERE name=?').get(name) as { rootpage: number })
        .rootpage,
  );
  db.close();
  const file = openSync(path, 'r+');
  for (const page of pages) writeSync(file, Buffer.alloc(size, 0xab), 0, size, (page - 1) * size);
  closeSync(file);
}

test('current databases recover passwords, PINs, faces and tokens despite damaged pages', async () => {
  await withDirectory(async (directory) => {
    const source = join(directory, 'old.db');
    const old = new ControlDatabase(source);
    const admin = await registerUser(old, 'admin', 'admin-password1');
    const member = await registerUser(old, 'member', 'member-password1');
    old.db
      .prepare(
        "INSERT INTO users (id,username,tenant,salt,password_hash) VALUES ('x','foreign','tx','00','md5')",
      )
      .run();
    const pin = await hashSecret('123456');
    old.security.saveSecurity(admin.user.id, {
      settings: { ...old.security.security(admin.user.id).settings, faceEnabled: true, idleSeconds: 60 },
      pin,
      face: { sealed: old.security.faceVault.seal(admin.user.id, template, 'm1'), modelVersion: 'm1' },
    });
    old.security.saveSecurity(member.user.id, {
      settings: { ...old.security.security(member.user.id).settings, faceEnabled: true },
      pin: undefined,
      face: { sealed: 'broken', modelVersion: 'm1' },
    });
    old.db.close();
    damage(source, ['workspace_tabs', 'user_settings', 'objects']);

    const plan = planRecovery(source, { tokens: true, now: Date.now() });
    assert.deepEqual(
      plan.users.map((user) => [user.username, user.isAdmin]),
      [
        ['admin', true],
        ['member', false],
      ],
    );
    assert.ok(plan.warnings.some((warning) => warning.startsWith('quick_check')));
    assert.ok(plan.skipped.some((line) => line.startsWith('foreign:')));
    assert.ok(plan.skipped.some((line) => line.startsWith('member: 人脸')));
    assert.equal(plan.users[1].settings.faceEnabled, false);

    const target = join(directory, 'new.db');
    const store = new ControlDatabase(target);
    try {
      applyRecovery(store, plan);
      await store.security.verifyPassword(admin.user.id, 'admin-password1');
      await store.security.verifyPin(admin.user.id, '123456');
      const security = store.security.security(admin.user.id);
      assert.equal(security.settings.idleSeconds, 60);
      assert.equal(security.settings.faceEnabled, true);
      assert.deepEqual(store.security.faceVault.open(admin.user.id, security.face!.sealed, 'm1'), template);
      assert.equal(store.accounts.identity(member.token)?.user.username, 'member');
      assert.equal((await accountsFor(store).login('member', 'member-password1')).user.id, member.user.id);
      assert.throws(() => applyRecovery(store, plan), /只能写入空库/);
    } finally {
      store.db.close();
    }
  });
});

test('older layouts and a damaged credential table keep whatever rows still decode', async () => {
  await withDirectory(async (directory) => {
    const source = join(directory, 'old.db');
    const key = randomBytes(32);
    writeFileSync(source + '.face-key', key);
    const password = await hashSecret('legacy-password1');
    const db = new Database(source);
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        tenant TEXT NOT NULL UNIQUE, salt TEXT, password_hash TEXT, legacy INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE user_security (user_id TEXT PRIMARY KEY, settings TEXT NOT NULL, pin_salt TEXT,
        pin_hash TEXT, face_ciphertext TEXT, face_model TEXT);
      CREATE TABLE padding (data TEXT);`);
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,0)').run(
      'u1',
      'first',
      't1',
      password.salt,
      password.hash,
    );
    db.prepare('INSERT INTO users VALUES (?,?,?,NULL,NULL,1)').run('u2', 'unset', 't2');
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,0)').run(
      'u3',
      'third',
      't3',
      password.salt,
      password.hash,
    );
    const vault = new FaceVault(new AtRestKey(source + '.face-key'));
    db.prepare('INSERT INTO user_security VALUES (?,?,NULL,NULL,?,?)').run(
      'u1',
      '{"faceEnabled":true,"idleSeconds":"bad"}',
      vault.seal('u1', template, 'm0'),
      'm0',
    );
    db.close();

    let plan = planRecovery(source, { tokens: false, now: Date.now() });
    assert.deepEqual(
      plan.users.map((user) => [user.username, user.isAdmin]),
      [
        ['first', true],
        ['third', false],
      ],
    );
    assert.ok(plan.skipped.some((line) => line.startsWith('unset:')));
    assert.deepEqual(plan.users[0].face, { template, modelVersion: 'm0' });
    assert.equal(plan.users[0].settings.idleSeconds, 300);
    assert.equal(planRecovery(source, { admin: 'THIRD', tokens: false, now: 0 }).users[1].isAdmin, true);

    damage(source, ['user_security']);
    plan = planRecovery(source, { tokens: false, now: Date.now() });
    assert.equal(plan.users.length, 2);
    assert.equal(plan.users[0].face, undefined);
    assert.ok(plan.warnings.some((warning) => warning.startsWith('user_security')));
  });
});
