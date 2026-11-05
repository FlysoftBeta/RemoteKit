import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { BenchmarkMarkerReadback } from '../public/benchmark-marker-readback.js';
import { decodeMarker, drawMarker } from '../public/marker-codec.js';

function setup(options = {}) {
  const bitmaps: any[] = [],
    captures: any[] = [],
    timers = new Map<number, () => void>();
  let timer = 0,
    now = 0,
    worker: any,
    capture: any;
  const api: any = {
    performance: { now: () => ++now },
    setTimeout: (callback: () => void) => {
      timers.set(++timer, callback);
      return timer;
    },
    clearTimeout: (id: number) => timers.delete(id),
    Worker: class {
      onmessage: any;
      onerror: any;
      terminated = false;
      sent: any[] = [];
      constructor() {
        worker = this;
        queueMicrotask(() => this.onmessage({ data: { type: 'ready' } }));
      }
      postMessage(data: any, transfer: any[]) {
        assert.equal(data.bitmap, transfer[0]);
        this.sent.push(data);
      }
      terminate() {
        this.terminated = true;
      }
    },
    createImageBitmap: (...args: any[]) => {
      captures.push(args);
      const bitmap = {
        closed: 0,
        close() {
          ++this.closed;
        },
      };
      bitmaps.push(bitmap);
      return capture ? capture(bitmap) : Promise.resolve(bitmap);
    },
  };
  const reader = new BenchmarkMarkerReadback({ api, ...options });
  return {
    reader,
    api,
    captures,
    bitmaps,
    timers,
    get worker() {
      return worker;
    },
    setCapture(fn: any) {
      capture = fn;
    },
  };
}
const rect = { x: 0, y: 0, width: 256, height: 112 };

