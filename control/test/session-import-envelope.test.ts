import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_BYTES,
  ImportLimitError,
  openEnvelope,
  parseImportPayload,
  sealEnvelope,
} from '../server/session-import/envelope';
import { hpkeSeal, x25519Public } from '../server/session-import/hpke';
import { buildPairingCode, parsePairingCode } from '../server/session-import/pairing';
import { browserIdentity, importPayload } from './session-import-fixture';
const privateKey = randomBytes(32),
  publicKey = x25519Public(privateKey);
const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
test('envelope round trip and every header region is authenticated', () => {
  const payload = importPayload();
  const envelope = sealEnvelope(publicKey, keyId, payload);
  assert.deepEqual(openEnvelope(privateKey, keyId, envelope), payload);
  for (const offset of [0, 4, 5, 13, 44, 45, envelope.length - 1]) {
    const altered = Buffer.from(envelope);
    altered[offset] ^= 1;
    const selectedKeyId = offset === 5 ? altered.subarray(5, 13).toString('hex') : keyId;
    assert.throws(() => openEnvelope(privateKey, selectedKeyId, altered), { code: 'invalid_request' });
  }
  assert.throws(() => openEnvelope(privateKey, keyId, envelope.subarray(0, 60)), { code: 'invalid_request' });
  const oversized = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
  envelope.copy(oversized);
  assert.throws(() => openEnvelope(privateKey, keyId, oversized), { code: 'invalid_request' });
  const aad = envelope.subarray(0, 13);
  const bomb = hpkeSeal(
    publicKey,
    Buffer.from('RemoteKit session import v1'),
    aad,
    gzipSync(Buffer.alloc(MAX_PAYLOAD_BYTES + 1)),
  );
  assert.throws(() => openEnvelope(privateKey, keyId, Buffer.concat([aad, bomb.enc, bomb.ciphertext])), {
    code: 'invalid_request',
  });
});
test('payload validates field types, timestamps, URLs, origins and cookie fields', () => {
  for (const patch of [
    { v: 2 },
    { id: 'not-uuid' },
    { createdAt: 1.5 },
    { token: 'invalid' },
    { device: null },
    { extra: 1 },
    { site: { name: 'Site', url: 'file:///file' } },
    { cookies: {} },
    { cookies: [{ ...importPayload().cookies[0], hostOnly: true }] },
    { cookies: [{ ...importPayload().cookies[0], sameSite: 'bad' }] },
    { cookies: [{ ...importPayload().cookies[0], expires: '0' }] },
    { cookies: [{ ...importPayload().cookies[0], secure: 'true' }] },
    { localStorage: [{ origin: 'https://example.com/', items: [] }] },
    { localStorage: [{ origin: 'https://example.com', items: [['key', 1]] }] },
  ])
    assert.throws(() => parseImportPayload({ ...importPayload(), ...patch }), { code: 'invalid_request' });
  const valid = importPayload();
  valid.cookies[0].hostOnly = true;
  valid.cookies[0].domain = 'example.com';
  assert.deepEqual(parseImportPayload(valid), valid);
});
test('payload limits include escaped UTF-8 JSON size of a whole localStorage entry', () => {
  const p = importPayload();
  const entry: [string, string] = ['', 'x'.repeat(256 * 1024 - 7)];
  assert.equal(Buffer.byteLength(JSON.stringify(entry)), 256 * 1024);
  p.localStorage[0].items = [entry];
  assert.doesNotThrow(() => parseImportPayload(p));
  entry[1] += 'x';
  assert.throws(() => parseImportPayload(p), ImportLimitError);
  p.localStorage[0].items = [['', '\u0000'.repeat(50000)]];
  assert.throws(() => parseImportPayload(p), ImportLimitError);
  for (const patch of [
    { cookies: Array(4097).fill(importPayload().cookies[0]) },
    { cookies: [{ ...importPayload().cookies[0], value: '界'.repeat(1366) }] },
    { device: 'a'.repeat(65) },
    { site: { name: 'a'.repeat(129), url: 'https://example.com' } },
    { localStorage: Array.from({ length: 257 }, (_, i) => ({ origin: `https://site${i}.com`, items: [] })) },
    {
      localStorage: [
        {
          origin: 'https://example.com',
          items: Array.from({ length: 43 }, (_, i) => [String(i), 'x'.repeat(250000)]),
        },
      ],
    },
  ])
    assert.throws(() => parseImportPayload({ ...importPayload(), ...patch }), ImportLimitError);
});
test('pairing code is unpadded base64url JSON and preserves Browser identity', () => {
  const p = {
    v: 1 as const,
    server: 'viewer.test:3001',
    user: '测试用户',
    mailbox: 'import@example.com',
    key: { id: keyId, x25519: publicKey.toString('base64url') },
    token: randomBytes(32).toString('base64url'),
    browser: { userAgent: browserIdentity.userAgent, ...browserIdentity.metadata },
  };
  const code = buildPairingCode(p);
  assert.match(code, /^RKP1:[A-Za-z0-9_-]+$/);
  assert.deepEqual(parsePairingCode(code), p);
  assert.throws(() => parsePairingCode(code + '='), { code: 'invalid_request' });
});
