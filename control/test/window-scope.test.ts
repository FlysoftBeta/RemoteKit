import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductState } from '../shared/product';
import { sameWindowScope } from '../client/app/window-scope';

const tab = (id: string, windowId: string, title = id) => ({
  id,
  windowId,
  webviewId: id,
  title,
  url: '',
  idleKeepAlive: false,
});
function state(): ProductState {
  return {
    snapshotSequence: 1,
    operationGeneration: 'g',
    pageDialogs: [],
    fileRequests: [],
    workspace: {
      tenantId: 't',
      revision: 1,
      activeSpaceId: 'a',
      tabs: [tab('t1', 'w1'), tab('t2', 'w2'), tab('t3', 'w3')],
      windows: [
        { id: 'w1', appId: 'browser', activeTabId: 't1', lastActiveAt: 1 },
        { id: 'w2', appId: 'browser', activeTabId: 't2', lastActiveAt: 2 },
        { id: 'w3', appId: 'browser', activeTabId: 't3', lastActiveAt: 3 },
      ],
      spaces: [
        {
          id: 'a',
          name: null,
          windowIds: ['w1', 'w2'],
          weights: [1, 1],
          focusedWindowId: 'w1',
          lastActiveAt: 5,
        },
        { id: 'b', name: null, windowIds: ['w3'], weights: [1], focusedWindowId: 'w3', lastActiveAt: 4 },
      ],
      apps: [],
      favorites: [],
      settings: {},
      sites: {},
    },
  } as unknown as ProductState;
}
const edit = (base: ProductState, change: (workspace: any, state: any) => void): ProductState => {
  const next = { ...base, workspace: { ...base.workspace } } as any;
  change(next.workspace, next);
  return next;
};

test('a group switch and the stamps it moves do not change what a window shows', () => {
  const before = state();
  const after = edit(before, (workspace, root) => {
    root.snapshotSequence = 2;
    root.operationGeneration = 'h';
    workspace.revision = 2;
    workspace.activeSpaceId = 'b';
    workspace.spaces = [
      { ...before.workspace.spaces[0], lastActiveAt: 9 },
      { ...before.workspace.spaces[1], lastActiveAt: 10 },
    ];
    workspace.windows = [
      before.workspace.windows[0],
      before.workspace.windows[1],
      { ...before.workspace.windows[2], lastActiveAt: 11 },
    ];
  });
  assert.equal(sameWindowScope(before, after, 'w1'), true);
  assert.equal(sameWindowScope(before, after, 'w2'), true);
});

test('focus moving inside a group is told to the windows by their focused prop, not by state', () => {
  const before = state();
  const after = edit(before, (workspace) => {
    workspace.spaces = [{ ...before.workspace.spaces[0], focusedWindowId: 'w2' }, before.workspace.spaces[1]];
  });
  assert.equal(sameWindowScope(before, after, 'w1'), true);
});

test('only the window whose tab changed renders again, and every window when the set of tabs changes', () => {
  const before = state();
  const retitled = edit(before, (workspace) => {
    workspace.tabs = [workspace.tabs[0], { ...workspace.tabs[1], title: 'new' }, workspace.tabs[2]];
  });
  assert.equal(sameWindowScope(before, retitled, 'w1'), true);
  assert.equal(sameWindowScope(before, retitled, 'w2'), false);
  const added = edit(before, (workspace) => {
    workspace.tabs = [...workspace.tabs, tab('t4', 'w3')];
  });
  assert.equal(sameWindowScope(before, added, 'w1'), false);
});

test('groups and windows changing shape, and any other part of the state, are changes', () => {
  const before = state();
  const regrouped = edit(before, (workspace) => {
    workspace.spaces = [{ ...before.workspace.spaces[0], windowIds: ['w1'] }, before.workspace.spaces[1]];
  });
  assert.equal(sameWindowScope(before, regrouped, 'w1'), false);
  const reweighted = edit(before, (workspace) => {
    workspace.spaces = [{ ...before.workspace.spaces[0], weights: [2, 1] }, before.workspace.spaces[1]];
  });
  assert.equal(sameWindowScope(before, reweighted, 'w2'), false);
  const retyped = edit(before, (workspace) => {
    workspace.windows = [
      before.workspace.windows[0],
      { ...before.workspace.windows[1], appId: 'files' },
      before.workspace.windows[2],
    ];
  });
  assert.equal(sameWindowScope(before, retyped, 'w1'), false);
  const settings = edit(before, (workspace) => {
    workspace.settings = { changed: true };
  });
  assert.equal(sameWindowScope(before, settings, 'w1'), false);
  const dialog = { ...before, pageDialogs: [{ id: 'd' }] } as unknown as ProductState;
  assert.equal(sameWindowScope(before, dialog, 'w1'), false);
  assert.equal(sameWindowScope(before, before, 'w1'), true);
});

test('a window frame renders again for its own props and scope, not for a group switch elsewhere', async () => {
  const { WindowFrame } = await import('../client/app/window-frame');
  const compare = (WindowFrame as unknown as { compare: (a: unknown, b: unknown) => boolean }).compare;
  const before = state();
  const base = {
    win: before.workspace.windows[0],
    state: before,
    transport: {},
    action: () => {},
    shellReady: true,
    appContent: () => null,
    call: () => {},
    weight: 1,
    onGeometry: () => {},
    visible: true,
    focused: true,
    fullscreen: false,
    groupHandle: true,
  };
  const switched = edit(before, (workspace, root) => {
    root.snapshotSequence = 2;
    workspace.activeSpaceId = 'b';
    workspace.spaces = before.workspace.spaces.map((space) => ({ ...space, lastActiveAt: 99 }));
  });
  assert.equal(compare(base, { ...base, state: switched }), true);
  assert.equal(compare(base, { ...base, state: switched, focused: false }), false);
  assert.equal(compare(base, { ...base, state: switched, visible: false }), false);
  assert.equal(compare(base, { ...base, state: switched, appContent: () => null }), true);
  const settings = { ...base, win: { ...base.win, appId: 'settings' } };
  assert.equal(compare(settings, { ...settings, state: switched, appContent: () => null }), false);
  assert.equal(compare(base, { ...base, win: { ...base.win, lastActiveAt: 7 } }), false);
});
