import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationsStore } from '../client/control/operations-store';
import { ViewportRequests } from '../client/control/viewport-requests';
import { productSnapshot } from './client-fixture';

test('duplicate authoritative content keeps store identity and advances its ordering watermark', () => {
  const store = new OperationsStore({
    ready: () => true,
    send: () => {},
    status: async () => {
      throw new Error('unused');
    },
  });
  const state = productSnapshot();
  store.acceptSnapshot(state);
  const published = store.getSnapshot();
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.acceptSnapshot({ ...structuredClone(state), snapshotSequence: 4 });
  assert.strictEqual(store.getSnapshot(), published);
  assert.equal(notifications, 0);
  store.acceptSnapshot({ ...state, snapshotSequence: 3, endpointError: 'old' });
  assert.strictEqual(store.getSnapshot(), published);
  store.acceptSnapshot({ ...state, snapshotSequence: 5, endpointError: 'changed' });
  assert.equal(store.getSnapshot().state?.endpointError, 'changed');
  assert.equal(notifications, 1);
});

test('viewport acknowledgements suppress duplicates; failure and reset permit resending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let fail = false;
  const viewport = new ViewportRequests(async () => {
    calls++;
    if (fail) throw new Error('offline');
  });
  const state = productSnapshot();
  const send = async () => {
    t.mock.timers.tick(100);
    await Promise.resolve();
    await Promise.resolve();
  };
  viewport.observe(state, true);
  viewport.measure(1280, 800, 2, true);
  await send();
  viewport.observe(structuredClone(state), true);
  await send();
  assert.equal(calls, 1);
  fail = true;
  viewport.measure(1280, 800, 3, true);
  await send();
  fail = false;
  viewport.measure(1280, 800, 2, true);
  await send();
  assert.equal(calls, 3);
  viewport.reset();
  viewport.observe(state, true);
  await send();
  assert.equal(calls, 4);
  viewport.reset();
});

test('a changed viewport is sent while an older request is pending and stale replies cannot replace its acknowledgement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending: (() => void)[] = [];
  const viewport = new ViewportRequests(() => new Promise<void>((resolve) => pending.push(resolve)));
  viewport.observe(productSnapshot(), true);
  viewport.measure(1280, 800, 2, true);
  t.mock.timers.tick(100);
  viewport.measure(1280, 800, 3, true);
  t.mock.timers.tick(100);
  assert.equal(pending.length, 2);
  pending[1]();
  await Promise.resolve();
  pending[0]();
  await Promise.resolve();
  viewport.observe(productSnapshot(), true);
  t.mock.timers.tick(100);
  assert.equal(pending.length, 2);
  viewport.reset();
});
