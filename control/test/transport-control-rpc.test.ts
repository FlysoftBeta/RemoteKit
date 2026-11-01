import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport, type ControlRpc } from '../client/transport';

function environment(t: TestContext) {
  const values: Record<string, unknown> = {
    document: { visibilityState: 'visible', createElement: () => ({ pause() {}, remove() {} }), addEventListener() {}, removeEventListener() {} },
    navigator: { userAgent: 'Chrome/157.0' },
    RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    RTCPeerConnection: class {
      iceGatheringState = 'complete'; localDescription: unknown; signalingState = 'stable';
      addTransceiver() { return {}; }
      createDataChannel() { return {}; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
      async setLocalDescription(value: unknown) { this.localDescription = value; }
      async setRemoteDescription() {}
      close() { this.signalingState = 'closed'; }
    },
  };
  for (const [name, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); });
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected HTTP fallback'); });
}

test('product offer and disconnect use injected RPC and preserve SDP diagnostics', async t => {
  environment(t);
  const calls: { method: string; params: unknown }[] = [];
  const transport = new RemoteTransport(); t.after(() => transport.disconnect());
  transport.setControlRpc(async (method, params) => {
    calls.push({ method, params });
    return method === 'rtc.offer' ? { type: 'answer', sdp: 'v=0\r\n', connectionId: 'first', endpointGeneration: 1 } : { closed: true };
  });
  await transport.connect();
  assert.equal(calls[0].method, 'rtc.offer');
  assert.equal(transport.signaling?.answerSdp, 'v=0\r\n');
  assert.equal(transport.diagnostics.connectionId, 'first');
  transport.disconnect();
  assert.deepEqual(calls[1], { method: 'rtc.close', params: { connectionId: 'first' } });
});

test('lease revocation during pending offer closes its late answer without reconnecting', async t => {
  environment(t);
  let answer!: (value: unknown) => void;
  let offered!: () => void;
  const offerStarted = new Promise<void>(resolve => { offered = resolve; });
  const calls: string[] = [];
  const transport = new RemoteTransport();
  transport.setControlRpc((method) => {
    calls.push(method);
    if (method !== 'rtc.offer') return Promise.resolve({ closed: true });
    offered(); return new Promise(resolve => { answer = resolve; });
  });
  const connecting = transport.connect();
  await offerStarted;
  transport.disconnect();
  answer({ type: 'answer', sdp: 'v=0\r\n', connectionId: 'late' });
  await connecting;
  assert.deepEqual(calls, ['rtc.offer', 'rtc.close']);
  const internal = transport as unknown as { reconnect: { wanted: boolean }; retryTimer?: unknown };
  assert.equal(internal.reconnect.wanted, false);
  assert.equal(internal.retryTimer, undefined);
  assert.equal(transport.diagnostics.connectionId, undefined);
});

test('ordinary transport has no implicit HTTP signaling', async t => {
  environment(t);
  const transport = new RemoteTransport();
  const internal = transport as unknown as { rtcRequest: ControlRpc };
  await assert.rejects(internal.rtcRequest('rtc.offer', {}), /WebSocket/);
});
