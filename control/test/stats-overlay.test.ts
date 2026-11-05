import test from 'node:test';
import assert from 'node:assert/strict';
import { statsViewModel } from '../client/media/stats-view-model';
import type { Diagnostics } from '../client/types';

test('stats choose the selected view presentation window and retain unknown metrics', () => {
  const diagnostics: Diagnostics = {
    connection: '',
    channel: '',
    displayFramesPerSecond: 50,
    paintFpsByView: { first: 24, second: 60 },
    decodedFramesPerSecond: 120,
  };
  assert.equal(statsViewModel(diagnostics, 'second').presentationFps, 60);
  assert.equal(statsViewModel(diagnostics, 'missing').presentationFps, undefined);
  assert.equal(statsViewModel(diagnostics).presentationFps, 50);
});
test('stats use GCC targets and negotiated playout independently of requested policy', () => {
  const diagnostics: Diagnostics = {
    connection: '',
    channel: '',
    endpoint: {
      gccTargetFps: 42,
      appliedFps: 240,
      gccTargetBitrate: 12000000,
      queueFullDrops: 3,
      rtcPlayoutDelayRequested: { maxMs: 50 },
      mediaPolicy: { requested: { maxFps: 60 }, applied: { maxFps: 60 } },
    },
    receiverVideoPlayoutExtensionNegotiated: false,
  };
  const model = statsViewModel(diagnostics);
  assert.equal(model.inputFps, 42);
  assert.equal(model.targetBitrate, 12000000);
  assert.equal(model.queueFullDrops, 3);
  assert.equal(model.playoutExtension, false);
  assert.equal(model.requestedPlayoutCap, 50);
  assert.equal(model.mediaPolicy?.applied?.maxFps, 60);
});
test('stats retain real receiver interval measurements including zero', () => {
  const receiverVideoTiming = { jitterBufferMeanMs: 0, decodeMeanMs: 3, droppedFrames: 1 };
  const model = statsViewModel({ connection: '', channel: '', receiverVideoTiming });
  assert.deepEqual(model.receiverTiming, receiverVideoTiming);
  assert.equal(model.videoTiming, undefined);
});
