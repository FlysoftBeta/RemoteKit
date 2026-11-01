import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import type { ProcessorVideoFrame, TrackProcessorConstructor } from '../client/track-processor';

class Canvas {
  width = 0; height = 0; isConnected = true; draws: unknown[][] = []; bitmap: unknown;
  getContext() { return { drawImage: (...args: unknown[]) => { this.draws.push(args); this.bitmap = (args[0] as any).bitmap ?? args[0]; } }; }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(t: test.TestContext) {
  const originals = ['document', 'MediaStreamTrackProcessor', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  let videoCallbacks = 0, nextRaf = 0;
  const rafs = new Map<number, FrameRequestCallback>();
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { rafs.set(++nextRaf, callback); return nextRaf; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => rafs.delete(id) });
  const raf = () => { const work = [...rafs.values()]; rafs.clear(); for (const callback of work) callback(performance.now()); };
  const video = { srcObject: null, pause() {}, requestVideoFrameCallback() { videoCallbacks++; return 1; }, cancelVideoFrameCallback() {} };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => tag === 'video' ? video : new Canvas() } });
  const readers: { resolve: (result: ReadableStreamReadResult<ProcessorVideoFrame>) => void; reject: (error: Error) => void; reads: number; cancelled: number; released: number }[] = [];
  const options: unknown[] = [];
  const Processor = class {
    totalFrames = 17; discardedFrames = 2;
    readable = { getReader: () => {
      const state = { resolve: (_result: ReadableStreamReadResult<ProcessorVideoFrame>) => {}, reject: (_error: Error) => {}, reads: 0, cancelled: 0, released: 0 }; readers.push(state);
      return { read: () => { state.reads++; return new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; }); }, cancel: async () => { state.cancelled++; }, releaseLock: () => { state.released++; } };
    } };
    constructor(value: unknown) { options.push(value); }
  } as unknown as TrackProcessorConstructor;
  Object.defineProperty(globalThis, 'MediaStreamTrackProcessor', { configurable: true, value: Processor });
  const transport = new RemoteTransport(); transport.frameSource = 'track-processor';
  const internal = transport as any; internal.activeFrameSource = 'track-processor';
  const peer = { close() {} }; internal.peer = peer;
  const sent: unknown[] = [], channel: any = { readyState: 'open', bufferedAmount: 0, send: (data: string) => sent.push(JSON.parse(data)) };
  internal.bindChannel(channel);
  const view = { id: '1', session: 's', instance: 'i', document: 'd', focus: '0', x: 0, y: 0, width: 640, height: 480, deviceScaleFactor: 1 };
  const layout = { type: 'layout', epoch: '1', generation: '1', width: 640, height: 480, views: [view] };
  const message = (data: object) => channel.onmessage({ data: JSON.stringify(data) }); message(layout);
  const canvas = new Canvas(), ready: boolean[] = [];
  transport.registerPlane({ view, layoutEpoch: '1', layoutGeneration: '1' }, canvas as any, value => ready.push(value));
  const start = () => internal.startProcessorPump(peer, { kind: 'video' });
  const metadata = (rtpTimestamp: number, layoutEpoch = '1') => message({ type: 'frame', rtpTimestamp, layoutEpoch });
  const frame = (rtpTimestamp: unknown, bitmap = `pixels-${rtpTimestamp}`) => {
    const state = { closed: 0, ownerClosed: 0 }; const value = { displayWidth: 640, displayHeight: 480, timestamp: 999, bitmap, metadata: () => ({ rtpTimestamp }), clone() { return { displayWidth: this.displayWidth, displayHeight: this.displayHeight, bitmap, close() { state.ownerClosed++; } }; }, close() { state.closed++; } };
    return { state, value: value as unknown as ProcessorVideoFrame };
  };
  return { transport, internal, video, options, readers, rafs, raf, canvas, view, layout, message, metadata, frame, start, videoCallbacks: () => videoCallbacks };
}

