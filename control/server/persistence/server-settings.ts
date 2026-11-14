import type Database from 'better-sqlite3';
import { corruptRecord, decodeJson, encodeJson, integer, literal, object } from './codec';
import { RemoteKitError } from '../../shared/errors';

export const serverSettings = object({
  version: literal(1),
  logRetentionDays: integer({ min: 1, max: 365 }),
});
export function readServerSettings(db: Database.Database) {
  const row = db.prepare('SELECT data FROM server_settings WHERE id=1').get() as { data: string } | undefined;
  if (!row) throw corruptRecord('server_settings', new Error('missing required record'));
  return decodeJson(row.data, serverSettings, 'server_settings');
}
export function setLogRetentionDays(db: Database.Database, days: unknown) {
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365)
    throw new RemoteKitError('invalid_request', '日志保留天数必须为 1–365 的整数');
  const settings = { version: 1 as const, logRetentionDays: days as number };
  db.prepare('UPDATE server_settings SET data=? WHERE id=1').run(
    encodeJson(settings, serverSettings, 'server_settings'),
  );
  return settings;
}
