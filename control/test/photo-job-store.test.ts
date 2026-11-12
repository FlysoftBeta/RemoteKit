import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CapturedBurst } from '../client/files/camera-capture';
import type { FileChannel, ProcessedPhoto } from '../client/files/file-channel';
import { PhotoJobStore, type PhotoServices } from '../client/files/photo-job-store';
import { RemoteKitError } from '../shared/errors';
import type { LibraryFileEntry, LibraryMethods, LibrarySnapshot } from '../shared/file-library';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const originalId = 'a'.repeat(64);
const result: ProcessedPhoto = {
  assetId: 'b'.repeat(64),
  type: 'image/webp',
  size: 12,
  width: 4,
  height: 3,
  geometry: 'unchanged',
  quarterTurns: 0,
  orientation: 'none',
};
const burst: CapturedBurst = {
  frames: [
    {
      frameId: '1',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      preview: new Blob(),
      width: 4,
      height: 3,
    },
  ],
  decision: {
    selectedFrameId: '1',
    keepFrameIds: ['1'],
    candidates: [],
    uncertain: false,
    stop: true,
    reason: 'quality',
  },
  stats: { samplingMs: 1, frameCount: 1, stopReason: 'quality', sourceWidth: 4, sourceHeight: 3 },
};
const destination = {
  destination: 'basket' as const,
  origin: { kind: 'files' as const, channel: 'camera' as const, partitionId: null },
};
const entry: LibraryFileEntry = {
  kind: 'file',
  available: true,
  id: 'entry',
  assetId: 'c'.repeat(64),
  originalAssetId: originalId,
  name: 'receipt.webp',
  type: 'image/webp',
  size: 20,
  createdAt: 123,
  source: { app: 'files', channel: 'camera' },
  partitionId: null,
  collected: false,
  photo: { mode: 'scan', quarterTurns: 3 },
};

function fixture(t: TestContext, target?: LibraryFileEntry) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const snapshot: LibrarySnapshot = {
    revision: 7,
    entries: target ? [target] : [],
    basket: target ? [target.id] : [],
    partitions: [],
    sources: [],
    excludedSources: [],
    basketPartitionId: null,
  };
  const uploads: File[] = [];
  const calls: { source: string; mode: 'photo' | 'scan'; turns?: 0 | 1 | 2 | 3; signal?: AbortSignal }[] = [];
  const mutations: {
    method: string;
    params: LibraryMethods['library.import' | 'library.replace']['params'];
  }[] = [];
  let process: FileChannel['processPhoto'] = async (_id, _mode, turns) => ({
    ...result,
    quarterTurns: turns ?? 0,
  });
  const services: PhotoServices = {
    latestSnapshot: () => snapshot,
    rpc: {
      uploadAsset: async (file) => {
        uploads.push(file);
        return {
          assetId: uploads.length === 1 ? originalId : 'd'.repeat(64),
          type: file.type,
          size: file.size,
        };
      },
      processPhoto: (source, mode, turns, signal) => {
        calls.push({ source, mode, turns, signal });
        return process(source, mode, turns, signal);
      },
    },
    mutate: async (method, params) => {
      mutations.push({ method, params });
      return snapshot;
    },
  };
  const store = new PhotoJobStore(services);
  store.configure(true, 'viewer');
  t.after(store.dispose);
  return {
    store,
    snapshot,
    uploads,
    calls,
    mutations,
    setProcess: (next: FileChannel['processPhoto']) => {
      process = next;
    },
  };
}

