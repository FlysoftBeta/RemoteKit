import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkerSchedule } from '../client/marker-schedule';
test('5Hz marker sampling does not redefine 32fps display cadence', () => {
  const schedule = new MarkerSchedule(5);
  const all = Array.from({ length: 33 }, (_, index) => index * 31.25),
    selected = all.filter((at) => schedule.accept(at));
  assert.equal(all.length, 33);
  assert.equal(selected.length, 6);
  assert.equal(((selected.length - 1) * 1000) / (selected[selected.length - 1] - selected[0]), 5);
});
test('sampling catches up phase after a pause without inventing historical samples', () => {
  const schedule = new MarkerSchedule(10);
  assert.equal(schedule.accept(0), true);
  assert.equal(schedule.accept(1), false);
  assert.equal(schedule.accept(1000), true);
  assert.equal(schedule.accept(1000), false);
  assert.equal(schedule.accept(1100), true);
});
