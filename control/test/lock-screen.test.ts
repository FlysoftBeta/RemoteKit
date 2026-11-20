import test from 'node:test';
import assert from 'node:assert/strict';
import { RapidTaps } from '../client/auth/lock-screen';

test('lock reveal needs five quick taps close together', () => {
  const reveal = new RapidTaps();
  assert.equal(reveal.push(100, 100, 0), false);
  assert.equal(reveal.push(110, 105, 300), false);
  assert.equal(reveal.push(95, 98, 400), false);
  assert.equal(reveal.push(95, 98, 500), false);
  assert.equal(reveal.push(95, 98, 600), true);
  assert.equal(reveal.push(100, 100, 700), false, 'a completed gesture starts over');
});

test('slow or scattered taps restart the lock reveal', () => {
  const reveal = new RapidTaps();
  reveal.push(100, 100, 0);
  reveal.push(100, 100, 300);
  assert.equal(reveal.push(100, 100, 900), false, 'gap too long');
  reveal.push(100, 100, 1100);
  assert.equal(reveal.push(400, 100, 1300), false, 'too far from the first tap');
  reveal.push(400, 100, 1500);
  assert.equal(reveal.push(400, 100, 1700), false);
  assert.equal(reveal.push(400, 100, 1800), false);
  assert.equal(reveal.push(400, 100, 1900), true);
});
