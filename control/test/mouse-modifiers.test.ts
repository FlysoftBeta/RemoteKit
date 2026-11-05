import test from 'node:test';
import assert from 'node:assert/strict';
import { mouseButtonModifiers } from '../client/input/keys';

test('DOM held mouse buttons map to Blink flags rather than keypad/autorepeat flags', () => {
  assert.equal(mouseButtonModifiers(0), 0);
  assert.equal(mouseButtonModifiers(1), 64);
  assert.equal(mouseButtonModifiers(4), 128);
  assert.equal(mouseButtonModifiers(2), 256);
  assert.equal(mouseButtonModifiers(8), 1 << 20);
  assert.equal(mouseButtonModifiers(16), 1 << 21);
  assert.equal(mouseButtonModifiers(31), 64 | 128 | 256 | (1 << 20) | (1 << 21));
  assert.equal(mouseButtonModifiers(31) & (16 | 32), 0);
});
