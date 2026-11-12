import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyFilesLaunch,
  backFilesTab,
  closeFilesTab,
  closeOtherFilesTabs,
  defaultFilesWindowState,
  filesTabId,
  fitFilesWindowState,
  hasValidFilesTabs,
  newFilesTab,
  openFilesEntry,
  readFilesLaunch,
  readFilesWindowState,
  reorderFilesTab,
  selectFilesTab,
  setFilesLayout,
  updateFilesLibraryTab,
  type FilesWindowState,
} from '../client/files/files-app-state';

const initial = () => defaultFilesWindowState('aaaaaaaa');
function expectDefault(value: unknown) {
  const state = readFilesWindowState(value);
  assert.equal(state.tabs.length, 1);
  assert.match(state.activeTabId, /^[a-z0-9]{8}$/);
  assert.deepEqual(state.tabs[0], { id: state.activeTabId, kind: 'library', view: 'all', query: '' });
  assert.equal(state.layout, 'grid');
}
test('files window accepts only the strict current state shape', () => {
  const base = initial();
  for (const value of [
    null,
    [],
    { view: 'all', query: '', layout: 'grid' },
    { ...base, extra: true },
    { ...base, tabs: [] },
    { ...base, tabs: [...base.tabs, ...base.tabs] },
    { ...base, activeTabId: 'missing1' },
    { ...base, layout: 'cards' },
    { ...base, tabs: [{ ...base.tabs[0], id: 'UPPER123' }] },
    { ...base, tabs: [{ ...base.tabs[0], query: 'x'.repeat(257) }] },
    { ...base, tabs: [{ ...base.tabs[0], view: { source: null } }] },
    { ...base, tabs: [{ ...base.tabs[0], view: { partition: 1 } }] },
    { ...base, tabs: [{ ...base.tabs[0], view: { source: { app: 'browser', channel: 'x'.repeat(254) } } }] },
    { ...base, tabs: [{ id: 'aaaaaaaa', kind: 'document', entryId: '' }] },
    { ...base, tabs: [{ id: 'aaaaaaaa', kind: 'document', entryId: 'entry', from: 'invalid' }] },
    { ...base, launch: { requestId: 'request' } },
    { ...base, launch: { requestId: 'request', entryId: 'entry', extra: true } },
  ])
    assert.throws(() => readFilesWindowState(value), { reason: 'corrupt_record' });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => readFilesWindowState(circular), { reason: 'corrupt_record' });
  expectDefault(undefined);
  expectDefault({});
  assert.deepEqual(readFilesWindowState(base), base);
  assert.notEqual(readFilesWindowState(base).tabs, base.tabs);
  assert.match(filesTabId(), /^[a-z0-9]{8}$/);
  assert.equal(
    readFilesLaunch({ requestId: 'r', view: { source: { app: 'study', channel: '' } } })?.requestId,
    'r',
  );
});

test('open and back preserve tab identity and originating view; queries and layout are window state', () => {
  let state = updateFilesLibraryTab(initial(), 'aaaaaaaa', {
    view: { partition: 'work' },
    query: 'x'.repeat(300),
  });
  assert.equal(state.tabs[0].kind === 'library' && state.tabs[0].query.length, 256);
  state = setFilesLayout(state, 'list');
  const document = openFilesEntry(state, 'aaaaaaaa', 'entry');
  assert.deepEqual(document.tabs[0], {
    id: 'aaaaaaaa',
    kind: 'document',
    entryId: 'entry',
    from: { partition: 'work' },
  });
  assert.deepEqual(backFilesTab(document, 'aaaaaaaa').tabs[0], {
    id: 'aaaaaaaa',
    kind: 'library',
    view: { partition: 'work' },
    query: '',
  });
  assert.equal(document.layout, 'list');
  const withoutFrom: FilesWindowState = {
    ...initial(),
    tabs: [{ id: 'aaaaaaaa', kind: 'document', entryId: 'entry' }],
  };
  assert.deepEqual(backFilesTab(withoutFrom, 'aaaaaaaa'), initial());
  assert.equal(state.tabs[0].kind, 'library');
});

