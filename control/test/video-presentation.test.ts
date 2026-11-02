import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import { presentationBarrier, videoPlaneGeometry, VideoCompositorStats } from '../client/video-presentation';
import type { Layout, Surface } from '../client/types';

const first: Surface = { id: '1', session: 's', instance: 'i', document: 'd', focus: '0', x: 4, y: 4, width: 640, height: 480, deviceScaleFactor: 2, mediaScale: .5 };
const second: Surface = { ...first, id: '2', x: 648 };
const layout: Layout = { type: 'layout', generation: '12', epoch: '20', width: 1296, height: 488, views: [first, second] };
const key = { version: 1, barrierId: '10000000000000001', outputGeneration: '12', layoutEpoch: '20' };

function environment(t: TestContext, stableViewport = false) {
  let cleanup = () => {}; t.after(() => cleanup());
  class Element {
    style: any = { setProperty(name: string, value: unknown) { this[name] = value; } };
    parentElement: Element | null = null; isConnected = true; width = 0; height = 0;
    videoWidth = 1296; videoHeight = 488; srcObject: any;
    attributes = new Map<string, string>(); callback?: (at: number, metadata: any) => void;
    draws = 0; removed = false;
    constructor(readonly tag: string) {}
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    append(node: Element) { node.parentElement = this; }
    insertBefore(node: Element) { node.parentElement = this; }
    getBoundingClientRect() { return { left: 10, top: 20, width: 320, height: 180 }; }
    getContext() { return { drawImage: () => this.draws++ }; }
    requestVideoFrameCallback(callback: (at: number, metadata: any) => void) { this.callback = callback; return 1; }
    cancelVideoFrameCallback() { this.callback = undefined; }
    pause() {} play() { return Promise.resolve(); } remove() { this.removed = true; }
    frame(rtp: number | undefined, presentedFrames = 1) { this.callback?.(performance.now(), { rtpTimestamp: rtp, presentedFrames }); }
  }
  const videos: Element[] = [], rafs = new Map<number, FrameRequestCallback>(); let rafId = 0;
  const listeners = new Map<string, () => void>(), timers: (() => void)[] = [];
  const document = { visibilityState: 'visible', createElement(tag: string) { const node = new Element(tag); if (tag === 'video') videos.push(node); return node; }, addEventListener(name: string, callback: () => void) { listeners.set(name, callback); }, removeEventListener(name: string) { listeners.delete(name); } };
  const globals: Record<string, unknown> = { document, navigator: { userAgent: 'Chrome/89.0' },
    requestAnimationFrame: (cb: FrameRequestCallback) => { const id = ++rafId; rafs.set(id, cb); return id; }, cancelAnimationFrame: (id: number) => rafs.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} }, MediaStream: class { constructor(readonly tracks: unknown[]) {} },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  t.mock.method(globalThis, 'setTimeout', ((cb: () => void) => { timers.push(cb); return timers.length; }) as any);
  t.mock.method(globalThis, 'clearTimeout', (() => {}) as any);
  const transport = new RemoteTransport(), internal = transport as any;
  const track = { kind: 'video' }, sent: any[] = [];
  const channel: any = { readyState: 'open', bufferedAmount: 0, send: (value: string) => sent.push(JSON.parse(value)) };
  internal.peer = { close() {} }; internal.processorTrack = track;
  transport.setControlRpc(async () => ({})); internal.presentationBackend = 'pending'; internal.bindChannel(channel); channel.onopen();
  const message = (message: object) => channel.onmessage({ data: JSON.stringify(message) });
  message(layout);
  const ready = [false, false], canvases = [new Element('canvas'), new Element('canvas')];
  const removers = canvases.map((canvas, index) => {
    canvas.parentElement = new Element('section');
    const readyChanged = (value: boolean) => ready[index] = value;
    return stableViewport ? transport.registerViewport(layout.views[index].id, canvas as any, readyChanged) :
      transport.registerPlane({ view: layout.views[index], layoutEpoch: '20', layoutGeneration: '12' }, canvas as any, readyChanged);
  });
  const raf = () => { const pending = [...rafs.values()]; rafs.clear(); for (const callback of pending) callback(performance.now()); };
  const metadata = (rtpTimestamp: number, layoutEpoch = '20') => message({ type: 'frame', rtpTimestamp, layoutEpoch });
  cleanup = () => { for (const remove of removers) remove(); transport.disconnect(); };
  return { transport, internal, channel, track, sent, message, metadata, raf, ready, videos, canvases, timers, document, listeners };
}

