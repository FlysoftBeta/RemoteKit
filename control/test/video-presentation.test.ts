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
  transport.setControlRpc(async () => ({})); transport.observePeerAuthorization(1); transport.setProductLocked(false);
  internal.processorTrack = track; internal.presentationBackend = 'pending'; internal.bindChannel(channel); channel.onopen();
  const message = (message: object) => channel.onmessage({ data: JSON.stringify({ authEpoch: 1, ...message }) });
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

test('poll windows distinguish compositor submissions, callbacks and element drops across idle and hide', () => {
  const stats = new VideoCompositorStats();
  stats.observe(0, 10, false);
  assert.equal(stats.sampleWindow(100, true, { totalVideoFrames: 15, droppedVideoFrames: 3 }), undefined);
  stats.observe(1000, 55, true);
  assert.deepEqual(stats.sampleWindow(1100, true, { totalVideoFrames: 65, droppedVideoFrames: 8 }),
    { fps: 45, callbackFps: 1, videoElementFps: 50, videoElementDrops: 5 });
  assert.deepEqual(stats.sampleWindow(2100, true, { totalVideoFrames: 65, droppedVideoFrames: 8 }),
    { fps: 0, callbackFps: 0, videoElementFps: 0, videoElementDrops: 0 });
  stats.resetObservation();
  stats.observe(2400, 160, false);
  assert.equal(stats.sampleWindow(3100, true), undefined, 'a new visibility interval establishes its own baseline');
});

test('video timing reports only locally measured samples inside the observation window', () => {
  const stats = new VideoCompositorStats();
  stats.observe(0, 10, false);
  stats.observe(120, 11, true, { receiveTime: 50, presentationTime: 110, expectedDisplayTime: 130, processingDuration: .002 });
  stats.observe(250, 12, true, { presentationTime: 240, expectedDisplayTime: 245 });
  assert.deepEqual(stats.timing(250), {
    receiveToSubmit: { samples: 1, p95: 60 }, submitToCallback: { samples: 2, p95: 10 },
    expectedDisplayLateness: { samples: 2, p95: 5 }, processing: { samples: 1, p95: 2 },
  });
  assert.equal(stats.timing(1300).submitToCallback, undefined);
});

test('video negotiation hides across two rAF turns; only latest full barrier can ACK', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf();
  assert.equal(s.sent.some(message => message.type === 'presentation.ready'), false);
  s.message({ type: 'presentation.prepare', ...key, barrierId: '10000000000000002' }); s.raf();
  s.message({ type: 'presentation.prepare', ...key });
  assert.equal(s.sent.some(message => message.type === 'presentation.ready'), false); s.raf();
  assert.deepEqual(s.sent.filter(message => message.type === 'presentation.ready'), [{ type: 'presentation.ready', ...key, barrierId: '10000000000000002', authEpoch: 1 }]);
  assert.deepEqual(s.ready, [false, false]);
});

test('each video needs its own matched RTP before input, without canvas copies or extra tracks', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' }); s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const [a, b] = s.videos.slice(1); s.metadata(10); a.frame(10);
  assert.deepEqual(s.ready, [true, false]); assert.equal(s.internal.canInput('1'), true); assert.equal(s.internal.canInput('2'), false);
  s.metadata(11); assert.deepEqual(s.ready, [true, false], 'metadata without this element observation cannot authorize it');
  b.frame(11);
  b.frame(11, 2); assert.deepEqual(s.ready, [true, true]);
  for (const video of [a, b]) {
    assert.deepEqual(video.srcObject.tracks, [s.track]); assert.equal((video as any).controls, false); assert.equal((video as any).disablePictureInPicture, true);
    assert.equal((video as any).disableRemotePlayback, true); assert.equal((video as any).muted, true); assert.equal((video as any).tabIndex, -1);
  }
  assert.equal(s.canvases.reduce((count, canvas) => count + canvas.draws, 0), 0);
  assert.equal(s.transport.presentationDiagnostics.rendering.atlasSnapshotCopies, 0);
  assert.equal(s.transport.presentationDiagnostics.processor.read, 0);
});

test('video readback exposes both sampling axes while changed axes retire the old input plane', t => {
  const s = environment(t, true), adapted = { ...first, mediaScale: .495, mediaScaleX: .5, mediaScaleY: .495 };
  s.message({ ...layout, views: [adapted, second] });
  s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  s.metadata(10); s.videos[1].frame(10);
  const source = s.transport.getPresentedPlane('1', 10)!;
  assert.equal(source.pixelsPerDip, 1); assert.equal(source.pixelsPerDipY, .99);
  assert.deepEqual(source.sourceRect, { x: 4, y: 4, width: 640, height: 480 });
  assert.equal(s.transport.sendInput(first, { type: 'wheel', x: 10, y: 10, dy: -120 }), false);
  assert.equal(s.internal.canInput('1'), true);
});

