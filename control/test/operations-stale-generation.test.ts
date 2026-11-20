import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAction } from '../client/control/action-builder';
import { OperationsStore } from '../client/control/operations-store';
import { applyCommand } from '../server/workspace/commands';
import { STALE_GENERATION_DETAIL } from '../shared/errors';
import type { OperationReceipt, ProductOperation, ProductState } from '../shared/product';
import { productSnapshot } from './client-fixture';

const open = () => buildAction({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
const stale = (request: Pick<ProductOperation, 'operationId' | 'operationGeneration'>): OperationReceipt => ({
  ...request,
  status: 'failed',
  error: { code: 'conflict', message: 'stale', detail: STALE_GENERATION_DETAIL },
});
function next(patch: Partial<ProductState> = {}): ProductState {
  return { ...productSnapshot(), snapshotSequence: 2, operationGeneration: 'generation-2', ...patch };
}

test('a stale-generation submission ends instead of resubmitting forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  const store = new OperationsStore({
    ready: () => true,
    submit: async (request) => {
      sent.push(request);
      return request.operationGeneration === 'generation'
        ? stale(request)
        : { ...request, status: 'committed' };
    },
    status: async (request) => ({ ...request, status: 'unknown' }),
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  const result = store.action(open());
  for (let index = 0; index < 6; index++) {
    await flush();
    t.mock.timers.tick(60_000);
  }
  assert.equal(sent.length, 1);
  assert.equal(store.getSnapshot().pending.length, 1);

  store.acceptSnapshot(next());
  const receipt = await result;
  assert.equal(receipt.status, 'committed');
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].operationId, sent[0].operationId);
  assert.equal(sent[1].operationGeneration, 'generation-2');
  assert.deepEqual(sent[1].action, sent[0].action);
});

test('an already refreshed generation reissues at once under a new identity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  let store!: OperationsStore;
  store = new OperationsStore({
    ready: () => true,
    submit: async (request) => {
      sent.push(request);
      if (request.operationGeneration === 'generation') {
        store.acceptSnapshot(next());
        return stale(request);
      }
      return { ...request, status: 'committed' };
    },
    status: async (request) => ({ ...request, status: 'unknown' }),
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  assert.equal((await store.action(open())).status, 'committed');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].operationGeneration, 'generation-2');
});

test('a target already reached in the new generation completes without resubmitting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  const store = new OperationsStore({
    ready: () => true,
    submit: async (request) => {
      sent.push(request);
      return stale(request);
    },
    status: async (request) => ({ ...request, status: 'unknown' }),
  });
  t.after(() => store.reset());
  const base = productSnapshot();
  store.acceptSnapshot(base);
  const action = open();
  const result = store.action(action);
  await flush();
  const workspace = applyCommand(base.workspace, action, { viewId: '1' }).workspace;
  store.acceptSnapshot(next({ workspace: { ...workspace, revision: base.workspace.revision + 1 } }));
  const receipt = await result;
  assert.equal(receipt.status, 'committed');
  assert.equal(sent.length, 1);
  assert.equal(store.getSnapshot().pending.length, 0);
});

test('an intent whose target vanished fails with not_found and is not resubmitted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  const store = new OperationsStore({
    ready: () => true,
    submit: async (request) => {
      sent.push(request);
      return stale(request);
    },
    status: async (request) => ({ ...request, status: 'unknown' }),
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  const failed = assert.rejects(store.action({ type: 'tab.activate', tabId: 'gone' }), {
    code: 'not_found',
  });
  await flush();
  store.acceptSnapshot(next());
  await failed;
  assert.equal(sent.length, 1);
});

test('an unknown outcome is never resubmitted and resolves as unknown when the target is absent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  const store = new OperationsStore({
    ready: () => true,
    submit: async (request) => {
      sent.push(request);
      return { ...request, status: 'unknown' };
    },
    status: async (request) => stale(request),
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  const result = store.action(open());
  await flush();
  store.acceptSnapshot(next());
  const receipt = await result;
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.resolved, true);
  assert.equal(receipt.error?.code, 'outcome_unknown');
  assert.equal(sent.length, 1);
});

test('an unknown outcome completes when the new generation shows the target reached', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  const store = new OperationsStore({
    ready: () => true,
    submit: async (request) => {
      sent.push(request);
      return { ...request, status: 'unknown' };
    },
    status: async (request) => stale(request),
  });
  t.after(() => store.reset());
  const base = productSnapshot();
  store.acceptSnapshot(base);
  const action = open();
  const result = store.action(action);
  await flush();
  const workspace = applyCommand(base.workspace, action, { viewId: '1' }).workspace;
  store.acceptSnapshot(next({ workspace: { ...workspace, revision: base.workspace.revision + 1 } }));
  assert.equal((await result).status, 'committed');
  assert.equal(sent.length, 1);
});

test('a scope reset cancels a wait for the new generation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new OperationsStore({
    ready: () => true,
    submit: async (request) => stale(request),
    status: async (request) => ({ ...request, status: 'unknown' }),
  });
  store.acceptSnapshot(productSnapshot());
  const result = assert.rejects(store.action(open()), { code: 'canceled' });
  await flush();
  store.reset();
  await result;
});