test('video crop scales only atlas ROI against actual client bounds, including nonuniform resize', () => {
  assert.deepEqual(videoPlaneGeometry(second, layout, { width: 320, height: 180 }), { width: 648, height: 183, left: -324, top: -1.5 });
  assert.equal(videoPlaneGeometry({ ...first, x: 1290 }, layout, { width: 320, height: 180 }), undefined);
  assert.equal(presentationBarrier({ ...key, barrierId: 1 }), undefined);
  assert.deepEqual(presentationBarrier(key), key);
});

test('video FPS and feedback count compositor deltas rather than rVFC callback count', () => {
  const stats = new VideoCompositorStats(); stats.observe(0, 10, false); stats.observe(100, 15, true); stats.observe(200, 20, true);
  assert.deepEqual(stats.snapshot(200), { callbacks: 3, frames: 10, fps: 50 });
  stats.resetObservation(); stats.observe(1000, 100, false); stats.observe(1100, 105, true);
  assert.deepEqual(stats.snapshot(1100), { callbacks: 5, frames: 15, fps: 50 });
});

test('video negotiation hides across two rAF turns; only latest full barrier can ACK', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf();
  assert.equal(s.sent.some(message => message.type === 'presentation.ready'), false);
  s.message({ type: 'presentation.prepare', ...key, barrierId: '10000000000000002' }); s.raf();
  assert.equal(s.sent.some(message => message.type === 'presentation.ready'), false); s.raf();
  assert.deepEqual(s.sent.filter(message => message.type === 'presentation.ready'), [{ type: 'presentation.ready', ...key, barrierId: '10000000000000002' }]);
  assert.deepEqual(s.ready, [false, false]);
});

test('each video needs its own matched RTP before input, without canvas copies or extra tracks', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' }); s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const [a, b] = s.videos.slice(1); s.metadata(10); a.frame(10);
  assert.deepEqual(s.ready, [true, false]); assert.equal(s.internal.canInput('1'), true); assert.equal(s.internal.canInput('2'), false);
  b.frame(11); s.metadata(11); assert.deepEqual(s.ready, [true, false], 'late metadata alone cannot authorize a video');
  b.frame(11, 2); assert.deepEqual(s.ready, [true, true]);
  for (const video of [a, b]) {
    assert.deepEqual(video.srcObject.tracks, [s.track]); assert.equal((video as any).controls, false); assert.equal((video as any).disablePictureInPicture, true);
    assert.equal((video as any).disableRemotePlayback, true); assert.equal((video as any).muted, true); assert.equal((video as any).tabIndex, -1);
  }
  assert.equal(s.canvases.reduce((count, canvas) => count + canvas.draws, 0), 0);
  assert.equal(s.transport.presentationDiagnostics.rendering.atlasSnapshotCopies, 0);
  assert.equal(s.transport.presentationDiagnostics.processor.read, 0);
});

