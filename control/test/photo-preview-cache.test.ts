import assert from 'node:assert/strict';
import test from 'node:test';
import { PhotoPreviewCache } from '../client/files/photo-preview-cache';

test('photo cache deduplicates pending reads, updates LRU order and releases on unmount', async () => {
  const reads: string[] = [];
  const cache = new PhotoPreviewCache({
    photoPreview: async (assetId) => ({ assetId, size: 1, width: 100, height: 100, type: 'image/webp' }),
    describeAsset: async (assetId) => ({ assetId, size: 1 }),
    readPhoto: async (asset) => {
      reads.push(asset.assetId);
      return new Blob(['x']);
    },
  });
  const first = cache.get('0', 1280);
  assert.equal(cache.get('0', 1280), first);
  await first;
  for (let index = 1; index < 12; index++) await cache.get(String(index), 1280);
  await cache.get('0', 1280);
  await cache.get('12', 1280);
  await cache.get('0', 1280);
  assert.equal(reads.filter((id) => id === '0').length, 1);
  await cache.get('1', 1280);
  assert.equal(reads.filter((id) => id === '1').length, 2);
  cache.dispose();
  await assert.rejects(cache.get('new', 1280), { code: 'canceled' });
});

test('photo cache evicts by compressed byte size independently of its item bound', async () => {
  const reads: string[] = [];
  const blob = new Blob([new Uint8Array(17 * 1024 * 1024)]);
  const cache = new PhotoPreviewCache({
    photoPreview: async (assetId) => ({
      assetId,
      size: blob.size,
      width: 100,
      height: 100,
      type: 'image/webp',
    }),
    describeAsset: async (assetId) => ({ assetId, size: blob.size }),
    readPhoto: async (asset) => {
      reads.push(asset.assetId);
      return blob;
    },
  });
  for (const id of ['a', 'b', 'c', 'a']) await cache.get(id, 1280);
  assert.deepEqual(reads, ['a', 'b', 'c', 'a']);
  cache.dispose();
});
