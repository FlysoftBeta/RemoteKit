import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store';
import { Control } from '../server/control';
import type { Endpoint, RtcSignal } from '../server/endpoint';

class SignalEndpoint implements Endpoint {
  listener?: (event: RtcSignal) => void;
  calls: { method: string; tenant: string; args: any }[] = [];
  onSignal(listener: (event: RtcSignal) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async request(method: string, tenant: string, args: any = {}) {
    this.calls.push({ method, tenant, args });
    if (method === 'session.snapshot') return { running: true, views: [], browserPid: 1 };
    if (method === 'session.ensure') return { running: true, browserPid: 1 };
    if (method === 'rtc.offer') return { accepted: true, pending: true, connectionId: args.connectionId };
    return { accepted: true, applied: true, closed: true };
  }
  signal(tenant: string, connectionId: string, signal: RtcSignal['signal']) {
    this.listener?.({ tenantId: tenant, connectionId, signal });
  }
}
async function offered(endpoint: SignalEndpoint, tenant: string) {
  for (let i = 0; i < 20; i++) {
    const call = endpoint.calls.find((c) => c.method === 'rtc.offer' && c.tenant === tenant);
    if (call) return call.args.connectionId as string;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('offer not accepted');
}
test('pending trickle offers allow other tenants and bind early candidates to connection/attempt/lease', async () => {
  const store = new Store(':memory:'),
    endpoint = new SignalEndpoint(),
    control = new Control(store, endpoint);
  try {
    const a = await store.register('signal-a', 'password-a');
    await store.setRegistrationCredential(a.tenantId, 'signal-registration');
    const b = await store.register('signal-b', 'password-b', 'signal-registration');
    await control.attachViewer(a.tenantId, 'lease-a', () => {});
    await control.attachViewer(b.tenantId, 'lease-b', () => {});
    assert.equal(control.productState(a.tenantId).viewer.trickleIce, true);
    const events: any[] = [];
    control.on('rtc.signal', (...event) => events.push(event));
    const first = control.offer(
      a.tenantId,
      { type: 'offer', sdp: 'v=0\r\n', trickle: true, attemptId: 'attempt-a' },
      'lease-a',
    );
    const connection = await offered(endpoint, a.tenantId);
    await control.viewerRequest(b.tenantId, 'lease-b', 'clock.ping', {});
    const candidate = {
      candidate: 'candidate:1 1 udp 1 127.0.0.1 9999 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    endpoint.signal(b.tenantId, connection, { type: 'ice', candidate });
    assert.equal(events.length, 0);
    endpoint.signal(a.tenantId, connection, { type: 'ice', candidate });
    assert.equal(events.length, 1);
    assert.equal(events[0][1], 'lease-a');
    assert.equal(events[0][2].attemptId, 'attempt-a');
    await assert.rejects(
      control.viewerRequest(a.tenantId, 'lease-a', 'rtc.ice', {
        connectionId: connection,
        attemptId: 'old',
        candidate,
      }),
      /失效/,
    );
    await control.viewerRequest(a.tenantId, 'lease-a', 'rtc.ice', {
      connectionId: connection,
      attemptId: 'attempt-a',
      candidate,
    });
    endpoint.signal(a.tenantId, connection, { type: 'answer', sdp: 'v=0\r\n' });
    assert.equal((await first).signalingMode, 'trickle');
    await control.detachViewer(a.tenantId, 'lease-a');
    endpoint.signal(a.tenantId, connection, { type: 'ice', candidate });
    assert.equal(events.length, 1);
  } finally {
    control.closeRelays();
    store.db.close();
  }
});
test('close cancels a pending answer immediately and late answers are ignored', async () => {
  const store = new Store(':memory:'),
    endpoint = new SignalEndpoint(),
    control = new Control(store, endpoint);
  try {
    const a = await store.register('signal-c', 'password-c');
    await control.attachViewer(a.tenantId, 'lease', () => {});
    const pending = control.offer(
      a.tenantId,
      { type: 'offer', sdp: 'v=0\r\n', trickle: true, attemptId: 'cancel' },
      'lease',
    );
    const failed = assert.rejects(pending, /取消/),
      connection = await offered(endpoint, a.tenantId);
    await control
      .closeRtc(a.tenantId, { connectionId: connection }, 'lease')
      .catch((error) => assert.match(String(error), /不属于/));
    await failed;
    endpoint.signal(a.tenantId, connection, { type: 'answer', sdp: 'v=0\r\n' });
  } finally {
    control.closeRelays();
    store.db.close();
  }
});
