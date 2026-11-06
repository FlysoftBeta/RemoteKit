import { gzipSync, gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { RemoteKitError } from '../../shared/errors';
import type { ImportPayload } from '../../shared/session-import';
import { hpkeOpen, hpkeSeal } from './hpke';

export const MAX_ENVELOPE_BYTES = 16 * 1024 ** 2;
export const MAX_PAYLOAD_BYTES = 32 * 1024 ** 2;
const info = Buffer.from('RemoteKit session import v1');
const invalid = (field: string): never => {
  throw new RemoteKitError('invalid_request', `Invalid session import: ${field}`);
};
export class ImportLimitError extends RemoteKitError {
  constructor(
    readonly payload: ImportPayload,
    reason: string,
  ) {
    super('invalid_request', reason);
  }
}
function object(value: unknown, keys: string[], field: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  const record = value as Record<string, any>;
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid(field);
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
export function isImportToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}
export function parseImportPayload(json: unknown): ImportPayload {
  const p = object(
    json,
    ['v', 'id', 'createdAt', 'token', 'device', 'site', 'cookies', 'localStorage'],
    'payload',
  );
  if (p.v !== 1) invalid('v');
  if (
    typeof p.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.id)
  )
    invalid('id');
  if (!isImportToken(p.token)) invalid('token');
  timestamp(p.createdAt, 'createdAt');
  string(p.device, 'device');
  const site = object(p.site, ['name', 'url'], 'site');
  string(site.name, 'site.name');
  webUrl(site.url, 'site.url');
  if (!Array.isArray(p.cookies) || !Array.isArray(p.localStorage)) invalid('storage arrays');
  let limit: string | undefined;
  const exceeds = (condition: boolean, reason: string) => {
    if (condition) limit ??= reason;
  };
  exceeds(Array.from(p.device).length > 64, '设备名超过 64 字符');
  exceeds(Array.from(site.name).length > 128, '站点名超过 128 字符');
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
  const payload = p as ImportPayload;
  if (limit) throw new ImportLimitError(payload, limit);
  return payload;
}
export function envelopeKeyId(bytes: Buffer): string | undefined {
  if (bytes.length < 61 || !bytes.subarray(0, 4).equals(Buffer.from('RKSI')) || bytes[4] !== 1) return;
  return bytes.subarray(5, 13).toString('hex');
}
function header(keyId: string) {
  if (!/^[0-9a-f]{16}$/.test(keyId)) invalid('key id');
  return Buffer.concat([Buffer.from('RKSI'), Buffer.from([1]), Buffer.from(keyId, 'hex')]);
}
export function sealEnvelope(publicKey: Buffer, keyId: string, payload: ImportPayload): Buffer {
  parseImportPayload(payload);
  const plaintext = Buffer.from(JSON.stringify(payload));
  if (plaintext.length > MAX_PAYLOAD_BYTES) invalid('payload size');
  const aad = header(keyId);
  const { enc, ciphertext } = hpkeSeal(publicKey, info, aad, gzipSync(plaintext));
  const bytes = Buffer.concat([aad, enc, ciphertext]);
  if (bytes.length > MAX_ENVELOPE_BYTES) invalid('envelope size');
  return bytes;
}
export function openEnvelope(privateKey: Buffer, keyId: string, bytes: Buffer): ImportPayload {
  if (bytes.length > MAX_ENVELOPE_BYTES || envelopeKeyId(bytes) !== keyId) invalid('envelope header');
  const compressed = hpkeOpen(
    privateKey,
    bytes.subarray(13, 45),
    info,
    bytes.subarray(0, 13),
    bytes.subarray(45),
  );
  let json: unknown;
  try {
    const plaintext = gunzipSync(compressed, { maxOutputLength: MAX_PAYLOAD_BYTES });
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    return invalid('compressed payload');
  }
  return parseImportPayload(json);
}
