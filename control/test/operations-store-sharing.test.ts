import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationsStore } from '../client/control/operations-store';
import type { ProductState, ProductTab, ProductWindow } from '../shared/product';
import { productSnapshot } from './client-fixture';

const window = (id: string): ProductWindow => ({
  id,
  appId: 'browser',
  activeTabId: `${id}-tab`,
  lastActiveAt: 1,
});
const tab = (id: string, windowId: string): ProductTab => ({
  id: `${id}-tab`,
  windowId,
  webviewId: id,
  kind: 'remote',
  title: id,
  url: `https://${id}.test/`,
  idleKeepAlive: false,
});
function withWindows(sequence: number, revision: number): ProductState {
  const state = productSnapshot();
  state.snapshotSequence = sequence;
  state.workspace.revision = revision;
  state.workspace.windows = [window('a'), window('b')];
  state.workspace.tabs = [tab('a', 'a'), tab('b', 'b')];
  state.workspace.spaces = [
    { id: 's', name: null, windowIds: ['a', 'b'], weights: [1, 1], focusedWindowId: 'a', lastActiveAt: 1 },
  ];
  state.workspace.activeSpaceId = 's';
  return state;
}
const store = (t: import('node:test').TestContext) => {
  const operations = new OperationsStore({
    ready: () => true,
    submit: async (request) => ({ ...request, status: 'committed' }),
    status: async (request) => ({ ...request, status: 'unknown' }),
  });
  t.after(() => operations.reset());
  return operations;
};

test('an authoritative state keeps the references of every part that did not change', (t) => {
  const operations = store(t);
  operations.acceptSnapshot(withWindows(1, 1));
  const first = operations.getSnapshot();
  const next = withWindows(2, 2);
  next.workspace.tabs[1].title = 'renamed';
  operations.acceptSnapshot(next);
  const second = operations.getSnapshot();
  assert.notEqual(second.state, first.state);
  assert.equal(second.state!.workspace.windows, first.state!.workspace.windows);
  assert.equal(second.state!.workspace.tabs[0], first.state!.workspace.tabs[0]);
  assert.notEqual(second.state!.workspace.tabs[1], first.state!.workspace.tabs[1]);
  assert.equal(second.state!.workspace.spaces, first.state!.workspace.spaces);
  assert.equal(second.authoritative!.workspace.windows, first.authoritative!.workspace.windows);
});

test('the authoritative state that confirms a projected change renders nothing again', (t) => {
  const operations = store(t);
  operations.acceptSnapshot(withWindows(1, 1));
  void operations.action({ type: 'window.focus', windowId: 'b' });
  const projected = operations.getSnapshot().state!;
  assert.equal(projected.workspace.spaces[0].focusedWindowId, 'b');
  const confirmed = withWindows(2, 2);
  confirmed.workspace.spaces[0].focusedWindowId = 'b';
  operations.acceptSnapshot(confirmed);
  const after = operations.getSnapshot().state!;
  assert.equal(after.workspace.spaces, projected.workspace.spaces);
  assert.equal(after.workspace.windows, projected.workspace.windows);
  assert.equal(after.workspace.tabs, projected.workspace.tabs);
});
