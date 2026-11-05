import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteKitError } from '../shared/errors';
import type { Asset, LibrarySnapshot, SelectionState } from '../shared/file-library';
import type { CapturedBurst } from '../client/files/camera-capture';
import { ImportQueue } from '../client/files/import-queue';
import { LibraryStore, type LibraryRequest } from '../client/files/library-store';
import { PhotoJobStore } from '../client/files/photo-job-store';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const snapshot = (revision: number): LibrarySnapshot => ({ revision, entries: [], basket: [], groups: [] });
const asset: Asset = { assetId: 'asset', hash: 'hash', size: 1, type: 'image/png' };
function libraryPort() {
  return {
    photoThumbnail: async () => new Blob(),
    uploadAsset: async () => asset,
    processPhoto: async () => asset,
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
  await store.select('chooser', ['entry'], null);
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
  await store.select('chooser', ['entry'], null);
  assert.equal(await store.cancelSelection('chooser'), 'selected');
  assert.equal(store.getSnapshot().cancellations.chooser, 'selected');
  assert.equal(store.getSnapshot().checkouts.chooser.state, 'selected');
  assert.equal(store.getSnapshot().snapshot?.revision, 2);
});

test('import retry retains the sealed asset and operation identity after a lost mutation response', async () => {
  const uploads: string[] = [];
  const mutations: { operationId: string; afterId?: string }[] = [];
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
  queue.enqueue([new File(['a'], 'a.png'), new File(['b'], 'b.png')], 1, true, 'anchor');
  queue.choose('group');
  await flush();
  assert.equal(queue.getSnapshot().remaining, 2);
  assert.ok(queue.getSnapshot().error);
  await queue.upload();
  assert.equal(queue.getSnapshot().remaining, 0);
  assert.equal(uploads.length, 2);
  assert.equal(mutations[0].operationId, mutations[1].operationId);
  assert.equal(mutations[2].afterId, 'first');
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
  queue.enqueue([new File(['a'], 'a.png')], 0, false);
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
      processPhoto: async () => asset,
    },
    mutate: async (_method, params) => {
      operations.push(params.operationId);
      if (operations.length === 1) throw new RemoteKitError('outcome_unknown', 'lost reply');
      return snapshot(1);
    },
  });
  store.configure(true, 'viewer');
  const job = store.reserve({ destination: 'basket', groupId: null }, 'photo')!;
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
      processPhoto: async () => asset,
    },
    mutate: async () => snapshot(1),
  });
  store.configure(true, 'first');
  const insertion = { afterId: 'anchor' };
  const job = store.reserve({ destination: 'basket', groupId: null, insertion }, 'photo')!;
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
