import test from 'node:test';
import assert from 'node:assert/strict';
import { RtcSession } from '../client/rtc/rtc-session';
import { RemoteKitError } from '../shared/errors';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: import('node:test').TestContext) {
  const peers: Peer[] = [];
  const offer =
    'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 packetization-mode=1;profile-level-id=42e01f\r\n';
  class Peer {
    connectionState = 'new';
    localDescription?: RTCSessionDescriptionInit;
    closed = false;
    constructor() {
      assert.equal(peers.filter((peer) => !peer.closed).length, 0);
      peers.push(this);
    }
    addTransceiver() {
      return { receiver: {} };
    }
    createDataChannel() {
      return {};
    }
    async createOffer() {
      return { type: 'offer', sdp: offer };
    }
    async setLocalDescription(value: RTCSessionDescriptionInit) {
      this.localDescription = value;
    }
    async setRemoteDescription() {
      this.connectionState = 'connected';
    }
    close() {
      this.closed = true;
      this.connectionState = 'closed';
    }
  }
  for (const [key, value] of Object.entries({
    RTCPeerConnection: Peer,
    RTCRtpReceiver: { getCapabilities: () => undefined },
    window: { devicePixelRatio: 1, screen: { width: 1600, height: 1000 } },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key),
    );
  }
  const rtc = new RtcSession();
  const calls: { method: string; params: any }[] = [];
  let closeError: RemoteKitError | undefined;
  let answer: ReturnType<typeof deferred<any>> | undefined;
  rtc.setControlRpc(async (method, params) => {
    calls.push({ method, params });
    if (method === 'rtc.close' && closeError) throw closeError;
    if (method === 'rtc.offer') {
      if (answer) {
        const pending = answer;
        answer = undefined;
        return pending.promise;
      }
      return { type: 'answer', sdp: offer, connectionId: `connection-${calls.length}`, avSync: false };
    }
    return {};
  });
  t.after(() => {
    closeError = undefined;
    rtc.disconnect();
  });
  return {
    rtc,
    peers,
    calls,
    failClose: (error: RemoteKitError) => {
      closeError = error;
    },
    deferAnswer: () => (answer = deferred<any>()),
  };
}

test('rejected remote cleanup settles the barrier and the next establish succeeds', async (t) => {
  const { rtc, peers, failClose, calls } = fixture(t);
  await rtc.connect();
  failClose(new RemoteKitError('forbidden', 'old lease ended'));
  await rtc.connect();
  assert.equal(peers[0].closed, true);
  assert.equal(rtc.peer, peers[1]);
  assert.equal(calls.filter((call) => call.method === 'rtc.offer').length, 2);
  assert.equal(peers.filter((peer) => !peer.closed).length, 1);
});

test('unreachable remote cleanup does not retry or hold up the next offer', async (t) => {
  const { rtc, peers, failClose, calls } = fixture(t);
  await rtc.connect();
  failClose(new RemoteKitError('unavailable', 'WebSocket offline'));
  await rtc.connect();
  assert.equal(rtc.peer, peers[1]);
  assert.equal(calls.filter((call) => call.method === 'rtc.close').length, 1);
});

test('overlapping establishes discard late answers and never leave two live peers', async (t) => {
  const { rtc, peers, deferAnswer, calls } = fixture(t);
  const answer = deferAnswer();
  const first = rtc.connect();
  while (!calls.some((call) => call.method === 'rtc.offer'))
    await new Promise<void>((resolve) => setImmediate(resolve));
  const second = rtc.connect();
  const third = rtc.connect();
  answer.resolve({ type: 'answer', sdp: 'v=0\r\n', connectionId: 'late', avSync: false });
  await Promise.all([first, second, third]);
  assert.equal(peers.filter((peer) => !peer.closed).length, 1);
  assert.equal(peers[0].closed, true);
  assert.equal(rtc.peer, peers[peers.length - 1]);
  assert.ok(calls.some((call) => call.method === 'rtc.close' && call.params.connectionId === 'late'));
});

test('connection retry follows structured error policy regardless of message text', async (t) => {
  const { rtc } = fixture(t);
  rtc.connectionFailed(new RemoteKitError('unavailable', 'permanent failure words'));
  assert.equal(rtc.getSnapshot().phase, 'retryWait');
  rtc.disconnect();
  await rtc.connect();
  rtc.connectionFailed(new RemoteKitError('forbidden', 'please retry'));
  assert.equal(rtc.getSnapshot().phase, 'exhausted');
});