test('processor snapshots bind exact RTP including zero; late metadata cannot borrow newer pixels', async t => {
  const s = setup(t); s.start(); assert.equal(s.readers[0].reads, 1);
  assert.deepEqual(s.options, [{ track: { kind: 'video' }, maxBufferSize: 1 }]);
  const first = s.frame(0); s.readers[0].resolve({ done: false, value: first.value }); await flush(); s.raf();
  assert.equal(first.state.closed, 1); assert.equal(s.transport.displayReady, false); assert.equal(s.canvas.draws.length, 0);
  s.metadata(0); assert.equal(s.canvas.draws.length, 0); s.raf(); assert.equal(s.transport.presentedFrame?.rtpTimestamp, 0); assert.equal(s.canvas.bitmap, 'pixels-0');
  const second = s.frame(10), third = s.frame(11);
  s.readers[0].resolve({ done: false, value: second.value }); await flush(); s.raf();
  s.readers[0].resolve({ done: false, value: third.value }); await flush(); s.raf();
  s.metadata(10); assert.equal(s.transport.displayReady, true); assert.equal(s.canvas.bitmap, 'pixels-0');
  assert.equal(s.transport.sendInput(s.view, { type: 'mouse' }), true);
  s.metadata(11); s.raf(); assert.equal(s.canvas.bitmap, 'pixels-11'); assert.equal(s.transport.presentedFrame?.rtpTimestamp, 11);
  assert.equal(second.state.closed, 1); assert.equal(third.state.closed, 1);
  assert.equal(s.video.srcObject, null); assert.equal(s.videoCallbacks(), 0);
  assert.equal(s.transport.presentationDiagnostics.processor.read, 3); assert.equal(s.transport.presentationDiagnostics.processor.total, 17);
  assert.equal(s.transport.presentationDiagnostics.processor.discarded, 2); assert.equal(s.transport.presentationDiagnostics.rawRvfcCount, 0);
});

test('a cancelled source closes its late frame and releases its reader without painting into its replacement', async t => {
  const s = setup(t); s.start(); const old = s.readers[0]; s.start(); const fresh = s.readers[1];
  s.metadata(8); const stale = s.frame(8, 'old'), current = s.frame(8, 'new');
  old.resolve({ done: false, value: stale.value }); await flush(); s.raf();
  assert.equal(old.cancelled, 1); assert.equal(old.released, 1); assert.equal(stale.state.closed, 1); assert.equal(s.canvas.draws.length, 0);
  fresh.resolve({ done: false, value: current.value }); await flush(); s.raf(); assert.equal(s.canvas.bitmap, 'new');
  s.transport.disconnect(); const afterClose = s.frame(9); fresh.resolve({ done: false, value: afterClose.value }); await flush(); s.raf();
  assert.equal(fresh.cancelled, 1); assert.equal(fresh.released, 1); assert.equal(afterClose.state.closed, 1); assert.equal(s.canvas.draws.length, 1); assert.equal(s.transport.displayReady, false);
});

for (const rtp of [undefined, -1, 0x100000000, 1.5, NaN]) test(`invalid processor RTP ${rtp} pauses input and closes the frame without fallback`, async t => {
  const s = setup(t); s.start(); s.metadata(7); const good = s.frame(7); s.readers[0].resolve({ done: false, value: good.value }); await flush(); s.raf();
  const bad = s.frame(rtp); s.readers[0].resolve({ done: false, value: bad.value }); await flush(); s.raf();
  assert.equal(bad.state.closed, 1); assert.equal(s.canvas.draws.length, 1); assert.equal(s.transport.displayReady, false); assert.equal(s.transport.sendInput(s.view, { type: 'mouse' }), false);
  assert.match(s.transport.diagnostics.error!, /rtpTimestamp/); assert.equal(s.readers[0].cancelled, 1); assert.equal(s.readers[0].released, 1); assert.equal(s.videoCallbacks(), 0);
});

test('processor metadata and canvas failures close frames and invalidate pending authorization', async t => {
  const s = setup(t); s.start(); const frame = s.frame(1); frame.value.metadata = () => { throw new Error('metadata unavailable'); };
  s.readers[0].resolve({ done: false, value: frame.value }); await flush(); s.raf();
  assert.equal(frame.state.closed, 1); assert.equal(s.transport.displayReady, false); assert.match(s.transport.diagnostics.error!, /metadata unavailable/);
  s.start(); const next = s.frame(2); s.internal.pendingFrame.getContext = () => ({ drawImage() { throw new Error('canvas failed'); } });
  s.readers[1].resolve({ done: false, value: next.value }); await flush(); s.raf(); s.metadata(2);
  assert.equal(next.state.closed, 1); assert.equal(s.transport.displayReady, false); assert.match(s.transport.diagnostics.error!, /canvas failed/);
});

