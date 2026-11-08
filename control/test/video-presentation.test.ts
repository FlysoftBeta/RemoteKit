import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PresentationSession } from '../client/presentation/presentation-session';
import {
  presentationBarrier,
  videoPlaneGeometry,
  VideoCompositorStats,
} from '../client/presentation/video-presentation';
import { CaptureLatency } from '../client/media/capture-latency';
import type { Layout, Surface } from '../client/presentation/types';
import { decodeIncoming } from '../client/rtc/protocol';
const first: Surface = {
  id: '1',
  session: 's',
  instance: 'i',
  document: 'd',
  focus: '0',
  x: 4,
  y: 4,
  width: 640,
  height: 480,
  deviceScaleFactor: 2,
  mediaScale: 0.5,
};
const second: Surface = { ...first, id: '2', x: 648 };
const layout: Layout = {
  type: 'layout',
  generation: '12',
  epoch: '20',
  width: 1296,
  height: 488,
  views: [first, second],
};
const key = { version: 1, barrierId: '10000000000000001', outputGeneration: '12', layoutEpoch: '20' };

function environment(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class Element {
    style: any = {
      setProperty(name: string, value: unknown) {
        this[name] = value;
      },
    };
    parentElement: Element | null = null;
    isConnected = true;
    width = 0;
    height = 0;
    offsetWidth = 320;
    videoWidth = 1296;
    videoHeight = 488;
    srcObject: unknown;
    onerror?: () => void;
    callback?: (at: number, metadata: any) => void;
    removed = false;
    constructor(readonly tag: string) {}
    setAttribute() {}
    removeAttribute() {}
    append(node: Element) {
      node.parentElement = this;
    }
    insertBefore(node: Element) {
      node.parentElement = this;
    }
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 320, height: 180 };
    }
    requestVideoFrameCallback(callback: (at: number, metadata: any) => void) {
      this.callback = callback;
      return 1;
    }
    cancelVideoFrameCallback() {
      this.callback = undefined;
    }
    pause() {}
    play() {
      return Promise.resolve();
    }
    remove() {
      this.removed = true;
    }
    frame(rtpTimestamp: number | undefined, presentedFrames = 1) {
      this.callback?.(performance.now(), { rtpTimestamp, presentedFrames });
    }
  }
  const videos: Element[] = [],
    rafs = new Map<number, FrameRequestCallback>(),
    visibility = new Set<() => void>();
  let serial = 0;
  const document = {
    visibilityState: 'visible',
    hidden: false,
    createElement: (tag: string) => {
      const element = new Element(tag);
      if (tag === 'video') videos.push(element);
      return element;
    },
    addEventListener: (_type: string, listener: () => void) => visibility.add(listener),
    removeEventListener: (_type: string, listener: () => void) => visibility.delete(listener),
  };
  const globals = {
    document,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    MediaStream: class {
      constructor(readonly tracks: unknown[]) {}
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      rafs.set(++serial, callback);
      return serial;
    },
    cancelAnimationFrame: (id: number) => rafs.delete(id),
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() =>
      previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name),
    );
  }
  const sent: Record<string, unknown>[] = [];
  const channel = {
    readyState: 'open',
    send: (raw: string) => sent.push(JSON.parse(raw)),
    bufferedAmount: 0,
  } as unknown as RTCDataChannel;
  const rtc = { peer: {} as RTCPeerConnection, attempt: 1, markConnection: () => {} };
  const authorization = { productLocked: false, peerAuthEpoch: 1, productReady: true };
  const presentation = new PresentationSession({
    endpoint: { channel, sendChannel: (_channel, message) => channel.send(JSON.stringify(message)) },
    rtc,
    authorization,
  });
  t.after(() => presentation.reset());
  presentation.setTrack({ kind: 'video' } as MediaStreamTrack);
  presentation.negotiatePresentation(channel);
  const message = (value: unknown) => {
    const decoded = decodeIncoming(value);
    assert.notEqual(decoded.type, 'decode-error');
    if (decoded.type !== 'decode-error') presentation.handle(decoded);
  };
  message(layout);
  const ready = [false, false],
    canvases = [new Element('canvas'), new Element('canvas')];
  const remove = canvases.map((canvas, index) => {
    canvas.parentElement = new Element('section');
    return presentation.registerViewport(
      layout.views[index].id,
      canvas as unknown as HTMLCanvasElement,
      (value) => (ready[index] = value),
    );
  });
  const raf = () => {
    const pending = [...rafs.values()];
    rafs.clear();
    pending.forEach((callback) => callback(performance.now()));
  };
  const mode = () => message({ type: 'presentation.mode', version: 1, backend: 'video' });
  const prepare = (barrier = key) => message({ type: 'presentation.prepare', ...barrier });
  const authorize = (rtp = 10) => {
    mode();
    prepare();
    raf();
    raf();
    message({ type: 'frame', rtpTimestamp: rtp, layoutEpoch: '20' });
    videos[1].frame(rtp);
  };
  return {
    presentation,
    rtc,
    authorization,
    document,
    videos,
    canvases,
    ready,
    sent,
    message,
    mode,
    prepare,
    raf,
    authorize,
    visibility,
    remove,
  };
}
test('video crop scales only atlas ROI against actual client bounds, including nonuniform resize', () => {
  assert.deepEqual(videoPlaneGeometry(second, layout, { width: 320, height: 180 }), {
    width: 648,
    height: 183,
    left: -324,
    top: -1.5,
  });
  assert.equal(videoPlaneGeometry({ ...first, x: 1290 }, layout, { width: 320, height: 180 }), undefined);
  assert.equal(presentationBarrier({ ...key, barrierId: 1 }), undefined);
  assert.deepEqual(presentationBarrier(key), key);
});

