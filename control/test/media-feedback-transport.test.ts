import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import type { Layout, Surface } from '../client/types';
import type { MediaFeedbackSampler } from '../client/media-feedback';
import type { PresentationDiagnostics } from '../client/presentation-diagnostics';

test('transport feedback is independent of delayed/failed relay HTTP and disconnect discards stale completions', { timeout: 2000 }, async t => {
  let now = 0, nextFrame = 0;
  const callbacks = new Map<number, FrameRequestCallback>(), listeners = new Set<() => void>();
  const globals = ['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'] as const;
  const originals = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const video = { pause() {}, autoplay: false, muted: false, playsInline: false, srcObject: null };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    visibilityState: 'visible', createElement: (tag: string) => tag === 'video' ? video : {},
    addEventListener: (_name: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_name: string, callback: () => void) => listeners.delete(callback),
  } });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { callbacks.set(++nextFrame, callback); return nextFrame; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => callbacks.delete(id) });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ visibility: 'visible' }) });
  t.mock.method(performance, 'now', () => now);
  t.after(() => { for (const [name, original] of originals) { if (original) Object.defineProperty(globalThis, name, original); else delete (globalThis as Record<string, unknown>)[name]; } });
  const transport = new RemoteTransport();
  type Internals = { peer: RTCPeerConnection; channel: RTCDataChannel; layout: Layout; videoPresentedFrames: number; connectionId: string;
    mediaFeedback: MediaFeedbackSampler; presentation: PresentationDiagnostics;
    renderers: Set<unknown>; readStats(peer: RTCPeerConnection): Promise<void>; closeLocal(): void };
  const connected = transport as unknown as Internals;
  const sent: Record<string, any>[] = [];
  const network: { resolve: (body: Record<string, unknown>) => void; reject: (error: Error) => void }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (url === '/api/rtc/close') return { ok: true, json: async () => ({ closed: true }) } as Response;
    assert.equal(url, '/api/rtc/network');
    return new Promise<Response>((resolve, reject) => { network.push({ resolve: body => resolve({ ok: true, json: async () => body } as Response), reject }); });
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let decoded = 100, closed = false, pending: (() => void) | undefined;
  const reports = () => new Map([['video', { type: 'inbound-rtp', kind: 'video', timestamp: now, framesDecoded: decoded, bytesReceived: decoded * 100 }], ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: .01 }]]);
  const peer = { getStats: async () => reports(), close: () => { closed = true; } } as unknown as RTCPeerConnection;
  connected.peer = peer;
  connected.connectionId = 'connection-1'; transport.diagnostics.networkSimulation = { enabled: true };
  connected.channel = { readyState: 'open', bufferedAmount: 0, send: (value: string) => sent.push(JSON.parse(value)) } as unknown as RTCDataChannel;
  const view = (id: string): Surface => ({ id, session: '1', instance: '1', document: '1', focus: '1', x: 0, y: 0, width: 100, height: 100, deviceScaleFactor: 1 });
  const main = view('main'), split = view('split'), hidden = view('hidden');
  connected.layout = { type: 'layout', epoch: 'e1', generation: 'g1', width: 100, height: 100, views: [main, split, hidden] };
  connected.renderers = new Set([main, split, hidden].map(surface => ({ view: surface, layoutEpoch: 'e1', layoutGeneration: 'g1', ready() {}, canvas: { isConnected: true, getBoundingClientRect: () => ({ width: surface.id === 'hidden' ? 0 : 100, height: 100 }) } })));
  connected.videoPresentedFrames = 80; connected.mediaFeedback.start();
  now = 1500; await connected.readStats(peer);
  assert.equal(network.length, 1); // Native feedback did not wait for this unresolved HTTP request.
  assert.deepEqual(sent[0].planes, [{ view: 'main' }, { view: 'split' }]);
  assert.equal('decodedFrames' in sent[0], false); assert.equal(sent[0].roundTripTimeMs, 10);
  connected.presentation.paint(1600, 'main', 90, 'e1', 1599, true);
  connected.presentation.paint(1601, 'split', 90, 'e1', 1599, true);
  decoded = 175; connected.videoPresentedFrames = 140;
  now = 3000; await connected.readStats(peer);
  assert.equal(network.length, 1); // A slow diagnostic does not accumulate parallel HTTP requests.
  assert.equal(sent[1].decodedFrames, 75); assert.equal(sent[1].videoFrames, 60);
  assert.equal('packetsLost' in sent[1], false); assert.equal('framesDropped' in sent[1], false);
  now = 3200; network[0].resolve({ enabled: true, observation: 'delayed' }); await flush();
  assert.equal(transport.diagnostics.networkSimulation?.observation, 'delayed');
  decoded = 200; now = 4500; await connected.readStats(peer);
  assert.equal(sent[2].windowMs, 1500); assert.equal(sent[2].decodedFrames, 25); assert.equal(network.length, 2);
  network[1].reject(new Error('relay unavailable')); await flush();
  decoded = 225; now = 6000; await connected.readStats(peer);
  assert.equal(sent[3].windowMs, 1500); assert.equal(sent[3].decodedFrames, 25); assert.equal(network.length, 3);
  assert.equal(transport.diagnostics.networkSimulation?.observation, 'delayed');
  // A getStats completion from the old peer must never restart observation or send.
  peer.getStats = () => new Promise(resolve => { pending = () => resolve(reports() as unknown as RTCStatsReport); });
  now = 7500; const oldRead = connected.readStats(peer);
  connected.closeLocal(); assert.equal(closed, true); assert.equal(callbacks.size, 0); assert.equal(listeners.size, 0);
  pending!(); await oldRead; assert.equal(sent.length, 4); assert.equal(callbacks.size, 0);
  // An HTTP response from the disconnected peer cannot overwrite a new connection.
  connected.peer = {} as RTCPeerConnection; connected.connectionId = 'connection-2';
  transport.diagnostics.networkSimulation = { enabled: true, observation: 'replacement' };
  network[2].resolve({ enabled: true, observation: 'stale' }); await flush();
  assert.equal(transport.diagnostics.networkSimulation?.observation, 'replacement');
});
