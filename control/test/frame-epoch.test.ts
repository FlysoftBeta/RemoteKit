import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameEpochGate } from '../client/frame-epoch';
test('video and frame message can arrive in either order; only exact layout epoch matches', () => {
  const gate = new FrameEpochGate(); gate.setEpoch('1'); gate.record(100, '1'); gate.observe(100); assert.equal(gate.ready, true);
  gate.observe(101); assert.equal(gate.ready, false); gate.record(101, '1'); assert.equal(gate.ready, true);
  gate.setEpoch('2'); assert.equal(gate.ready, false); gate.record(102, '1'); gate.observe(102); assert.equal(gate.ready, false);
  gate.record(103, '2'); gate.observe(103); assert.equal(gate.ready, true);
  gate.setEpoch('2'); assert.equal(gate.ready, true); // focus-only updates keep geometry epoch
  gate.observe(undefined); assert.equal(gate.ready, false); gate.observe(104); gate.record(103, '2'); assert.equal(gate.ready, false); // late old metadata cannot authorize new video
});
test('timestamp map is bounded and validates uint32 RTP timestamps', () => {
  const gate = new FrameEpochGate(2); gate.setEpoch('9'); gate.record(0xffffffff, '9'); gate.observe(0xffffffff); assert.equal(gate.ready, true);
  gate.record(0, '9'); gate.record(1, '9'); gate.observe(0xffffffff); assert.equal(gate.ready, false);
  gate.observe(0); assert.equal(gate.ready, true); gate.observe(-1); assert.equal(gate.ready, false); gate.observe(2 ** 32); assert.equal(gate.ready, false);
  gate.clear(); gate.observe(0); assert.equal(gate.ready, false);
});
