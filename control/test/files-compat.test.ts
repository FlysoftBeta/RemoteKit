import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setDocumentCompat, defaultFilesWindowState, openFilesEntry } from '../client/files/files-app-state';
import {
  validateDesired,
  validateSessionObserved,
  PDF_VIEWER_URL,
  type SessionDesired,
} from '../server/endpoint/coordination';
import { tab as tabCodec } from '../server/persistence/documents';
import { applyCommand } from '../server/workspace/commands';
import { syncFilesOwnership } from '../server/workspace/files-owner';
import type { FilesWindowState } from '../shared/files-state';
import { filesState } from '../shared/persisted-window-state';
import type { ProductTab, ProductWorkspace } from '../shared/product';
import { productSnapshot } from './client-fixture';
import { observedSession } from './coordination-fixture';

const compatState = (compat: boolean, entryId = 'entry1'): FilesWindowState => {
  const base = defaultFilesWindowState('aaaaaaaa');
  const opened = openFilesEntry(base, 'aaaaaaaa', entryId);
  return setDocumentCompat(opened, 'aaaaaaaa', compat);
};

function workspace(state: FilesWindowState): ProductWorkspace {
  const snapshot = productSnapshot().workspace;
  return {
    ...snapshot,
    tabs: [],
    windows: [{ id: 'w1', appId: 'files', activeTabId: null, lastActiveAt: 1, state: { ...state } }],
    spaces: [
      { id: 's1', name: null, windowIds: ['w1'], weights: [1], focusedWindowId: 'w1', lastActiveAt: 1 },
    ],
    activeSpaceId: 's1',
  };
}
let counter = 0;
const asset = (name: string) => name.padEnd(64, '0');
const environment = (pdfs: string[], assets: Record<string, string> = {}) => ({
  readablePdf: (id: string) => (pdfs.includes(id) ? (assets[id] ?? asset('a')) : undefined),
  ids: () => ({ tabId: `tab-${++counter}`, viewId: String(counter) }),
});

test('document tab compat flag is declared, optional and strict', () => {
  const state = compatState(true);
  assert.deepEqual(filesState.read(state, '$'), state);
  assert.equal('compat' in compatState(false).tabs[0], false);
  for (const compat of [false, 1, 'true'])
    assert.throws(() => filesState.read({ ...state, tabs: [{ ...state.tabs[0], compat }] }, '$'));
  const photo = { id: 'bbbbbbbb', kind: 'photos', entryId: 'e', from: 'all', compat: true };
  assert.throws(() => filesState.read({ ...state, tabs: [photo], activeTabId: 'bbbbbbbb' }, '$'));
});

test('product tab owner is persisted strictly', () => {
  const owned: ProductTab = {
    id: 't',
    windowId: 'w1',
    webviewId: '1',
    title: 'PDF',
    url: PDF_VIEWER_URL,
    idleKeepAlive: false,
    kind: 'remote',
    owner: { kind: 'files', windowId: 'w1', filesTabId: 'aaaaaaaa', assetId: asset('a') },
  };
  assert.deepEqual(tabCodec.read(JSON.parse(JSON.stringify(owned)), '$'), owned);
  assert.throws(() => tabCodec.read({ ...owned, owner: { ...owned.owner, extra: 1 } }, '$'));
  assert.throws(() => tabCodec.read({ ...owned, owner: { kind: 'browser' } }, '$'));
});

test('compat PDF tab gets one owned tab and the window active tab is derived', () => {
  const state = workspace(compatState(true));
  const result = syncFilesOwnership(state, environment(['entry1']));
  assert.equal(result.changed, true);
  assert.equal(state.tabs.length, 1);
  const [owned] = state.tabs;
  assert.deepEqual(owned.owner, {
    kind: 'files',
    windowId: 'w1',
    filesTabId: 'aaaaaaaa',
    assetId: asset('a'),
  });
  assert.equal(owned.url, PDF_VIEWER_URL);
  assert.equal(owned.kind, 'remote');
  assert.equal(state.windows[0].activeTabId, owned.id);
  assert.equal(syncFilesOwnership(state, environment(['entry1'])).changed, false);
  assert.equal(state.tabs.length, 1);
});

test('a non-current compat tab keeps its owned tab but is not the window active tab', () => {
  const files = compatState(true);
  const other = { id: 'cccccccc', kind: 'library' as const, view: 'all' as const, query: '' };
  const state = workspace({ ...files, tabs: [...files.tabs, other], activeTabId: 'cccccccc' });
  syncFilesOwnership(state, environment(['entry1']));
  assert.equal(state.tabs.length, 1);
  assert.equal(state.windows[0].activeTabId, null);
});

