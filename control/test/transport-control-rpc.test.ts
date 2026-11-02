import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport, type ControlRpc } from '../client/transport';
import {readFileSync} from 'node:fs';
import { requireAcceptedReceipt, type ProductActionHandler } from '../client/product-operations';
import type { OperationReceipt } from '../shared/product';

for (const status of ['applying', 'committed', 'unknown'] as const)
test(`product action ${status} wire is an execution receipt without a workspace`, async t => {
  environment(t);
  const transport = new RemoteTransport();
  t.after(() => transport.disconnect());
  const sent: unknown[] = [];
  const channel: any = { readyState: 'open', bufferedAmount: 0, send(value: string) { sent.push(JSON.parse(value)); }, close() { this.readyState = 'closed'; } };
  (transport as any).bindChannel(channel);
  const receipt: OperationReceipt = {
    operationId: 'forward-operation', operationGeneration: 'generation-1', status,
    ...(status === 'applying' ? { application: { status: 'pending' as const, reason: 'navigation_pending' } } : {}),
    ...(status === 'committed' ? { revision: 12 } : {}),
  };
  const action: ProductActionHandler = async command => requireAcceptedReceipt(await transport.productAction({
    operationId: receipt.operationId, operationGeneration: receipt.operationGeneration, action: command,
  }));
  const pending = action({ type: 'tab.command', tabId: 'tab-1', command: 'forward' });
  channel.onmessage({ data: JSON.stringify({ type: 'product.result', version: 1, operationId: receipt.operationId, operationGeneration: receipt.operationGeneration, result: receipt }) });
  assert.deepEqual(await pending, receipt);
  assert.equal('state' in receipt, false);
  assert.equal(sent.length, 1, 'pending or unknown receipt must not replay the action');
});

test('receipt submission rejects only explicit rejected/expired outcomes', () => {
  for (const status of ['rejected', 'expired'] as const)
    assert.throws(() => requireAcceptedReceipt({ operationId: 'operation', operationGeneration: 'generation', status, error: 'explicit rejection' }), /explicit rejection/);
});

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
      async addIceCandidate(_candidate: unknown) {}
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

test('Native forwarded timeout wire preserves unknown receipt without Client replay', async t => {
  environment(t);
  // The Native DirectServices CPU test compares its actual timeout output to
  // this same fixture, so this exercises the complete cross-language contract.
  const wire=JSON.parse(readFileSync(new URL('../../endpoint/tests/fixtures/product-action-timeout.json',import.meta.url),'utf8'));
  const transport=new RemoteTransport();t.after(()=>transport.disconnect());
  const sent:any[]=[],channel:any={readyState:'open',bufferedAmount:0,send(value:string){sent.push(JSON.parse(value));},close(){this.readyState='closed';}};
  (transport as any).bindChannel(channel);
  const pending=transport.productAction({operationId:wire.operationId,operationGeneration:wire.operationGeneration,action:{type:'window.create'}});
  channel.onmessage({data:JSON.stringify(wire)});
  assert.deepEqual(await pending,wire.result);
  assert.equal(sent.filter(message=>message.type==='product.action').length,1);
  assert.equal((transport as any).productPending.size,0);
});

test('transport separates Endpoint DC clock from Control RPC and expires pending probes across replacement', async t => {
  environment(t);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(Date, 'now', () => 1000 + now);
  const transport = new RemoteTransport(); t.after(() => transport.disconnect());
  const state = transport as any;
  const replies: ((value: unknown) => void)[] = [];
  transport.setControlRpc(async method => method === 'clock.ping' ? new Promise(resolve => replies.push(resolve)) : {});
  const peer = { close() {} }; state.peer = peer;
  const sent: any[] = [];
  const channel = () => ({readyState:'open',bufferedAmount:0,send(value: string) { sent.push(JSON.parse(value)); }} as any);
  const old = channel(); state.bindChannel(old);
  state.productionFeedback(peer);
  assert.equal(sent[0].type,'clock.ping'); assert.equal(replies.length,1);
  now = 10;
  old.onmessage({data:JSON.stringify({...sent[0],type:'clock.pong',serverTimeMs:705,serverMonotonicMs:500})});
  assert.equal(state.latency.endpointClock.mapping(now,1010).wall,710);
  assert.equal(state.controlClock.mapping(now,1010),undefined);
  // A hung Control RPC cannot block bounded resampling.
  now = 5000; state.productionFeedback(peer); assert.equal(replies.length,2);
  now = 5010; replies[0]({serverTime:1505}); await Promise.resolve(); await Promise.resolve();
  assert.equal(state.controlClock.mapping(now,6010),undefined);
  replies[1]({serverTime:6505}); await Promise.resolve(); await Promise.resolve();
  assert.equal(state.controlClock.mapping(now,6010).wall,6510);
  const replacement = channel(); state.bindChannel(replacement);
  assert.equal(state.latency.endpointClock.mapping(now,6010),undefined);
  old.onmessage({data:JSON.stringify({...sent[1],type:'clock.pong',serverTimeMs:5705,serverMonotonicMs:5500})});
  assert.equal(state.latency.endpointClock.mapping(now,6010),undefined);
  state.sampleEndpointClock();
  const fresh = sent[sent.length-1];
  now = 5020;
  replacement.onmessage({data:JSON.stringify({...fresh,type:'clock.pong',serverTimeMs:5715,serverMonotonicMs:5510})});
  assert.equal(state.latency.endpointClock.mapping(now,6020).wall,5720);
});

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