test('viewport focus-only layouts preserve media authorization and queued drag/wheel input', t => {
  const s = environment(t, true); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const video = s.videos[1]; s.metadata(10); video.frame(10);
  const initial = s.transport.layout!.views[0];
  s.transport.ensureInputFocus(initial);
  const request = s.sent.find(message => message.type === 'focus');
  assert.ok(request);
  assert.equal(s.transport.sendInput(initial, { type: 'mouse', action: 'down', x: 630, y: 30 }), true);
  // Endpoint publishes a fresh layout object while acknowledging focus. It
  // must not destroy the video or clear the down event waiting for its token.
  s.message({ ...layout, views: [{ ...first, focus: '1' }, { ...second }] });
  assert.equal(s.ready[0], true); assert.equal(s.videos.length, 3);
  assert.equal(video.removed, false); assert.ok(video.srcObject);
  s.message({ type: 'focus', ok: true, focusRequestId: request.focusRequestId, layoutEpoch: '20', token: { ...first, view: first.id, focus: '1' } });
  const current = s.transport.layout!.views[0];
  s.transport.ensureInputFocus(current);
  assert.equal(s.sent.filter(message => message.type === 'focus').length, 1, 'wheel does not refocus an established lease');
  for (const event of [{ type: 'mouse', action: 'move', x: 630, y: 250 }, { type: 'mouse', action: 'up', x: 630, y: 250 }, { type: 'wheel', x: 100, y: 100, dx: 0, dy: -120 }])
    assert.equal(s.transport.sendInput(current, event), true);
  assert.deepEqual(s.sent.filter(message => message.type === 'input').map(message => [message.event.type, message.event.action, message.focus]),
    [['mouse', 'down', '1'], ['mouse', 'move', '1'], ['mouse', 'up', '1'], ['wheel', undefined, '1']]);
});

test('viewport document and epoch changes retain video but require the new barrier and own RTP', t => {
  const s = environment(t, true); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const [a, b] = s.videos.slice(1); s.metadata(10); a.frame(10); b.frame(10);
  const next = { ...layout, epoch: '21', views: [{ ...first, document: 'new-document' }, { ...second }] };
  s.message(next); assert.deepEqual(s.ready, [false, false]); assert.equal(s.videos.length, 3);
  assert.equal(a.removed, false); assert.ok(a.srcObject);
  assert.equal(s.transport.sendInput(first, { type: 'wheel', dy: -120 }), false);
  s.metadata(11, '21'); a.frame(11); assert.deepEqual(s.ready, [false, false], 'RTP cannot bypass unacknowledged barrier');
  s.message({ type: 'presentation.prepare', ...key, barrierId: '10000000000000002', layoutEpoch: '21' }); s.raf(); s.raf();
  a.frame(10); assert.deepEqual(s.ready, [false, false], 'old-epoch callback remains rejected');
  a.frame(11); assert.deepEqual(s.ready, [true, false], 'the second video needs its own new-epoch callback');
  assert.equal(s.transport.sendInput(first, { type: 'wheel', dy: -120 }), false, 'old document input remains rejected');
  assert.equal(s.transport.sendInput(next.views[0], { type: 'wheel', dy: -120 }), true);
  b.frame(11); assert.deepEqual(s.ready, [true, true]);
});

test('viewport registrations survive RTC replacement while old receiver callbacks stay inert', t => {
  const s = environment(t, true); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const oldVideo = s.videos[1], oldCallback = oldVideo.callback!;
  s.metadata(10); oldVideo.frame(10); assert.equal(s.ready[0], true);
  s.transport.disconnect(); assert.deepEqual(s.ready, [false, false]); assert.equal(oldVideo.srcObject, null);
  const track = { kind: 'video', id: 'replacement' };
  s.internal.peer = { close() {} }; s.internal.processorTrack = track;
  s.internal.presentationBackend = 'pending'; s.internal.bindChannel(s.channel);
  s.message(layout); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const freshVideo = s.videos[3]; assert.deepEqual(freshVideo.srcObject.tracks, [track]);
  s.metadata(20); oldCallback(performance.now(), { rtpTimestamp: 20, presentedFrames: 1 });
  assert.deepEqual(s.ready, [false, false]);
  freshVideo.frame(20); assert.deepEqual(s.ready, [true, false]);
});

