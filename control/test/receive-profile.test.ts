import test from 'node:test';
import assert from 'node:assert/strict';
import { configureReceiveOffer, originalGatheredOffer, chooseReceiveProfile, loadReceiveProfile, supportsExperimentalH264Level42 } from '../client/receive-profile';
test('product receive defaults never read persisted experimental settings', t => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let storageReads = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { storageReads++; throw new Error('Persistence forbidden'); } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Chrome/157.0' } });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
  });
  assert.equal(loadReceiveProfile(), 'native');
  assert.equal(storageReads, 0);
});
test('Chrome89 4.2 profile is explicit, constrained-baseline mode1 only and preserves native offer', () => {
  const original = 'v=0\r\na=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\na=fmtp:110 packetization-mode=0;profile-level-id=42e01f\r\na=fmtp:112 packetization-mode=1;profile-level-id=4d0015\r\n';
  assert.equal(configureReceiveOffer(original, 'native', 'Chrome/157.0').sdp, original);
  assert.throws(() => configureReceiveOffer(original, 'chrome89-h264-42', 'Chrome/157.0'));
  const effective = configureReceiveOffer(original, 'chrome89-h264-42', 'Chrome/89.0.4389.90');
  assert.equal(effective.changes.length, 1); assert.match(effective.sdp, /a=fmtp:108 .*profile-level-id=42e02a/); assert.match(effective.sdp, /a=fmtp:110 .*profile-level-id=42e01f/);
  const gathered = effective.sdp + 'a=candidate:raw-host\r\n'; assert.equal(originalGatheredOffer(gathered, original), original + 'a=candidate:raw-host\r\n');
  assert.match(configureReceiveOffer(original, 'chrome89-h264-51', 'Chrome/89.0').sdp, /a=fmtp:108 .*profile-level-id=42e033/);
});

test('Chromium157 can explicitly select capability-checked level4.2 without changing its default or UA', () => {
  const ua = 'Mozilla/5.0 Chrome/157.0.8103.15 Safari/537.36';
  const codecs = [{ mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' }];
  const offer = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108 110\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\na=rtpmap:110 H264/90000\r\na=fmtp:110 packetization-mode=0;profile-level-id=42e01f\r\n';
  assert.equal(chooseReceiveProfile(ua), 'native');
  assert.equal(chooseReceiveProfile(ua, 'h264-level42-experimental'), 'h264-level42-experimental');
  const configured = configureReceiveOffer(offer, 'h264-level42-experimental', ua, codecs);
  assert.equal(configured.changes.length, 1); assert.match(configured.sdp, /a=fmtp:108 .*profile-level-id=42e02a/);
  assert.match(configured.sdp, /a=fmtp:110 .*profile-level-id=42e01f/);
  assert.equal(originalGatheredOffer(configured.sdp, offer), offer);
  assert.throws(() => configureReceiveOffer(offer, 'chrome89-h264-42', ua, codecs), /Chrome 89/);
});

test('experimental level4.2 refuses missing codec capabilities and incompatible offer payloads', () => {
  const cb = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
  const offer = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 packetization-mode=1;profile-level-id=42e01f\r\n';
  for (const codecs of [undefined, [], [{ ...cb, mimeType: 'video/VP8' }], [{ ...cb, sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f' }], [{ ...cb, sdpFmtpLine: 'packetization-mode=1;profile-level-id=64001f' }]]) {
    assert.equal(supportsExperimentalH264Level42(codecs), false);
    assert.throws(() => configureReceiveOffer(offer, 'h264-level42-experimental', 'Chrome/157.0', codecs), /需要客户端支持 H.264/);
  }
  assert.throws(() => configureReceiveOffer(offer.replace('H264/90000', 'VP8/90000'), 'h264-level42-experimental', 'Chrome/157.0', [cb]), /原始 offer/);
  assert.throws(() => configureReceiveOffer(offer.replace('m=video', 'm=audio'), 'h264-level42-experimental', 'Chrome/157.0', [cb]), /原始 offer/);
  assert.throws(() => configureReceiveOffer(offer.replace('m=video 9', 'm=video 0'), 'h264-level42-experimental', 'Chrome/157.0', [cb]), /原始 offer/);
});

test('only the verified desktop Chrome build defaults to 4.2 and saved choices take priority', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36';
  assert.equal(chooseReceiveProfile(ua), 'chrome89-h264-42');
  assert.equal(chooseReceiveProfile(ua, 'native'), 'native');
  assert.equal(chooseReceiveProfile(ua, 'chrome89-h264-51'), 'chrome89-h264-51');
  assert.equal(chooseReceiveProfile(ua.replace('4389.90', '4389.91')), 'native');
  assert.equal(chooseReceiveProfile(ua.replace('Windows NT 10.0', 'Linux; Android 10')), 'native');
  assert.equal(chooseReceiveProfile(ua + ' Edg/89.0'), 'native');
  assert.equal(chooseReceiveProfile(ua.replace('Chrome/89.0.4389.90', 'Chrome/157.0.0.0'), 'chrome89-h264-51'), 'native');
});
