import assert from 'node:assert/strict';
import test from 'node:test';
import {
  backFilesTab,
  defaultFilesWindowState,
  filteredFiles,
  fitFilesWindowState,
  nextPhotoIndex,
  openPhotosTab,
  photoSequence,
  readFilesWindowState,
  updateFilesLibraryTab,
} from '../client/files/files-app-state';
import type { FilesWindowState } from '../shared/files-state';
import type { LibraryFileEntry, LibrarySnapshot } from '../shared/file-library';
import { nativeError, parseWireError, RemoteKitError, wireError } from '../shared/errors';
import { presentFailure } from '../client/failures/present';

const entry = (id: string, createdAt: number, extra: Partial<LibraryFileEntry> = {}): LibraryFileEntry => ({
  kind: 'file',
  id,
  assetId: id,
  name: id + '.jpg',
  type: 'image/jpeg',
  size: 10,
  available: true,
  source: { app: 'files', channel: 'camera' },
  partitionId: null,
  collected: true,
  createdAt,
  ...extra,
});
const snapshot: LibrarySnapshot = {
  revision: 1,
  entries: [
    entry('first', 3),
    entry('second', 2),
    entry('pending', 4, { photo: { mode: 'scan', pending: 'choice' } }),
    entry('text', 5, { type: 'text/plain' }),
  ],
  basket: ['second', 'first'],
  partitions: [],
  excludedSources: [],
  sources: [],
  basketPartitionId: null,
};

test('photos insert after their source and strict state restores the source search', () => {
  const source = updateFilesLibraryTab(defaultFilesWindowState('aaaaaaaa'), 'aaaaaaaa', {
    view: 'recent',
    query: '相片',
  });
  const opened = openPhotosTab(source, 'aaaaaaaa', 'first', 'bbbbbbbb');
  assert.equal(opened.tabs.length, 2);
  assert.equal(opened.activeTabId, 'bbbbbbbb');
  assert.deepEqual(readFilesWindowState(opened), opened);
  assert.deepEqual(backFilesTab(opened, 'bbbbbbbb').tabs[1], {
    id: 'bbbbbbbb',
    kind: 'library',
    view: 'recent',
    query: '相片',
  });
  assert.throws(() =>
    readFilesWindowState({ ...opened, tabs: [{ ...opened.tabs[1], fromQuery: 'x'.repeat(257) }] }),
  );
  assert.throws(() => readFilesWindowState({ ...opened, tabs: [{ ...opened.tabs[1], extra: true }] }));
});

test('photo contexts participate in the UTF-8 budget and at most sixteen tabs survive', () => {
  const state: FilesWindowState = {
    tabs: Array.from({ length: 16 }, (_, i) => ({
      id: String(i).padStart(8, '0'),
      kind: 'photos',
      entryId: 'entry',
      from: 'all',
      fromQuery: '文'.repeat(256),
    })),
    activeTabId: '00000000',
    layout: 'grid',
  };
  const fitted = fitFilesWindowState(state, defaultFilesWindowState());
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 8192);
  assert.equal(fitted.tabs[0].kind !== 'library' && fitted.tabs[0].fromQuery, '文'.repeat(256));
  assert.ok(fitted.tabs.slice(1).every((tab) => tab.kind !== 'library' && !tab.fromQuery));
  const opened = openPhotosTab(fitted, fitted.activeTabId, 'entry', 'zzzzzzzz');
  assert.equal(opened.tabs.length, 16);
  assert.equal(opened.tabs[0].id, 'zzzzzzzz');
});

test('live sequences share library search and preserve basket order while excluding unfinished photos', () => {
  assert.deepEqual(
    photoSequence(snapshot, 'all').map((e) => e.id),
    ['first', 'second'],
  );
  assert.deepEqual(
    photoSequence(snapshot, 'basket').map((e) => e.id),
    ['second', 'first'],
  );
  assert.deepEqual(
    photoSequence(snapshot, 'all', 'first'),
    filteredFiles(snapshot, 'all', 'first').filter((e) => e.kind === 'file' && e.type.startsWith('image/')),
  );
  const removed = { ...snapshot, entries: snapshot.entries.filter((e) => e.id !== 'first') };
  const entries = photoSequence(removed, 'all');
  assert.equal(nextPhotoIndex(entries, 'first', 0), 0);
  assert.equal(entries[0].id, 'second');
  assert.equal(nextPhotoIndex(entries, 'missing', 1), 0);
  assert.equal(nextPhotoIndex([], 'missing', 0), -1);
  assert.deepEqual(
    photoSequence({ ...snapshot, excludedSources: [{ app: 'files', channel: 'camera' }] }, 'all'),
    [],
  );
});

test('missing asset, entry and selection retain wire details and have distinct user messages', () => {
  const texts = new Set<string>();
  for (const detail of ['asset_unreadable', 'selection_unknown', 'entry_missing'] as const) {
    const error = new RemoteKitError('not_found', 'same native message', { detail });
    const wire = wireError(error);
    assert.equal(parseWireError(wire)?.detail, detail);
    assert.equal(nativeError(wire).detail, detail);
    texts.add(presentFailure(error, { operation: '发送文件', scope: 'surface' }).text);
  }
  assert.equal(texts.size, 3);
});
