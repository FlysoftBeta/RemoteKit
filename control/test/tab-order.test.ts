import assert from 'node:assert/strict';
import test from 'node:test';
import { projectOperations } from '../client/control/product-operations';
import { applyCommand } from '../server/workspace/commands';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { placeTab, type ProductState, type ProductTab, type ProductWorkspace } from '../shared/product';

function workspace(): ProductWorkspace {
  const tab = (id: string, windowId: string): ProductTab => ({
    id,
    windowId,
    idleKeepAlive: false,
    webviewId: id,
    kind: 'start',
    title: id,
    url: '',
  });
  return {
    ...emptyWorkspace('tenant'),
    windows: [
      { id: 'w1', appId: 'browser', activeTabId: 'a', lastActiveAt: 1 },
      { id: 'w2', appId: 'browser', activeTabId: 'x', lastActiveAt: 1 },
    ],
    // Interleaved on purpose: a window's order is the global order filtered by window.
    tabs: [tab('a', 'w1'), tab('x', 'w2'), tab('b', 'w1'), tab('c', 'w1'), tab('y', 'w2')],
    spaces: [
      { id: 's1', windowIds: ['w1'], weights: [1], focusedWindowId: 'w1', lastActiveAt: 1 },
      { id: 's2', windowIds: ['w2'], weights: [1], focusedWindowId: 'w2', lastActiveAt: 1 },
    ],
    activeSpaceId: 's1',
  };
}
const order = (w: ProductWorkspace, windowId: string) =>
  w.tabs.filter((tab) => tab.windowId === windowId).map((tab) => tab.id);
const move = (w: ProductWorkspace, tabId: string, windowId: string, index?: number) =>
  applyCommand(w, { type: 'tab.move', tabId, windowId, index }, { ids: [], viewId: '1', now: 1 }).workspace;

test('placeTab inserts at a position among the target window tabs', () => {
  const cases: [string, string, number | undefined, string[], string[]][] = [
    ['c', 'w1', 0, ['c', 'a', 'b'], ['x', 'y']],
    ['a', 'w1', 2, ['b', 'c', 'a'], ['x', 'y']],
    ['a', 'w1', 99, ['b', 'c', 'a'], ['x', 'y']],
    ['b', 'w2', 1, ['a', 'c'], ['x', 'b', 'y']],
    ['b', 'w2', 0, ['a', 'c'], ['b', 'x', 'y']],
    ['b', 'w2', undefined, ['a', 'c'], ['x', 'y', 'b']],
  ];
  for (const [tabId, windowId, index, w1, w2] of cases) {
    const w = workspace();
    placeTab(w.tabs, tabId, windowId, index);
    assert.deepEqual([order(w, 'w1'), order(w, 'w2')], [w1, w2], `${tabId}→${windowId}@${index}`);
  }
});

test('tab.move reorders within a window and moves across windows at a position', () => {
  const reordered = move(workspace(), 'c', 'w1', 0);
  assert.deepEqual(order(reordered, 'w1'), ['c', 'a', 'b']);
  assert.equal(reordered.windows[0].activeTabId, 'c');
  const moved = move(workspace(), 'a', 'w2', 1);
  assert.deepEqual(order(moved, 'w2'), ['x', 'a', 'y']);
  assert.equal(moved.windows[0].activeTabId, 'b');
  assert.equal(moved.windows[1].activeTabId, 'a');
  assert.equal(moved.activeSpaceId, 's2');
  assert.equal(moved.spaces[1].focusedWindowId, 'w2');
  for (const index of [-1, 1.5, Number.NaN])
    assert.throws(() => move(workspace(), 'a', 'w1', index), /无效的标签页位置/);
});

test('the optimistic projection orders a pending move like the server', (t) => {
  t.mock.method(Date, 'now', () => 1);
  const state = { workspace: workspace() } as ProductState;
  const projected = projectOperations(state, [
    {
      operationId: 'op',
      operationGeneration: 'g',
      action: { type: 'tab.move', tabId: 'a', windowId: 'w2', index: 0 },
    },
  ])!;
  const server = move(workspace(), 'a', 'w2', 0);
  assert.deepEqual(
    projected.workspace.tabs.map((tab) => [tab.id, tab.windowId]),
    server.tabs.map((tab) => [tab.id, tab.windowId]),
  );
  assert.deepEqual(projected.workspace.windows, server.windows);
});