test('new, close, close others, select and reorder use stable ids and adjacent activation', () => {
  let state = newFilesTab(initial(), 'bbbbbbbb');
  state = newFilesTab(state, 'cccccccc');
  state = selectFilesTab(state, 'aaaaaaaa');
  state = newFilesTab(state, 'dddddddd');
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    ['aaaaaaaa', 'dddddddd', 'bbbbbbbb', 'cccccccc'],
  );
  const moved = reorderFilesTab(state, 'dddddddd', 3);
  assert.deepEqual(
    moved.tabs.map((tab) => tab.id),
    ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'],
  );
  assert.equal(moved.activeTabId, 'dddddddd');
  assert.equal(closeFilesTab(moved, 'dddddddd', 'eeeeeeee').activeTabId, 'cccccccc');
  assert.equal(closeFilesTab(state, 'bbbbbbbb', 'eeeeeeee').activeTabId, 'dddddddd');
  assert.deepEqual(
    closeOtherFilesTabs(state, 'bbbbbbbb').tabs.map((tab) => tab.id),
    ['bbbbbbbb'],
  );
  assert.equal(closeOtherFilesTabs(state, 'bbbbbbbb').activeTabId, 'bbbbbbbb');
  assert.deepEqual(closeFilesTab(setFilesLayout(initial(), 'list'), 'aaaaaaaa', 'eeeeeeee'), {
    ...defaultFilesWindowState('eeeeeeee'),
    layout: 'list',
  });
  assert.equal(selectFilesTab(state, 'missing1'), state);
  assert.equal(closeFilesTab(state, 'missing1', 'eeeeeeee'), state);
});

test('launch appends after active, consumes launch and uses exactly one tab in an uninitialized window', () => {
  const launch = {
    requestId: 'request',
    entryId: 'entry',
    view: { source: { app: 'browser', channel: 'example.com' } },
  };
  const base = { ...newFilesTab(initial(), 'bbbbbbbb'), activeTabId: 'aaaaaaaa', launch };
  const state = applyFilesLaunch(base, launch, 'cccccccc');
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    ['aaaaaaaa', 'cccccccc', 'bbbbbbbb'],
  );
  assert.equal(state.activeTabId, 'cccccccc');
  assert.equal(state.launch, undefined);
  assert.deepEqual(state.tabs[1], { id: 'cccccccc', kind: 'document', entryId: 'entry', from: launch.view });
  const fresh = applyFilesLaunch(initial(), launch, 'cccccccc', false);
  assert.equal(fresh.tabs.length, 1);
  assert.deepEqual(
    applyFilesLaunch(initial(), { requestId: 'r', view: 'recent' }, 'cccccccc', false).tabs[0],
    { id: 'cccccccc', kind: 'library', view: 'recent', query: '' },
  );
  assert.equal(hasValidFilesTabs({ launch }), false);
});

test('sixteen tabs disable creation; launches replace the active tab', () => {
  let state = initial();
  for (let index = 1; index < 16; index++) state = newFilesTab(state, String(index).padStart(8, '0'));
  assert.equal(newFilesTab(state, 'zzzzzzzz'), state);
  const launched = applyFilesLaunch(state, { requestId: 'r', entryId: 'entry' }, 'zzzzzzzz');
  assert.equal(launched.tabs.length, 16);
  assert.equal(launched.activeTabId, 'zzzzzzzz');
  assert.equal(launched.tabs[15].kind, 'document');
  assert.deepEqual(launched.tabs[15], { id: 'zzzzzzzz', kind: 'document', entryId: 'entry', from: 'all' });
  assert.throws(
    () => readFilesWindowState({ ...state, tabs: [...state.tabs, { ...state.tabs[0], id: 'zzzzzzzz' }] }),
    { reason: 'corrupt_record' },
  );
});

test('UTF-8 budget clears inactive drafts first, then the active draft', () => {
  const tabs = Array.from({ length: 16 }, (_, index) => ({
    id: String(index).padStart(8, '0'),
    kind: 'library' as const,
    view: 'all' as const,
    query: '文'.repeat(256),
  }));
  const next: FilesWindowState = { tabs, activeTabId: tabs[0].id, layout: 'grid' };
  const trimmed = fitFilesWindowState(next, initial());
  assert.equal(trimmed.tabs[0].kind === 'library' && trimmed.tabs[0].query.length, 256);
  assert.ok(trimmed.tabs.slice(1).every((tab) => tab.kind === 'library' && !tab.query));
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= 8192);
  assert.throws(() => readFilesWindowState(next), { reason: 'corrupt_record' });
  const heavy: FilesWindowState = {
    ...next,
    tabs: tabs.map((tab) => ({
      ...tab,
      query: '',
      view: { source: { app: 'browser', channel: '文'.repeat(125) } },
    })),
  };
  heavy.tabs[0] = { ...tabs[0], view: { source: { app: 'browser', channel: '文'.repeat(125) } } };
  const bounded = fitFilesWindowState(heavy, initial());
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 8192);
  assert.equal(bounded.tabs[0].kind === 'library' && bounded.tabs[0].query, '');
  const excessive = {
    ...next,
    tabs: tabs.map((tab) => ({
      ...tab,
      query: '',
      view: { source: { app: 'browser', channel: '文'.repeat(253) } },
    })),
  };
  assert.equal(fitFilesWindowState(excessive, initial()).activeTabId, 'aaaaaaaa');
});
