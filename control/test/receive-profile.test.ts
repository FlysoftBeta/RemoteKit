import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureReceiveOffer,
  requiredH264Level,
  selectProductReceiveProfile,
  selectReceiveProfile,
  supportsConstrainedBaselineMode1,
} from '../client/media/receive-profile';
import { diagnosticClientSample } from '../server/diagnostics/projection';

const codecs = [
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
];
const offer =
  'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108 110\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\na=rtpmap:110 H264/90000\r\na=fmtp:110 packetization-mode=0;profile-level-id=42e01f\r\n';
const fhd = { width: 1920, height: 1080 };
const qhd = { width: 2560, height: 1600 };
const uhd = { width: 3840, height: 2160 };

test('the required level is the lowest one carrying the physical screen at 60fps', () => {
  assert.equal(requiredH264Level({ width: 1280, height: 720 }), 42);
  assert.equal(requiredH264Level(fhd), 42);
  assert.equal(requiredH264Level({ width: 1080, height: 2400 }), 51);
  assert.equal(requiredH264Level(qhd), 51);
  assert.equal(requiredH264Level({ width: 1440, height: 3200 }), 52);
  assert.equal(requiredH264Level(uhd), 52);
  assert.equal(requiredH264Level({ width: 5120, height: 2880 }), 52);
});

test('a supported required level is declared at the native size', async () => {
  const probed: unknown[] = [];
  const selection = await selectReceiveProfile(codecs, qhd, async (configuration) => {
    probed.push(configuration);
    return { supported: true };
  });
  assert.equal(selection.profile, 'h264-level51');
  assert.deepEqual(selection.required, qhd);
  assert.deepEqual(probed[0], { codec: 'avc1.42e033', codedWidth: 2560, codedHeight: 1600 });
  assert.deepEqual(
    probed.map((configuration) => (configuration as { codec: string }).codec),
    ['avc1.42e033', 'avc1.42e032', 'avc1.42e02a'],
  );
  assert.match(selection.reason, /covers 2560x1600@60/);
});

test('an explicit rejection falls back to the highest supported lower level at the native aspect', async () => {
  const sizes = new Map<string, [number, number]>();
  const selection = await selectReceiveProfile(codecs, uhd, async (configuration) => {
    sizes.set(configuration.codec, [configuration.codedWidth, configuration.codedHeight]);
    return { supported: configuration.codec !== 'avc1.42e034' };
  });
  assert.equal(selection.profile, 'h264-level51');
  const [width, height] = sizes.get('avc1.42e033')!;
  assert.ok(Math.abs(width / height - 16 / 9) < 0.01);
  assert.ok(Math.ceil(width / 16) * Math.ceil(height / 16) * 60 <= 983040);
  assert.deepEqual(selection.probes, {
    level52: 'rejected',
    level51: 'supported',
    level50: 'supported',
    level42: 'supported',
  });
});

test('undetermined probes declare the required level instead of the browser default', async () => {
  const thrown = await selectReceiveProfile(codecs, qhd, async () => {
    throw new TypeError('webrtc type unsupported');
  });
  assert.equal(thrown.profile, 'h264-level51');
  assert.match(thrown.reason, /without decoder evidence/);
  assert.match(thrown.reason, /TypeError/);
  const partly = await selectReceiveProfile(codecs, uhd, async (configuration) => {
    if (configuration.codec === 'avc1.42e034') return { supported: false };
    throw new Error('unknown');
  });
  assert.equal(partly.profile, 'h264-level51');
});

test('only an explicit rejection of every level or a missing codec keeps the browser offer', async () => {
  assert.equal(
    (await selectReceiveProfile(codecs, fhd, async () => ({ supported: false }))).profile,
    'native',
  );
  assert.equal((await selectReceiveProfile([], fhd, async () => ({ supported: true }))).profile, 'native');
});

