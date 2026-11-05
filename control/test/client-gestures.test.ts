import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClientGestures,
  momentumPosition,
  GESTURE_SLOP_DIP,
  MOMENTUM_MAX_US,
} from '../client/client-gestures';
import { TouchInput, mergeTouchMoves, mergeGestureMomentum } from '../client/touch-input';
const p = (x: number, y = 0, id = 1) => ({ id, x, y, pressure: 0.5 });

test('client tap keeps tapDown target binding and explicit tap click candidate', () => {
  const g = new ClientGestures();
  assert.deepEqual(
    g.update('start', [p(10)], 0).map((g) => g.type),
    ['tapDown'],
  );
  assert.deepEqual(g.update('move', [p(10 + GESTURE_SLOP_DIP)], 10000), []);
  assert.deepEqual(
    g.update('end', [p(11)], 20000).map((g) => g.type),
    ['tap'],
  );
});
test('source pan includes pre-slop distance and leaves both axes for Browser arbitration', () => {
  const g = new ClientGestures();
  g.update('start', [p(0)], 0);
  g.update('move', [p(3, 4)], 10000);
  const begin = g.update('move', [p(9, 12)], 20000);
  assert.deepEqual(
    begin.map((g) => g.type),
    ['tapCancel', 'scrollBegin', 'scrollUpdate'],
  );
  assert.equal(begin[2].deltaX, 9);
  assert.equal(begin[2].deltaY, 12);
  const update = g.update('move', [p(12, 16)], 30000)[0];
  assert.equal(update.deltaX, 3);
  assert.equal(update.deltaY, 4);
  const end = g.update('end', [p(12, 16)], 40000);
  assert.equal(end[end.length - 1].type, 'flingStart');
  assert.ok(g.momentum);
});
test('interleaved pointer history uses current contact collection and incremental pinch scale', () => {
  const t = new TouchInput('pinch');
  const take = (action: 'start' | 'move' | 'end', point: ReturnType<typeof p>, at: number) =>
    t.sample('identity', action, point, at, 1000000, true)!;
  take('start', p(0), 0);
  assert.deepEqual(
    take('start', p(100, 0, 2), 1).gestures?.map((g) => g.type),
    ['tapCancel'],
  );
  const first = take('move', p(-10), 20);
  assert.ok(first.gestures?.some((g) => g.type === 'pinchBegin'));
  assert.equal(first.gestures?.find((g) => g.type === 'pinchUpdate')?.scale, 1.1);
  assert.equal(t.sample('identity', 'move', p(105, 0, 2), 10, undefined, true), undefined);
  const second = take('move', p(110, 0, 2), 21);
  assert.ok(Math.abs(second.gestures!.find((g) => g.type === 'pinchUpdate')!.scale! - 120 / 110) < 1e-12);
  assert.ok(second.gestures!.some((g) => g.type === 'scrollUpdate'));
  assert.ok(take('end', p(-10), 30).gestures!.some((g) => g.type === 'pinchEnd'));
});
test('source velocity and analytic momentum survive batched delivery and paused rAF', () => {
  const run = () => {
    const t = new TouchInput('trajectory');
    const packets = [t.sample('a', 'start', p(0), 0, 1000, true)!];
    for (let n = 1; n <= 10; n++)
      packets.push(t.sample('a', 'move', p(n * 10, n * 3), n * 10, undefined, true)!);
    packets.push(t.sample('a', 'end', p(100, 30), 110, undefined, true)!);
    return { packets, plan: t.takeMomentum()! };
  };
  const a = run(),
    b = run();
  let accumulated = 0;
  for (const packet of a.packets)
    for (const g of packet.gestures!) if (g.type === 'scrollUpdate') accumulated += g.deltaX!;
  assert.equal(accumulated, 100);
  assert.deepEqual(a.plan, b.plan);
  const batches = [a.packets[0]];
  for (const packet of a.packets.slice(1)) {
    const merged = mergeTouchMoves(batches[batches.length - 1], packet);
    if (merged) batches[batches.length - 1] = merged;
    else batches.push(packet);
  }
  assert.ok(batches.length < a.packets.length);
  assert.equal(
    batches
      .flatMap((packet) => packet.gestures!)
      .filter((g) => g.type === 'scrollUpdate')
      .reduce((sum, g) => sum + g.deltaX!, 0),
    100,
  );
  assert.deepEqual(
    batches.flatMap((packet) => packet.gestures!),
    a.packets.flatMap((packet) => packet.gestures!),
  );
  const terminal = momentumPosition(a.plan, a.plan.startElapsedUs + MOMENTUM_MAX_US * 10);
  assert.ok(terminal.done);
  assert.ok(Math.abs(terminal.cumulativeX) <= 8000 / 4.2);
  const times = [120000, 150000, 300000, 900000, 3000000];
  assert.deepEqual(
    times.map((time) => momentumPosition(a.plan, time)),
    times.map((time) => momentumPosition(b.plan, time)),
  );
  assert.equal(momentumPosition(a.plan, 3000000).cumulativeX, terminal.cumulativeX);
  let previous = 0,
    sum = 0;
  for (const time of times) {
    const x = momentumPosition(a.plan, time).cumulativeX;
    sum += x - previous;
    previous = x;
  }
  assert.ok(Math.abs(sum - terminal.cumulativeX) < 1e-8);
});
test('source-time stationary release suppresses fling and velocity remains bounded', () => {
  const stopped = new ClientGestures();
  stopped.update('start', [p(0)], 0);
  stopped.update('move', [p(100)], 10000);
  assert.equal(stopped.update('end', [p(100)], 200000)[0].type, 'scrollEnd');
  assert.equal(stopped.momentum, undefined);
  const fast = new ClientGestures();
  fast.update('start', [p(0)], 0);
  fast.update('move', [p(10000, 10000)], 10000);
  fast.update('end', [p(10000, 10000)], 11000);
  assert.ok(Math.abs(Math.hypot(fast.momentum!.velocityX, fast.momentum!.velocityY) - 8000) < 1e-8);
});
test('bounded merging preserves transitions and rejects identity or sequence changes', () => {
  const t = new TouchInput('queue');
  t.sample('a', 'start', p(0), 0, 1000, true);
  const a = t.sample('a', 'move', p(20), 20, undefined, true)!;
  const b = t.sample('a', 'move', p(40), 40, undefined, true)!;
  assert.equal(mergeTouchMoves({ ...a, gestures: Array(8).fill(a.gestures![0]) }, b), undefined);
  assert.equal(mergeTouchMoves(a, b)!.gestures!.length, 4);
  const progress = {
    type: 'gesture',
    gestureMode: 'client-v1',
    sequenceId: 'q',
    inputIdentity: 'old',
    action: 'momentum',
    sampleElapsedUs: 20,
    cumulativeX: 30,
    cumulativeY: 0,
  };
  assert.equal(
    mergeGestureMomentum({ ...progress, sampleElapsedUs: 10, cumulativeX: 10 }, progress),
    progress,
  );
  assert.equal(mergeGestureMomentum(progress, { ...progress, inputIdentity: 'new' }), undefined);
  assert.equal(mergeGestureMomentum(progress, { ...progress, sequenceId: 'new' }), undefined);
  assert.equal(mergeGestureMomentum(progress, { ...progress, action: 'cancel' }), undefined);
  const cancelled = t.cancel()!;
  assert.equal(cancelled.inputIdentity, 'a');
  assert.equal(cancelled.gestures![cancelled.gestures!.length - 1].type, 'scrollEnd');
  t.reset();
  assert.equal(t.takeMomentum(), undefined);
  assert.equal(t.sample('new', 'start', p(0), 50, undefined, true)!.inputIdentity, 'new');
});
