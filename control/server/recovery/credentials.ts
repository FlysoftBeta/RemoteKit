import Sqlite from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthSettings } from '../../shared/security';
import { AtRestKey, FaceVault, defaultAuthSettings, type SecretHash } from '../auth/crypto';
import type { ControlDatabase } from '../persistence/database';

// Every Control version stored passwords and PINs as hex scrypt(N=16384, r=8, p=1, 64 bytes)
// with a hex salt, so a hash in any other shape came from an unknown method and is dropped.
const SCRYPT_HASH = /^[0-9a-f]{128}$/;
const SALT = /^[0-9a-f]{2,128}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
// Bounds the row-by-row scan when a damaged table cannot even report its size.
const BLIND_SCAN_ROWS = 100_000;

type Row = Record<string, unknown>;

export interface RecoveredUser {
  id: string;
  username: string;
  tenant: string;
  password: SecretHash;
  isAdmin: boolean;
  lastLoginAt: number | null;
  disabledAt: number | null;
  settings: AuthSettings;
  pin?: SecretHash;
  face?: { template: number[]; modelVersion: string };
}

export interface RecoveryPlan {
  users: RecoveredUser[];
  tokens: { hash: string; userId: string; expiresAt: number }[];
  // Damage the reader worked around: unreadable tables, rows or key files.
  warnings: string[];
  // Credentials deliberately left behind, one line each with the account and the reason.
  skipped: string[];
}

export interface RecoveryOptions {
  // Key file for face templates; defaults to <source>.key, then the older <source>.face-key.
  sourceKey?: string;
  // Account to make administrator when the source has none.
  admin?: string;
  tokens: boolean;
  now: number;
}

const text = (value: unknown) => (typeof value === 'string' && value.length ? value : undefined);
const timestamp = (value: unknown) =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);

// Damaged pages fail whole-table scans, so this falls back to single-row reads and keeps
// whatever still decodes. Columns are taken as found because the source may be any version.
function readRows(db: Sqlite.Database, table: string, warnings: string[]): Row[] {
  let columns: unknown[];
  try {
    columns = db.prepare(`PRAGMA table_info(${table})`).all();
  } catch (error) {
    warnings.push(`${table}: 无法读取表结构（${(error as Error).message}）`);
    return [];
  }
  if (!columns.length) return [];
  try {
    return db.prepare(`SELECT rowid AS _rowid, * FROM ${table}`).all() as Row[];
  } catch (error) {
    warnings.push(`${table}: 整表读取失败（${(error as Error).message}），改为逐行读取`);
  }
  let last = 0;
  for (const sql of [`SELECT max(rowid) AS n FROM ${table}`, `SELECT count(*) AS n FROM ${table}`])
    try {
      last = Math.max(last, Number((db.prepare(sql).get() as { n: unknown }).n ?? 0));
    } catch {}
  const one = db.prepare(`SELECT rowid AS _rowid, * FROM ${table} WHERE rowid=?`);
  const rows: Row[] = [];
  let failed = 0;
  for (let rowid = 1; rowid <= (last || BLIND_SCAN_ROWS); rowid++)
    try {
      const row = one.get(rowid) as Row | undefined;
      if (row) rows.push(row);
    } catch {
      failed++;
    }
  if (failed) warnings.push(`${table}: ${failed} 行无法读取，已跳过`);
  return rows;
}

function authSettings(value: unknown, faceKept: boolean): AuthSettings {
  const defaults = defaultAuthSettings();
  let stored: Row = {};
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
  } catch {}
  const settings = { ...defaults } as Record<keyof AuthSettings, unknown>;
  for (const key of Object.keys(defaults) as (keyof AuthSettings)[])
    if (typeof stored[key] === typeof defaults[key]) settings[key] = stored[key];
  return { ...(settings as AuthSettings), faceEnabled: faceKept && settings.faceEnabled === true };
}

