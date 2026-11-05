import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import type { Layout, Surface } from '../client/types';
import type { MediaFeedbackSampler } from '../client/media-feedback';

test(
  'transport feedback samples current media and disconnect discards stale completions',
  { timeout: 2000 },
  async (t) => {
    let now = 0,
      nextFrame = 0;
    const callbacks = new Map<number, FrameRequestCallback>(),
      listeners = new Set<() => void>();
    const globals = [
      'document',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'getComputedStyle',
    ] as const;
    const originals = globals.map(
      (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );
    const video = { pause() {}, autoplay: false, muted: false, playsInline: false, srcObject: null };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        visibilityState: 'visible',
        createElement: (tag: string) => (tag === 'video' ? video : {}),
        addEventListener: (_name: string, callback: () => void) => listeners.add(callback),
        removeEventListener: (_name: string, callback: () => void) => listeners.delete(callback),
      },
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callbacks.set(++nextFrame, callback);
        return nextFrame;
      },
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: (id: number) => callbacks.delete(id),
    });
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      value: () => ({ visibility: 'visible' }),
    });
    t.mock.method(performance, 'now', () => now);
    t.after(() => {
      for (const [name, original] of originals) {
        if (original) Object.defineProperty(globalThis, name, original);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    });
    const transport = new RemoteTransport();
    transport.setControlRpc(async () => ({ closed: true }));
    transport.observePeerAuthorization(1);
    transport.setProductLocked(false);
    type Internals = {
      peer: RTCPeerConnection;
      channel: RTCDataChannel;
      layout: Layout;
      connectionId: string;
      mediaFeedback: MediaFeedbackSampler;
      renderers: Set<unknown>;
      readStats(peer: RTCPeerConnection): Promise<void>;
      closeLocal(): void;
    };
    const connected = transport as unknown as Internals;
    const sent: Record<string, any>[] = [];
    let decoded = 100,
      closed = false,
      pending: (() => void) | undefined,
      inboundId = 'video';
    const reports = () =>
      new Map([
        [
          inboundId,
          {
            id: inboundId,
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
    const peer = {
      getStats: async () => reports(),
      close: () => {
        closed = true;
      },
    } as unknown as RTCPeerConnection;
    connected.peer = peer;
    connected.connectionId = 'connection-1';
    connected.channel = {
      readyState: 'open',
      bufferedAmount: 0,
      send: (value: string) => {
        const message = JSON.parse(value);
        if (message.type === 'media.feedback') sent.push(message);
      },
    } as unknown as RTCDataChannel;
    const view = (id: string): Surface => ({
      id,
      session: '1',
      instance: '1',
      document: '1',
      focus: '1',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      deviceScaleFactor: 1,
    });
    const main = view('main'),
      split = view('split'),
      hidden = view('hidden');
    connected.layout = {
      type: 'layout',
      epoch: 'e1',
      generation: 'g1',
      width: 100,
      height: 100,
      views: [main, split, hidden],
    };
    connected.renderers = new Set(
      [main, split, hidden].map((surface) => ({
        view: surface,
        layoutEpoch: 'e1',
        layoutGeneration: 'g1',
        ready() {},
        canvas: {
          isConnected: true,
          getBoundingClientRect: () => ({ width: surface.id === 'hidden' ? 0 : 100, height: 100 }),
        },
      })),
    );
    connected.mediaFeedback.start();
    now = 1500;
    await connected.readStats(peer);
    assert.deepEqual(sent[0].planes, [{ view: 'main' }, { view: 'split' }]);
    assert.equal('decodedFrames' in sent[0], false);
    assert.equal(sent[0].roundTripTimeMs, 10);
    decoded = 175;
    now = 3000;
    await connected.readStats(peer);
    assert.equal(sent[1].decodedFrames, 75);
    assert.equal('videoFrames' in sent[1], false);
    assert.equal('packetsLost' in sent[1], false);
    assert.equal('framesDropped' in sent[1], false);
    assert.equal(transport.diagnostics.decodedFramesPerSecond, 50);
    assert.equal(transport.diagnostics.receiverVideoTiming?.jitterBufferMeanMs, 10);
    assert.ok(Math.abs(transport.diagnostics.receiverVideoTiming!.decodeMeanMs! - 1) < 1e-9);
    assert.equal(transport.diagnostics.receiverVideoTiming?.droppedFrames, undefined);
    const collection = transport.getDiagnosticCollectionSample();
    assert.equal(collection?.clientTimeMs, 3000);
    assert.equal(collection?.rtc?.sampledAtMs, 3000);
    assert.equal(collection?.rtc?.inboundVideo?.framesDecoded, 175);
    assert.equal(collection?.media?.video?.jitterBufferMeanMs, 10);
    assert.equal(collection?.availability.sourceCaptureTiming, false);
    assert.doesNotMatch(JSON.stringify(collection), /connection-1|"id":/);
    now = 3200;
    decoded = 200;
    now = 4500;
    await connected.readStats(peer);
    assert.equal(sent[2].windowMs, 1500);
    assert.equal(sent[2].decodedFrames, 25);
    decoded = 225;
    now = 6000;
    inboundId = 'video-replacement';
    await connected.readStats(peer);
    assert.equal(sent[3].windowMs, 1500);
    assert.equal(sent[3].decodedFrames, 25);
    assert.equal(transport.diagnostics.decodedFramesPerSecond, undefined);
    assert.equal(transport.diagnostics.receiverVideoTiming, undefined);
    assert.equal(transport.exportMediaDiagnostics().samples.length, 4);
    // A getStats completion from the old peer must never restart observation or send.
    peer.getStats = () =>
      new Promise((resolve) => {
        pending = () => resolve(reports() as unknown as RTCStatsReport);
      });
    now = 7500;
    const oldRead = connected.readStats(peer);
    connected.closeLocal();
    assert.equal(closed, true);
    assert.equal(callbacks.size, 0);
    assert.equal(listeners.size, 0);
    pending!();
    await oldRead;
    assert.equal(sent.length, 4);
    assert.equal(callbacks.size, 0);
    assert.deepEqual(transport.exportMediaDiagnostics().samples, []);
    assert.equal(transport.getDiagnosticCollectionSample(), undefined);
    connected.peer = {} as RTCPeerConnection;
    connected.connectionId = 'connection-2';
  },
);
