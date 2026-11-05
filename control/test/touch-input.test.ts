import test from 'node:test';
import assert from 'node:assert/strict';
import { TouchInput, mergeTouchMoves, pointerSampleTime } from '../client/input/touch-input';
import { CaptureLatency } from '../client/media/capture-latency';

const point = (y: number, id = 1) => ({ id, x: 10, y, pressure: 0.5 });
test('source clock is fixed for a gesture and sampling intervals survive delivery stalls', () => {
  const touch = new TouchInput('test');
  const packets = [
    touch.sample('a', 'start', point(0), 10, 1000000)!,
    ...[16, 32, 48, 64, 80].map((t) => touch.sample('a', 'move', point(t), 10 + t, 9999999)!),
    touch.sample('a', 'end', point(80), 106)!,
  ];
  assert.deepEqual(
    packets.map((p) => p.sampleElapsedUs),
    [0, 16000, 32000, 48000, 64000, 80000, 96000],
  );
  assert.ok(
    packets.every(
      (p) => p.clockMode === 'source' && p.startServerWallUs === 1000000 && p.sequenceId === 'test:1',
    ),
  );
  assert.equal(touch.contactIds.length, 0);
});
test('calibration uses conservative server bound and expires without changing an active gesture', () => {
  const clock = new CaptureLatency();
  clock.calibrate(0, 900, 10, 910, 1005);
  assert.equal(clock.inputStart(90, 100, 1000), 1084000);
  assert.equal(clock.inputStart(15990, 16000, 16900), undefined);
  assert.equal(clock.inputStart(90, 100, 1100), undefined);
  const touch = new TouchInput('fallback');
  const down = touch.sample('a', 'start', point(0), 10)!;
  assert.equal(down.clockMode, 'arrival-fallback');
  assert.equal(touch.sample('a', 'move', point(10), 26, 999999)!.clockMode, 'arrival-fallback');
  assert.equal(touch.stats.arrivalFallbackGestures, 1);
});
test('multi-touch cancel is exactly one packet and clock/identity violations are detectable', () => {
  const touch = new TouchInput('multi');
  touch.sample('a', 'start', point(0), 10, 1000);
  touch.sample('a', 'start', point(0, 2), 12);
  assert.equal(touch.matches('b'), false);
  assert.equal(touch.sample('b', 'move', point(5), 15), undefined);
  assert.equal(touch.sample('a', 'move', point(5), 9), undefined);
  const cancel = touch.cancel()!;
  assert.deepEqual(cancel.points, []);
  assert.equal(touch.cancel(), cancel);
  touch.accepted(cancel);
  assert.equal(touch.cancel(), undefined);
  assert.deepEqual(touch.contactIds, []);
  assert.equal(touch.sample('a', 'move', point(5), 20), undefined);
});
test('move batches retain bounded recent source history and cannot cross terminals or gestures', () => {
  const touch = new TouchInput('batch');
  touch.sample('a', 'start', point(0), 0, 1000);
  let batch = touch.sample('a', 'move', point(0.001), 1)!;
  for (let i = 2; i <= 100; i++)
    batch = mergeTouchMoves(batch, touch.sample('a', 'move', point(i / 1000), i)!)!;
  assert.equal(batch.samples!.length, 32);
  assert.equal(batch.samples![0].sampleElapsedUs, 68000);
  assert.equal(batch.sampleElapsedUs, 100000);
  const end = touch.sample('a', 'end', point(0.1), 101)!;
  assert.equal(mergeTouchMoves(batch, end), undefined);
  touch.accepted(end);
  const next = touch.sample('a', 'start', point(0), 102)!;
  assert.equal(mergeTouchMoves(batch, { ...batch, sequenceId: next.sequenceId }), undefined);
});
test('interleaved per-pointer coalesced history skips old wire samples without cancelling pinch', () => {
  const touch = new TouchInput('pinch');
  touch.sample('a', 'start', point(0, 1), 0);
  touch.sample('a', 'start', point(0, 2), 1);
  touch.sample('a', 'start', point(0, 3), 2);
  const packets = [
    touch.sample('a', 'move', point(10, 1), 10),
    touch.sample('a', 'move', point(20, 1), 20),
    touch.sample('a', 'move', point(11, 2), 11),
    touch.sample('a', 'move', point(21, 2), 21),
    touch.sample('a', 'move', point(12, 3), 12),
    touch.sample('a', 'move', point(21, 3), 21),
  ].filter(Boolean);
  assert.deepEqual(
    packets.map((p) => p!.sampleElapsedUs),
    [10000, 20000, 21000, 21000],
  );
  assert.equal(touch.stats.invalidClock, 0);
  assert.equal(touch.stats.skippedHistory, 2);
  assert.equal(touch.stats.cancelled, 0);
  assert.deepEqual(touch.contactIds, [1, 2, 3]);
  assert.deepEqual(
    packets.slice(-2).map((p) => p!.points[0]),
    [point(21, 2), point(21, 3)],
  );
});
test('failed final end retains old owner for cancellation until queue accepts it', () => {
  const touch = new TouchInput('terminal');
  const down = touch.sample('old', 'start', point(0), 0)!;
  const end = touch.sample('old', 'end', point(5), 10)!;
  assert.equal(touch.sample('new', 'start', point(0), 11), undefined);
  const cancel = touch.cancel()!;
  assert.equal(cancel.sequenceId, down.sequenceId);
  assert.equal(cancel.inputIdentity, 'old');
  assert.equal(cancel.sampleElapsedUs, end.sampleElapsedUs);
  assert.equal(touch.cancel(), cancel);
  touch.accepted(cancel);
  assert.notEqual(touch.sample('new', 'start', point(0), 12)!.sequenceId, down.sequenceId);
});
test('timestamp normalization supports Chrome89 epoch values and rejects future/stale samples', () => {
  assert.equal(pointerSampleTime(123, 125, 1000000000000), 123);
  assert.equal(pointerSampleTime(1700000000123, 125, 1700000000000), 123);
  assert.equal(pointerSampleTime(127, 125, 0), undefined);
  assert.equal(pointerSampleTime(1, 6000, 0), undefined);
  assert.equal(pointerSampleTime(NaN, 125, 0), undefined);
});
