import assert from 'node:assert/strict';
import test from 'node:test';
import { PageRequestTimeline } from '../client/files/page-request-timeline';

test('a request is timed from the first state that carries it to its first render', () => {
  const timeline = new PageRequestTimeline();
  timeline.stateReceived(['a'], 100, 1000);
  timeline.stateReceived(['a', 'b'], 150, 1050);
  timeline.rendered('a', 120, 1020);
  timeline.rendered('a', 400, 1300);
  timeline.rendered('missing', 130, 1030);
  assert.deepEqual(timeline.export(0), [
    { stateAtMs: 100, stateWallMs: 1000, renderedAtMs: 120, renderedWallMs: 1020 },
    { stateAtMs: 150, stateWallMs: 1050 },
  ]);
  assert.deepEqual(timeline.export(120), [{ stateAtMs: 150, stateWallMs: 1050 }]);
});

test('the history keeps the newest sixteen requests', () => {
  const timeline = new PageRequestTimeline();
  for (let index = 0; index < 20; index++) timeline.stateReceived([`r${index}`], index, index);
  assert.equal(timeline.export(0).length, 16);
  assert.equal(timeline.export(0)[0].stateAtMs, 4);
});
