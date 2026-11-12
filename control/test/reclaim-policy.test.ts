import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dwellFactor,
  hardExhaustion,
  idleKeepAliveFloorMs,
  minute,
  returnProbability,
  shouldStopSession,
  tabReclaimDelays,
} from '../server/workspace/reclaim-policy';
import { BackgroundReclaim, type ReclaimObservation } from '../server/workspace/lifecycle';
import { TestClock } from './server-fixture';

test('dwell ranks the top fifth deterministically and requires five minutes', () => {
  const pages = Array.from({ length: 10 }, (_, index) => ({
    pageKey: String(index),
    visibleMs: (10 - index) * minute,
  }));
  assert.equal(dwellFactor('0', pages), 4);
  assert.equal(dwellFactor('1', pages), 4);
  assert.equal(dwellFactor('2', pages), 1);
  assert.equal(dwellFactor('short', [{ pageKey: 'short', visibleMs: 5 * minute - 1 }]), 1);
  assert.equal(dwellFactor('missing', pages), 1);
  assert.equal(dwellFactor(null, pages), 1);
  assert.deepEqual(tabReclaimDelays(1, false), { freezeMs: 30_000, discardMs: 120_000 });
  assert.deepEqual(tabReclaimDelays(4, false), { freezeMs: 120_000, discardMs: 480_000 });
  assert.deepEqual(tabReclaimDelays(4, true), { freezeMs: 30_000, discardMs: 120_000 });
  assert.deepEqual(tabReclaimDelays(1, true), { freezeMs: 10_000, discardMs: 30_000 });
});

test('empirical survival conditions on completed absences and changes thresholds under pressure', () => {
  const history = [...Array(14).fill(minute), ...Array(2).fill(6 * minute), ...Array(4).fill(60 * minute)];
  assert.equal(returnProbability(history, 5 * minute), 1 / 3);
  assert.equal(shouldStopSession(history, 5 * minute, false), false);
  assert.equal(shouldStopSession(history, 5 * minute, true), true);
  assert.equal(shouldStopSession(history, 2 * minute - 1, true), false);
  assert.equal(shouldStopSession(history, 10 * minute, false), true);
  assert.equal(returnProbability(history, 61 * minute), 0);
  assert.equal(shouldStopSession(history.slice(1), 9 * minute, true), false);
  assert.equal(shouldStopSession(history.slice(1), 10 * minute, false), true);
  assert.equal(shouldStopSession(Array(20).fill(minute), 5 * minute - 1, false), false);
  assert.equal(shouldStopSession(Array(20).fill(minute), 5 * minute, false), true);
});

test('keep alive holds every Session for thirty eligible minutes unless memory is exhausted', () => {
  const history = Array(20).fill(120 * minute);
  assert.equal(shouldStopSession(history, 60 * minute, true, [undefined]), false);
  assert.equal(shouldStopSession(history, 60 * minute, true, [idleKeepAliveFloorMs - 1]), false);
  assert.equal(shouldStopSession(history, 60 * minute, true, [idleKeepAliveFloorMs]), true);
  assert.equal(shouldStopSession(history, 60 * minute, true, [idleKeepAliveFloorMs, 0]), false);
  assert.equal(shouldStopSession([], 0, false, [0], true), true);
  assert.equal(hardExhaustion({ total: 1000, available: 50 }, false), false);
  assert.equal(hardExhaustion({ total: 1000, available: 49 }, false), true);
  assert.equal(hardExhaustion(undefined, true), true);
});

test('a keep-alive page cannot freeze or discard under ordinary pressure, even after thirty minutes', () => {
  const clock = new TestClock();
  const policy = new BackgroundReclaim(clock);
  const observation: ReclaimObservation = {
    visible: false,
    protectedByProduct: false,
    idleKeepAlive: true,
    underPressure: true,
    browserIncarnation: 'browser',
    current: { actual: 0, visible: false, instance: '1', canDiscard: true },
  };
  for (let index = 0; index < 400; index++) {
    clock.advance(5000);
    assert.equal(policy.observe(observation), null);
  }
  assert.equal(policy.observe({ ...observation, exhaustion: true }), 'discard');
  assert.equal(
    policy.observe({ ...observation, exhaustion: true, current: { ...observation.current, audible: true } }),
    null,
  );
});
