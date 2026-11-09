import assert from 'node:assert/strict';
import test from 'node:test';
import { DownloadOutlined } from '@mui/icons-material';
import { sourceIcon } from '../client/files/files-organization';
import type { LibraryEntry, LibraryFileEntry, LibrarySnapshot } from '../shared/file-library';
import { filesInView, removalCounts, sourceAppName } from '../client/files/files-app-state';

const source = { app: 'browser', channel: 'example.com' };
const now = 20 * 86400_000;
const entry = (id: string, fields: Partial<LibraryFileEntry> = {}): LibraryFileEntry => ({
  kind: 'file',
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

test('aggregate views hide excluded sources; partition and source views retain them', () => {
  const data = snapshot([
    entry('hidden'),
    entry('organized', { partitionId: 'p' }),
    entry('old', { source: null, partitionId: 'p', createdAt: now - 8 * 86400_000 }),
    entry('upload', { source: { app: 'files', channel: 'upload' } }),
  ]);
  assert.deepEqual(
    filesInView(data, 'all', now).map((item) => item.id),
    ['upload', 'old'],
  );
  assert.deepEqual(
    filesInView(data, 'recent', now).map((item) => item.id),
    ['upload'],
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
  assert.equal(sourceAppName('download'), '下载');
  assert.equal(sourceIcon({ source: { app: 'download', channel: 'example.com' } }).type, DownloadOutlined);
  assert.equal(sourceAppName('browser'), '浏览器');
  assert.equal(sourceAppName('web:docs', [{ id: 'docs', name: '文档' }]), '文档');
  assert.equal(sourceAppName('web:missing'), 'web:missing');
});
