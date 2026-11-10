import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteKitError } from '../shared/errors';
import type { Asset, LibraryMethods, LibrarySnapshot, SelectionState } from '../shared/file-library';
import type { CapturedBurst } from '../client/files/camera-capture';
import { ImportQueue } from '../client/files/import-queue';
import { LibraryStore, type LibraryRequest } from '../client/files/library-store';
import type { ProcessedPhoto } from '../client/files/file-channel';
import { PhotoJobStore } from '../client/files/photo-job-store';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const snapshot = (revision: number): LibrarySnapshot => ({
  revision,
  entries: [],
  basket: [],
  partitions: [],
  sources: [],
  excludedSources: [],
  basketPartitionId: null,
});
const asset: Asset = { assetId: 'a'.repeat(64), size: 1, type: 'image/jpeg' };
const processed: ProcessedPhoto = {
  assetId: 'b'.repeat(64),
  size: 1,
  type: 'image/webp',
  geometry: 'unchanged',
  quarterTurns: 0,
  orientation: 'none',
};
function libraryPort() {
  return {
    photoThumbnail: async () => new Blob(),
    uploadAsset: async () => asset,
    processPhoto: async () => processed,
    commitSelection: async (_requestId: string, selectionId: string) => ({
      state: 'unknown' as const,
      selectionId,
    }),
    cancelSelection: async () => ({ state: 'unknown' as SelectionState }),
  };
}

test('library revisions stay monotonic and old scope responses cannot populate a new scope', async (t) => {
  let get: () => Promise<LibrarySnapshot> = async () => snapshot(2);
  const request = (async () => get()) as LibraryRequest;
  const store = new LibraryStore(request, libraryPort());
  t.after(store.dispose);
  store.configure(true, true, 'first', []);
  await flush();
  assert.equal(store.getSnapshot().snapshot?.revision, 2);
  store.receive(snapshot(4));
  store.receive(snapshot(3));
  assert.equal(store.getSnapshot().snapshot?.revision, 4);
  let resolve!: (value: LibrarySnapshot) => void;
  get = () =>
    new Promise((done) => {
      resolve = done;
    });
  const stale = store.refresh();
  get = async () => snapshot(1);
  store.configure(true, true, 'second', []);
  await flush();
  resolve(snapshot(99));
  await stale;
  assert.equal(store.getSnapshot().snapshot?.revision, 1);
  get = async () => snapshot(0);
  await store.refresh();
  assert.equal(store.getSnapshot().snapshot?.revision, 1);
  assert.ok(Object.isFrozen(store.getSnapshot().snapshot));
  store.configure(true, false, 'second', []);
  store.receive(snapshot(100));
  assert.equal(store.getSnapshot().snapshot, undefined);
});

test('claimed cancellation outcomes keep reconciling without resubmitting the native selection', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let state: SelectionState = 'unknown';
  let commits = 0;
  let finishes = 0;
  const port = libraryPort();
  port.commitSelection = async (_id, selectionId) => {
    commits++;
    return { state: 'unknown', selectionId };
  };
  const request = (async (method: string) => {
    if (method === 'library.prepare') return { selectionId: 'selection' };
    if (method === 'library.finish') {
      finishes++;
      return { state, snapshot: snapshot(finishes) };
    }
    return snapshot(0);
  }) as LibraryRequest;
  const store = new LibraryStore(request, port);
  t.after(store.dispose);
  store.configure(true, true, 'viewer', ['chooser']);
  await store.select('chooser', ['entry']);
  assert.equal(await store.cancelSelection('chooser'), 'unknown');
  assert.equal(store.getSnapshot().cancellations.chooser, 'unknown');
  assert.equal(store.getSnapshot().checkouts.chooser.state, 'unknown');
  store.configure(true, true, 'viewer', []);
  state = 'selected';
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(store.getSnapshot().checkouts.chooser.state, 'selected');
  assert.equal(commits, 1);
  assert.ok(finishes >= 3);
});