for (const [name, next, pdfs] of [
  ['switching back to the local reader', () => compatState(false), ['entry1']],
  ['closing the tab', () => defaultFilesWindowState('dddddddd'), ['entry1']],
  ['deleting the entry', () => compatState(true), []],
  ['an entry that stops being a readable PDF', () => compatState(true, 'entry2'), ['entry1']],
] as const) {
  test(`${name} retires the owned tab and clears the active tab`, () => {
    const state = workspace(compatState(true));
    syncFilesOwnership(state, environment(['entry1']));
    const view = state.tabs[0].webviewId;
    state.windows[0].state = { ...next() };
    const result = syncFilesOwnership(state, environment([...pdfs]));
    assert.deepEqual(result.retired, [view]);
    assert.equal(state.tabs.length, 0);
    assert.equal(state.windows[0].activeTabId, null);
  });
}

test('a pending close of a retired tab is cleared', () => {
  const state = workspace(compatState(true));
  syncFilesOwnership(state, environment(['entry1']));
  state.pendingClose = {
    id: state.tabs[0].id,
    enteredAt: 1,
    observationEpoch: '1',
    observationSequence: '1',
  };
  state.windows[0].state = { ...compatState(false) };
  syncFilesOwnership(state, environment(['entry1']));
  assert.equal(state.pendingClose, null);
});

test('the workspace tab limit leaves the compat tab without a view instead of failing', () => {
  const state = workspace(compatState(true));
  for (let i = 0; i < 32; i++)
    state.tabs.push({
      id: `x${i}`,
      windowId: 'w1',
      webviewId: `v${i}`,
      title: '',
      url: 'https://example.com/',
      idleKeepAlive: false,
      kind: 'remote',
    });
  syncFilesOwnership(state, environment(['entry1']));
  assert.equal(state.tabs.length, 32);
  assert.equal(state.windows[0].activeTabId, null);
});

test('clients cannot navigate, activate, move or close an owned tab', () => {
  const state = workspace(compatState(true));
  syncFilesOwnership(state, environment(['entry1']));
  const tabId = state.tabs[0].id;
  for (const action of [
    { type: 'tab.navigate', tabId, url: 'https://example.com/' },
    { type: 'tab.command', tabId, command: 'reload' },
    { type: 'tab.activate', tabId },
    { type: 'tab.close', tabId },
    { type: 'tab.move', tabId, windowId: 'w1' },
  ])
    assert.throws(() => applyCommand(state, action as never, { viewId: '' }), { code: 'forbidden' });
});

test('desired views may carry a PDF document only at the viewer address', () => {
  const desired: SessionDesired = JSON.parse(
    readFileSync(new URL('../../protocol/coordination.fixture.json', import.meta.url), 'utf8'),
  );
  const view = {
    ...desired.views[0],
    url: PDF_VIEWER_URL,
    document: { kind: 'pdf' as const, assetId: asset('a') },
  };
  validateDesired({ ...desired, views: [view] });
  assert.throws(() => validateDesired({ ...desired, views: [{ ...view, url: 'https://example.com/' }] }), {
    code: 'invalid_request',
  });
  assert.throws(
    () =>
      validateDesired({
        ...desired,
        views: [{ ...view, document: { kind: 'doc', assetId: asset('a') } as never }],
      }),
    { code: 'invalid_request' },
  );
  assert.throws(() => validateDesired({ ...desired, views: [{ ...view, signIn: 'changyan' }] }), {
    code: 'invalid_request',
  });
});

test('a replaced asset retires the owned tab and creates a new view instead of changing the document', () => {
  const state = workspace(compatState(true));
  syncFilesOwnership(state, environment(['entry1']));
  const before = state.tabs[0];
  const result = syncFilesOwnership(state, environment(['entry1'], { entry1: asset('b') }));
  assert.deepEqual(result.retired, [before.webviewId]);
  assert.equal(state.tabs.length, 1);
  assert.notEqual(state.tabs[0].id, before.id);
  assert.notEqual(state.tabs[0].webviewId, before.webviewId);
  assert.equal(state.tabs[0].owner?.assetId, asset('b'));
  assert.equal(state.windows[0].activeTabId, state.tabs[0].id);
});

test('desired document asset IDs must be 64 lowercase hex digits', () => {
  const desired: SessionDesired = JSON.parse(
    readFileSync(new URL('../../protocol/coordination.fixture.json', import.meta.url), 'utf8'),
  );
  const view = { ...desired.views[0], url: PDF_VIEWER_URL, document: { kind: 'pdf' as const, assetId: 'a' } };
  assert.throws(() => validateDesired({ ...desired, views: [view] }), { code: 'invalid_request' });
});

test('observations accept optional document errors keyed by view', () => {
  const observed = (documentErrors: unknown) => ({ ...baseObserved(), documentErrors }) as never;
  validateSessionObserved(baseObserved());
  validateSessionObserved(observed({ '3': { code: 'not_found', message: 'gone' } }));
  assert.throws(() => validateSessionObserved(observed({ x: { code: 'not_found' } })), {
    code: 'invalid_request',
  });
  assert.throws(() => validateSessionObserved(observed([])), { code: 'invalid_request' });
});

function baseObserved() {
  const desired: SessionDesired = JSON.parse(
    readFileSync(new URL('../../protocol/coordination.fixture.json', import.meta.url), 'utf8'),
  );
  return observedSession(desired, 'epoch', 'incarnation', desired);
}
