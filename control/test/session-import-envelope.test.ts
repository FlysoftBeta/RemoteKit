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
import { importPayload } from './session-import-fixture';
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
    { username: '' },
    { username: 'x'.repeat(65) },
    { username: null },
    { password: '' },
    { password: 'x'.repeat(257) },
    { password: null },
    { token: 'invalid' },
    { device: null },
    { extra: 1 },
    { site: { name: 'Site', url: 'https://example.com' } },
    { sites: [] },
    { sites: [{ name: 'Site', url: 'file:///file' }] },
    { sites: [{ name: 'Site', url: 'https://example.com', icon: '' }] },
    {
      sites: [
        { name: 'A', url: 'https://example.com' },
        { name: 'B', url: 'https://example.com' },
      ],
    },
    { cookies: {} },
    { cookies: [{ ...importPayload().cookies[0], hostOnly: true }] },
    { cookies: [{ ...importPayload().cookies[0], sameSite: 'bad' }] },
    { cookies: [{ ...importPayload().cookies[0], expires: '0' }] },
    { cookies: [{ ...importPayload().cookies[0], secure: 'true' }] },
    { localStorage: [{ origin: 'https://example.com/', items: [] }] },
    { localStorage: [{ origin: 'https://example.com', items: [['key', 1]] }] },
  ])
    assert.throws(() => parseImportPayload({ ...importPayload(), ...patch }), { code: 'invalid_request' });
  for (const credentials of [
    { username: 'a', password: 'b' },
    { username: '界'.repeat(64), password: '😀'.repeat(256) },
  ]) {
    const payload = importPayload(credentials);
    assert.deepEqual(parseImportPayload(payload), payload);
  }
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
    { sites: [{ name: 'a'.repeat(129), url: 'https://example.com' }] },
    { sites: Array.from({ length: 17 }, (_, i) => ({ name: 'S', url: `https://s${i}.example.com` })) },
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