for (const mode of ['photo', 'scan'] as const) {
  test(`${mode} processes the JPEG original and saves a WebP derivative with its applied turns`, async (t) => {
    const f = fixture(t);
    f.setProcess(async () => ({ ...result, quarterTurns: 2, orientation: 'text' }));
    const job = f.store.reserve(destination, mode)!;
    f.store.capture(job.id, Promise.resolve(burst));
    await flush();
    assert.equal(f.uploads[0].name, 'photo.jpg');
    assert.equal(f.uploads[0].type, 'image/jpeg');
    assert.deepEqual(
      f.calls.map(({ source, mode, turns }) => ({ source, mode, turns })),
      [{ source: originalId, mode, turns: undefined }],
    );
    assert.equal(f.mutations[0].method, 'library.import');
    const params = f.mutations[0].params as LibraryMethods['library.import']['params'];
    assert.equal(params.assetId, result.assetId);
    assert.equal(params.originalAssetId, originalId);
    assert.equal(params.name, `photo-${job.id}.webp`);
    assert.equal(params.photo?.quarterTurns, 2);
    assert.equal(params.photo?.mode, mode);
    assert.deepEqual(f.store.getSnapshot(), []);
  });
}

test('photo processing errors are retryable jobs and retry reuses the uploaded original', async (t) => {
  const f = fixture(t);
  f.setProcess(async () => {
    throw new RemoteKitError('unavailable', 'encoder busy');
  });
  const job = f.store.reserve(destination, 'photo')!;
  f.store.capture(job.id, Promise.resolve(burst));
  await flush();
  assert.equal(f.store.getSnapshot()[0].state, 'error');
  assert.equal(f.store.getSnapshot()[0].error?.code, 'unavailable');
  assert.equal(f.mutations.length, 0);
  f.setProcess(async () => result);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.mutations[0].params.originalAssetId, originalId);
  assert.equal('quarterTurns' in f.mutations[0].params.photo!, false);
});

test('scan failure saves a pending JPEG, releases its slot and resolves to a photo derivative after reload', async (t) => {
  const f = fixture(t);
  f.setProcess(async () => {
    throw new RemoteKitError('rejected', 'no document');
  });
  const job = f.store.reserve(destination, 'scan')!;
  f.store.capture(job.id, Promise.resolve(burst));
  await flush();
  assert.deepEqual(f.store.getSnapshot(), []);
  const saved = f.mutations[0].params as LibraryMethods['library.import']['params'];
  assert.equal(saved.assetId, originalId);
  assert.equal(saved.name, `photo-${job.id}.jpg`);
  assert.deepEqual(saved.photo, {
    mode: 'scan',
    pending: 'scan-error',
    processingFailure: {
      code: 'rejected',
      message: 'no document',
      reason: undefined,
      errorId: saved.photo!.processingFailure!.errorId,
    },
  });
  assert.match(saved.photo!.processingFailure!.errorId!, /^v-[0-9a-f]{10}$/);
  const pending: LibraryFileEntry = {
    ...entry,
    assetId: saved.assetId,
    type: 'image/jpeg',
    name: saved.name,
    originalAssetId: saved.originalAssetId,
    photo: saved.photo,
  };
  f.snapshot.entries = [pending];
  f.snapshot.basket = [pending.id];
  f.store.configure(true, 'reloaded');
  const next = f.store.reserve(destination, 'photo')!;
  assert.ok(next);
  f.store.cancel(next.id);
  f.setProcess(async () => result);
  f.store.resolve(pending, 'basket', originalId, true);
  await flush();
  assert.equal(f.calls[1].mode, 'photo');
  assert.equal(f.calls[1].turns, 0);
  assert.equal(f.mutations[1].method, 'library.replace');
  assert.equal(f.mutations[1].params.photo?.mode, 'photo');
  assert.equal(f.mutations[1].params.photo?.pending, undefined);
  assert.equal(f.mutations[1].params.assetId, result.assetId);
  assert.equal(f.mutations[1].params.originalAssetId, originalId);
});

