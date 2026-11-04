import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AuthSettings } from '../shared/security';

export class AuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const defaultAuthSettings = (): AuthSettings => ({
  lockOnHidden: true, lockOnIdle: true, idleSeconds: 60, lockOnDeparture: false, faceEnabled: false,
});

export interface SecretHash { salt: string; hash: string }
let kdfActive = 0;
export async function deriveSecret(secret: string, salt: string): Promise<Buffer> {
  if (kdfActive >= 4) throw new AuthError(429, '验证服务繁忙，请稍后再试');
  kdfActive++;
  try { return await new Promise<Buffer>((resolve, reject) => scrypt(secret, salt, 64, (error, value) => error ? reject(error) : resolve(value))); }
  finally { kdfActive--; }
}
export async function hashSecret(secret: string): Promise<SecretHash> {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await deriveSecret(secret, salt)).toString('hex') };
}
export async function verifySecret(secret: string, saved?: SecretHash): Promise<boolean> {
  const actual = await deriveSecret(secret, saved?.salt ?? 'unknown-user-salt');
  return !!saved && timingSafeEqual(actual, Buffer.from(saved.hash, 'hex'));
}

export class AuthAttempts {
  private attempts = new Map<string, { count: number; until: number; inFlight: boolean }>();
  async run<T>(key: string, work: () => Promise<T>, limit = 6, interval = 60000): Promise<T> {
    const now = Date.now();
    for (const [id, entry] of this.attempts) if (!entry.inFlight && entry.until <= now) this.attempts.delete(id);
    let entry = this.attempts.get(key);
    if (entry?.inFlight || (entry && entry.count >= limit) || (!entry && this.attempts.size >= 4096)) throw new AuthError(429, '尝试次数过多，请稍后再试');
    if (!entry) { entry = { count: 0, until: now + interval, inFlight: false }; this.attempts.set(key, entry); }
    entry.count++;
    entry.inFlight = true;
    try { return await work(); }
    finally { entry.inFlight = false; }
  }
}

export function validFaceTemplate(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 128 && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1) &&
    Math.abs(value.reduce((sum, n) => sum + n * n, 0) - 1) <= 0.01;
}

export class FaceVault {
  private key?: Buffer;
  constructor(private readonly dbPath: string) {}
  private loadKey(create: boolean) {
    if (this.key) return this.key;
    if (this.dbPath === ':memory:' || !this.dbPath) return this.key = randomBytes(32);
    const path = this.dbPath + '.face-key';
    try { this.key = readFileSync(path); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const key = randomBytes(32);
      try { writeFileSync(path, key, { flag: 'wx', mode: 0o600 }); this.key = key; }
      catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        this.key = readFileSync(path);
      }
    }
    if (this.key.length !== 32) { this.key = undefined; throw new Error('人脸模板密钥无效'); }
    return this.key;
  }
  seal(user: string, template: number[], modelVersion: string) {
    if (!validFaceTemplate(template)) throw new Error('人脸模板无效');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.loadKey(true), iv);
    cipher.setAAD(Buffer.from(JSON.stringify([user, modelVersion])));
    const data = Buffer.concat([cipher.update(JSON.stringify(template)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  open(user: string, sealed: string, modelVersion: string): number[] {
    const record = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.loadKey(false), record.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([user, modelVersion])));
    decipher.setAuthTag(record.subarray(12, 28));
    const template: unknown = JSON.parse(Buffer.concat([decipher.update(record.subarray(28)), decipher.final()]).toString());
    if (!validFaceTemplate(template)) throw new Error('人脸模板无效');
    return template;
  }
}
