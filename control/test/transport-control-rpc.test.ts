import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RtcSession, type RtcEvent } from '../client/rtc/rtc-session';
import type { ControlRpc } from '../client/rtc/session-port';

function environment(t: TestContext) {
  const peers: Peer[] = [];
  class Peer {
    localDescription?: RTCSessionDescriptionInit;
    connectionState = 'new';
    iceConnectionState = 'new';
    signalingState = 'stable';
    closed = false;
    candidates: RTCIceCandidateInit[] = [];
    channels: { label: string }[] = [];
    onicecandidate?: (event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void;
    onconnectionstatechange?: () => void;
    ontrack?: (event: { track: MediaStreamTrack; receiver: RTCRtpReceiver }) => void;
    constructor() {
      peers.push(this);
    }
    addTransceiver() {
      return { receiver: {} };
    }
    createDataChannel(label: string) {
      const channel = { label };
      this.channels.push(channel);
      return channel;
    }
    async createOffer() {
      return { type: 'offer' as const, sdp: 'v=0\r\n' };
    }
    async setLocalDescription(value: RTCSessionDescriptionInit) {
      this.localDescription = value;
    }
    async setRemoteDescription() {}
    async addIceCandidate(candidate: RTCIceCandidateInit) {
      this.candidates.push(candidate);
    }
    close() {
      this.closed = true;
      this.signalingState = 'closed';
    }
  }
  for (const [name, value] of Object.entries({
    navigator: { userAgent: 'Chrome/89.0' },
    RTCPeerConnection: Peer,
    RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() =>
      previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name),
    );
  }
  const rtc = new RtcSession();
  t.after(() => rtc.disconnect());
  const events: RtcEvent[] = [];
  rtc.events.subscribe((event) => events.push(event));
  return { rtc, peers, events };
}
const answer = { type: 'answer', sdp: 'v=0\r\n', connectionId: 'connection', endpointGeneration: 1 };
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test('RTC publishes channels, receivers and tracks independently of presentation', async (t) => {
  const { rtc, peers, events } = environment(t);
  const calls: string[] = [];
  rtc.setControlRpc(async (method) => {
    calls.push(method);
    return method === 'rtc.offer' ? answer : {};
  });
  await rtc.connect();
  assert.equal(rtc.getSnapshot().phase, 'establishing');
  assert.deepEqual(
    peers[0].channels.map((channel) => channel.label),
    ['remotekit', 'remotekit-auth'],
  );
  assert.equal(events.filter((event) => event.type === 'receiver').length, 2);
  const track = { kind: 'video' } as MediaStreamTrack;
  peers[0].ontrack?.({ track, receiver: {} as RTCRtpReceiver });
  assert.ok(events.some((event) => event.type === 'track' && event.track === track));
  peers[0].connectionState = 'connected';
  peers[0].onconnectionstatechange?.();
  assert.equal(rtc.getSnapshot().phase, 'connected');
  rtc.disconnect();
  assert.equal(rtc.getSnapshot().phase, 'stopped');
  assert.equal(peers[0].closed, true);
  assert.deepEqual(calls, ['rtc.offer', 'rtc.close']);
});

test('trickle queues early remote ICE and sends local ICE after the matching answer', async (t) => {
  const { rtc, peers } = environment(t);
  let finish!: (value: unknown) => void;
  let attemptId = '';
  const ice: unknown[] = [];
  rtc.setControlRpc(async (method, params) => {
    if (method === 'rtc.offer') {
      attemptId = (params as { attemptId: string }).attemptId;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    if (method === 'rtc.ice') ice.push(params);
    return {};
  });
  const job = rtc.connect();
  await flush();
  const candidate = { candidate: 'candidate:1', sdpMid: '0' };
  peers[0].onicecandidate?.({ candidate: { toJSON: () => candidate } });
  rtc.receiveServerSignal({
    type: 'rtc.signal',
    attemptId,
    connectionId: 'connection',
    signal: { type: 'ice', candidate },
  });
  assert.deepEqual(peers[0].candidates, []);
  assert.deepEqual(ice, []);
  finish(answer);
  await job;
  await flush();
  assert.deepEqual(peers[0].candidates, [candidate]);
  assert.equal(ice.length, 1);
  rtc.receiveServerSignal({
    type: 'rtc.signal',
    attemptId: 'stale',
    connectionId: 'connection',
    signal: { type: 'ice', candidate },
  });
  await flush();
  assert.equal(peers[0].candidates.length, 1);
});

test('stopping an establishing peer closes a late answer and prevents retries', async (t) => {
  const { rtc, peers } = environment(t);
  let finish!: (value: unknown) => void;
  const closed: unknown[] = [];
  rtc.setControlRpc(async (method, params) => {
    if (method === 'rtc.offer')
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (method === 'rtc.close') closed.push(params);
    return {};
  });
  const job = rtc.connect();
  await flush();
  rtc.disconnect();
  finish(answer);
  await job;
  assert.equal(rtc.getSnapshot().phase, 'stopped');
  assert.equal(peers[0].closed, true);
  assert.deepEqual(closed, [{ connectionId: 'connection' }]);
});

test('RTC retries bounded attempts and manual connect starts a fresh attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { rtc } = environment(t);
  let offers = 0;
  const rpc: ControlRpc = async () => {
    offers++;
    throw new Error('offline');
  };
  rtc.setControlRpc(rpc);
  await rtc.connect();
  assert.equal(rtc.getSnapshot().phase, 'retryWait');
  for (const delay of [2000, 5000, 10000]) {
    t.mock.timers.tick(delay);
    await flush();
  }
  assert.equal(rtc.getSnapshot().phase, 'exhausted');
  assert.equal(offers, 4);
  await rtc.connect();
  assert.equal(rtc.getSnapshot().phase, 'retryWait');
  assert.equal(offers, 5);
});

test('connected peers reset the outage budget and stopped sessions ignore delayed recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { rtc, peers } = environment(t);
  let offers = 0;
  rtc.setControlRpc(async (method) => {
    if (method === 'rtc.offer') {
      offers++;
      return { ...answer, connectionId: `connection-${offers}` };
    }
    return {};
  });
  await rtc.connect();
  peers[0].connectionState = 'connected';
  peers[0].onconnectionstatechange?.();
  peers[0].connectionState = 'disconnected';
  peers[0].onconnectionstatechange?.();
  peers[0].onconnectionstatechange?.();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(offers, 2);
  peers[1].connectionState = 'connected';
  peers[1].onconnectionstatechange?.();
  peers[1].connectionState = 'failed';
  peers[1].onconnectionstatechange?.();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(offers, 3);
  rtc.disconnect();
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(rtc.getSnapshot().phase, 'stopped');
  assert.equal(offers, 3);
});