test('processor read failure, absent API, and direct-mode combination are explicit errors', async t => {
  const s = setup(t); s.start(); s.readers[0].reject(new Error('reader failed')); await flush(); s.raf();
  assert.equal(s.readers[0].released, 1); assert.match(s.transport.diagnostics.error!, /reader failed/);
  s.transport.presentationMode = 'single-plane-direct'; s.start(); assert.match(s.transport.diagnostics.error!, /snapshot/); assert.equal(s.readers.length, 1);
  s.transport.presentationMode = 'snapshot'; Reflect.deleteProperty(globalThis, 'MediaStreamTrackProcessor'); s.start();
  assert.match(s.transport.diagnostics.error!, /MediaStreamTrackProcessor/); assert.equal(s.videoCallbacks(), 0);
});


test('processor feedback omits DOM video counters while preserving plane sampling', async t => {
  const s = setup(t); s.start(); s.internal.renderers.clear();
  let sampled: any;
  s.internal.mediaFeedback.sample = (value: unknown) => { sampled = value; };
  s.internal.videoPresentedFrames = 100;
  s.internal.peer.getStats = async () => new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 120, timestamp: 1000, bytesReceived: 3000 }]]);
  await s.internal.readStats(s.internal.peer);
  assert.equal('videoFrames' in sampled, false); assert.equal(sampled.decodedFrames, 120); assert.deepEqual(sampled.planes, []);
});

test('processor layout epochs and decoded dimensions continue to gate plane painting and input', async t => {
  const s = setup(t); s.start(); s.metadata(1); const first = s.frame(1); s.readers[0].resolve({ done: false, value: first.value }); await flush(); s.raf();
  s.message({ ...s.layout, epoch: '2' });
  const wrongEpoch = s.frame(2); s.metadata(2, '1'); s.readers[0].resolve({ done: false, value: wrongEpoch.value }); await flush(); s.raf();
  assert.equal(s.canvas.draws.length, 1); assert.equal(s.transport.sendInput(s.view, { type: 'mouse' }), false);
  const replacement = new Canvas(); s.transport.registerPlane({ view: s.view, layoutEpoch: '2', layoutGeneration: '1' }, replacement as any, () => {});
  const wrongSize = s.frame(3); Object.defineProperty(wrongSize.value, 'displayWidth', { value: 320 }); s.metadata(3, '2');
  s.readers[0].resolve({ done: false, value: wrongSize.value }); await flush(); s.raf(); assert.equal(replacement.draws.length, 0); assert.equal(wrongSize.state.closed, 1);
  const correct = s.frame(4); s.metadata(4, '2'); s.readers[0].resolve({ done: false, value: correct.value }); await flush(); s.raf();
  assert.equal(replacement.bitmap, 'pixels-4'); assert.equal(s.canvas.draws.length, 1); assert.equal(s.transport.diagnostics.videoWidth, 640);
  assert.equal(s.transport.sendInput(s.view, { type: 'mouse' }), true);
  const reads = s.readers[0].reads; await flush(); s.raf(); assert.equal(s.readers[0].reads, reads, 'static waiting has one pending read and no polling');
});

test('an ended processor stream releases its reader and leaves input disabled', async t => {
  const s = setup(t); s.start(); s.readers[0].resolve({ done: true, value: undefined }); await flush(); s.raf();
  assert.equal(s.readers[0].released, 1); assert.equal(s.readers[0].cancelled, 1); assert.equal(s.transport.displayReady, false);
  assert.match(s.transport.diagnostics.error!, /已结束/);
});

