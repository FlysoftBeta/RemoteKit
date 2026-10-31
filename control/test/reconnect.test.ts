import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectPolicy } from '../client/reconnect';
test('retries are bounded at 2/5/10 seconds and duplicate failure signals do not schedule peers', () => {
  const state = new ReconnectPolicy(); assert.equal(state.schedule(), undefined); state.start();
  for (const delay of [2000, 5000, 10000]) { assert.equal(state.schedule()?.delayMs, delay); assert.equal(state.schedule(), undefined); assert.equal(state.beginRetry(), true); }
  assert.equal(state.schedule(), undefined); assert.equal(state.beginRetry(), false);
});
test('explicit disconnect cancels desired recovery and successful connection resets outage budget', () => {
  const state = new ReconnectPolicy(); state.start(); state.schedule(); state.stop(); assert.equal(state.beginRetry(), false); assert.equal(state.schedule(), undefined);
  state.start(); state.schedule(); state.beginRetry(); state.connected(); assert.equal(state.schedule()?.delayMs, 2000); state.stop(); assert.equal(state.pending, false);
});