test('uncertain bursts save a pending choice and resolving a persisted candidate saves its WebP and turns', async (t) => {
  const f = fixture(t);
  const job = f.store.reserve(destination, 'photo')!;
  f.store.capture(
    job.id,
    Promise.resolve({
      ...burst,
      frames: [...burst.frames, { ...burst.frames[0], frameId: '2' }],
      decision: {
        ...burst.decision,
        uncertain: true,
        keepFrameIds: ['1', '2'],
        candidates: [{ frameId: '2', score: 0.9 }],
      },
    }),
  );
  await flush();
  assert.deepEqual(f.store.getSnapshot(), []);
  assert.equal(f.calls.length, 0);
  assert.equal(f.mutations[0].method, 'library.import');
  const saved = f.mutations[0].params as LibraryMethods['library.import']['params'];
  assert.equal(saved.assetId, originalId);
  assert.equal(saved.name, `photo-${job.id}.jpg`);
  assert.deepEqual(saved.photo, {
    mode: 'photo',
    pending: 'choice',
    candidateAssetIds: [originalId, 'd'.repeat(64)],
  });
  assert.ok(f.uploads.every((file) => file.name === 'photo.jpg' && file.type === 'image/jpeg'));
  const pending: LibraryFileEntry = {
    ...entry,
    assetId: saved.assetId,
    type: 'image/jpeg',
    name: saved.name,
    originalAssetId: saved.originalAssetId,
    photo: saved.photo,
  };
  f.snapshot.entries = [pending];
  f.snapshot.basket = [pending.id];
  f.store.configure(true, 'reloaded');
  const alternative = pending.photo!.candidateAssetIds![1];
  f.setProcess(async () => ({ ...result, quarterTurns: 2 }));
  f.store.resolve(pending, 'basket', alternative);
  await flush();
  assert.equal(f.calls[0].source, alternative);
  assert.equal(f.mutations[1].method, 'library.replace');
  assert.equal(f.mutations[1].params.assetId, result.assetId);
  assert.equal(f.mutations[1].params.originalAssetId, alternative);
  assert.equal(f.mutations[1].params.photo?.quarterTurns, 2);
  assert.equal(f.mutations[1].params.photo?.pending, undefined);
  assert.equal(f.mutations[1].params.photo?.candidateAssetIds, undefined);
  assert.deepEqual(f.store.getSnapshot(), []);
});

test('retake scan failure remains a job and use original replaces with a photo derivative', async (t) => {
  const f = fixture(t, entry);
  f.setProcess(async () => {
    throw new RemoteKitError('rejected', 'no document');
  });
  const job = f.store.reserve({ ...destination, replace: entry }, 'scan')!;
  f.store.capture(job.id, Promise.resolve(burst));
  await flush();
  assert.equal(f.store.getSnapshot()[0].state, 'scan-error');
  assert.equal(f.mutations.length, 0);
  f.setProcess(async (_source, _mode, quarterTurns) => ({ ...result, quarterTurns: quarterTurns ?? 0 }));
  f.store.resolve(entry, 'basket', originalId, true, job.id);
  await flush();
  assert.equal(f.calls[1].mode, 'photo');
  assert.equal(f.mutations[0].method, 'library.replace');
  assert.equal(f.mutations[0].params.assetId, result.assetId);
  assert.equal(f.mutations[0].params.originalAssetId, originalId);
  assert.equal(f.mutations[0].params.photo?.pending, undefined);
});

test('uncertain retakes retain candidate jobs without changing the saved entry', async (t) => {
  const f = fixture(t, entry);
  const job = f.store.reserve({ ...destination, replace: entry }, 'photo')!;
  f.store.capture(
    job.id,
    Promise.resolve({
      ...burst,
      frames: [...burst.frames, { ...burst.frames[0], frameId: '2' }],
      decision: { ...burst.decision, uncertain: true, candidates: [{ frameId: '2', score: 0.9 }] },
    }),
  );
  await flush();
  assert.equal(f.store.getSnapshot()[0].state, 'choice');
  assert.equal(f.mutations.length, 0);
  const alternative = f.store.getSnapshot()[0].candidates![1];
  f.store.resolve(entry, 'basket', alternative, false, job.id);
  await flush();
  assert.equal(f.mutations[0].method, 'library.replace');
  assert.equal(f.mutations[0].params.originalAssetId, alternative);
});

