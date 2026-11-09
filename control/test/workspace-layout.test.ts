import assert from 'node:assert/strict';
import test from 'node:test';
import { selectVisibility } from '../client/app/visibility';
import { dividerWeights } from '../client/app/window-divider';
import { launcherActions, launcherNavigation, launcherPlacement } from '../client/app/launcher-actions';
import { projectOperations } from '../client/control/product-operations';
import { ViewportRequests } from '../client/control/viewport-requests';
import { productSnapshot } from './client-fixture';
import type { LauncherItem, ProductAction, ViewerViewport } from '../shared/product';

function workspace() {
  const state = productSnapshot();
  state.workspace.windows = ['a', 'b', 'c'].map((id, index) => ({
    id,
    appId: index === 1 ? 'files' : 'browser',
    activeTabId: index === 1 ? null : id,
    lastActiveAt: index,
  }));
  state.workspace.tabs = ['a', 'c'].map((id) => ({
    id,
    windowId: id,
    webviewId: id,
    kind: 'remote',
    title: id,
    url: 'https://example.test/',
  }));
  state.workspace.spaces = [
    { id: 'one', windowIds: ['a', 'b'], weights: [0.7, 0.3], focusedWindowId: 'b', lastActiveAt: 1 },
    { id: 'two', windowIds: ['c'], weights: [1], focusedWindowId: 'c', lastActiveAt: 2 },
  ];
  state.workspace.activeSpaceId = 'one';
  return state;
}

test('space visibility uses the 360px window threshold without changing the space', () => {
  const state = workspace();
  assert.deepEqual(selectVisibility(state, 744).visibleWindowIds, ['a', 'b']);
  assert.deepEqual(selectVisibility(state, 743).visibleWindowIds, ['b']);
  assert.deepEqual(state.workspace.spaces[0].windowIds, ['a', 'b']);
  state.workspace.activeSpaceId = 'two';
  assert.deepEqual(selectVisibility(state, 1600).visibleWindowIds, ['c']);
});

test('a window shown fullscreen is the only visible one; a page fullscreen wins', () => {
  const state = workspace();
  const chosen = selectVisibility(state, 1600, 'a');
  assert.deepEqual(chosen.visibleWindowIds, ['a']);
  assert.equal(chosen.sideBySide, false);
  assert.deepEqual(selectVisibility(state, 1600, 'gone').visibleWindowIds, ['a', 'b']);
  state.pageFullscreen = { windowId: 'c', tabId: 'c', target: 'target' } as typeof state.pageFullscreen;
  assert.deepEqual(selectVisibility(state, 1600, 'a').visibleWindowIds, ['c']);
});

test('viewport reports hidden spaces and local apps as invisible', async () => {
  const reports: ViewerViewport[] = [];
  const requests = new ViewportRequests(async (viewport) => {
    reports.push(viewport);
  });
  requests.observe(workspace(), true);
  requests.measure(1600, 884, 1, true);
  requests.setGeometry('a', 1000, 796);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.deepEqual(
    reports[0].windows.map((window) => [window.windowId, window.visible]),
    [
      ['a', true],
      ['b', false],
      ['c', false],
    ],
  );
  assert.equal(reports[0].windows[0].height, 796);
  requests.reset();
});

test('space projection handles split, focus, detach, proportions and settings singleton', () => {
  const state = workspace();
  const project = (actions: ProductAction[]) =>
    projectOperations(
      state,
      actions.map((action, index) => ({ action, operationId: String(index), operationGeneration: 'g' })),
    )!.workspace;
  const next = project([
    {
      type: 'window.open',
      appId: 'settings',
      placement: { mode: 'split', besideWindowId: 'b', side: 'right' },
    },
    { type: 'window.open', appId: 'settings', placement: { mode: 'space' } },
  ]);
  assert.equal(next.windows.filter((window) => window.appId === 'settings').length, 1);
  assert.deepEqual(next.spaces[0].windowIds, ['a', 'b', 'pending-0']);
  assert.deepEqual(next.spaces[0].weights, [0.7, 0.15, 0.15]);
  const detached = project([{ type: 'window.place', windowId: 'a', placement: { mode: 'space' } }]);
  assert.deepEqual(detached.spaces[0].windowIds, ['b']);
  assert.deepEqual(detached.spaces[0].weights, [1]);
  assert.equal(detached.activeSpaceId, 'pending-0-space');
  const focused = project([{ type: 'window.focus', windowId: 'c' }]);
  assert.equal(focused.activeSpaceId, 'two');
  assert.equal(focused.spaces[1].focusedWindowId, 'c');
  assert.deepEqual(
    project([{ type: 'space.layout', spaceId: 'one', weights: [1, 3] }]).spaces[0].weights,
    [0.25, 0.75],
  );
  assert.deepEqual(dividerWeights([0.2, 0.3, 0.5], 1, 0.5), [0.2, 0.4, 0.4]);
});

