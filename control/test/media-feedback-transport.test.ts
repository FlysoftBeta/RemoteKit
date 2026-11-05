import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaObservations } from '../client/media/observations';
import { PresentationDiagnostics } from '../client/media/presentation-diagnostics';
import type { Layout } from '../client/presentation/types';
import type { Outgoing } from '../client/rtc/protocol';

test('media sampling selects current RTC counters and discards stale peer completions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const [name, value] of Object.entries({
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: (): number => 1,
    cancelAnimationFrame() {},
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() =>
      old ? Object.defineProperty(globalThis, name, old) : Reflect.deleteProperty(globalThis, name),
    );
  }
  let decoded = 100;
  let finish: (() => void) | undefined;
  const reports = () =>
    new Map([
      [
        'video',
        {
          id: 'video',
          type: 'inbound-rtp',
          kind: 'video',
          timestamp: now,
          framesDecoded: decoded,
          bytesReceived: decoded * 100,
          jitterBufferEmittedCount: decoded,
          jitterBufferDelay: decoded / 100,
          totalDecodeTime: decoded / 1000,
        },
      ],
      ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.01 }],
    ]);
  const peer = { getStats: async () => reports(), getReceivers: () => [] } as unknown as RTCPeerConnection;
  const rtc = { peer: peer as RTCPeerConnection | null, attempt: 1, controlRpc: undefined };
  const sent: Outgoing[] = [];
  const channel = { readyState: 'open', bufferedAmount: 0 } as RTCDataChannel;
  const presentation = {
    layout: { type: 'layout', generation: '1', epoch: '2', width: 640, height: 480, views: [] } as Layout,
    canInput: () => null,
    selectedViewId: '1',
    presentationBackend: 'video' as const,
    presentationErrorCode: undefined,
    freezeCopies: 0,
    mediaRefreshRequests: 0,
    presentationBarrierAcknowledged: true,
    presentationBarrier: undefined,
    presentation: new PresentationDiagnostics(),
    encodedFrameSamples: [],
    videoTrack: undefined,
    getRenderingDiagnostics: () => ({
      backend: 'video' as const,
      backendReason: undefined,
      videoCompositorByView: {},
      visibility: 'visible' as const,
      freezeCopies: 0,
      mediaRefreshRequests: 0,
    }),
    sampleVideoWindows: () => [],
    currentVideoWindows: () => [],
    feedbackPlanes: () => [{ view: '1', frames: 10 }],
  };
  const media = new MediaObservations({
    rtc,
    authorization: { productLocked: false, peerAuthEpoch: 1 },
    presentation,
    endpoint: { channel, sendChannel: (_channel, message) => sent.push(message) },
    input: { inputTrace: [], inputResults: [] },
  });
  t.after(() => media.reset());
  media.start(peer);
  await media.readStats(peer);
  now = 2000;
  decoded = 200;
  await media.readStats(peer);
  assert.equal(media.getSnapshot().decodedFramesPerSecond, 50);
  assert.equal(media.getSnapshot().receiveBitrateBps, 40000);
  assert.equal(media.getSnapshot().receiverVideoTiming?.jitterBufferMeanMs, 10);
  assert.ok(Math.abs(media.getSnapshot().receiverVideoTiming!.decodeMeanMs! - 1) < 1e-9);
  assert.equal(media.getDiagnosticCollectionSample()?.rtc?.sampledAtMs, 2000);
  assert.equal(media.exportMediaDiagnostics().samples.length, 2);
  assert.ok(sent.some((message) => message.type === 'media.feedback' && message.planes[0].view === '1'));
  peer.getStats = () =>
    new Promise((resolve) => {
      finish = () => resolve(reports() as unknown as RTCStatsReport);
    });
  const pending = media.readStats(peer);
  media.reset();
  rtc.peer = null;
  finish!();
  await pending;
  assert.deepEqual(media.exportMediaDiagnostics().samples, []);
  assert.equal(media.getDiagnosticCollectionSample(), undefined);
  assert.equal(media.getSnapshot().receiverVideoTiming, undefined);
});