test('rotation accumulates taps and debounces one absolute derivation from the original', async (t) => {
  const f = fixture(t, entry);
  f.store.rotate(entry, 'basket');
  t.mock.timers.tick(500);
  f.store.rotate(entry, 'basket');
  assert.equal(f.store.getSnapshot()[0].rotationTurns, 2);
  t.mock.timers.tick(599);
  await flush();
  assert.equal(f.calls.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].source, originalId);
  assert.equal(f.calls[0].mode, 'scan');
  assert.equal(f.calls[0].turns, 1);
  assert.equal(f.mutations[0].method, 'library.replace');
  const params = f.mutations[0].params as LibraryMethods['library.replace']['params'];
  assert.equal(params.entryId, entry.id);
  assert.equal(params.expectedRevision, 7);
  assert.equal(params.originalAssetId, originalId);
  assert.equal(params.photo?.quarterTurns, 1);
  assert.deepEqual(f.store.getSnapshot(), []);
});

test('a tap aborts in-flight rotation and restarts even before its late result arrives', async (t) => {
  const target = { ...entry, photo: { mode: 'photo' as const, quarterTurns: 2 as const } };
  const f = fixture(t, target);
  const pending: ((asset: ProcessedPhoto) => void)[] = [];
  f.setProcess(() => new Promise((resolve) => pending.push(resolve)));
  f.store.rotate(target, 'basket');
  t.mock.timers.tick(600);
  f.store.rotate(target, 'basket');
  assert.equal(f.calls[0].signal?.aborted, true);
  t.mock.timers.tick(600);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].turns, 0);
  pending[1](result);
  await flush();
  pending[0]({ ...result, quarterTurns: 3 });
  await flush();
  assert.equal(f.mutations.length, 1);
  assert.equal('quarterTurns' in f.mutations[0].params.photo!, false);
  assert.deepEqual(f.store.getSnapshot(), []);
});

test('four taps cancel a no-op rotation without a request and cancel reverts feedback', async (t) => {
  const f = fixture(t, entry);
  for (let tap = 0; tap < 4; tap++) f.store.rotate(entry, 'basket');
  assert.deepEqual(f.store.getSnapshot(), []);
  t.mock.timers.tick(600);
  assert.equal(f.calls.length, 0);
  f.store.rotate(entry, 'basket');
  f.store.cancel(f.store.getSnapshot()[0].id);
  assert.deepEqual(f.store.getSnapshot(), []);
  t.mock.timers.tick(600);
  assert.equal(f.calls.length, 0);
});

test('rotation failures use retry and cancel and keep the original source', async (t) => {
  const target = { ...entry, originalAssetId: undefined };
  const f = fixture(t, target);
  f.setProcess(async () => {
    throw new RemoteKitError('unavailable', 'busy');
  });
  f.store.rotate(target, 'library');
  t.mock.timers.tick(600);
  await flush();
  const job = f.store.getSnapshot()[0];
  assert.equal(job.state, 'error');
  assert.equal(job.error?.code, 'unavailable');
  assert.equal(job.rotationTurns, 1);
  f.setProcess(async () => result);
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(f.calls.every((call) => call.source === target.assetId && call.turns === 0));
  assert.equal(f.mutations[0].params.originalAssetId, target.assetId);
});

test('returning to the current turns aborts an active rotation and ignores its late result', async (t) => {
  const f = fixture(t, entry);
  let resolve!: (asset: ProcessedPhoto) => void;
  f.setProcess(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.store.rotate(entry, 'basket');
  t.mock.timers.tick(600);
  for (let tap = 0; tap < 3; tap++) f.store.rotate(entry, 'basket');
  assert.equal(f.calls[0].signal?.aborted, true);
  assert.deepEqual(f.store.getSnapshot(), []);
  t.mock.timers.tick(600);
  resolve(result);
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.mutations.length, 0);
});

test('use original preserves the displayed orientation while switching a scan to photo mode', async (t) => {
  const f = fixture(t, entry);
  f.store.resolve(entry, 'basket', originalId, true);
  await flush();
  assert.equal(f.calls[0].source, originalId);
  assert.equal(f.calls[0].mode, 'photo');
  assert.equal(f.calls[0].turns, 3);
  assert.equal(f.mutations[0].params.photo?.quarterTurns, 3);
  assert.equal(f.mutations[0].params.photo?.mode, 'photo');
});
