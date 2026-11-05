import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameEpochGate } from '../client/frame-epoch';
test('timestamp map is bounded and validates uint32 RTP timestamps and epochs', () => {
  const gate = new FrameEpochGate(2);
  gate.record(0xffffffff, '9');
  assert.equal(gate.epochFor(0xffffffff), '9');
  gate.record(0, '10');
  gate.record(1, '10');
  gate.record(-1, '11');
  gate.record(2 ** 32, '11');
  gate.record(2, 'invalid');
  assert.equal(gate.epochFor(0xffffffff), undefined);
  assert.equal(gate.epochFor(0), '10');
  assert.equal(gate.epochFor(1), '10');
  assert.equal(gate.epochFor(2), undefined);
  gate.clear();
  assert.equal(gate.epochFor(0), undefined);
});
