import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';
import {
  AuthAttempts,
  FaceVault,
  defaultAuthSettings,
  hashSecret,
  verifySecret,
  type SecretHash,
} from '../security-crypto';
import type { AuthSettings } from '../../shared/security';
import type { Clock } from '../util/clock';

export class SecurityRepository {
  readonly authAttempts: AuthAttempts;
  readonly faceVault: FaceVault;
  constructor(
    private readonly db: Database.Database,
    path: string,
    clock: Clock,
  ) {
    this.authAttempts = new AuthAttempts(clock);
    this.faceVault = new FaceVault(path);
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
    const settings: AuthSettings = { ...defaultAuthSettings(), ...JSON.parse(row?.settings ?? '{}') };
    return {
      settings,
      pin: row?.pin_hash && row.pin_salt ? { salt: row.pin_salt, hash: row.pin_hash } : undefined,
      face:
        row?.face_ciphertext && row.face_model
          ? { sealed: row.face_ciphertext, modelVersion: row.face_model }
          : undefined,
    };
  }
  saveSecurity(user: string, record: ReturnType<SecurityRepository['security']>) {
    this.db
      .prepare('INSERT OR REPLACE INTO user_security VALUES (?,?,?,?,?,?)')
      .run(
        user,
        JSON.stringify(record.settings),
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
}
