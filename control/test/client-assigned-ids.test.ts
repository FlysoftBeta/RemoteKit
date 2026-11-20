import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAction } from '../client/control/action-builder';
import { OperationsStore } from '../client/control/operations-store';
import { isBeingCreated, projectOperations, targetIds } from '../client/control/product-operations';
import { applyCommand } from '../server/workspace/commands';
import {
  creationIdFields,
  type OperationReceipt,
  type ProductAction,
  type ProductOperation,
} from '../shared/product';
import { randomUuid } from '../shared/random-uuid';
import { productSnapshot } from './client-fixture';

const open = () => buildAction({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
const operation = (action: ProductAction): ProductOperation => ({
  operationId: randomUuid(),
  operationGeneration: 'g',
  action,
});
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

test('creation requirements cover browser and web tabs, replacement groups, apps and favorites', () => {
  assert.deepEqual(creationIdFields(open()), ['windowId', 'tabId', 'spaceId']);
  assert.deepEqual(
    creationIdFields({
      type: 'window.open',
      appId: 'web:app',
      placement: { mode: 'replace', windowId: 'old' },
    }),
    ['windowId', 'tabId', 'spaceId'],
  );
  assert.deepEqual(
    creationIdFields({
      type: 'window.open',
      appId: 'files',
      placement: { mode: 'split', besideWindowId: 'old', side: 'left' },
    }),
    ['windowId'],
  );
  assert.deepEqual(creationIdFields({ type: 'window.place', placement: { mode: 'space' } }), ['spaceId']);
  assert.deepEqual(
    creationIdFields({
      type: 'window.place',
      placement: { mode: 'split', besideWindowId: 'old', side: 'left' },
    }),
    [],
  );
  assert.deepEqual(creationIdFields({ type: 'tab.create' }), ['tabId']);
  assert.deepEqual(creationIdFields({ type: 'app.install' }), ['appId']);
  assert.deepEqual(creationIdFields({ type: 'favorite.add' }), ['favoriteId']);
});

test('commands reject missing, malformed, duplicate and already used creation ids without mutation', () => {
  const workspace = productSnapshot().workspace;
  const action = open();
  const ctx = { viewId: '1' };
  for (const field of creationIdFields(action)) {
    for (const value of [
      undefined,
      '',
      'pending-x',
      randomUuid().toUpperCase(),
      '00000000-0000-1000-8000-000000000000',
      7,
    ]) {
      assert.throws(() => applyCommand(workspace, { ...action, [field]: value } as ProductAction, ctx), {
        code: 'invalid_request',
      });
    }
  }
  assert.throws(() => applyCommand(workspace, { ...action, tabId: action.windowId }, ctx), {
    code: 'conflict',
  });
  assert.equal(workspace.windows.length, 0);
  const state = applyCommand(workspace, action, ctx).workspace;
  for (const id of [action.windowId, action.tabId!, action.spaceId!]) {
    assert.throws(() => applyCommand(state, { ...open(), windowId: id }, ctx), { code: 'conflict' });
  }
  assert.throws(
    () => applyCommand(workspace, action, { ...ctx, historicalIdUsed: (id) => id === action.windowId }),
    { code: 'conflict' },
  );
  assert.deepEqual(
    targetIds(
      buildAction({ type: 'window.open', appId: 'browser', placement: { mode: 'replace', windowId: 'old' } }),
    ),
    ['browser', 'old'],
  );
});

test('projections retain action ids, recognize creation until authoritative, and never duplicate acknowledged objects', () => {
  const state = productSnapshot();
  const action = open();
  const pending = [operation(action)];
  const projected = projectOperations(state, pending)!;
  assert.equal(projected.workspace.windows[0].id, action.windowId);
  assert.equal(projected.workspace.tabs[0].id, action.tabId);
  assert.equal(projected.workspace.spaces[0].id, action.spaceId);
  assert(isBeingCreated(state, pending, action.windowId));
  assert(isBeingCreated(state, pending, action.tabId!));
  assert.equal(isBeingCreated(projected, pending, action.tabId!), false);
  assert.equal(projectOperations(projected, pending)!.workspace.tabs.length, 1);
  const tab = buildAction({ type: 'tab.create', windowId: action.windowId });
  const detached = buildAction({
    type: 'window.place',
    windowId: action.windowId,
    placement: { mode: 'space' },
  });
  const next = projectOperations(projected, [operation(tab), operation(detached)])!;
  assert.equal(next.workspace.tabs[1].id, tab.tabId);
  assert.equal(next.workspace.activeSpaceId, detached.spaceId);
  assert.equal(
    projectOperations(state, [
      {
        ...pending[0],
        receipt: { ...pending[0], status: 'failed', error: { code: 'rejected', message: 'rejected' } },
      },
    ])!.workspace.windows.length,
    0,
  );
});

test('tab commands project only their loading state', () => {
  const state = projectOperations(productSnapshot(), [operation(open())])!;
  delete state.workspace.tabs[0].pendingUrl;
  const tabId = state.workspace.tabs[0].id;
  for (const command of ['back', 'forward', 'reload', 'stop'] as const) {
    const projected = projectOperations(state, [operation({ type: 'tab.command', tabId, command })])!;
    assert.deepEqual(projected.workspace.tabs[0], {
      ...state.workspace.tabs[0],
      loading: command !== 'stop',
    });
  }
});

for (const status of ['accepted', 'applying', 'committed'] as const) {
  test(`actions on a new window, tab and group wait for an ${status} creator receipt`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent: ProductOperation[] = [];
    let acknowledge!: (receipt: OperationReceipt) => void;
    const store = new OperationsStore({
      ready: () => true,
      submit: (request) => {
        sent.push(request);
        return request.action.type === 'window.open'
          ? new Promise((resolve) => {
              acknowledge = resolve;
            })
          : Promise.resolve({ ...request, status: 'committed' });
      },
      status: async (request) => ({ ...request, status: 'unknown' }),
    });
    t.after(() => store.reset());
    store.acceptSnapshot(productSnapshot());
    const action = open();
    const creator = store.action(action);
    const commands: ProductAction[] = [
      buildAction({ type: 'window.place', windowId: action.windowId, placement: { mode: 'space' } }),
      { type: 'tab.navigate', tabId: action.tabId!, url: 'https://new.test/' },
      buildAction({ type: 'tab.create', windowId: action.windowId }),
      { type: 'space.close', spaceIds: [action.spaceId!] },
      { type: 'window.close', windowId: action.windowId },
    ];
    const dependents = commands.map((command) => store.action(command));
    await flush();
    assert.equal(sent.length, 1);
    acknowledge({ ...sent[0], status });
    await creator;
    t.mock.timers.tick(100);
    await flush();
    assert.deepEqual(
      sent.slice(1).map((request) => request.action),
      commands,
    );
    assert((await Promise.all(dependents)).every((receipt) => receipt.status === 'committed'));
  });
}

test('dependent and transitive operations inherit a creator failure without sending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  let rejectCreator!: (receipt: OperationReceipt) => void;
  const store = new OperationsStore({
    ready: () => true,
    submit: (request) => {
      sent.push(request);
      return new Promise((resolve) => {
        rejectCreator = resolve;
      });
    },
    status: async (request) => ({ ...request, status: 'unknown' }),
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  const action = open();
  const creator = assert.rejects(store.action(action), { code: 'forbidden' });
  const tab = buildAction({ type: 'tab.create', windowId: action.windowId });
  const dependent = assert.rejects(store.action(tab), { code: 'forbidden' });
  const transitive = assert.rejects(store.action({ type: 'tab.close', tabId: tab.tabId }), {
    code: 'forbidden',
  });
  rejectCreator({ ...sent[0], status: 'failed', error: { code: 'forbidden', message: 'creator failed' } });
  await creator;
  t.mock.timers.tick(100);
  await flush();
  t.mock.timers.tick(100);
  await Promise.all([dependent, transitive]);
  assert.equal(sent.length, 1);
  assert.equal(store.getSnapshot().pending.length, 0);
});

test('scope reset cancels dependency waits without submitting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  const store = new OperationsStore({
    ready: () => true,
    submit: (request) => {
      sent.push(request);
      return new Promise(() => {});
    },
    status: async (request) => ({ ...request, status: 'unknown' }),
  });
  store.acceptSnapshot(productSnapshot());
  const action = open();
  const creator = assert.rejects(store.action(action));
  const dependent = assert.rejects(store.action({ type: 'window.close', windowId: action.windowId }), {
    code: 'canceled',
  });
  store.reset();
  await Promise.all([creator, dependent]);
  assert.equal(sent.length, 1);
});