test('selected cancellation still finishes the library checkout', async (t) => {
  let selected = false;
  const port = libraryPort();
  port.cancelSelection = async () => {
    selected = true;
    return { state: 'selected' };
  };
  const request = (async (method: string) => {
    if (method === 'library.prepare') return { selectionId: 'selection' };
    if (method === 'library.finish')
      return { state: selected ? 'selected' : 'unknown', snapshot: snapshot(selected ? 2 : 1) };
    return snapshot(0);
  }) as LibraryRequest;
  const store = new LibraryStore(request, port);
  t.after(store.dispose);
  store.configure(true, true, 'viewer', ['chooser']);
  await store.select('chooser', ['entry']);
  assert.equal(await store.cancelSelection('chooser'), 'selected');
  assert.equal(store.getSnapshot().cancellations.chooser, 'selected');
  assert.equal(store.getSnapshot().checkouts.chooser.state, 'selected');
  assert.equal(store.getSnapshot().snapshot?.revision, 2);
});

test('basket mutations record file usage only after a successful addition in the owning window', async (t) => {
  let current = snapshot(0);
  const usage: unknown[] = [];
  const request = (async (method: string, params: unknown) => {
    if (method === 'usage.record') {
      usage.push(params);
      return {};
    }
    if (method === 'library.basket') {
      const ids = (params as { ids: string[] }).ids;
      if (ids.includes('fail')) throw new RemoteKitError('conflict', 'changed');
      current = { ...current, revision: current.revision + 1, basket: ids };
    }
    return current;
  }) as LibraryRequest;
  const store = new LibraryStore(request, libraryPort());
  t.after(store.dispose);
  store.configure(true, true, 'viewer', []);
  await flush();
  await store.mutate(
    'library.basket',
    { operationId: 'one', expectedRevision: 0, ids: ['a'] },
    'files-window',
  );
  await store.mutate(
    'library.basket',
    { operationId: 'two', expectedRevision: 1, ids: ['a', 'b'] },
    'browser-window',
  );
  await store.mutate(
    'library.basket',
    { operationId: 'three', expectedRevision: 2, ids: ['b', 'a'] },
    'files-window',
  );
  await assert.rejects(
    store.mutate(
      'library.basket',
      { operationId: 'four', expectedRevision: 3, ids: ['fail'] },
      'files-window',
    ),
  );
  assert.deepEqual(usage, [
    { item: 'file:a', windowId: 'files-window' },
    { item: 'file:b', windowId: 'browser-window' },
  ]);
});

test('upload admission distinguishes the file count and size limits', () => {
  const queue = new ImportQueue(
    { rpc: { uploadAsset: async () => asset }, mutate: async () => snapshot(1) },
    'library',
  );
  const origin = { kind: 'files' as const, channel: 'upload' as const, partitionId: null };
  assert.throws(
    () =>
      queue.enqueue(
        Array.from({ length: 65 }, () => new File(['a'], 'a.txt')),
        0,
        origin,
      ),
    /最多可添加 64 个文件/,
  );
  const oversized = new File(['a'], 'large.txt');
  Object.defineProperty(oversized, 'size', { value: 256 * 1024 * 1024 + 1 });
  assert.throws(() => queue.enqueue([oversized], 0, origin), /单个文件不能超过 256 MiB/);
  queue.dispose();
});

test('Files uploads retain the selected partition and upload channel', async () => {
  const origins: unknown[] = [];
  const queue = new ImportQueue(
    {
      rpc: { uploadAsset: async () => asset },
      mutate: async (_method, params) => {
        origins.push(params.origin);
        return snapshot(1);
      },
    },
    'library',
  );
  queue.configure(true, 'viewer');
  const origin = { kind: 'files' as const, channel: 'upload' as const, partitionId: 'chosen' };
  queue.enqueue([new File(['a'], 'a.txt')], 0, origin);
  origin.partitionId = 'elsewhere';
  await flush();
  assert.deepEqual(origins, [{ kind: 'files', channel: 'upload', partitionId: 'chosen' }]);
  queue.dispose();
});

