import { openFaceTemplate, sealFaceTemplate } from '../persistence/sealed-documents';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { RemoteKitError } from '../../shared/errors';
import { DEFAULT_IDLE_SECONDS, type AuthSettings } from '../../shared/security';
import { systemClock, type Clock } from '../util/clock';

export const defaultAuthSettings = (): AuthSettings => ({
  lockOnHidden: true,
  lockOnIdle: true,
  idleSeconds: DEFAULT_IDLE_SECONDS,
  lockOnDeparture: false,
  faceEnabled: false,
});

export interface SecretHash {
  salt: string;
  hash: string;
}
let kdfActive = 0;
export async function deriveSecret(secret: string, salt: string): Promise<Buffer> {
  if (kdfActive >= 4) throw new RemoteKitError('busy', '验证服务繁忙，请稍后再试');
  kdfActive++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(secret, salt, 64, (error, value) => (error ? reject(error) : resolve(value))),
    );
  } finally {
    kdfActive--;
  }
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
  constructor(private readonly clock: Clock = systemClock) {}
  private attempts = new Map<string, { count: number; until: number; inFlight: boolean }>();
  async run<T>(key: string, work: () => Promise<T>, limit = 6, interval = 60000): Promise<T> {
    const now = this.clock.monotonicMs();
    for (const [id, entry] of this.attempts)
      if (!entry.inFlight && entry.until <= now) this.attempts.delete(id);
    let entry = this.attempts.get(key);
    if (entry?.inFlight || (!entry && this.attempts.size >= 4096))
      throw new RemoteKitError('busy', '验证服务繁忙，请稍后再试');
    if (entry && entry.count >= limit)
      throw new RemoteKitError('rate_limited', '尝试次数过多，请稍后再试', {
        retryAfterMs: Math.max(0, Math.ceil(entry.until - now)),
      });
    if (!entry) {
      entry = { count: 0, until: now + interval, inFlight: false };
      this.attempts.set(key, entry);
    }
    entry.count++;
    entry.inFlight = true;
    try {
      return await work();
    } finally {
      entry.inFlight = false;
    }
  }
}

export class AtRestKey {
  private key?: Buffer;
  // A null path keeps an ephemeral key, for in-memory databases.
  constructor(private readonly path: string | null) {}
  private loadKey(create: boolean) {
    if (this.key) return this.key;
    if (!this.path) return (this.key = randomBytes(32));
    const path = this.path;
    try {
      this.key = readFileSync(path);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const key = randomBytes(32);
      try {
        writeFileSync(path, key, { flag: 'wx', mode: 0o600 });
        this.key = key;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        this.key = readFileSync(path);
      }
    }
    if (this.key.length !== 32) {
      this.key = undefined;
      throw new RemoteKitError('internal', '本地密钥无效', { detail: 'Invalid at-rest key' });
    }
    return this.key;
  }
  derive(info: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.loadKey(false), Buffer.alloc(0), info, 32));
  }
  seal(aad: string, plaintext: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.loadKey(true), iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  open(aad: string, sealed: string): Buffer {
    const record = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.loadKey(false), record.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(record.subarray(12, 28));
    return Buffer.concat([decipher.update(record.subarray(28)), decipher.final()]);
  }
}

export class FaceVault {
  constructor(private readonly key: AtRestKey) {}
  seal(user: string, template: number[], modelVersion: string) {
    return sealFaceTemplate(this.key, user, template, modelVersion);
  }
  open(user: string, sealed: string, modelVersion: string): number[] {
    return openFaceTemplate(this.key, user, sealed, modelVersion);
  }
}
