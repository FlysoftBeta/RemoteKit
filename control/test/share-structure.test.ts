import assert from 'node:assert/strict';
import test from 'node:test';
import { shareStructure } from '../client/util/share-structure';

test('equal parts keep their previous reference and changed parts are rebuilt', () => {
  const previous = { a: { x: 1 }, list: [{ id: 1 }, { id: 2 }], flag: true };
  const next = shareStructure(previous, { a: { x: 1 }, list: [{ id: 1 }, { id: 3 }], flag: true });
  assert.notEqual(next, previous);
  assert.equal(next.a, previous.a);
  assert.notEqual(next.list, previous.list);
  assert.equal(next.list[0], previous.list[0]);
  assert.deepEqual(next.list[1], { id: 3 });
});

test('a value equal as a whole is the previous value itself', () => {
  const previous = { a: [1, 2, { b: null }], c: 'x' };
  assert.equal(shareStructure(previous, { a: [1, 2, { b: null }], c: 'x' }), previous);
});

test('added and removed keys and length changes are changes', () => {
  const previous = { a: 1, list: [1, 2] };
  assert.notEqual(shareStructure(previous, { a: 1, list: [1, 2], b: 2 }), previous);
  assert.notEqual(shareStructure(previous, { a: 1 }), previous);
  assert.notEqual(shareStructure(previous, { a: 1, list: [1] }).list, previous.list);
  assert.notEqual(shareStructure(previous, { a: 1, list: [1, 2, 3] }).list, previous.list);
});

test('a different kind of value is taken as it is', () => {
  const next = { a: [1] };
  assert.equal(shareStructure({ a: { 0: 1 } }, next).a, next.a);
  assert.equal(shareStructure(undefined, next), next);
  assert.equal(shareStructure(null, 3), 3);
});

test('neither input is mutated', () => {
  const previous = Object.freeze({ a: Object.freeze({ x: 1 }), b: Object.freeze([1]) });
  const next = { a: { x: 1 }, b: [2] };
  shareStructure(previous, next);
  assert.deepEqual(next, { a: { x: 1 }, b: [2] });
});
