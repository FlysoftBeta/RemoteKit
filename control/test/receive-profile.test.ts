import test from 'node:test';
import assert from 'node:assert/strict';
import { configureReceiveOffer, originalGatheredOffer, chooseReceiveProfile } from '../client/receive-profile';
test('Chrome89 4.2 profile is explicit, constrained-baseline mode1 only and preserves native offer', () => {
  const original = 'v=0\r\na=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\na=fmtp:110 packetization-mode=0;profile-level-id=42e01f\r\na=fmtp:112 packetization-mode=1;profile-level-id=4d0015\r\n';
  assert.equal(configureReceiveOffer(original, 'native', 'Chrome/157.0').sdp, original);
  assert.throws(() => configureReceiveOffer(original, 'chrome89-h264-42', 'Chrome/157.0'));
  const effective = configureReceiveOffer(original, 'chrome89-h264-42', 'Chrome/89.0.4389.90');
  assert.equal(effective.changes.length, 1); assert.match(effective.sdp, /a=fmtp:108 .*profile-level-id=42e02a/); assert.match(effective.sdp, /a=fmtp:110 .*profile-level-id=42e01f/);
  const gathered = effective.sdp + 'a=candidate:raw-host\r\n'; assert.equal(originalGatheredOffer(gathered, original), original + 'a=candidate:raw-host\r\n');
  assert.match(configureReceiveOffer(original, 'chrome89-h264-51', 'Chrome/89.0').sdp, /a=fmtp:108 .*profile-level-id=42e033/);
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
