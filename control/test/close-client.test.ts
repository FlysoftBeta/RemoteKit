import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationsStore } from '../client/control/operations-store';
import { projectOperations } from '../client/control/product-operations';
import { PENDING_CLOSE_DETAIL, type ErrorCode } from '../shared/errors';
import type { ProductOperation, ProductState } from '../shared/product';
import { productSnapshot } from './client-fixture';

function stateWithWindow() {
  const state = productSnapshot();
  state.workspace.windows = [
    { id: 'window', appId: 'browser', activeTabId: 'tab', lastActiveAt: 0, state: {} },
  ];
  state.workspace.tabs = [
    {
      id: 'tab',
      windowId: 'window',
      webviewId: '1',
      idleKeepAlive: false,
      url: 'https://close.test/',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    },
  ];
  state.workspace.spaces = [
    {
      id: 'space',
      name: null,
      windowIds: ['window'],
      weights: [1],
      focusedWindowId: 'window',
      lastActiveAt: 0,
    },
  ];
  state.workspace.activeSpaceId = 'space';
  return state;
}

test('a structured pending-close conflict retains the confirmation and does not report a generic failure', async (t) => {
  const state = stateWithWindow();
  state.workspace.pendingClose = {
    id: 'tab',
    windowId: 'window',
    enteredAt: 0,
    observationEpoch: 'epoch',
    observationSequence: '1',
    browserIncarnation: 'browser',
    instance: '1',
    document: '1',
    requestId: 'token',
    nativeRequestId: 'native',
    awaiting: false,
  };
  const store = new OperationsStore({
    ready: () => true,
    submit: async (operation) => ({
      ...operation,
      status: 'failed',
      error: { code: 'conflict', message: 'message is irrelevant', detail: PENDING_CLOSE_DETAIL },
    }),
    status: async (operation) => ({ ...operation, status: 'unknown' }),
  });
  t.after(() => store.reset());
  store.acceptSnapshot(state);
  const receipt = await store.action({ type: 'space.close', spaceIds: ['space'] });
  assert.equal(receipt.status, 'failed');
  assert.equal(store.getSnapshot().error, undefined);
  assert.deepEqual(store.getSnapshot().state?.workspace.pendingClose, state.workspace.pendingClose);
  assert.equal(store.getSnapshot().state?.workspace.windows.length, 1);
});

for (const code of ['not_found', 'outcome_unknown'] as ErrorCode[]) {
  test(`an asynchronous ${code} close receipt restores the window with a unified error`, async (t) => {
    const state = stateWithWindow();
    let sent!: ProductOperation;
    const store = new OperationsStore({
      ready: () => true,
      submit: async (operation) => {
        sent = operation;
        return { ...operation, status: 'applying' };
      },
      status: async (operation) => ({ ...operation, status: 'applying' }),
    });
    t.after(() => store.reset());
    store.acceptSnapshot(state);
    await store.action({ type: 'window.close', windowId: 'window' });
    assert.equal(store.getSnapshot().state?.workspace.windows.length, 0);
    const next: ProductState = {
      ...state,
      snapshotSequence: 2,
      workspace: { ...state.workspace, revision: 1 },
      operationReceipts: [
        {
          ...sent,
          status: code === 'outcome_unknown' ? 'unknown' : 'failed',
          ...(code === 'outcome_unknown' ? { resolved: true } : {}),
          error: { code, message: 'close failed' },
        },
      ],
    };
    store.acceptSnapshot(next);
    assert.equal(store.getSnapshot().state?.workspace.windows.length, 1);
    assert.equal(store.getSnapshot().error?.code, code);
    assert.equal(projectOperations(next, [])?.workspace.windows.length, 1);
  });
}