test('one RAF admits only the latest decoded owner and closes superseded owners before copying', async t => {
  const s = setup(t); s.start();
  const first = s.frame(10), latest = s.frame(11);
  s.metadata(10); s.metadata(11);
  s.readers[0].resolve({ done: false, value: first.value }); await flush();
  assert.equal(first.state.closed, 1); assert.equal(first.state.ownerClosed, 0);
  s.readers[0].resolve({ done: false, value: latest.value }); await flush();
  assert.equal(first.state.ownerClosed, 1); assert.equal(latest.state.closed, 1);
  assert.equal(s.rafs.size, 1); assert.equal(s.canvas.draws.length, 0);
  s.raf(); assert.equal(s.canvas.bitmap, 'pixels-11'); assert.equal(s.canvas.draws.length, 1); assert.equal(latest.state.ownerClosed, 1);
  const counts = s.transport.presentationDiagnostics.processor;
  assert.equal(counts.read, 2); assert.equal(counts.rafAdmitted, 1); assert.equal(counts.replaced, 1); assert.equal(counts.canvas, 1); assert.equal(counts.ownerClosed, 2);
  assert.equal(s.rafs.size, 0); s.raf(); s.metadata(11); assert.equal(s.rafs.size, 0); assert.equal(s.canvas.draws.length, 1);
});

test('disconnect before RAF releases the pending owner and cancels presentation', async t => {
  const s = setup(t); s.start(); s.metadata(1); const frame = s.frame(1);
  s.readers[0].resolve({ done: false, value: frame.value }); await flush();
  const cancelledCallback = [...s.rafs.values()][0]; assert.equal(s.rafs.size, 1);
  s.transport.disconnect(); assert.equal(s.rafs.size, 0); assert.equal(frame.state.ownerClosed, 1); assert.equal(frame.state.closed, 1);
  cancelledCallback(performance.now()); assert.equal(s.canvas.draws.length, 0); assert.equal(s.transport.displayReady, false);
});

test('late metadata authorizes its captured snapshot only at the next RAF and then goes idle', async t => {
  const s = setup(t); s.start(); const frame = s.frame(0);
  s.readers[0].resolve({ done: false, value: frame.value }); await flush(); s.raf();
  assert.equal(frame.state.ownerClosed, 1); assert.equal(s.rafs.size, 0); assert.equal(s.canvas.draws.length, 0);
  s.metadata(0); assert.equal(s.canvas.draws.length, 0); assert.equal(s.rafs.size, 1);
  s.raf(); assert.equal(s.canvas.bitmap, 'pixels-0'); assert.equal(s.canvas.draws.length, 1); assert.equal(s.rafs.size, 0);
  s.raf(); assert.equal(s.canvas.draws.length, 1); assert.equal(s.transport.presentationDiagnostics.processor.rafAdmitted, 1);
});

test('pending processor reads and unmatched metadata preserve only the actually painted input plane', async t => {
  const s = setup(t); s.start(); s.metadata(1); const first = s.frame(1);
  s.readers[0].resolve({ done: false, value: first.value }); await flush(); s.raf();
  const candidate = s.frame(2); s.readers[0].resolve({ done: false, value: candidate.value }); await flush();
  assert.equal(s.transport.presentedFrame?.rtpTimestamp, 1);
  assert.equal(s.transport.sendInput(s.view, { type: 'mouse' }), true, 'read before RAF retains painted input');
  s.raf(); assert.equal(s.transport.presentedFrame?.rtpTimestamp, 1);
  assert.equal(s.transport.sendInput(s.view, { type: 'mouse' }), true, 'snapshot without metadata retains painted input');
  s.metadata(2, '9'); s.raf(); assert.equal(s.transport.presentedFrame?.rtpTimestamp, 1);
  assert.equal(s.transport.sendInput(s.view, { type: 'mouse' }), true, 'unmatched candidate cannot revoke input');
  s.metadata(2); assert.equal(s.transport.presentedFrame?.rtpTimestamp, 1); s.raf();
  assert.equal(s.transport.presentedFrame?.rtpTimestamp, 2); assert.equal(s.canvas.bitmap, 'pixels-2');
  assert.equal(candidate.state.closed, 1); assert.equal(candidate.state.ownerClosed, 1);
  s.message({ ...s.layout, epoch: '2', generation: '2', width: 800 });
  assert.equal(s.transport.displayReady, false); assert.equal(s.transport.sendInput(s.view, { type: 'mouse' }), false, 'geometry epoch immediately revokes old input');
  const waiting = s.frame(3); s.readers[0].resolve({ done: false, value: waiting.value }); await flush();
  s.transport.disconnect(); assert.equal(waiting.state.closed, 1); assert.equal(waiting.state.ownerClosed, 1);
  s.raf(); assert.equal(s.transport.displayReady, false); assert.equal(s.canvas.bitmap, 'pixels-2');
});
