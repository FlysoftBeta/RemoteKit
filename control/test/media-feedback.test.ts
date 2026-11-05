import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaFeedbackSampler, type FeedbackCounters } from '../client/media/media-feedback';

function harness() {
  let now = 0,
    visible = true,
    id = 0,
    removed = 0;
  const frames = new Map<number, FrameRequestCallback>(),
    visibility = new Set<() => void>();
  const sampler = new MediaFeedbackSampler({
    now: () => now,
    visible: () => visible,
    requestFrame: (callback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelFrame: (key) => {
      frames.delete(key);
    },
    onVisibility: (callback) => {
      visibility.add(callback);
      return () => {
        visibility.delete(callback);
        removed++;
      };
    },
  });
  return {
    sampler,
    frames,
    visibility,
    get removed() {
      return removed;
    },
    time: (value: number) => {
      now = value;
    },
    raf: (at: number) => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(at);
    },
    hide: (value: boolean) => {
      visible = !value;
      for (const callback of visibility) callback();
    },
  };
}
const counters = (change: Partial<FeedbackCounters> = {}): FeedbackCounters => ({
  layoutEpoch: 'e1',
  outputGeneration: 'g1',
  planes: [],
  ...change,
});

test('feedback measures foreground RAF independently and requires reliable counter baselines', () => {
  const h = harness();
  h.sampler.start();
  for (let i = 0; i <= 90; i++) h.raf((i * 1000) / 60);
  h.time(1500);
  const first = h.sampler.sample(counters({ decodedFrames: 100, videoFrames: 90, roundTripTimeMs: 10 }));
  assert.ok(first);
  assert.equal(first.seq, 1);
  assert.equal(first.rafSamples, 90);
  assert.ok(Math.abs(first.displayHzEstimate! - 60) < 0.001);
  assert.equal('decodedFrames' in first, false);
  assert.equal('videoFrames' in first, false);
  assert.equal(first.roundTripTimeMs, 10);
  h.time(2000);
  assert.equal(h.sampler.sample(counters()), undefined);
  h.time(3001);
  const second = h.sampler.sample(counters({ decodedFrames: 175, videoFrames: 139 }));
  assert.ok(second);
  assert.equal(second.windowMs, 1501);
  assert.equal(second.decodedFrames, 75);
  assert.equal(second.videoFrames, 49);
  assert.equal('displayHzEstimate' in second, false);
  assert.equal('roundTripTimeMs' in second, false);
});

test('split planes preserve independent compositor counts and receiver frame deltas', () => {
  const h = harness();
  h.sampler.start();
  h.time(1500);
  h.sampler.sample(
    counters({
      videoFrames: 10,
      planes: [
        { view: 'main', frames: 4 },
        { view: 'split', frames: 8 },
      ],
    }),
  );
  h.time(3000);
  const report = h.sampler.sample(
    counters({
      videoFrames: 11,
      planes: [
        { view: 'main', frames: 5 },
        { view: 'split', frames: 10 },
      ],
    }),
  );
  assert.deepEqual(report?.planes, [
    { view: 'main', frames: 1 },
    { view: 'split', frames: 2 },
  ]);
  assert.equal(report?.videoFrames, 1);
  h.time(4500);
  const changed = h.sampler.sample(
    counters({
      planes: [
        { view: 'split', frames: 11 },
        { view: 'new', frames: 1 },
      ],
    }),
  );
  assert.deepEqual(changed?.planes, [{ view: 'split', frames: 1 }, { view: 'new' }]);
});

test('missing, regressed and replacement-layout counters stay unknown then establish a fresh baseline', () => {
  const h = harness();
  h.sampler.start();
  h.time(1500);
  h.sampler.sample(
    counters({
      decodedFrames: 100,
      videoFrames: 50,
      packetsLost: 5,
      framesDropped: 3,
      planes: [{ view: 'a', frames: 40 }],
    }),
  );
  h.time(3000);
  const reset = h.sampler.sample(
    counters({
      decodedFrames: 10,
      videoFrames: undefined,
      packetsLost: NaN,
      framesDropped: -1,
      roundTripTimeMs: Infinity,
      planes: [{ view: 'a', frames: 2 }],
    }),
  );
  assert.deepEqual(reset, {
    type: 'media.feedback',
    version: 1,
    seq: 2,
    layoutEpoch: 'e1',
    outputGeneration: 'g1',
    visible: true,
    windowMs: 1500,
    rafSamples: 0,
    planes: [{ view: 'a' }],
  });
  h.time(4500);
  const next = h.sampler.sample(
    counters({ decodedFrames: 15, videoFrames: 9, planes: [{ view: 'a', frames: 4 }] }),
  );
  assert.equal(next?.decodedFrames, 5);
  assert.equal('videoFrames' in next!, false);
  assert.equal(next?.planes[0].frames, 2);
  h.time(6000);
  const generation = h.sampler.sample(
    counters({
      outputGeneration: 'g2',
      decodedFrames: 20,
      videoFrames: 12,
      planes: [{ view: 'a', frames: 6 }],
    }),
  );
  assert.equal('decodedFrames' in generation!, false);
  assert.equal('frames' in generation!.planes[0], false);
});

test('visibility changes invalidate refresh estimates until a complete visible sample window', () => {
  const h = harness();
  h.sampler.start();
  for (let i = 0; i < 30; i++) h.raf(i * 16.67);
  h.hide(true);
  h.time(1500);
  const hidden = h.sampler.sample(counters());
  assert.equal(hidden?.visible, false);
  assert.equal('displayHzEstimate' in hidden!, false);
  h.hide(false);
  for (let i = 0; i < 30; i++) h.raf(1600 + i * 16.67);
  h.time(3000);
  assert.equal(h.sampler.sample(counters())?.displayHzEstimate, undefined);
  for (let i = 0; i < 30; i++) h.raf(3100 + i * 16.67);
  h.time(4500);
  assert.ok(h.sampler.sample(counters())?.displayHzEstimate);
});

test('disconnect cancels RAF/listeners, ignores late callbacks and reconnect resets sequence and baselines', () => {
  const h = harness();
  h.sampler.start();
  const late = [...h.frames.values()][0];
  h.time(1500);
  assert.equal(h.sampler.sample(counters({ decodedFrames: 5 }))?.seq, 1);
  h.sampler.stop();
  assert.equal(h.frames.size, 0);
  assert.equal(h.visibility.size, 0);
  assert.equal(h.removed, 1);
  late(1600);
  assert.equal(h.frames.size, 0);
  h.time(3000);
  assert.equal(h.sampler.sample(counters()), undefined);
  h.sampler.start();
  assert.equal(h.frames.size, 1);
  assert.equal(h.visibility.size, 1);
  h.time(4500);
  const reconnect = h.sampler.sample(counters({ decodedFrames: 1 }));
  assert.equal(reconnect?.seq, 1);
  assert.equal('decodedFrames' in reconnect!, false);
  h.sampler.stop();
  h.sampler.stop();
  assert.equal(h.removed, 2);
});