test('same-barrier late metadata retains authorized display; initial static miss schedules bounded fresh frames', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' }); s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const [a, b] = s.videos.slice(1); s.metadata(10); a.frame(10); a.frame(11, 6);
  assert.equal(s.ready[0], true); assert.equal(s.internal.canInput('1'), true); assert.equal(s.transport.getPresentedPlane('1', 10), undefined);
  b.frame(12); const before = s.timers.length; s.metadata(12);
  assert.equal(s.ready[1], false); assert.ok(s.timers.length >= before);
  for (let i = 1; i < 6; i++) s.timers[i]?.();
  assert.ok([...s.internal.videoPlanes.values()].every((plane: any) => plane.metadataRetries <= 3));
  b.frame(12, 3); assert.equal(s.ready[1], true);
  s.message({ ...layout, epoch: '21' }); assert.deepEqual(s.ready, [false, false]);
});

test('hidden pages hold ACK; returning visible requires two new turns; fallback hides before canvas mode', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' }); s.message({ type: 'presentation.prepare', ...key }); s.raf();
  s.document.visibilityState = 'hidden'; s.listeners.get('visibilitychange')!(); s.raf(); s.raf();
  assert.equal(s.sent.some(message => message.type === 'presentation.ready'), false);
  s.document.visibilityState = 'visible'; s.listeners.get('visibilitychange')!(); s.raf();
  assert.equal(s.sent.some(message => message.type === 'presentation.ready'), false); s.raf();
  s.metadata(10); s.videos[1].frame(10); assert.equal(s.ready[0], true);
  s.internal.fallbackPresentation('test-failure'); assert.deepEqual(s.ready, [false, false]);
  assert.equal(s.sent.some(message => message.type === 'media.presentation' && message.backend === 'canvas'), false);
  s.raf(); s.raf(); assert.equal(s.sent.some(message => message.type === 'media.presentation' && message.backend === 'canvas'), true);
});

test('canvas fallback survives visibility suspension and resumes only after two foreground turns', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.internal.fallbackPresentation('test-failure'); s.raf();
  const canvasModes = () => s.sent.filter(message => message.type === 'media.presentation' && message.backend === 'canvas');
  s.document.visibilityState = 'hidden'; s.listeners.get('visibilitychange')!(); s.raf(); s.raf();
  assert.equal(canvasModes().length, 0); assert.equal(s.videos[0].srcObject, undefined);
  s.document.visibilityState = 'visible'; s.listeners.get('visibilitychange')!(); s.raf();
  assert.equal(canvasModes().length, 0); assert.equal(s.videos[0].srcObject, undefined);
  s.raf(); assert.equal(canvasModes().length, 1); assert.deepEqual((s.videos[0].srcObject as any).tracks, [s.track]);
  s.raf(); assert.equal(canvasModes().length, 1, 'the pending action completes once');
});

test('late fallback play rejection cannot fail a replacement peer or attempt', async t => {
  const s = environment(t), receiver = s.videos[0];
  let rejectPlay: (error: Error) => void = () => {}, failed = 0;
  receiver.play = () => new Promise<void>((_resolve, reject) => { rejectPlay = reject; });
  s.internal.connectionFailed = () => { failed++; };
  s.internal.fallbackPresentation('test-failure'); s.raf(); s.raf();
  s.internal.attempt++; rejectPlay(new Error('old attempt')); await Promise.resolve();
  assert.equal(failed, 0);
  s.internal.fallbackPresentation('test-failure'); s.raf(); s.raf();
  s.internal.peer = { close() {} }; rejectPlay(new Error('old peer')); await Promise.resolve();
  assert.equal(failed, 0);
  s.internal.fallbackPresentation('test-failure'); s.raf(); s.raf();
  rejectPlay(new Error('current playback failure')); await Promise.resolve();
  assert.equal(failed, 1, 'a current playback rejection still fails the connection');
});