test('duplicate layout/prepare transactions cannot starve hidden ACK or revoke ready videos', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  const repeat = () => { s.message(layout); s.message({ type: 'presentation.prepare', ...key }); };
  repeat();
  // Model repeated 4ms server polling between foreground compositor turns.
  for (let i = 0; i < 20; i++) repeat();
  s.raf();
  assert.equal(s.sent.some(message => message.type === 'presentation.ready'), false);
  for (let i = 0; i < 20; i++) repeat();
  s.raf();
  assert.deepEqual(s.sent.filter(message => message.type === 'presentation.ready'), [{ type: 'presentation.ready', ...key, authEpoch: 1 }]);
  s.metadata(10); s.videos[1].frame(10); s.videos[2].frame(10);
  assert.deepEqual(s.ready, [true, true]);
  for (let i = 0; i < 20; i++) repeat();
  s.raf(); s.raf();
  assert.deepEqual(s.ready, [true, true]);
  assert.equal(s.sent.filter(message => message.type === 'presentation.ready').length, 1);
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
  s.videos[2].frame(99);
  s.transport.disconnect(); assert.deepEqual(s.ready, [false, false]); assert.equal(oldVideo.srcObject, null);
  const track = { kind: 'video', id: 'replacement' };
  s.transport.observePeerAuthorization(1);
  s.transport.setProductLocked(false);
  s.internal.peer = { close() {} }; s.internal.processorTrack = track;
  s.internal.presentationBackend = 'pending'; s.internal.bindChannel(s.channel);
  s.message(layout); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const freshVideo = s.videos[3]; assert.deepEqual(freshVideo.srcObject.tracks, [track]);
  s.metadata(99); assert.deepEqual(s.ready, [false, false], 'old peer pending observation is retired');
  s.metadata(20); oldCallback(performance.now(), { rtpTimestamp: 20, presentedFrames: 1 });
  assert.deepEqual(s.ready, [false, false]);
  freshVideo.frame(20); assert.deepEqual(s.ready, [true, false]);
});

test('split to narrow retains hidden receivers without timing out current video; return requires own fresh frame', t => {
  const s = environment(t, true); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const [a, b] = s.videos.slice(1); s.metadata(10); a.frame(10); b.frame(10);
  const narrow = { ...layout, epoch: '21', views: [{ ...second }] };
  const narrowKey = { ...key, barrierId: '10000000000000002', layoutEpoch: '21' };
  s.message(narrow); s.message({ type: 'presentation.prepare', ...narrowKey }); s.raf(); s.raf();
  // A metadata refresh is already pending when this element's own frame arrives.
  s.metadata(11, '21'); const pendingTimer = s.timers[s.timers.length - 1]; b.frame(11);
  assert.deepEqual(s.ready, [false, true]);
  assert.equal(s.internal.canInput('1'), false); assert.equal(s.internal.canInput('2'), true);
  for (let retries = 0; retries < 4; retries++) {
    pendingTimer(); s.metadata(12 + retries, '21');
    s.internal.scheduleVideoMetadataRefresh();
  }
  assert.equal(s.internal.presentationBackend, 'video');
  assert.equal(s.internal.videoPlanes.size, 2); assert.equal(a.removed, false); assert.ok(a.srcObject);
  assert.equal([...s.internal.videoPlanes.values()][0].metadataRetries, 0);
  assert.equal(s.transport.presentationDiagnostics.rendering.atlasSnapshotCopies, 0);
  assert.equal(s.canvases.reduce((sum, canvas) => sum + canvas.draws, 0), 0);

  s.message({ ...layout, epoch: '22' }); s.metadata(20, '22'); a.frame(20); b.frame(20);
  assert.deepEqual(s.ready, [false, false], 'return cannot reuse prior barrier or current frames before ACK');
  s.message({ type: 'presentation.prepare', ...key, barrierId: '10000000000000003', layoutEpoch: '22' }); s.raf(); s.raf();
  b.frame(20); assert.deepEqual(s.ready, [false, true], 'another video cannot authorize returning Window');
  a.frame(10); assert.deepEqual(s.ready, [false, true], 'returning video rejects its old layout RTP');
  a.frame(20); assert.deepEqual(s.ready, [true, true]);
  assert.equal(s.videos.length, 3, 'layout changes retain both original video identities');
});

