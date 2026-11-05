import test from 'node:test';
import assert from 'node:assert/strict';
import { lockDirection, RevealSequence } from '../client/lock-screen';

test('lock reveal accepts one mixed direction sequence and recovers its longest prefix', () => {
  const reveal = new RevealSequence();
  const directions = ['Up', 'Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'] as const;
  assert.deepEqual(
    directions.map((direction, i) => reveal.push(direction, i * 400)),
    [...Array(8).fill(false), true],
  );
  assert.equal(reveal.push('Right', 4000), false);
  reveal.push('Up', 4100);
  reveal.push('Up', 9200);
  for (const direction of directions.slice(3)) assert.equal(reveal.push(direction, 9300), false);
});

test('lock tap regions use normalized axes, a central dead zone, and vertical diagonal ties', () => {
  assert.equal(lockDirection(500, 50, 1000, 100), undefined);
  assert.equal(lockDirection(0, 50, 1000, 100), 'Left');
  assert.equal(lockDirection(999, 50, 1000, 100), 'Right');
  assert.equal(lockDirection(250, 25, 1000, 100), 'Up');
  assert.equal(lockDirection(750, 75, 1000, 100), 'Down');
});
