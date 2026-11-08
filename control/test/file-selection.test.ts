import test from 'node:test';
import assert from 'node:assert/strict';
import { fileChooserAccept, selectionViewModel, validateSelection } from '../client/files/file-selection';
import { selectVisibility } from '../client/app/visibility';
import type { FileRequest, PageDialog, ProductState } from '../shared/product';
import { productSnapshot } from './client-fixture';
const request: FileRequest = {
  id: 'opaque',
  tabId: 'a',
  windowId: 'w',
  origin: 'https://example.test',
  multiple: false,
  accept: ['.JPG', 'image/png'],
  state: 'pending',
  limits: { maxFiles: 3, maxFileBytes: 100, maxBatchBytes: 150 },
};

test('chooser cancellation preserves claimed outcomes until terminal reconciliation', () => {
  assert.equal(selectionViewModel('unknown', 'selected').selected, true);
  assert.equal(selectionViewModel('unknown', 'selected').cancelled, false);
  assert.equal(selectionViewModel('pending', 'unknown').uncertain, true);
  assert.equal(selectionViewModel('unknown', 'unknown').terminal, false);
  assert.equal(selectionViewModel('validating', 'validating').terminal, false);
  assert.equal(selectionViewModel('selected', 'unknown').selected, true);
  assert.equal(selectionViewModel('selected', 'unknown').uncertain, false);
  assert.equal(selectionViewModel('cancelled', 'unknown').cancelled, true);
});

test('omitted file hints do not restrict selection to an incomplete accept list', () => {
  assert.deepEqual(fileChooserAccept(request), request.accept);
  const partial = { ...request, accept: ['application/pdf'], acceptTypesOmitted: true };
  assert.deepEqual(fileChooserAccept(partial), []);
  assert.equal(validateSelection([new File(['bytes'], 'unlisted.txt')], partial), '');
  assert.deepEqual(partial.accept, ['application/pdf']);
});
test('file selection respects multiple and size limits', () => {
  const a = new File(['data'], 'a.jpg', { type: 'image/jpeg', lastModified: 1 }),
    b = new File(['data'], 'b.png', { type: 'image/png', lastModified: 1 });
  assert.equal(validateSelection([a], request), '');
  assert.match(validateSelection([a, b], request), /数量/);
  assert.match(validateSelection([new File([new Uint8Array(101)], 'large.jpg')], request), /单个/);
});
test('one foreground modal uses active visible window; background requests wait', () => {
  const state = {
    workspace: {
      activeSpaceId: 'space',
      spaces: [{ id: 'space', windowIds: ['w1', 'w2'], weights: [0.5, 0.5], focusedWindowId: 'w2' }],
      windows: [
        { id: 'w1', activeTabId: 'a' },
        { id: 'w2', activeTabId: 'b' },
      ],
    },
    pageDialogs: [{ id: 'page', tabId: 'a' }],
    fileRequests: [{ ...request, id: 'file', tabId: 'b' }],
  } as unknown as ProductState;
  assert.deepEqual(selectVisibility(state, 1440).foreground, { kind: 'file', id: 'file' });
  state.fileRequests = [];
  assert.deepEqual(selectVisibility(state, 1440).foreground, { kind: 'page', id: 'page' });
  assert.equal(selectVisibility(state, 390).foreground, null);
});

function promptState() {
  const state = productSnapshot();
  state.workspace.windows = [
    { id: 'w', appId: 'browser', activeTabId: 'a', lastActiveAt: 1 },
    { id: 'other', appId: 'browser', activeTabId: 'other-tab', lastActiveAt: 0 },
  ];
  state.workspace.activeSpaceId = 'space';
  state.workspace.spaces = [
    { id: 'space', windowIds: ['w', 'other'], weights: [0.5, 0.5], focusedWindowId: 'w', lastActiveAt: 1 },
  ];
  const identity = { tabId: 'a', windowId: 'w', origin: request.origin };
  state.pageDialogs = [
    {
      ...identity,
      id: 'permission',
      kind: 'permission',
      embeddingOrigin: request.origin,
      permissions: ['geolocation'],
    },
    {
      ...identity,
      id: 'protocol',
      kind: 'protocol_handler',
      protocol: 'mailto',
      url: request.origin + '/%s',
    },
  ];
  return state;
}

test('non-modal cards do not claim foreground or block a file chooser in the same tab', () => {
  const state = promptState();
  const before = structuredClone(state);
  assert.equal(selectVisibility(state, 1440).foreground, null);
  assert.deepEqual(state, before);
  state.fileRequests = [request];
  assert.deepEqual(selectVisibility(state, 1440).foreground, { kind: 'file', id: request.id });
  state.workspace.windows[0].activeTabId = 'background-tab';
  assert.equal(selectVisibility(state, 1440).foreground, null);
});

test('all modal page kinds take foreground behind older cards in the same tab', () => {
  const identity = { id: 'modal', tabId: 'a', windowId: 'w', origin: request.origin };
  const modals: PageDialog[] = [
    ...(['alert', 'confirm', 'prompt', 'beforeunload'] as const).map((kind) => ({
      ...identity,
      kind,
      message: '页面消息',
      defaultPrompt: '',
    })),
    { ...identity, kind: 'http_auth', realm: '', scheme: 'basic', proxy: false, url: request.origin },
    { ...identity, kind: 'repost' },
  ];
  for (const modal of modals) {
    const state = promptState();
    state.pageDialogs.push(modal);
    state.fileRequests = [request];
    assert.deepEqual(selectVisibility(state, 1440).foreground, { kind: 'page', id: 'modal' }, modal.kind);
  }
});

test('cards in the focused window do not block another visible window modal', () => {
  const state = promptState();
  state.pageDialogs.push({
    id: 'other-modal',
    tabId: 'other-tab',
    windowId: 'other',
    origin: request.origin,
    kind: 'repost',
  });
  assert.deepEqual(selectVisibility(state, 1440).foreground, { kind: 'page', id: 'other-modal' });
  assert.equal(selectVisibility(state, 390).foreground, null);
  assert.equal(state.workspace.spaces[0].focusedWindowId, 'w');
});
