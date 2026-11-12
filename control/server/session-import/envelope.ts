import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { RemoteKitError, wireError, type WireError } from '../../shared/errors';
import type { ControlEvent, DeviceEvent, ImportMessage } from '../../shared/session-import';
import { hpkeOpen, hpkeSeal } from './hpke';

export const MAX_ENVELOPE_BYTES = 16 * 1024 ** 2;
export const MAX_PAYLOAD_BYTES = 32 * 1024 ** 2;
const info = Buffer.from('RemoteKit session import v2');
const invalid = (field: string): never => {
  throw new RemoteKitError('invalid_request', '会话导入格式无效', {
    detail: `Invalid session import: ${field}`,
  });
};
export type ImportEvent = Extract<DeviceEvent, { type: 'import' }>;
export interface EventResult {
  event: DeviceEvent;
  error: WireError | null;
}
class ImportLimitError extends RemoteKitError {
  constructor(reason: string) {
    super('limit_exceeded', reason);
  }
}
class UnknownKeysError extends RemoteKitError {}
function object(value: unknown, keys: string[], field: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  const record = value as Record<string, any>;
  if (Object.keys(record).some((key) => !keys.includes(key)))
    throw new UnknownKeysError('invalid_request', '会话导入含未知字段', {
      detail: `Invalid session import: ${field}`,
    });
  return record;
}
function string(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') invalid(field);
}
function timestamp(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(field);
}
function webUrl(value: unknown, field: string): URL {
  string(value, field);
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) invalid(field);
    return url;
  } catch {
    return invalid(field);
  }
}
function parseImport(event: unknown): ImportEvent {
  const p = object(event, ['seq', 'at', 'type', 'id', 'sites', 'cookies', 'localStorage'], 'import');
  if (!Array.isArray(p.sites) || p.sites.length === 0) invalid('sites');
  const urls = new Set<string>();
  for (const value of p.sites) {
    const site = object(value, ['name', 'url'], 'site');
    string(site.name, 'site.name');
    webUrl(site.url, 'site.url');
    if (urls.has(site.url)) invalid('site.url');
    urls.add(site.url);
  }
  if (!Array.isArray(p.cookies) || !Array.isArray(p.localStorage)) invalid('storage arrays');
  let limit: string | undefined;
  const exceeds = (condition: boolean, reason: string) => {
    if (condition) limit ??= reason;
  };
  exceeds(p.sites.length > 16, '站点超过 16 个');
  exceeds(
    p.sites.some((site: { name: string }) => Array.from(site.name).length > 128),
    '站点名超过 128 字符',
  );
  exceeds(p.cookies.length > 4096, 'Cookie 超过 4096 条');
  exceeds(p.localStorage.length > 256, '来源超过 256 个');
  for (const value of p.cookies) {
    const c = object(
      value,
      ['name', 'value', 'domain', 'path', 'hostOnly', 'secure', 'httpOnly', 'sameSite', 'expires'],
      'cookie',
    );
    for (const field of ['name', 'value', 'domain', 'path']) string(c[field], `cookie.${field}`);
    for (const field of ['hostOnly', 'secure', 'httpOnly'])
      if (typeof c[field] !== 'boolean') invalid(`cookie.${field}`);
    if (!['unspecified', 'none', 'lax', 'strict'].includes(c.sameSite)) invalid('cookie.sameSite');
    if (c.expires !== null) timestamp(c.expires, 'cookie.expires');
    if (!c.domain || /[\s/\\:@?#\u0000]/u.test(c.domain) || (c.hostOnly && c.domain.startsWith('.')))
      invalid('cookie.domain');
    const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    if (!host || webUrl('https://' + host, 'cookie.domain').hostname !== host.toLowerCase())
      invalid('cookie.domain');
    if (!c.path.startsWith('/')) invalid('cookie.path');
    exceeds(Buffer.byteLength(c.name) + Buffer.byteLength(c.value) > 4096, 'Cookie 名称与值超过 4096 字节');
  }
  const originBytes = new Map<string, number>();
  for (const value of p.localStorage) {
    const storage = object(value, ['origin', 'items'], 'localStorage');
    if (webUrl(storage.origin, 'origin').origin !== storage.origin) invalid('origin');
    if (!Array.isArray(storage.items)) invalid('items');
    let size = originBytes.get(storage.origin) ?? 0;
    for (const item of storage.items) {
      if (!Array.isArray(item) || item.length !== 2) invalid('item');
      string(item[0], 'item.key');
      string(item[1], 'item.value');
      size += Buffer.byteLength(item[0]) + Buffer.byteLength(item[1]);
      exceeds(Buffer.byteLength(JSON.stringify(item)) > 256 * 1024, 'localStorage 条目超过 256 KiB');
    }
    exceeds(size > 10 * 1024 ** 2, 'localStorage 来源超过 10 MiB');
    originBytes.set(storage.origin, size);
  }
  exceeds(Buffer.byteLength(JSON.stringify(p)) > MAX_PAYLOAD_BYTES, '载荷超过 32 MiB');
  if (limit) throw new ImportLimitError(limit);
  return p as ImportEvent;
}
export function parseDeviceMessage(json: unknown): {
  message: ImportMessage<DeviceEvent>;
  results: EventResult[];
} {
  const m = object(json, ['v', 'ack', 'events'], 'message');
  if (m.v !== 2 || !Number.isSafeInteger(m.ack) || m.ack < 0 || !Array.isArray(m.events)) invalid('message');
  const results: EventResult[] = [];
  let previous: number | undefined;
  for (const value of m.events) {
    const e = object(
      value,
      [
        'seq',
        'at',
        'type',
        'username',
        'password',
        'code',
        'device',
        'id',
        'sites',
        'cookies',
        'localStorage',
      ],
      'event',
    );
    if (!Number.isSafeInteger(e.seq) || e.seq < 1 || (previous !== undefined && e.seq !== previous + 1))
      invalid('seq');
    timestamp(e.at, 'at');
    if (e.at < 0) invalid('at');
    previous = e.seq;
    let error: WireError | null = null;
    if (e.type === 'pair') {
      object(e, ['seq', 'at', 'type', 'username', 'password', 'code', 'device'], 'pair');
      for (const [field, max] of [
        ['username', 64],
        ['password', 256],
        ['device', 64],
      ] as const) {
        string(e[field], field);
        if ((field !== 'device' && !e[field].length) || Array.from(e[field]).length > max) invalid(field);
      }
      if (
        !Array.isArray(e.code) ||
        e.code.length !== 5 ||
        e.code.some((word: unknown) => typeof word !== 'string')
      )
        invalid('code');
    } else if (e.type === 'import' || e.type === 'withdraw') {
      if (
        typeof e.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.id)
      )
        invalid('id');
      if (e.type === 'withdraw') object(e, ['seq', 'at', 'type', 'id'], 'withdraw');
      else {
        // Unknown keys invalidate the message; item validation failures belong to this import event.
        object(e, ['seq', 'at', 'type', 'id', 'sites', 'cookies', 'localStorage'], 'import');
        try {
          parseImport(e);
        } catch (failure) {
          if (failure instanceof UnknownKeysError) throw failure;
          if (failure instanceof RemoteKitError) {
            error = wireError(failure);
          } else throw failure;
        }
      }
    } else invalid('type');
    results.push({ event: e as DeviceEvent, error });
  }
  return { message: m as ImportMessage<DeviceEvent>, results };
}
export function publicKeyId(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}
export function envelopeKeyId(bytes: Buffer): string | undefined {
  if (bytes.length < 93 || !bytes.subarray(0, 4).equals(Buffer.from('RKSI')) || bytes[4] !== 2) return;
  return bytes.subarray(5, 13).toString('hex');
}
export function sealMessage<E extends DeviceEvent | ControlEvent>(
  senderPrivate: Buffer,
  senderPublic: Buffer,
  recipientPublic: Buffer,
  message: ImportMessage<E>,
): Buffer {
  const plaintext = Buffer.from(JSON.stringify(message));
  if (plaintext.length > MAX_PAYLOAD_BYTES) invalid('payload size');
  const aad = Buffer.concat([
    Buffer.from('RKSI'),
    Buffer.from([2]),
    Buffer.from(publicKeyId(recipientPublic), 'hex'),
    senderPublic,
  ]);
  const { enc, ciphertext } = hpkeSeal(senderPrivate, recipientPublic, info, aad, gzipSync(plaintext));
  const bytes = Buffer.concat([aad, enc, ciphertext]);
  if (bytes.length > MAX_ENVELOPE_BYTES) invalid('envelope size');
  return bytes;
}
export function openMessage(
  recipientPrivate: Buffer,
  recipientKeyId: string,
  bytes: Buffer,
): { senderPublic: Buffer; senderKeyId: string; message: unknown } {
  if (bytes.length > MAX_ENVELOPE_BYTES || envelopeKeyId(bytes) !== recipientKeyId)
    invalid('envelope header');
  const senderPublic = bytes.subarray(13, 45);
  const compressed = hpkeOpen(
    recipientPrivate,
    senderPublic,
    bytes.subarray(45, 77),
    info,
    bytes.subarray(0, 45),
    bytes.subarray(77),
  );
  try {
    const plaintext = gunzipSync(compressed, { maxOutputLength: MAX_PAYLOAD_BYTES });
    const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    return { senderPublic, senderKeyId: publicKeyId(senderPublic), message };
  } catch {
    return invalid('compressed payload');
  }
}