test('fractional flex bounds do not masquerade as UI scaling on the other axis', (t) => {
  const f = environment(t);
  f.canvases[0].getBoundingClientRect = () => ({ left: 10, top: 20, width: 320.25, height: 180 });
  f.authorize();
  const video = f.videos[1];
  assert.equal(video.parentElement?.style.width, '320.25px');
  assert.equal(video.parentElement?.style.height, '180px');
  assert.equal(video.style.height, '183px');
  assert.equal(video.style.top, '-1.5px');
});

test('video FPS and feedback count compositor deltas rather than rVFC callback count', () => {
  const stats = new VideoCompositorStats();
  stats.observe(0, 10, false);
  stats.observe(100, 15, true);
  stats.observe(200, 20, true);
  assert.deepEqual(stats.snapshot(200), { callbacks: 3, frames: 10, fps: 50 });
  stats.resetObservation();
  stats.observe(1000, 100, false);
  stats.observe(1100, 105, true);
  assert.deepEqual(stats.snapshot(1100), { callbacks: 5, frames: 15, fps: 50 });
});

test('poll windows distinguish compositor submissions, callbacks and element drops across idle and hide', () => {
  const stats = new VideoCompositorStats();
  stats.observe(0, 10, false);
  assert.equal(stats.sampleWindow(100, true, { totalVideoFrames: 15, droppedVideoFrames: 3 }), undefined);
  stats.observe(1000, 55, true);
  assert.deepEqual(stats.sampleWindow(1100, true, { totalVideoFrames: 65, droppedVideoFrames: 8 }), {
    fps: 45,
    callbackFps: 1,
    videoElementFps: 50,
    videoElementDrops: 5,
  });
  assert.deepEqual(stats.sampleWindow(2100, true, { totalVideoFrames: 65, droppedVideoFrames: 8 }), {
    fps: 0,
    callbackFps: 0,
    videoElementFps: 0,
    videoElementDrops: 0,
  });
  stats.resetObservation();
  stats.observe(2400, 160, false);
  assert.equal(
    stats.sampleWindow(3100, true),
    undefined,
    'a new visibility interval establishes its own baseline',
  );
});

test('video timing reports only locally measured samples inside the observation window', () => {
  const stats = new VideoCompositorStats();
  stats.observe(0, 10, false);
  stats.observe(120, 11, true, {
    receiveTime: 50,
    presentationTime: 110,
    expectedDisplayTime: 130,
    processingDuration: 0.002,
  });
  stats.observe(250, 12, true, { presentationTime: 240, expectedDisplayTime: 245 });
  assert.deepEqual(stats.timing(250), {
    receiveToSubmit: { samples: 1, p95: 60 },
    submitToCallback: { samples: 2, p95: 10 },
    expectedDisplayLateness: { samples: 2, p95: 5 },
    processing: { samples: 1, p95: 2 },
  });
  assert.equal(stats.timing(1300).submitToCallback, undefined);
});

