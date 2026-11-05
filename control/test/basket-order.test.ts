import test from 'node:test';
import assert from 'node:assert/strict';
import { basketDragCurrent, basketDrop } from '../client/files/basket-order';

const ids = ['a', 'b', 'c', 'd'];
const drag = { id: 'b', ids, revision: 24 };

test('dropping across multiple rows creates one immutable ordered update tied to captured revision', () => {
  assert.deepEqual(basketDrop(drag, 'd', ids, 24), { ids: ['a', 'c', 'd', 'b'], revision: 24 });
  assert.deepEqual(basketDrop(drag, 'a', ids, 24), { ids: ['b', 'a', 'c', 'd'], revision: 24 });
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});
test('escape, pointer cancellation, no-op drop and stale revisions cannot mutate the basket', () => {
  assert.equal(basketDrop(null, 'd', ids, 24), undefined);
  assert.equal(basketDrop(drag, undefined, ids, 24), undefined);
  assert.equal(basketDrop(drag, 'b', ids, 24), undefined);
  assert.equal(basketDrop(drag, 'd', ids, 25), undefined);
  assert.equal(basketDrop(drag, 'd', ['a', 'd', 'c', 'b'], 24), undefined);
  assert.equal(basketDragCurrent(drag, ['a', 'c', 'd'], 24), false);
});
