import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  capturePhotoBurst,
  photoCoverCrop,
  type CaptureStats,
  type PhotoBurstDecision,
} from '../client/files/camera-capture';
import type { FileChannel } from '../client/files/file-channel';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function decision(selected: string, keep = [selected], stop = false, uncertain = false): PhotoBurstDecision {
  return {
    selectedFrameId: selected,
    keepFrameIds: keep,
    stop,
    uncertain,
    reason: 'test',
    candidates: keep.map((frameId, index) => ({ frameId, score: 1 - index * 0.01 })),
  };
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let time = 0;
  t.mock.method(performance, 'now', () => time);
  const tick = (ms: number) => {
    time += ms;
    t.mock.timers.tick(ms);
  };
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  let callbackId = 0,
    sourceFrame = 0;
  const video = {
    videoWidth: 4096,
    videoHeight: 3072,
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
      callbacks.set(++callbackId, callback);
      return callbackId;
    },
    cancelVideoFrameCallback(id: number) {
      callbacks.delete(id);
    },
  } as HTMLVideoElement;
  function frame(id: number, mediaTime = id / 30) {
    sourceFrame = id;
    const entries = [...callbacks.entries()];
    for (const [key, callback] of entries) {
      callbacks.delete(key);
      callback(time, { presentedFrames: id, mediaTime } as VideoFrameCallbackMetadata);
    }
  }
  const canvases: Canvas[] = [];
  const encodes: { width: number; height: number; type: string; source: number }[] = [];
  const sourceRects: number[][] = [];
  const heldPng: (() => void)[] = [];
  let holdPng = false;
  let peakPixels = 0;
  let peakOriginals = 0;
  class Canvas {
    width = 0;
    height = 0;
    source = 0;
    constructor() {
      canvases.push(this);
    }
    getContext() {
      return {
        drawImage: (source: unknown, ...rect: number[]) => {
          if (source === video) {
            this.source = sourceFrame;
            sourceRects.push(rect);
          } else {
            assert.ok(source instanceof Canvas);
            this.source = source.source;
          }
          const fullCanvases = canvases.filter((canvas) => canvas.width > 512 || canvas.height > 512);
          peakOriginals = Math.max(peakOriginals, fullCanvases.length);
          peakPixels = Math.max(
            peakPixels,
            fullCanvases.reduce((pixels, canvas) => pixels + canvas.width * canvas.height, 0),
          );
        },
      };
    }
    toBlob(callback: (blob: Blob) => void, type: string) {
      encodes.push({ width: this.width, height: this.height, type, source: this.source });
      const blob = new Blob([String(this.source)], { type });
      if (holdPng && type === 'image/png') heldPng.push(() => callback(blob));
      else callback(blob);
    }
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new Canvas() },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const released = () => canvases.every((canvas) => canvas.width === 1 && canvas.height === 1);
  const stats: CaptureStats[] = [];
  const previews: Blob[] = [];
  const options = {
    viewportWidth: 4,
    viewportHeight: 5,
    onSamplingEnd: (value: CaptureStats) => {
      stats.push(value);
    },
    onPreview: (blob: Blob) => {
      previews.push(blob);
    },
  };
  return {
    tick,
    frame,
    video,
    encodes,
    sourceRects,
    released,
    callbacks,
    stats,
    options,
    previews,
    heldPng,
    peakPixels: () => peakPixels,
    peakOriginals: () => peakOriginals,
    holdPng: () => {
      holdPng = true;
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function burstRpc(methods: {
  canSamplePhotoBurst?: () => boolean;
  beginPhotoBurst?: FileChannel['beginPhotoBurst'];
  samplePhotoBurst: FileChannel['samplePhotoBurst'];
  endPhotoBurst: FileChannel['endPhotoBurst'];
  cancelPhotoBurst?: FileChannel['cancelPhotoBurst'];
}) {
  return {
    canSamplePhotoBurst: () => true,
    beginPhotoBurst: async () => ({ burstId: 'burst' }),
    cancelPhotoBurst: async () => {},
    ...methods,
  } as FileChannel;
}

test('cover uses the centered source region, keeps small frames unscaled and caps output pixels', () => {
  assert.deepEqual(photoCoverCrop(1920, 1080, 1, 1), {
    x: 420,
    y: 0,
    cropWidth: 1080,
    cropHeight: 1080,
    width: 1080,
    height: 1080,
  });
  assert.deepEqual(photoCoverCrop(1080, 1920, 1, 1), {
    x: 0,
    y: 420,
    cropWidth: 1080,
    cropHeight: 1080,
    width: 1080,
    height: 1080,
  });
  const capped = photoCoverCrop(7680, 4320, 16, 9);
  assert.ok(capped.width * capped.height <= 8 * 1024 * 1024);
  assert.equal(capped.cropWidth, 7680);
  assert.equal(capped.cropHeight, 4320);
});

test('quality stops immediately, preserves scored frame identity and encodes only retained uncertain originals', async (t) => {
  const f = fixture(t);
  const samples: { ids: string[]; source: number }[] = [];
  let endIds: string[] | undefined;
  const rpc = burstRpc({
    async samplePhotoBurst(_, id, blob, ids) {
      samples.push({ ids, source: Number(await blob.text()) });
      assert.equal(blob.type, 'image/jpeg');
      if (id === '1') return decision(id);
      if (id === '2') return decision(id, [id, '1']);
      return decision(id, [id, '2'], true, true);
    },
    async endPhotoBurst(_, ids) {
      endIds = ids;
      return decision('3', ['3', '2'], true, true);
    },
  });
  f.holdPng();
  const run = capturePhotoBurst(f.video, new AbortController().signal, rpc, f.options);
  await flush();
  f.frame(11);
  await flush();
  f.tick(51);
  f.frame(11);
  f.frame(12);
  await flush();
  f.tick(52);
  f.frame(13, 12 / 30);
  f.frame(14);
  await flush();
  assert.deepEqual(f.stats, [
    { samplingMs: 103, frameCount: 3, stopReason: 'quality', sourceWidth: 4096, sourceHeight: 3072 },
  ]);
  assert.deepEqual(samples, [
    { ids: ['1'], source: 11 },
    { ids: ['1', '2'], source: 12 },
    { ids: ['1', '2', '3'], source: 14 },
  ]);
  assert.deepEqual(endIds, ['2', '3']);
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.previews.length, 1);
  assert.equal(f.peakOriginals(), 3);
  assert.ok(f.peakPixels() <= 3 * 8 * 1024 * 1024);
  const crop = photoCoverCrop(4096, 3072, 4, 5);
  assert.ok(
    f.sourceRects.every(
      (rect) =>
        rect[0] === crop.x && rect[1] === crop.y && rect[2] === crop.cropWidth && rect[3] === crop.cropHeight,
    ),
  );
  f.heldPng.shift()?.();
  await flush();
  f.heldPng.shift()?.();
  const result = await run;
  assert.deepEqual(
    await Promise.all(
      result.frames.map(async (frame) => [
        frame.frameId,
        await frame.blob.text(),
        await frame.preview.text(),
        frame.width,
        frame.height,
      ]),
    ),
    [
      ['3', '14', '14', crop.width, crop.height],
      ['2', '12', '12', crop.width, crop.height],
    ],
  );
  assert.deepEqual(
    f.encodes.filter((e) => e.type === 'image/png').map((e) => e.source),
    [14, 12],
  );
  assert.ok(
    f.encodes.filter((e) => e.type === 'image/jpeg').every((e) => Math.max(e.width, e.height) <= 512),
  );
  assert.ok(f.released());
});

test('deadline closes shutter during in-flight sample and skips source frames under backpressure', async (t) => {
  const f = fixture(t);
  const sample = deferred<PhotoBurstDecision>();
  let ready = false,
    samples = 0,
    ends = 0;
  const rpc = burstRpc({
    canSamplePhotoBurst: () => ready,
    samplePhotoBurst: () => {
      samples++;
      return sample.promise;
    },
    async endPhotoBurst(_, ids) {
      ends++;
      assert.deepEqual(ids, ['1']);
      return decision('1');
    },
  });
  const run = capturePhotoBurst(f.video, new AbortController().signal, rpc, f.options);
  await flush();
  f.frame(1);
  ready = true;
  f.tick(51);
  f.frame(2);
  await flush();
  f.tick(948);
  f.frame(3);
  assert.equal(samples, 1);
  assert.equal(f.stats.length, 0);
  f.tick(1);
  f.frame(4);
  assert.equal(f.stats.length, 1);
  assert.equal(f.stats[0].samplingMs, 1000);
  assert.equal(f.stats[0].stopReason, 'deadline');
  assert.equal(f.callbacks.size, 0);
  assert.equal(ends, 0);
  sample.resolve(decision('1', ['1'], true));
  const result = await run;
  assert.equal(ends, 1);
  assert.equal(f.stats.length, 1);
  assert.equal(await result.frames[0].blob.text(), '2');
  assert.ok(f.released());
});

test('absolute slots admit at most 20 frames and release dropped originals after each decision', async (t) => {
  const f = fixture(t);
  let latest = '';
  const rpc = burstRpc({
    async samplePhotoBurst(_, id, _blob, ids) {
      assert.deepEqual(ids, latest ? [latest, id] : [id]);
      latest = id;
      return decision(id);
    },
    async endPhotoBurst() {
      return decision(latest);
    },
  });
  const run = capturePhotoBurst(f.video, new AbortController().signal, rpc, f.options);
  await flush();
  for (let slot = 0; slot < 20; slot++) {
    f.frame(2 * slot + 1);
    await flush();
    f.tick(20);
    f.frame(2 * slot + 2);
    await flush();
    f.tick(30);
  }
  assert.equal((await run).stats.frameCount, 20);
  assert.equal(latest, '20');
  assert.equal(f.peakOriginals(), 2);
  assert.ok(f.released());
});

test('abort releases original canvases immediately while quality is pending', async (t) => {
  const f = fixture(t);
  const pending = deferred<PhotoBurstDecision>();
  const abort = new AbortController();
  let cancels = 0;
  const rpc = burstRpc({
    samplePhotoBurst: () => pending.promise,
    async endPhotoBurst() {
      throw new Error('aborted capture finalized');
    },
    async cancelPhotoBurst(id) {
      assert.equal(id, 'burst');
      cancels++;
    },
  });
  const run = capturePhotoBurst(f.video, abort.signal, rpc, f.options);
  await flush();
  f.frame(1);
  await flush();
  assert.equal(f.released(), false);
  abort.abort();
  assert.ok(f.released());
  await assert.rejects(run, { name: 'AbortError' });
  pending.resolve(decision('1', ['1'], true));
  await flush();
  assert.equal(cancels, 1);
  assert.equal(f.stats.length, 1);
  assert.equal(f.stats[0].stopReason, 'aborted');
  assert.equal(f.callbacks.size, 0);
  assert.ok(f.released());
});

test('a queued burst begin does not prevent the shutter from freezing a source frame', async (t) => {
  const f = fixture(t);
  const begin = deferred<{ burstId: string }>();
  const sampled: string[] = [];
  const rpc = burstRpc({
    beginPhotoBurst: () => begin.promise,
    canSamplePhotoBurst: () => false,
    async samplePhotoBurst(id, frameId, preview) {
      assert.equal(id, 'slow-begin');
      sampled.push(await preview.text());
      return decision(frameId, [frameId], true);
    },
    async endPhotoBurst() {
      return decision('1');
    },
  });
  const run = capturePhotoBurst(f.video, new AbortController().signal, rpc, f.options);
  f.frame(1);
  await flush();
  f.tick(1000);
  f.frame(2);
  assert.deepEqual(sampled, []);
  assert.equal(f.stats[0].frameCount, 1);
  assert.equal(f.stats[0].stopReason, 'deadline');
  begin.resolve({ burstId: 'slow-begin' });
  const result = await run;
  assert.deepEqual(sampled, ['1']);
  assert.equal(await result.frames[0].blob.text(), '1');
  assert.ok(f.released());
});