test('static late metadata recovers own layout and input without inventing current RTP or compositor samples', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' }); s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const [a, b] = s.videos.slice(1); s.metadata(10); a.frame(10); a.frame(11, 6);
  assert.equal(s.ready[0], true); assert.equal(s.internal.canInput('1'), true); assert.equal(s.transport.getPresentedPlane('1', 10), undefined);
  let reported = 0; s.transport.subscribePresentedFrames(() => reported++);
  const paints: any[] = []; s.internal.latency.paint = (...values: any[]) => paints.push(values);
  b.frame(12); const plane = [...s.internal.videoPlanes.values()][1] as any;
  const observation = plane.pendingObservation, callbacks = plane.stats.callbacks, frames = plane.stats.frames;
  s.metadata(12);
  assert.equal(s.ready[1], true); assert.equal(s.internal.canInput('2'), true);
  assert.equal(s.transport.sendInput(second, { type: 'wheel', dy: -120 }), true);
  assert.equal(s.sent[s.sent.length - 1].type, 'input'); assert.equal(reported, 0);
  assert.equal(s.transport.getPresentedPlane('2', 12), undefined); assert.equal(s.transport.getLastPresentation('2'), undefined);
  assert.equal(plane.stats.callbacks, callbacks); assert.equal(plane.stats.frames, frames);
  assert.deepEqual(paints, [[12, '20', observation.at, observation.wall]]);
  for (let rtp = 13; rtp < 18; rtp++) { b.frame(rtp, rtp); s.metadata(rtp); assert.equal(s.ready[1], true); }
  assert.equal(reported, 0, 'continuous metadata-late frames do not emit fabricated compositor events');
  s.message({ ...layout, epoch: '21' }); assert.deepEqual(s.ready, [false, false]);
});

test('latest own observation wins; old candidate, hidden and replacement barriers cannot authorize', t => {
  const s = environment(t, true); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const [a, b] = s.videos.slice(1);
  a.frame(30); a.frame(31); s.metadata(30); assert.deepEqual(s.ready, [false, false]);
  s.metadata(31); assert.deepEqual(s.ready, [true, false]);
  b.frame(32); s.document.visibilityState = 'hidden'; s.listeners.get('visibilitychange')!();
  s.metadata(32); assert.deepEqual(s.ready, [false, false]);
  s.document.visibilityState = 'visible'; s.listeners.get('visibilitychange')!(); s.metadata(32);
  assert.deepEqual(s.ready, [false, false], 'foreground requires a fresh own observation');
  a.frame(33); s.message({ type: 'presentation.prepare', ...key, barrierId: '10000000000000002' });
  s.raf(); s.raf(); s.metadata(33); assert.deepEqual(s.ready, [false, false]);
  a.frame(34); s.message({ ...layout, epoch: '21', generation: '13' }); s.metadata(34);
  assert.deepEqual(s.ready, [false, false]);
});

test('unmatched static observations have a bounded explicit canvas fallback without RTC replacement', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  const peer = s.internal.peer; s.videos[1].frame(80);
  for (let retries = 0; retries < 4; retries++) s.timers[s.timers.length - 1]!();
  assert.equal(s.internal.presentationBackend, 'canvas'); assert.equal(s.internal.peer, peer);
  assert.equal(s.transport.presentationDiagnostics.rendering.backendReason, 'video-frame-metadata-timeout');
  assert.equal(s.transport.presentationDiagnostics.rendering.presentationFallbackReason, 'video-frame-metadata-timeout');
  assert.equal(s.transport.presentationDiagnostics.rendering.canvasBackendReason, 'chrome89-compatible-2d');
  assert.deepEqual(s.ready, [false, false]); s.raf(); s.raf();
  assert.equal(s.sent.some(message => message.type === 'media.presentation' && message.backend === 'canvas'), true);
});

test('presentation fallback preserves the first cause independently of the canvas backend', t => {
  const s = environment(t);
  s.internal.fallbackPresentation('video-playback-failed');
  s.internal.fallbackPresentation('invalid-presentation-mode');
  const rendering = s.transport.presentationDiagnostics.rendering;
  assert.equal(rendering.backendReason, 'video-playback-failed');
  assert.equal(rendering.presentationFallbackReason, 'video-playback-failed');
  assert.equal(rendering.canvasBackendReason, 'chrome89-compatible-2d');
  s.transport.disconnect();
  assert.equal(s.transport.presentationDiagnostics.rendering.presentationFallbackReason, undefined);
});

