import test from 'node:test';
import assert from 'node:assert/strict';
import { configureReceiverPlayout } from '../client/receiver-playout';

test('standard jitter buffer target is set to zero without applying the legacy hint', () => {
  const receiver = { jitterBufferTarget: 100, playoutDelayHint: .2 };
  assert.deepEqual(configureReceiverPlayout(receiver as unknown as RTCRtpReceiver), {
    jitterBufferTargetSupported: true, jitterBufferTarget: 0,
    playoutDelayHintSupported: true, playoutDelayHint: null,
  });
  assert.equal(receiver.jitterBufferTarget, 0); assert.equal(receiver.playoutDelayHint, .2);
});

test('Chrome89 compatibility hint is zero and never creates a claimed standard property', () => {
  const receiver = { playoutDelayHint: .2 };
  assert.deepEqual(configureReceiverPlayout(receiver as unknown as RTCRtpReceiver), {
    jitterBufferTargetSupported: false, jitterBufferTarget: null,
    playoutDelayHintSupported: true, playoutDelayHint: 0,
  });
  assert.equal('jitterBufferTarget' in receiver, false); assert.equal(receiver.playoutDelayHint, 0);
  const unavailable = {};
  assert.deepEqual(configureReceiverPlayout(unavailable as RTCRtpReceiver), {
    jitterBufferTargetSupported: false, jitterBufferTarget: null,
    playoutDelayHintSupported: false, playoutDelayHint: null,
  });
  assert.deepEqual(unavailable, {});
});

test('rejected standard setter reports failure and uses an existing compatibility hint', () => {
  const receiver = { get jitterBufferTarget() { return 50; }, set jitterBufferTarget(_value: number) { throw new Error('unsupported'); }, playoutDelayHint: 1 };
  assert.deepEqual(configureReceiverPlayout(receiver as unknown as RTCRtpReceiver), {
    jitterBufferTargetSupported: true, jitterBufferTarget: null,
    playoutDelayHintSupported: true, playoutDelayHint: 0, error: 'jitter-buffer-target-rejected',
  });
});