test('presentation ACK requires hiding followed by two compositor turns and only the latest key', (t) => {
  const s = environment(t);
  s.mode();
  s.prepare();
  s.raf();
  assert.equal(s.sent.filter((m) => m.type === 'presentation.ready').length, 0);
  s.prepare({ ...key, barrierId: '10000000000000002' });
  s.raf();
  assert.equal(s.sent.filter((m) => m.type === 'presentation.ready').length, 0);
  s.raf();
  assert.equal(s.sent.filter((m) => m.type === 'presentation.ready').length, 1);
  const barrier = s.presentation.getSnapshot().barrier;
  assert.equal(barrier.phase, 'acknowledged');
  if (barrier.phase === 'acknowledged') assert.equal(barrier.key.barrierId, '10000000000000002');
});
test('each mounted viewport needs its own RTP observation before acquiring input authority', (t) => {
  const s = environment(t);
  s.authorize();
  assert.ok(s.presentation.canInput('1'));
  assert.equal(s.presentation.canInput('2'), null);
  assert.deepEqual(s.ready, [true, false]);
  assert.equal(s.videos.length, 3);
  s.videos[2].frame(10);
  assert.ok(s.presentation.canInput('2'));
  assert.equal(s.presentation.getPresentedPlane('1', 10)?.image, s.videos[1]);
});
test('invalidation exposes the last ROI before retiring its authority', (t) => {
  const s = environment(t);
  s.authorize();
  let captured = false;
  s.presentation.subscribePresentationInvalidation((id) => {
    if (id === '1') captured = !!s.presentation.getPresentedPlane(id, 10);
  });
  s.message({ ...layout, epoch: '21' });
  assert.equal(captured, true);
  assert.equal(s.presentation.canInput('1'), null);
});
test('duplicate prepares preserve ready views and cannot restart a completed barrier', (t) => {
  const s = environment(t);
  s.authorize();
  s.prepare();
  s.message(layout);
  s.raf();
  s.raf();
  assert.ok(s.presentation.canInput('1'));
  assert.equal(s.sent.filter((m) => m.type === 'presentation.ready').length, 1);
});
test('late frame metadata restores layout readiness without inventing current RTP pixels', (t) => {
  const s = environment(t);
  s.mode();
  s.prepare();
  s.raf();
  s.raf();
  s.videos[1].frame(42);
  assert.equal(s.presentation.canInput('1'), null);
  s.message({ type: 'frame', rtpTimestamp: 42, layoutEpoch: '20' });
  assert.ok(s.presentation.canInput('1'));
  assert.equal(s.presentation.getLastPresentation('1'), undefined);
  assert.equal(s.presentation.getPresentedPlane('1', 42), undefined);
  s.videos[1].frame(42);
  assert.equal(s.presentation.getLastPresentation('1')?.rtpTimestamp, 42);
});
test('resize transition state blocks input and chooser bounds independently of CSS', (t) => {
  const s = environment(t);
  s.authorize();
  s.presentation.setTransitionBlocked('1', true);
  assert.equal(s.presentation.canInput('1'), null);
  s.presentation.setTransitionBlocked('1', false);
  assert.ok(s.presentation.canInput('1'));
});
test('hidden documents suspend ACK and need two fresh turns after becoming visible', (t) => {
  const s = environment(t);
  s.mode();
  s.prepare();
  s.raf();
  s.document.visibilityState = 'hidden';
  s.visibility.forEach((fn) => fn());
  s.raf();
  assert.equal(s.sent.filter((m) => m.type === 'presentation.ready').length, 0);
  s.document.visibilityState = 'visible';
  s.visibility.forEach((fn) => fn());
  s.raf();
  assert.equal(s.sent.filter((m) => m.type === 'presentation.ready').length, 0);
  s.raf();
  assert.equal(s.sent.filter((m) => m.type === 'presentation.ready').length, 1);
});
test('static content keeps requesting fresh metadata while mounted without replacing the peer', (t) => {
  const s = environment(t);
  const peer = s.rtc.peer;
  s.mode();
  s.prepare();
  s.raf();
  s.raf();
  for (let i = 0; i < 5; i++) t.mock.timers.tick(1100);
  assert.equal(s.presentation.getSnapshot().backend.phase, 'video');
  assert.equal(s.rtc.peer, peer);
  s.message({ type: 'frame', rtpTimestamp: 10, layoutEpoch: '20' });
  s.videos[1].frame(10);
  assert.ok(s.presentation.canInput('1'));
});
test('missing RTP metadata produces a stable error and stale callbacks cannot restore authority', (t) => {
  const s = environment(t);
  s.mode();
  s.prepare();
  s.raf();
  s.raf();
  s.videos[1].frame(undefined);
  assert.equal(s.presentation.getSnapshot().backend.phase, 'unavailable');
  assert.equal(s.presentation.canInput('1'), null);
  s.videos[1].frame(10);
  assert.equal(s.presentation.canInput('1'), null);
});
test('viewport registrations survive reset but old element callbacks cannot authorize the replacement', (t) => {
  const s = environment(t);
  s.authorize();
  const stale = s.videos[1].callback;
  s.presentation.reset();
  s.rtc.attempt++;
  s.presentation.setTrack({ kind: 'video' } as MediaStreamTrack);
  s.message(layout);
  s.presentation.negotiatePresentation({ readyState: 'open' } as RTCDataChannel);
  s.mode();
  s.prepare();
  s.raf();
  s.raf();
  stale?.(0, { rtpTimestamp: 10 });
  assert.equal(s.presentation.canInput('1'), null);
  s.message({ type: 'frame', rtpTimestamp: 10, layoutEpoch: '20' });
  s.videos[s.videos.length - 2]?.frame(10);
  assert.ok(s.presentation.canInput('1'));
});
