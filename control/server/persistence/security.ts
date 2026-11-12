import { corruptRecord, decodeJson, encodeJson } from './codec';
import { authSettings } from './documents';
import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';
import type { AuthSettings } from '../../shared/security';
import {
  AuthAttempts,
  AtRestKey,
  FaceVault,
  hashSecret,
  verifySecret,
  type SecretHash,
} from '../auth/crypto';
import type { Clock } from '../util/clock';

export class SecurityRepository {
  readonly authAttempts: AuthAttempts;
  readonly faceVault: FaceVault;
  constructor(
    private readonly db: Database.Database,
    key: AtRestKey,
    clock: Clock,
  ) {
    this.authAttempts = new AuthAttempts(clock);
    this.faceVault = new FaceVault(key);
  }
  private passwordHash(user: string): SecretHash | undefined {
    return this.db.prepare('SELECT salt, password_hash AS hash FROM users WHERE id=?').get(user) as
      SecretHash | undefined;
  }
  async verifyPassword(user: string, secret: unknown) {
    if (typeof secret !== 'string' || secret.length > 256)
      throw new RemoteKitError('invalid_request', '密码格式无效');
    const saved = this.passwordHash(user);
    const valid = await this.authAttempts.run('password:' + user, () => verifySecret(secret, saved));
    if (!valid || this.passwordHash(user)?.hash !== saved?.hash)
      throw new RemoteKitError('forbidden', '密码错误');
    return saved!.hash;
  }
  async replacePassword(user: string, currentHash: string, secret: unknown, authorize: () => void) {
    if (typeof secret !== 'string' || secret.length < 8 || secret.length > 256)
      throw new RemoteKitError('invalid_request', '密码需8–256个字符');
    const { salt, hash } = await hashSecret(secret);
    authorize();
    if (
      !this.db
        .prepare('UPDATE users SET salt=?, password_hash=? WHERE id=? AND password_hash=?')
        .run(salt, hash, user, currentHash).changes
    )
      throw new RemoteKitError('conflict', '密码已更新，请重试');
  }
  security(user: string) {
    const row = this.db
      .prepare(
        'SELECT settings, pin_salt, pin_hash, face_ciphertext, face_model FROM user_security WHERE user_id=?',
      )
      .get(user) as
      | {
          settings: string;
          pin_salt: string | null;
          pin_hash: string | null;
          face_ciphertext: string | null;
          face_model: string | null;
        }
      | undefined;
    if (!row) throw corruptRecord(`user_security ${user}`, new Error('missing required record'));
    if (
      (row.pin_hash === null) !== (row.pin_salt === null) ||
      (row.face_ciphertext === null) !== (row.face_model === null)
    )
      throw corruptRecord(`user_security ${user}`, new Error('incomplete credential pair'));
    const settings: AuthSettings = decodeJson(row.settings, authSettings, `user_security.settings ${user}`);
    return {
      settings,
      pin: row.pin_hash === null ? undefined : { salt: row.pin_salt!, hash: row.pin_hash },
      face:
        row.face_ciphertext === null
          ? undefined
          : { sealed: row.face_ciphertext, modelVersion: row.face_model! },
    };
  }

  saveSecurity(user: string, record: ReturnType<SecurityRepository['security']>) {
    this.db
      .prepare('INSERT OR REPLACE INTO user_security VALUES (?,?,?,?,?,?)')
      .run(
        user,
        encodeJson(record.settings, authSettings, `user_security.settings ${user}`),
        record.pin?.salt ?? null,
        record.pin?.hash ?? null,
        record.face?.sealed ?? null,
        record.face?.modelVersion ?? null,
      );
  }
  async verifyPin(user: string, secret: unknown) {
    if (typeof secret !== 'string' || !/^\d{6,12}$/.test(secret))
      throw new RemoteKitError('invalid_request', 'PIN 需6–12位数字');
    const pin = this.security(user).pin;
    const valid = await this.authAttempts.run('pin:' + user, () => verifySecret(secret, pin));
    if (!valid || this.security(user).pin?.hash !== pin?.hash)
      throw new RemoteKitError('forbidden', 'PIN 错误');
  }
  clearSecondFactors(user: string) {
    const record = this.security(user);
    this.saveSecurity(user, {
      settings: { ...record.settings, faceEnabled: false },
      pin: undefined,
      face: undefined,
    });
  }
}