test('launcher appends to the target group, honors longest app scope and explicitly reuses page or file windows', () => {
  const state = workspace().workspace;
  const page: LauncherItem = {
    key: 'page',
    group: 'pages',
    kind: 'page',
    score: 1,
    title: 'Page',
    url: 'https://example.test/app/note',
  };
  assert.deepEqual(launcherActions(state, page), [
    {
      type: 'window.open',
      appId: 'browser',
      url: page.url,
      placement: { mode: 'split', besideWindowId: 'b', side: 'right' },
      source: 'launcher',
    },
  ]);
  state.apps = [
    {
      id: 'app',
      name: 'Notes',
      startUrl: page.url!,
      scope: 'https://example.test/app/',
      display: 'standalone',
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  assert.equal(
    (launcherActions(state, page)[0] as Extract<ProductAction, { type: 'window.open' }>).appId,
    'web:app',
  );
  const app: LauncherItem = { ...page, kind: 'app', appId: 'browser' };
  assert.deepEqual(launcherActions(state, app), [
    {
      type: 'window.open',
      appId: 'browser',
      url: undefined,
      placement: { mode: 'split', besideWindowId: 'b', side: 'right' },
      source: 'launcher',
    },
  ]);
  const placement = { mode: 'split', besideWindowId: 'a', side: 'left' } as const;
  assert.deepEqual(launcherActions(state, app, placement), [
    { type: 'window.open', appId: 'browser', url: undefined, placement, source: 'launcher' },
  ]);
  assert.deepEqual(launcherActions(state, page, undefined, true), [
    { type: 'tab.create', windowId: 'c', url: page.url, source: 'launcher' },
  ]);
  const file: LauncherItem = { ...page, kind: 'file', entryId: 'file' };
  assert.equal(launcherActions(state, file)[0].type, 'window.open');
  assert.deepEqual(launcherActions(state, file, undefined, true), [
    { type: 'window.focus', windowId: 'b', source: 'launcher' },
  ]);
  assert.deepEqual(launcherNavigation(page.url!, { mode: 'space' }), {
    type: 'window.open',
    appId: 'browser',
    placement: { mode: 'space' },
    url: page.url,
    source: 'launcher',
  });
  assert.deepEqual(launcherNavigation('two words', { mode: 'space' }), {
    type: 'window.open',
    appId: 'browser',
    url: 'two words',
    placement: { mode: 'space' },
    source: 'launcher',
  });
});

test('a stale placement target cannot break authoritative snapshot projection', () => {
  const state = workspace();
  const projected = projectOperations(state, [
    {
      operationId: 'stale',
      operationGeneration: 'g',
      action: {
        type: 'window.place',
        windowId: 'a',
        placement: { mode: 'split', besideWindowId: 'retired', side: 'left' },
      },
    },
  ])!;
  assert.deepEqual(projected.workspace.spaces, state.workspace.spaces);
});

test('replace projection preserves the slot and proportions and detaches the replaced window', () => {
  const state = workspace();
  const projected = projectOperations(state, [
    {
      operationId: 'replace',
      operationGeneration: 'g',
      action: {
        type: 'window.open',
        appId: 'files',
        placement: { mode: 'replace', windowId: 'a' },
      },
    },
  ])!.workspace;
  assert.deepEqual(projected.spaces[0].windowIds, ['pending-replace', 'b']);
  assert.deepEqual(projected.spaces[0].weights, [0.7, 0.3]);
  assert.deepEqual(projected.spaces[2].windowIds, ['a']);
  assert.equal(projected.activeSpaceId, 'one');
  assert.equal(projected.spaces[0].focusedWindowId, 'pending-replace');
  assert.deepEqual(
    projectOperations(state, [
      {
        operationId: 'stale',
        operationGeneration: 'g',
        action: {
          type: 'window.open',
          appId: 'files',
          placement: { mode: 'replace', windowId: 'retired' },
        },
      },
    ])!.workspace.spaces,
    state.workspace.spaces,
  );
});

test('launcher falls back to a new group at capacity and settings always focuses its singleton', () => {
  const state = workspace().workspace;
  state.spaces[0].windowIds.push('c');
  assert.deepEqual(launcherPlacement(state), { mode: 'space' });
  state.windows[0].appId = 'settings';
  const item: LauncherItem = {
    key: 'app:settings',
    kind: 'app',
    group: 'apps',
    score: 0,
    title: 'Settings',
    appId: 'settings',
  };
  assert.deepEqual(launcherActions(state, item, { mode: 'replace', windowId: 'b' }), [
    { type: 'window.focus', windowId: 'a', source: 'launcher' },
  ]);
  state.activeSpaceId = null;
  assert.deepEqual(launcherPlacement(state), { mode: 'space' });
});