function readSource(path: string, warnings: string[], tokens: boolean) {
  // Read a copy so SQLite never checkpoints the WAL into, or otherwise rewrites, the original.
  const directory = mkdtempSync(join(tmpdir(), 'remotekit-recovery-'));
  try {
    const copy = join(directory, 'source.db');
    copyFileSync(path, copy);
    for (const suffix of ['-wal', '-shm'])
      if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix);
    const db = new Sqlite(copy, { fileMustExist: true });
    try {
      try {
        const result = (db.pragma('quick_check') as Row[]).map((row) => String(Object.values(row)[0]));
        if (result.join() !== 'ok') warnings.push(`quick_check: ${result.slice(0, 5).join('; ')}`);
      } catch (error) {
        warnings.push(`quick_check 失败: ${(error as Error).message}`);
      }
      return {
        users: readRows(db, 'users', warnings),
        security: readRows(db, 'user_security', warnings),
        tokens: tokens ? readRows(db, 'auth_tokens', warnings) : [],
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function planRecovery(source: string, options: RecoveryOptions): RecoveryPlan {
  const warnings: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(source)) throw new Error(`${source} 不存在`);
  const keyPath =
    options.sourceKey ?? [source + '.key', source + '.face-key'].find((path) => existsSync(path));
  if (!keyPath) warnings.push('没有找到旧库的 key 文件，人脸不迁移');
  const vault = keyPath ? new FaceVault(new AtRestKey(keyPath)) : undefined;
  const rows = readSource(source, warnings, options.tokens);

  const users: (RecoveredUser & { rowid: number })[] = [];
  const seen = { id: new Set<string>(), username: new Set<string>(), tenant: new Set<string>() };
  for (const row of rows.users) {
    const id = text(row.id);
    const username = text(row.username);
    const tenant = text(row.tenant);
    const salt = text(row.salt);
    const hash = text(row.password_hash);
    const label = username ?? id ?? `rowid ${row._rowid}`;
    if (!id || !username || !tenant) skipped.push(`${label}: 账户字段缺失`);
    else if (!salt || !hash || !SALT.test(salt) || !SCRYPT_HASH.test(hash))
      skipped.push(`${label}: 密码哈希不是 scrypt 格式，放弃该账户`);
    else if (seen.id.has(id) || seen.username.has(username.toLowerCase()) || seen.tenant.has(tenant))
      skipped.push(`${label}: 与已迁移账户重复`);
    else {
      seen.id.add(id);
      seen.username.add(username.toLowerCase());
      seen.tenant.add(tenant);
      users.push({
        rowid: Number(row._rowid),
        id,
        username,
        tenant,
        password: { salt, hash },
        isAdmin: Number(row.is_admin ?? 0) !== 0,
        lastLoginAt: timestamp(row.last_login_at),
        disabledAt: timestamp(row.disabled_at),
        settings: defaultAuthSettings(),
      });
    }
  }

  const byId = new Map(users.map((user) => [user.id, user]));
  const securityDone = new Set<string>();
  for (const row of rows.security) {
    const user = byId.get(text(row.user_id) ?? '');
    if (!user || securityDone.has(user.id)) continue;
    securityDone.add(user.id);
    const pinSalt = text(row.pin_salt);
    const pinHash = text(row.pin_hash);
    if (pinSalt && pinHash && SALT.test(pinSalt) && SCRYPT_HASH.test(pinHash))
      user.pin = { salt: pinSalt, hash: pinHash };
    else if (pinSalt || pinHash) skipped.push(`${user.username}: PIN 不是 scrypt 格式，放弃 PIN`);
    const sealed = text(row.face_ciphertext);
    const modelVersion = text(row.face_model);
    if (sealed && modelVersion) {
      try {
        if (!vault) throw new Error('没有旧 key');
        user.face = { template: vault.open(user.id, sealed, modelVersion), modelVersion };
      } catch (error) {
        skipped.push(`${user.username}: 人脸无法解密（${(error as Error).message}），放弃人脸`);
      }
    }
    user.settings = authSettings(row.settings, !!user.face);
  }

  const admins = users.filter((user) => user.isAdmin);
  const admin = options.admin
    ? users.find((user) => user.username.toLowerCase() === options.admin!.toLowerCase())
    : admins.length === 1
      ? admins[0]
      : [...users].sort((a, b) => a.rowid - b.rowid).find((user) => user.disabledAt === null);
  if (options.admin && !admin) throw new Error(`--admin ${options.admin} 不在可迁移账户中`);
  if (admin && !admin.isAdmin) warnings.push(`旧库没有唯一的管理员，指定 ${admin.username} 为管理员`);
  for (const user of users) user.isAdmin = user === admin;
  if (admin) admin.disabledAt = null;

  const tokens: RecoveryPlan['tokens'] = [];
  for (const row of rows.tokens) {
    const hash = text(row.hash);
    const userId = text(row.user_id);
    const expiresAt = timestamp(row.expires_at);
    if (hash && TOKEN_HASH.test(hash) && userId && byId.has(userId) && expiresAt && expiresAt > options.now)
      tokens.push({ hash, userId, expiresAt });
  }
  return { users: users.map(({ rowid: _, ...user }) => user), tokens, warnings, skipped };
}

// Writes into a database the current Control just created; face templates are sealed again
// under that database's own key.
export function applyRecovery(store: ControlDatabase, plan: RecoveryPlan) {
  const existing = (store.db.prepare('SELECT count(*) AS n FROM users').get() as { n: bigint }).n;
  if (existing) throw new Error(`新库已有 ${existing} 个账户，只能写入空库`);
  store.transaction(() => {
    const insertUser = store.db.prepare(
      `INSERT INTO users (id,username,tenant,salt,password_hash,is_admin,last_login_at,disabled_at)
      VALUES (?,?,?,?,?,?,?,?)`,
    );
    const insertToken = store.db.prepare('INSERT INTO auth_tokens VALUES (?,?,?)');
    for (const user of plan.users) {
      insertUser.run(
        user.id,
        user.username,
        user.tenant,
        user.password.salt,
        user.password.hash,
        Number(user.isAdmin),
        user.lastLoginAt,
        user.disabledAt,
      );
      store.security.saveSecurity(user.id, {
        settings: user.settings,
        pin: user.pin,
        face: user.face && {
          sealed: store.security.faceVault.seal(user.id, user.face.template, user.face.modelVersion),
          modelVersion: user.face.modelVersion,
        },
      });
    }
    for (const token of plan.tokens) insertToken.run(token.hash, token.userId, token.expiresAt);
  });
}