test('each queued batch captures its destination independently', async () => {
  const mutations: LibraryMethods['library.import']['params'][] = [];
  const queue = new ImportQueue(
    {
      rpc: { uploadAsset: async () => asset },
      mutate: async (_method, params) => {
        mutations.push(params);
        return snapshot(mutations.length);
      },
    },
    'library',
  );
  queue.configure(true, 'viewer-scope');
  const origin = {
    kind: 'files' as const,
    channel: 'upload' as const,
    partitionId: 'first' as string | null,
  };
  queue.enqueue([new File(['a'], 'first.txt'), new File(['b'], 'second.txt')], 0, origin);
  origin.partitionId = null;
  queue.enqueue([new File(['c'], 'third.txt')], 0, origin);
  origin.partitionId = 'elsewhere';
  await flush();
  assert.deepEqual(
    mutations.map((params) => params.origin),
    [
      { kind: 'files', channel: 'upload', partitionId: 'first' },
      { kind: 'files', channel: 'upload', partitionId: 'first' },
      { kind: 'files', channel: 'upload', partitionId: null },
    ],
  );
  assert.deepEqual(
    mutations.map((params) => params.destination),
    Array(3).fill('library'),
  );
  queue.dispose();
});

test('window disposal cancels every batch and ignores late uploads', async () => {
  let finish!: (value: Asset) => void;
  let signal!: AbortSignal;
  let mutations = 0;
  const queue = new ImportQueue(
    {
      rpc: {
        uploadAsset: async (_file, _id, current) => {
          signal = current;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      mutate: async () => {
        mutations++;
        return snapshot(1);
      },
    },
    'library',
  );
  queue.configure(true, 'viewer');
  queue.enqueue([new File(['a'], 'a.txt')], 0, { kind: 'files', channel: 'upload', partitionId: 'group' });
  queue.enqueue([new File(['b'], 'b.txt')], 0, { kind: 'files', channel: 'upload', partitionId: null });
  queue.dispose();
  assert(signal.aborted);
  assert.equal(queue.getSnapshot().remaining, 0);
  finish(asset);
  await flush();
  assert.equal(mutations, 0);
});

test('retry retains the failed job and destination when another batch is submitted', async () => {
  const mutations: LibraryMethods['library.import']['params'][] = [];
  const queue = new ImportQueue(
    {
      rpc: { uploadAsset: async () => asset },
      mutate: async (_method, params) => {
        mutations.push(params);
        if (mutations.length === 1) throw new RemoteKitError('outcome_unknown', 'lost reply');
        return snapshot(mutations.length);
      },
    },
    'library',
  );
  queue.configure(true, 'viewer');
  queue.enqueue([new File(['a'], 'a.txt')], 0, { kind: 'files', channel: 'upload', partitionId: 'group' });
  await flush();
  const error = queue.getSnapshot().error;
  queue.enqueue([new File(['b'], 'b.txt')], 0, { kind: 'files', channel: 'upload', partitionId: null });
  assert.equal(queue.getSnapshot().remaining, 2);
  assert.equal(queue.getSnapshot().error, error);
  await queue.upload();
  assert.equal(mutations[0].operationId, mutations[1].operationId);
  assert.deepEqual(mutations[0].origin, mutations[1].origin);
  assert.deepEqual(mutations[2].origin, { kind: 'files', channel: 'upload', partitionId: null });
  assert.equal(queue.getSnapshot().remaining, 0);
  queue.dispose();
});

test('import retry retains the sealed asset and operation identity after a lost mutation response', async () => {
  const uploads: string[] = [];
  const mutations: LibraryMethods['library.import']['params'][] = [];
  let loseReply = true;
  const queue = new ImportQueue(
    {
      rpc: {
        uploadAsset: async (_file, id) => {
          uploads.push(id);
          return asset;
        },
      },
      mutate: async (_method, params) => {
        mutations.push(params);
        if (loseReply) {
          loseReply = false;
          throw new RemoteKitError('outcome_unknown', 'lost reply');
        }
        return { ...snapshot(1), basket: ['anchor', 'first', 'second'] };
      },
    },
    'basket',
  );
  queue.configure(true, 'scope');
  queue.enqueue(
    [new File(['a'], 'a.png'), new File(['b'], 'b.png')],
    1,
    { kind: 'request', requestId: 'chooser' },
    'anchor',
  );
  await flush();
  assert.equal(queue.getSnapshot().remaining, 2);
  assert.ok(queue.getSnapshot().error);
  await queue.upload();
  assert.equal(queue.getSnapshot().remaining, 0);
  assert.equal(uploads.length, 2);
  assert.equal(mutations[0].operationId, mutations[1].operationId);
  assert.equal(mutations[2].afterId, 'first');
  assert.deepEqual(
    mutations.map((params) => params.origin),
    [
      { kind: 'request', requestId: 'chooser' },
      { kind: 'request', requestId: 'chooser' },
      { kind: 'request', requestId: 'chooser' },
    ],
  );
  queue.dispose();
});

test('import scope revocation aborts an upload and prevents its late mutation', async () => {
  let resolve!: (asset: Asset) => void;
  let signal!: AbortSignal;
  let mutations = 0;
  const queue = new ImportQueue(
    {
      rpc: {
        uploadAsset: async (_file, _id, current) => {
          signal = current;
          return new Promise((done) => {
            resolve = done;
          });
        },
      },
      mutate: async () => {
        mutations++;
        return snapshot(1);
      },
    },
    'library',
  );
  queue.configure(true, 'first');
  queue.enqueue([new File(['a'], 'a.png')], 0, { kind: 'files', channel: 'upload', partitionId: null });
  queue.configure(true, 'second');
  resolve(asset);
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(mutations, 0);
  assert.equal(queue.getSnapshot().remaining, 0);
  queue.dispose();
});

const burst: CapturedBurst = {
  frames: [
    { frameId: 'frame', blob: new Blob(['image']), preview: new Blob(['preview']), width: 1, height: 1 },
  ],
  decision: {
    selectedFrameId: 'frame',
    keepFrameIds: ['frame'],
    candidates: [],
    uncertain: false,
    stop: true,
    reason: 'quality',
  },
  stats: { samplingMs: 1, frameCount: 1, stopReason: 'quality', sourceWidth: 1, sourceHeight: 1 },
};

test('photo retry commits the same mutation without reuploading captured frames', async () => {
  let uploads = 0;
  const operations: string[] = [];
  const store = new PhotoJobStore({
    latestSnapshot: () => snapshot(0),
    rpc: {
      uploadAsset: async () => {
        uploads++;
        return asset;
      },
      processPhoto: async () => processed,
    },
    mutate: async (_method, params) => {
      operations.push(params.operationId);
      if (operations.length === 1) throw new RemoteKitError('outcome_unknown', 'lost reply');
      return snapshot(1);
    },
  });
  store.configure(true, 'viewer');
  const job = store.reserve(
    { destination: 'basket', origin: { kind: 'request', requestId: 'chooser' } },
    'photo',
  )!;
  store.capture(job.id, Promise.resolve(burst));
  await flush();
  assert.equal(store.getSnapshot()[0].state, 'error');
  store.retry(job.id);
  await flush();
  assert.deepEqual(operations, [job.id, job.id]);
  assert.equal(uploads, 1);
  assert.deepEqual(store.getSnapshot(), []);
  store.dispose();
});

test('photo scope reset ignores a late capture and publishes immutable job snapshots', async () => {
  let uploads = 0;
  const store = new PhotoJobStore({
    latestSnapshot: () => snapshot(0),
    rpc: {
      uploadAsset: async () => {
        uploads++;
        return asset;
      },
      processPhoto: async () => processed,
    },
    mutate: async () => snapshot(1),
  });
  store.configure(true, 'first');
  const insertion = { afterId: 'anchor' };
  const job = store.reserve(
    { destination: 'basket', origin: { kind: 'request', requestId: 'chooser' }, insertion },
    'photo',
  )!;
  assert.ok(Object.isFrozen(store.getSnapshot()[0].insertion));
  assert.equal(Object.isFrozen(insertion), false);
  let resolve!: (burst: CapturedBurst) => void;
  store.capture(
    job.id,
    new Promise((done) => {
      resolve = done;
    }),
  );
  store.configure(true, 'second');
  resolve(burst);
  await flush();
  assert.equal(job.signal.aborted, true);
  assert.equal(uploads, 0);
  assert.deepEqual(store.getSnapshot(), []);
  store.dispose();
});