test('hidden time at the metadata retry edge cannot cause canvas fallback; resume starts a fresh budget', t => {
  const s = environment(t); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.raf(); s.raf();
  s.videos[1].frame(80);
  for (let retries = 0; retries < 3; retries++) s.timers[s.internal.videoMetadataRefreshTimer - 1]();
  s.document.visibilityState = 'hidden'; s.listeners.get('visibilitychange')!();
  for (let tick = 0; tick < 5; tick++) {
    const timer = s.internal.videoMetadataRefreshTimer;
    if (timer !== undefined) s.timers[timer - 1]();
  }
  assert.equal(s.internal.presentationBackend, 'video');
  assert.equal(s.internal.videoMetadataRefreshTimer, undefined);
  assert.equal([...s.internal.videoPlanes.values()].every((plane: any) => plane.metadataRetries === 0), true);
  s.document.visibilityState = 'visible'; s.listeners.get('visibilitychange')!();
  assert.deepEqual(s.ready, [false, false], 'foreground cannot authorize retained pixels');
  assert.notEqual(s.internal.videoMetadataRefreshTimer, undefined);
  for (let retries = 0; retries < 3; retries++) {
    s.timers[s.internal.videoMetadataRefreshTimer - 1]();
    assert.equal(s.internal.presentationBackend, 'video');
  }
  s.timers[s.internal.videoMetadataRefreshTimer - 1]();
  assert.equal(s.internal.presentationFallbackReason, 'video-frame-metadata-timeout');
});

test('metadata watchdog waits for the current barrier ACK and positive client bounds', t => {
  const s = environment(t, true); s.message({ type: 'presentation.mode', version: 1, backend: 'video' });
  s.message({ type: 'presentation.prepare', ...key }); s.metadata(80);
  assert.equal(s.internal.videoMetadataRefreshTimer, undefined, 'pending hide/ACK is not a metadata failure');
  s.raf(); assert.equal(s.internal.videoMetadataRefreshTimer, undefined);
  s.raf(); assert.notEqual(s.internal.videoMetadataRefreshTimer, undefined);
  const next = { ...layout, epoch: '21' };
  s.message(next);
  assert.equal(s.internal.videoMetadataRefreshTimer, undefined, 'layout invalidation cancels the old budget');
  s.canvases.forEach(canvas => canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }));
  s.message({ type: 'presentation.prepare', ...key, barrierId: '10000000000000002', layoutEpoch: '21' });
  s.raf(); s.raf(); s.metadata(81, '21');
  assert.equal(s.internal.videoMetadataRefreshTimer, undefined, 'zero client area cannot consume retries');
  s.canvases.forEach(canvas => canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 180 }));
  s.internal.scheduleVideoMetadataRefresh();
  assert.notEqual(s.internal.videoMetadataRefreshTimer, undefined, 'restored bounds resume bounded observation');
  s.videos[1].frame(80); assert.deepEqual(s.ready, [false, false], 'the old epoch stays blocked');
  s.videos[1].frame(81); assert.deepEqual(s.ready, [true, false]);
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

test('processor failure playback rejection is scoped to peer, attempt, receiver and track', async t => {
  const s = environment(t), receiver = s.videos[0];
  let rejectPlay: (error: Error) => void = () => {}, failed = 0;
  receiver.play = () => new Promise<void>((_resolve, reject) => { rejectPlay = reject; });
  s.internal.connectionFailed = () => { failed++; };
  const begin = () => { s.internal.receiverVideo = receiver; s.internal.processorFailed(new Error('processor failed')); };
  begin(); s.internal.attempt++; rejectPlay(new Error('old attempt')); await Promise.resolve();
  begin(); s.internal.peer = { close() {} }; rejectPlay(new Error('old peer')); await Promise.resolve();
  begin(); s.internal.receiverVideo = Object.create(receiver); rejectPlay(new Error('old receiver')); await Promise.resolve();
  begin(); s.internal.processorTrack = { kind: 'video' }; rejectPlay(new Error('old track')); await Promise.resolve();
  assert.equal(failed, 0);
  begin(); rejectPlay(new Error('current playback failure')); await Promise.resolve(); assert.equal(failed, 1);
  begin(); s.transport.disconnect(); rejectPlay(new Error('disconnected playback')); await Promise.resolve();
  assert.equal(failed, 1);
});