test('trickle sends an ungathered offer, queues early remote ICE, and flushes local ICE after answer', async t => {
  environment(t);
  const received: unknown[] = [], calls: { method: string; params: any }[] = [];
  t.mock.method(RTCPeerConnection.prototype, 'addIceCandidate', async (candidate: RTCIceCandidateInit) => { received.push(candidate); });
  t.mock.method(RTCPeerConnection.prototype, 'setLocalDescription', async function (this: RTCPeerConnection, value: unknown) {
    Object.assign(this, { localDescription: value, iceGatheringState: 'gathering' });
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'local', sdpMid: '0', sdpMLineIndex: 0 }) } } as RTCPeerConnectionIceEvent);
  });
  const transport = new RemoteTransport(); t.after(() => transport.disconnect()); transport.trickleIce = true;
  const candidate = { candidate: 'remote', sdpMid: '0', sdpMLineIndex: 0 };
  transport.setControlRpc(async (method, params: any) => {
    calls.push({ method, params });
    if (method === 'rtc.offer') {
      assert.equal(params.trickle, true);
      transport.receiveServerSignal({ type: 'rtc.signal', connectionId: 'p', attemptId: params.attemptId, signal: { type: 'ice', candidate } });
      transport.receiveServerSignal({ type: 'rtc.signal', connectionId: 'old', attemptId: 'stale', signal: { type: 'ice', candidate: { ...candidate, candidate: 'stale' } } });
      assert.equal(received.length, 0);
      return { type: 'answer', sdp: 'v=0\r\n', connectionId: 'p', signalingMode: 'trickle' };
    }
    return { accepted: true };
  });
  await transport.connect(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [candidate]);
  assert.equal(calls[0].method, 'rtc.offer'); assert.equal(calls[1].method, 'rtc.ice');
  assert.equal(calls[1].params.connectionId, 'p'); assert.equal(calls[1].params.attemptId, calls[0].params.attemptId);
  assert.equal(transport.connectionAttempts[0].signalingMode, 'trickle');
  transport.disconnect();
});

