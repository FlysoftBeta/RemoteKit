import { randomInt, timingSafeEqual, createHash } from 'node:crypto';
import type { DeviceEvent } from '../../shared/session-import';
import { verifySecret, type AuthAttempts } from '../auth/crypto';
import type { ControlDatabase } from '../persistence/database';
import { wordlist } from './wordlist';

export const PAIR_REJECTED_REASON = '配对失败：账户、密码或配对码不正确，或该账户未开启配对';
export const newPairingCode = () => Array.from({ length: 5 }, () => wordlist[randomInt(2048)]);
function normalizedCode(code: string[]) {
  return createHash('sha256')
    .update(JSON.stringify(code.map((word) => word.trim().toLowerCase())))
    .digest();
}
export interface PairCheck {
  event: Extract<DeviceEvent, { type: 'pair' }>;
  tenant: string | null;
  username: string;
  valid: boolean;
  passwordHash: string | null;
}
export async function checkPair(
  store: ControlDatabase,
  auth: AuthAttempts,
  keyId: string,
  event: Extract<DeviceEvent, { type: 'pair' }>,
  now: number,
  pairedTenant?: string,
): Promise<PairCheck> {
  const user = store.accounts.loginUser(event.username);
  const result: PairCheck = {
    event,
    tenant: user?.tenant ?? null,
    username: user?.username ?? event.username,
    valid: false,
    passwordHash: user?.password_hash ?? null,
  };
  if (!user) return result;
  pairedTenant ??= store.sessionImports.device(keyId)?.tenant;
  if (pairedTenant === user.tenant && user.disabled_at === null) return { ...result, valid: true };
  const password = await auth.run('password:' + user.id, () =>
    verifySecret(event.password, { salt: user.salt, hash: user.password_hash }),
  );
  const pairing = store.sessionImports.pairing(user.tenant, now);
  result.valid =
    !pairedTenant &&
    user.disabled_at === null &&
    password &&
    store.accounts.passwordHash(user.id) === user.password_hash &&
    pairing.open &&
    timingSafeEqual(normalizedCode(event.code), normalizedCode(pairing.code!));
  return result;
}
export function confirmPair(store: ControlDatabase, keyId: string, check: PairCheck, now: number): boolean {
  const user = store.accounts.loginUser(check.username);
  if (!check.valid || !user || user.tenant !== check.tenant || user.disabled_at !== null) return false;
  const device = store.sessionImports.device(keyId);
  if (device) return device.tenant === user.tenant;
  const pairing = store.sessionImports.pairing(user.tenant, now);
  return (
    user.password_hash === check.passwordHash &&
    pairing.open &&
    timingSafeEqual(normalizedCode(check.event.code), normalizedCode(pairing.code!))
  );
}
