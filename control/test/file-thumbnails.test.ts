import test from 'node:test';
import assert from 'node:assert/strict';
import { FileThumbnails } from '../client/files/file-thumbnails';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('visible thumbnails share one request per asset and no more than one request runs at a time', async () => {
  const calls: { id: string; signal: AbortSignal; resolve: (blob: Blob) => void }[] = [];
  const store = new FileThumbnails(
    (id, signal) => new Promise((resolve) => calls.push({ id, signal, resolve })),
  );
  const visible: (Blob | undefined)[] = [];
  store.subscribe('a', (blob) => visible.push(blob));
  store.subscribe('a', (blob) => visible.push(blob));
  const leave = store.subscribe('b', (blob) => visible.push(blob));
  store.subscribe('c', (blob) => visible.push(blob));
  leave();
  assert.deepEqual(
    calls.map((call) => call.id),
    ['a'],
  );
  const a = new Blob(['one']);
  calls[0].resolve(a);
  await tick();
  assert.deepEqual(visible, [a, a]);
  assert.deepEqual(
    calls.map((call) => call.id),
    ['a', 'c'],
  );
  store.clear();
  assert.equal(calls[1].signal.aborted, true);
  calls[1].resolve(new Blob(['discarded']));
  await tick();
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('c'), undefined);
  assert.deepEqual(visible, [a, a]);
});

test('camera preview cache evicts the oldest compressed bytes within its two MiB budget', () => {
  const store = new FileThumbnails(async () => {
    throw new Error('unexpected request');
  });
  const blob = new Blob([new Uint8Array(128 * 1024)]);
  for (let index = 0; index < 17; index++) store.remember(String(index), blob);
  assert.equal(store.get('0'), undefined);
  assert.equal(store.get('1'), blob);
  assert.equal(store.get('16'), blob);
});
