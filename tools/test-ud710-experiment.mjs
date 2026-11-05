import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createMarkerCodec } from './ud710-marker.mjs';
import { createScrollStimulus } from './ud710-lag-scenario.mjs';
process.env.REMOTEKIT_QA_UD710_AUDIO = 'on';
const { validateAudioEvidence, createScenario } = await import('./ud710-av-scenario.mjs');
const codec = createMarkerCodec();

test('CRC matches CCITT-FALSE vector and rejects every single-bit payload corruption', () => {
  assert.equal(codec.crc16(new TextEncoder().encode('123456789')), 0x29b1);
  for (const [time, sequence] of [
    [0, 0],
    [0xffffffff, 0xffff],
    [0x80000000, 0x8000],
    [1780901201, 123],
  ]) {
    const encoded = codec.encode(time, sequence);
    assert.deepEqual(codec.decode(encoded), { ok: true, value: time, sequence });
    for (let bit = 0; bit < 80; bit++) {
      const broken = encoded.slice();
      broken[bit >>> 3] ^= 1 << (bit & 7);
      assert.equal(codec.decode(broken).ok, false);
    }
  }
});

test('pixel marker tolerates gray black/white and rejects ambiguous or damaged cells', () => {
  const pixels = new Uint8ClampedArray(codec.width * codec.height * 4);
  const context = {
    fillStyle: 'white',
    fillRect(x, y, width, height) {
      const level = this.fillStyle === 'black' ? 25 : 230;
      for (let py = y; py < y + height; py++)
        for (let px = x; px < x + width; px++) {
          const offset = (py * codec.width + px) * 4;
          pixels.set([level, level, level, 255], offset);
        }
    },
  };
  codec.draw(context, codec.encode(0xfedcba98, 65537));
  assert.deepEqual(codec.readPixels(pixels), { ok: true, value: 0xfedcba98, sequence: 1 });
  for (let y = 7; y <= 9; y++)
    for (let x = 6; x <= 8; x++) {
      pixels.fill(128, (y * codec.width + x) * 4, (y * codec.width + x) * 4 + 3);
    }
  assert.equal(codec.readPixels(pixels).reason, 'ambiguous');
});

test('audio-off rejects actual RTP and missing telemetry; audio-on requires both ends', () => {
  const client = [{ rtc: { inboundVideo: { bytesReceived: 1000 } } }];
  const endpoint = [{ stats: { senderRtcStats: { outbound: [{ kind: 'video', bytesSent: 1000 }] } } }];
  assert.equal(validateAudioEvidence(client, endpoint, 'off').bytesSent, 0);
  assert.throws(() => validateAudioEvidence([], [], 'off'), /Missing live RTC/);
  assert.throws(() => validateAudioEvidence(client, endpoint, 'on'), /lacks sender/);
  client[0].rtc.inboundAudio = { packetsReceived: 10, bytesReceived: 500 };
  assert.throws(() => validateAudioEvidence(client, endpoint, 'off'), /still carried/);
  assert.throws(() => validateAudioEvidence(client, endpoint, 'on'), /lacks sender/);
  endpoint[0].stats.senderRtcStats.outbound.push({ kind: 'audio', packetsSent: 10, bytesSent: 500 });
  assert.equal(validateAudioEvidence(client, endpoint, 'on').bytesReceived, 500);
});

test('legacy and CRC fixture scripts compile and retain the same scrolling stimulus', () => {
  const legacy = createScrollStimulus();
  let checked;
  createScenario().fixture(
    { url: '/' },
    {
      setHeader() {},
      end(value) {
        checked = value;
      },
    },
  );
  for (const html of [legacy, checked]) {
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(script));
    assert.match(script, /elapsed % 1700/);
  }
  assert.match(legacy, /height="32"/);
  assert.match(checked, /height="80"/);
  const isolated = vm.runInNewContext('(' + createMarkerCodec.toString() + ')()');
  assert.equal(isolated.decode(isolated.encode(123, 456)).value, 123);
});
