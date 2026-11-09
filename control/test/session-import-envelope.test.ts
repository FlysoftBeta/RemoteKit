import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_BYTES,
  openMessage,
  parseDeviceMessage,
  sealMessage,
  envelopeKeyId,
} from '../server/session-import/envelope';
import { hpkeSeal } from '../server/session-import/hpke';
import { wordlist } from '../server/session-import/wordlist';
import {
  controlPrivate,
  controlPublic,
  controlKeyId,
  devicePrivate,
  devicePublic,
  deviceKeyId,
  deviceEnvelope,
  importEvent,
  pairEvent,
} from './session-import-fixture';
test('v2 round trip authenticates each header region and limits decompression', () => {
  const message = { v: 2 as const, ack: 0, events: [pairEvent(), importEvent()] };
  const envelope = deviceEnvelope(message.events);
  const opened = openMessage(controlPrivate, controlKeyId, envelope);
  assert.equal(opened.senderKeyId, deviceKeyId);
  assert.deepEqual(opened.message, message);
  assert.deepEqual(parseDeviceMessage(opened.message).message, message);
  for (const offset of [0, 4, 5, 13, 44, 45, 76, 77, envelope.length - 1]) {
    const changed = Buffer.from(envelope);
    changed[offset] ^= 1;
    assert.throws(
      () =>
        openMessage(
          controlPrivate,
          offset === 5 ? changed.subarray(5, 13).toString('hex') : controlKeyId,
          changed,
        ),
      { code: 'invalid_request' },
    );
  }
  assert.equal(envelopeKeyId(Buffer.from('RKSI' + String.fromCharCode(1))), undefined);
  assert.throws(() => openMessage(controlPrivate, controlKeyId, envelope.subarray(0, 92)));
  const oversized = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
  envelope.copy(oversized);
  assert.throws(() => openMessage(controlPrivate, controlKeyId, oversized));
  const aad = envelope.subarray(0, 45);
  const bomb = hpkeSeal(
    devicePrivate,
    controlPublic,
    Buffer.from('RemoteKit session import v2'),
    aad,
    gzipSync(Buffer.alloc(MAX_PAYLOAD_BYTES + 1)),
  );
  assert.throws(
    () => openMessage(controlPrivate, controlKeyId, Buffer.concat([aad, bomb.enc, bomb.ciphertext])),
    { code: 'invalid_request' },
  );
  assert.throws(() =>
    sealMessage(devicePrivate, devicePublic, controlPublic, {
      v: 2,
      ack: 0,
      events: [
        importEvent({
          localStorage: [{ origin: 'https://example.com', items: [['', 'x'.repeat(MAX_PAYLOAD_BYTES)]] }],
        }),
      ],
    }),
  );
});
test('message rejects v1, unknown keys, invalid pair/withdraw, sequence gaps and invalid ack', () => {
  const valid = { v: 2, ack: 0, events: [pairEvent(), importEvent()] };
  for (const patch of [
    { v: 1 },
    { extra: true },
    { ack: -1 },
    { ack: 1.5 },
    { events: {} },
    { events: [pairEvent(), importEvent({ seq: 3 })] },
    { events: [pairEvent({ seq: 0 })] },
    { events: [{ ...pairEvent(), extra: 1 }] },
    { events: [pairEvent({ code: ['one'] })] },
    { events: [pairEvent({ device: '界'.repeat(65) })] },
    { events: [pairEvent({ password: '' })] },
    { events: [{ seq: 1, at: 0, type: 'withdraw', id: 'bad' }] },
    { events: [{ ...importEvent(), extra: 1 }] },
    { events: [importEvent({ cookies: [{ ...importEvent().cookies[0], extra: 1 } as any] })] },
  ])
    assert.throws(() => parseDeviceMessage({ ...valid, ...patch }), { code: 'invalid_request' });
  assert.deepEqual(parseDeviceMessage({ v: 2, ack: 10, events: [] }).message, { v: 2, ack: 10, events: [] });
});
test('invalid import fields and limits return per-event errors while retaining adjacent events', () => {
  const p = importEvent();
  const patches: [any, string][] = [
    [{ sites: [] }, 'sites'],
    [{ sites: [{ name: 'S', url: 'file:///file' }] }, 'site.url'],
    [{ sites: [p.sites[0], p.sites[0]] }, 'site.url'],
    [{ cookies: {} }, 'storage arrays'],
    [{ cookies: [{ ...p.cookies[0], hostOnly: true }] }, 'cookie.domain'],
    [{ cookies: [{ ...p.cookies[0], sameSite: 'bad' }] }, 'cookie.sameSite'],
    [{ localStorage: [{ origin: 'https://example.com/', items: [] }] }, 'origin'],
    [{ localStorage: [{ origin: 'https://example.com', items: [['x', 1]] }] }, 'item.value'],
    [{ cookies: Array(4097).fill(p.cookies[0]) }, 'Cookie 超过 4096 条'],
    [{ cookies: [{ ...p.cookies[0], value: '界'.repeat(1366) }] }, 'Cookie 名称与值超过 4096 字节'],
    [
      { sites: Array.from({ length: 17 }, (_, i) => ({ name: 'S', url: `https://s${i}.com` })) },
      '站点超过 16 个',
    ],
    [{ sites: [{ name: '界'.repeat(129), url: 'https://example.com' }] }, '站点名超过 128 字符'],
    [
      { localStorage: Array.from({ length: 257 }, (_, i) => ({ origin: `https://s${i}.com`, items: [] })) },
      '来源超过 256 个',
    ],
    [
      { localStorage: [{ origin: 'https://example.com', items: [['', 'x'.repeat(256 * 1024)]] }] },
      'localStorage 条目超过 256 KiB',
    ],
    [
      {
        localStorage: [
          {
            origin: 'https://example.com',
            items: Array.from({ length: 43 }, (_, i) => [String(i), 'x'.repeat(250000)]),
          },
        ],
      },
      'localStorage 来源超过 10 MiB',
    ],
  ];
  for (const [patch, reason] of patches) {
    const { results } = parseDeviceMessage({
      v: 2,
      ack: 0,
      events: [pairEvent(), { ...p, ...patch }, { seq: 3, at: p.at, type: 'withdraw', id: p.id }],
    });
    assert.equal(results[0].error, null);
    assert.ok(results[1].error, reason);
    assert.equal(
      results[1].errorCode,
      patches.findIndex((entry) => entry[0] === patch) < 8 ? 'invalid_request' : 'limit_exceeded',
      reason,
    );
    assert.equal(results[2].error, null);
  }
  const entry = ['', 'x'.repeat(256 * 1024 - 7)];
  assert.equal(Buffer.byteLength(JSON.stringify(entry)), 256 * 1024);
  assert.equal(
    parseDeviceMessage({
      v: 2,
      ack: 0,
      events: [{ ...p, localStorage: [{ origin: 'https://example.com', items: [entry] }] }],
    }).results[0].error,
    null,
  );
});
test('pairing wordlist is the canonical BIP39 source embedded without runtime assets', () => {
  assert.equal(wordlist.length, 2048);
  const source = readFileSync(new URL('../../protocol/session-import/wordlist.txt', import.meta.url));
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda',
  );
  assert.deepEqual(wordlist, source.toString('utf8').trim().split(/\r?\n/));
});