test('without WebCodecs, MediaCapabilities WebRTC is asked at 60fps; its absence is not a limit', async (t) => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const requests: MediaDecodingConfiguration[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaCapabilities: {
        decodingInfo: async (configuration: MediaDecodingConfiguration) => {
          requests.push(configuration);
          return { supported: true };
        },
      },
    },
  });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, 'navigator', old);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const selection = await selectReceiveProfile(codecs, fhd, undefined);
  assert.equal(selection.profile, 'h264-level42');
  assert.equal(selection.probeSource, 'media-capabilities-webrtc');
  assert.deepEqual(requests[0], {
    type: 'webrtc',
    video: {
      contentType: 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e02a',
      width: 1920,
      height: 1080,
      bitrate: 48000000,
      framerate: 60,
    },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const unavailable = await selectReceiveProfile(codecs, fhd, undefined);
  assert.equal(unavailable.profile, 'h264-level42');
  assert.deepEqual(unavailable.probes, { level42: 'unavailable' });
});

test('the offer rewrite touches only constrained-baseline mode1 H264 video payloads', () => {
  assert.equal(configureReceiveOffer(offer, 'native').sdp, offer);
  const configured = configureReceiveOffer(offer, 'h264-level52', codecs);
  assert.equal(configured.changes.length, 1);
  assert.match(configured.sdp, /a=fmtp:108 .*profile-level-id=42e034/);
  assert.match(configured.sdp, /a=fmtp:110 .*profile-level-id=42e01f/);
  assert.match(configureReceiveOffer(offer, 'h264-level42', codecs).sdp, /a=fmtp:108 .*42e02a/);
  const cb = codecs[0];
  for (const unsupported of [
    undefined,
    [],
    [{ ...cb, mimeType: 'video/VP8' }],
    [{ ...cb, sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f' }],
    [{ ...cb, sdpFmtpLine: 'packetization-mode=1;profile-level-id=64001f' }],
  ]) {
    assert.equal(supportsConstrainedBaselineMode1(unsupported), false);
    assert.throws(() => configureReceiveOffer(offer, 'h264-level42', unsupported), /需要客户端支持 H.264/);
  }
  for (const changed of [
    offer.split('H264/90000').join('VP8/90000'),
    offer.replace('m=video', 'm=audio'),
    offer.replace('m=video 9', 'm=video 0'),
  ])
    assert.throws(() => configureReceiveOffer(changed, 'h264-level42', codecs), /原始 offer/);
});

test('production probes run in parallel and share page-local in-flight and completed results', async (t) => {
  const saved = ['VideoDecoder', 'window'].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const pending: { configuration: { codec: string }; resolve: (value: { supported: boolean }) => void }[] =
    [];
  Object.defineProperty(globalThis, 'VideoDecoder', {
    configurable: true,
    value: {
      isConfigSupported: (configuration: { codec: string }) =>
        new Promise((resolve) => pending.push({ configuration, resolve })),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { devicePixelRatio: 2, screen: { width: 1280, height: 800 } },
  });
  t.after(() => {
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  });
  const first = selectProductReceiveProfile(codecs),
    second = selectProductReceiveProfile(codecs);
  await Promise.resolve();
  assert.equal(pending.length, 3);
  pending.forEach((work) => work.resolve({ supported: true }));
  assert.equal((await first).profile, 'h264-level51');
  assert.equal((await second).profile, 'h264-level51');
  assert.equal((await selectProductReceiveProfile(codecs)).profile, 'h264-level51');
  assert.equal(pending.length, 3);
  assert.deepEqual((await first).required, qhd);
  assert.ok((await first).probeDurationMs! >= 0);
});

test('diagnostics keep the coded outcome per probed level and the required size', async () => {
  const selection = await selectReceiveProfile(codecs, uhd, async (configuration) => {
    if (configuration.codec === 'avc1.42e034') throw new TypeError('unsupported');
    return { supported: false };
  });
  assert.equal(selection.profile, 'h264-level52');
  const projected = diagnosticClientSample(
    { receive: { ...selection, reason: selection.reason } },
    new Set(),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), {
    receive: {
      profile: 'h264-level52',
      probeSource: 'video-decoder',
      probes: { level52: 'error', level51: 'rejected', level50: 'rejected', level42: 'rejected' },
      required: { width: 3840, height: 2160 },
    },
  });
});