test('fractional displayed ROI is normalized in the paint stack before taking its immutable bitmap', async () => {
  const s = setup(),
    draws: any[] = [];
  let normalized: any;
  s.api.OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      normalized = this;
    }
    getContext() {
      return { drawImage: (...args: any[]) => draws.push(args) };
    }
  };
  await s.reader.start();
  const image = {},
    roi = { x: 40, y: 20, width: 256.5, height: 118.75 },
    identity = { rtp: 17, epoch: '2' };
  const job = s.reader.submit(image, roi, identity);
  assert.deepEqual(draws, [[image, 40, 20, 256.5, 118.75, 0, 0, 256, 112]]);
  assert.deepEqual(s.captures, [[normalized]]);
  await Promise.resolve();
  const sent = s.worker.sent[0];
  s.worker.onmessage({ data: { id: sent.id, marker: { frameId: 3 }, bitmapClosed: true, costs: {} } });
  const result = await job;
  assert.deepEqual(result.sourceRect, roi);
  assert.deepEqual(result.identity, identity);
  s.reader.close();
});
test('snapshot is called in submission stack, preserves paint identity and closes worker ownership', async () => {
  const s = setup();
  await s.reader.start();
  const canvas = {},
    identity = { rtp: 42, epoch: '3', observedWall: 123, observedAt: 7 };
  const job = s.reader.submit(canvas, rect, identity);
  assert.deepEqual(s.captures, [[canvas, 0, 0, 256, 112]]);
  await Promise.resolve();
  const sent = s.worker.sent[0];
  s.worker.onmessage({
    data: { id: sent.id, marker: { frameId: 8 }, bitmapClosed: true, costs: { workerReadbackMs: 2 } },
  });
  const result = await job;
  assert.deepEqual(result.identity, identity);
  assert.deepEqual(result.sourceRect, rect);
  assert.equal(result.costs.workerReadbackMs, 2);
  assert.equal(s.reader.stats.bitmapTransferred, 1);
  assert.equal(s.reader.stats.bitmapClosedWorker, 1);
  assert.equal(s.timers.size, 0);
  s.reader.close();
  assert.equal(s.worker.terminated, true);
});
test('capacity overflow is an explicit failure; timeout rejects work and late bitmap is closed', async () => {
  const s = setup({ maxPending: 1 });
  await s.reader.start();
  let finish: any;
  s.setCapture(
    (bitmap: any) =>
      new Promise((resolve) => {
        finish = () => resolve(bitmap);
      }),
  );
  const first = s.reader.submit({}, rect, {});
  const rejected = assert.rejects(first, /timeout/);
  await assert.rejects(s.reader.submit({}, rect, {}), /capacity exceeded/);
  [...s.timers.values()][0]();
  await rejected;
  finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(s.bitmaps[0].closed, 1);
  assert.equal(s.reader.pending.size, 0);
  assert.equal(s.reader.stats.failed, 2);
  assert.equal(s.reader.stats.bitmapClosedMain, 1);
  assert.equal(s.worker.terminated, true);
});
test('transfer failure closes bitmap and cannot become a successful job', async () => {
  const s = setup();
  await s.reader.start();
  s.worker.postMessage = () => {
    throw new Error('transfer failed');
  };
  await assert.rejects(s.reader.submit({}, rect, {}), /transfer failed/);
  assert.equal(s.bitmaps[0].closed, 1);
  assert.equal(s.reader.stats.failed, 1);
  assert.equal(s.reader.pending.size, 0);
  s.reader.close();
});
test('worker decodes original CRC, clears previous pixels before transparent input, and closes every bitmap', () => {
  const pixels = { width: 256, height: 112, data: new Uint8ClampedArray(256 * 112 * 4) };
  const context = {
    fillStyle: '',
    fail: false,
    fillRect(x: number, y: number, width: number, height: number) {
      const rgb: Record<string, number[]> = {
        '#fff': [255, 255, 255],
        '#000': [0, 0, 0],
        '#00ffff': [0, 255, 255],
        '#ff00ff': [255, 0, 255],
      };
      for (let r = y; r < y + height; r++)
        for (let c = x; c < x + width; c++) pixels.data.set([...rgb[this.fillStyle], 255], (r * 256 + c) * 4);
    },
    clearRect(x: number, y: number, width: number, height: number) {
      assert.deepEqual([x, y, width, height], [0, 0, 256, 112]);
      pixels.data.fill(0);
    },
    drawImage(bitmap: { data: Uint8ClampedArray }) {
      // Model source-over: fully transparent pixels preserve the destination.
      for (let offset = 0; offset < pixels.data.length; offset += 4)
        if (bitmap.data[offset + 3]) pixels.data.set(bitmap.data.subarray(offset, offset + 4), offset);
    },
    getImageData() {
      if (this.fail) throw new Error('GPU read failed');
      return pixels;
    },
  };
  drawMarker(context as unknown as CanvasRenderingContext2D, 99, 12345, 42);
  const markerPixels = new Uint8ClampedArray(pixels.data);
  const messages: any[] = [],
    self: any = { postMessage: (message: any) => messages.push(message) };
  const code = fs
    .readFileSync(new URL('../public/benchmark-marker-worker.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/m, '');
  vm.runInNewContext(code, {
    self,
    performance,
    decodeMarker,
    MARKER_WIDTH: 256,
    MARKER_HEIGHT: 112,
    OffscreenCanvas: class {
      getContext() {
        return context;
      }
    },
  });
  let closed = 0;
  const bitmap = {
    width: 256,
    height: 112,
    data: markerPixels,
    close() {
      ++closed;
    },
  };
  self.onmessage({ data: { id: 1, bitmap } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[1].marker)), {
    frameId: 99,
    timestamp: 12345,
    stimulus: 42,
  });
  const transparentBitmap = { ...bitmap, data: new Uint8ClampedArray(markerPixels.length) };
  self.onmessage({ data: { id: 2, bitmap: transparentBitmap } });
  assert.equal(messages[2].marker, null);
  context.fail = true;
  self.onmessage({ data: { id: 3, bitmap } });
  assert.match(messages[3].error, /GPU read failed/);
  assert.equal(closed, 3);
  assert.equal(messages[3].bitmapClosed, true);
});
