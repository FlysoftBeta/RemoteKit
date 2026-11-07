import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryEntry, LibrarySnapshot } from '../shared/file-library';
import { filesInView, readFilesState, removalCounts, sourceAppName } from '../client/files/files-app-state';

const source = { app: 'browser', channel: 'example.com' };
const now = 20 * 86400_000;
const entry = (id: string, fields: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  name: id,
  assetId: id,
  type: 'image/png',
  size: 1,
  createdAt: now,
  source,
  partitionId: null,
  collected: true,
  ...fields,
});
const snapshot = (entries: LibraryEntry[]): LibrarySnapshot => ({
  revision: 1,
  entries,
  basket: [],
  partitions: [{ id: 'p', name: '分区' }],
  sources: [{ ...source, count: entries.length, excluded: true }],
  excludedSources: [source],
  basketPartitionId: null,
});

test('Files view state validates and emits bounded canonical JSON', () => {
  const defaults = { view: 'all', query: '', layout: 'grid' };
  for (const value of [
    null,
    [],
    { view: 'groups' },
    { view: 'all', query: 'x'.repeat(4096), layout: 'grid' },
    { view: { source: null }, query: '', layout: 'grid' },
    { view: { partition: 1 }, query: '', layout: 'grid' },
  ]) {
    assert.deepEqual(readFilesState(value), defaults);
  }
  const value = { view: { source }, query: '照片', layout: 'list', extra: 'discard' };
  assert.deepEqual(readFilesState(value), { view: { source }, query: '照片', layout: 'list' });
  assert.ok(new TextEncoder().encode(JSON.stringify(readFilesState(value))).length <= 4096);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.deepEqual(readFilesState(circular), defaults);
});

test('aggregate views hide excluded sources unless partitioned; source view retains them', () => {
  const data = snapshot([
    entry('hidden'),
    entry('organized', { partitionId: 'p' }),
    entry('old', { source: null, partitionId: 'p', createdAt: now - 8 * 86400_000 }),
    entry('upload', { source: { app: 'files', channel: 'upload' } }),
  ]);
  assert.deepEqual(
    filesInView(data, 'all', now).map((item) => item.id),
    ['organized', 'upload', 'old'],
  );
  assert.deepEqual(
    filesInView(data, 'recent', now).map((item) => item.id),
    ['organized', 'upload'],
  );
  assert.deepEqual(
    filesInView(data, { source }, now).map((item) => item.id),
    ['hidden', 'organized'],
  );
  assert.deepEqual(
    filesInView(data, { partition: 'p' }, now).map((item) => item.id),
    ['organized', 'old'],
  );
});

test('partition and source removal counts honor the remaining references', () => {
  const data = snapshot([
    entry('collected', { partitionId: 'p' }),
    entry('uncollected', { partitionId: 'p', collected: false }),
    entry('detached', { source: null, partitionId: 'p' }),
    entry('basket', { source: null, partitionId: 'p', collected: false }),
    entry('source-basket'),
    entry('source-only'),
  ]);
  data.basket = ['basket', 'source-basket'];
  assert.deepEqual(removalCounts(data, { partition: 'p' }), { deleted: 2, kept: 2 });
  assert.deepEqual(removalCounts(data, { source }), { deleted: 1, kept: 3 });
});

test('source names use installed app names and retain the app ID fallback', () => {
  assert.equal(sourceAppName('browser'), '浏览器');
  assert.equal(sourceAppName('web:docs', [{ id: 'docs', name: '文档' }]), '文档');
  assert.equal(sourceAppName('web:missing'), 'web:missing');
});