test('a network timeout never changes a decoder-verified receive profile', async t => {
  environment(t);
  const codec = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
  t.mock.method(RTCRtpReceiver, 'getCapabilities', () => ({ codecs: [codec], headerExtensions: [] }));
  const transport = new RemoteTransport(); t.after(() => transport.disconnect());
  (transport as any).productReceiveSelection = { profile: 'h264-level52', reason: 'verified decoder' };
  t.mock.method(RTCPeerConnection.prototype, 'createOffer', async () => ({ type: 'offer' as const, sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 packetization-mode=1;profile-level-id=42e01f\r\n' }));
  transport.setControlRpc(async () => { throw new Error('ICE gathering timeout'); });
  await transport.connect(); assert.equal((transport as any).productReceiveSelection.profile, 'h264-level52');
});

test('explicit codec failures fall through level5.2 then 5.1 before verified level4.2', async t => {
  environment(t);
  const codec = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
  t.mock.method(RTCRtpReceiver, 'getCapabilities', () => ({ codecs: [codec], headerExtensions: [] }));
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 packetization-mode=1;profile-level-id=42e01f\r\n';
  t.mock.method(RTCPeerConnection.prototype, 'createOffer', async () => ({ type: 'offer' as const, sdp }));
  let attempts = 0;
  t.mock.method(RTCPeerConnection.prototype, 'setRemoteDescription', async () => { if (++attempts < 3) throw new Error('unsupported SDP codec'); });
  const transport = new RemoteTransport(); t.after(() => transport.disconnect());
  (transport as any).productReceiveSelection = { profile: 'h264-level52', reason: 'verified decoder' };
  transport.setControlRpc(async method => method === 'rtc.offer' ? { type: 'answer', sdp, connectionId: 'p' } : { closed: true });
  await transport.connect(); assert.equal((transport as any).productReceiveSelection.profile, 'h264-level51');
  await transport.connect(); assert.equal((transport as any).productReceiveSelection.profile, 'h264-level42-experimental');
  await transport.connect(); assert.equal(transport.receiveProfile, 'h264-level42-experimental');
  transport.disconnect();
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

test('failed automatic level4.2 negotiation downgrades once and keeps original SDP evidence', async t => {
  environment(t);
  const codec = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
  t.mock.method(RTCRtpReceiver, 'getCapabilities', () => ({ codecs: [codec], headerExtensions: [] }));
  const oldDecoder = Object.getOwnPropertyDescriptor(globalThis, 'VideoDecoder');
  let probes = 0;
  Object.defineProperty(globalThis, 'VideoDecoder', { configurable: true, value: { isConfigSupported: async (config: { codec: string }) => { probes++; return { supported: config.codec === 'avc1.42e02a' }; } } });
  t.after(() => { if (oldDecoder) Object.defineProperty(globalThis, 'VideoDecoder', oldDecoder); else Reflect.deleteProperty(globalThis, 'VideoDecoder'); });
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 packetization-mode=1;profile-level-id=42e01f\r\n';
  t.mock.method(RTCPeerConnection.prototype, 'createOffer', async () => ({ type: 'offer' as const, sdp }));
  let descriptions = 0;
  t.mock.method(RTCPeerConnection.prototype, 'setRemoteDescription', async () => { if (++descriptions === 1) throw new Error('unsupported SDP codec answer'); });
  const transport = new RemoteTransport(); t.after(() => transport.disconnect());
  transport.setControlRpc(async method => method === 'rtc.offer' ? { type: 'answer', sdp, connectionId: 'p' } : { closed: true });
  await transport.connect(); await transport.connect();
  assert.equal(transport.receiveProfile, 'native'); assert.equal(probes, 3);
  assert.match(String(transport.diagnostics.receiveSelection?.reason), /negotiation failed/);
  const previous = transport.signaling?.previousNegotiationFailure as Record<string, unknown>;
  assert.equal(previous.originalOfferSdp, sdp);
  assert.match(String(previous.effectiveOfferSdp), /42e02a/);
  transport.disconnect();
});


test('start-page actions wait in memory for data-only RTC and first navigation preserves the same peer/channel',async t=>{
  environment(t);const transport=new RemoteTransport();t.after(()=>transport.disconnect());
  const sent:any[]=[],channel:any={readyState:'connecting',bufferedAmount:0,send(value:string){sent.push(JSON.parse(value));},close(){this.readyState='closed';}};
  (transport as any).bindChannel(channel);
  const first={operationId:'12345678-1234-4234-8234-123456789abc',operationGeneration:'generation',action:{type:'window.create' as const}};
  const pending=transport.productAction(first);assert.equal(sent.length,0);
  channel.readyState='open';channel.onopen();const wire=sent.find(message=>message.type==='product.action');assert.equal(wire.operationId,first.operationId);assert.equal(wire.version,1);
  channel.onmessage({data:JSON.stringify({type:'product.result',version:1,operationId:first.operationId,operationGeneration:first.operationGeneration,result:{...first,action:undefined,status:'committed',revision:1}})});
  assert.equal((await pending).status,'committed');
  const peer=(transport as any).peer,next={...first,operationId:'22345678-1234-4234-8234-123456789abc',action:{type:'tab.navigate' as const,tabId:'tab',url:'https://example.test/'}};
  const navigation=transport.productAction(next);assert.equal((transport as any).channel,channel);assert.equal((transport as any).peer,peer);
  channel.onmessage({data:JSON.stringify({type:'product.result',version:1,operationId:next.operationId,operationGeneration:next.operationGeneration,result:{operationId:next.operationId,operationGeneration:next.operationGeneration,status:'applying'}})});
  assert.equal((await navigation).status,'applying');assert.equal(sent.filter(message=>message.type==='product.action').length,2);
});