test('a queued action succeeds through the command layer after creation and unrelated work proceeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let workspace = productSnapshot().workspace;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: ProductOperation[] = [];
  const store = new OperationsStore({
    ready: () => true,
    submit: async (request) => {
      sent.push(request);
      if (request.action.type === 'window.open') await gate;
      workspace = applyCommand(workspace, request.action, { viewId: '1' }).workspace;
      return { ...request, status: 'committed' };
    },
    status: async (request) => ({ ...request, status: 'unknown' }),
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  const action = open();
  const creator = store.action(action);
  const dependent = store.action({
    type: 'window.state',
    windowId: action.windowId,
    state: { section: 'apps' },
  });
  await store.action({ type: 'settings.update', settings: { browser: { searchEngine: 'bing' } } });
  assert.deepEqual(
    sent.map((request) => request.action.type),
    ['window.open', 'settings.update'],
  );
  release();
  await creator;
  t.mock.timers.tick(100);
  await dependent;
  assert.deepEqual(workspace.windows[0].state, { section: 'apps' });
});

for (const resolved of [false, true]) {
  test(`an ${resolved ? 'resolved' : 'unresolved'} unknown creator outcome ${resolved ? 'fails' : 'holds'} the dependent`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent: ProductOperation[] = [];
    let acknowledge!: (receipt: OperationReceipt) => void;
    const store = new OperationsStore({
      ready: () => true,
      submit: (request) => {
        sent.push(request);
        return request.action.type === 'window.open'
          ? new Promise((resolve) => {
              acknowledge = resolve;
            })
          : Promise.resolve({ ...request, status: 'committed' });
      },
      status: async (request) => ({
        ...request,
        status: 'unknown',
        resolved,
        ...(resolved ? { error: { code: 'outcome_unknown', message: 'retired' } } : {}),
      }),
    });
    t.after(() => store.reset());
    const state = productSnapshot();
    store.acceptSnapshot(state);
    const action = open();
    const creator = store.action(action);
    const result = store.action({ type: 'window.close', windowId: action.windowId });
    const dependent = resolved ? assert.rejects(result, { code: 'outcome_unknown' }) : result;
    acknowledge({ ...sent[0], status: 'unknown' });
    await creator;
    t.mock.timers.tick(100);
    await flush();
    assert.equal(sent.length, 1);
    if (!resolved) {
      store.acceptSnapshot({
        ...state,
        snapshotSequence: state.snapshotSequence! + 1,
        operationReceipts: [{ ...sent[0], status: 'accepted' }],
      });
      t.mock.timers.tick(100);
      await flush();
      assert.equal(sent.length, 2);
    }
    await dependent;
  });
}
