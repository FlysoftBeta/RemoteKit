import { testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlDatabase } from '../server/persistence/database';
import { Control } from '../server/control';
import type { EndpointLink } from '../server/endpoint/link';
import type { RtcSignal } from '../server/endpoint/types';

class SignalEndpoint implements EndpointLink {
  readonly state = { state: 'ready' as const, incarnation: 'test', connectionEpoch: 'test' };
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
    if (method === 'rtc.authorize') return { applied: true, epoch: args.epoch };
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
  const store = new ControlDatabase(':memory:'),
    endpoint = new SignalEndpoint(),
    control = new Control(store, testGateway(endpoint));
  try {
    const a = await store.accounts.register('signal-a', 'password-a');
    await store.accounts.setRegistrationCredential(a.tenantId, 'signal-registration');
    const b = await store.accounts.register('signal-b', 'password-b', 'signal-registration');
    await control.attachViewer(
      a.tenantId,
      'lease-a',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    await control.attachViewer(
      b.tenantId,
      'lease-b',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const events: any[] = [];
    control.on('rtc.signal', (...event) => events.push(event));
    const first = control.offer(
      a.tenantId,
      { type: 'offer', sdp: 'v=0\r\n', attemptId: 'attempt-a' },
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
      { code: 'forbidden' },
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
    control.clearSignals();
    store.db.close();
  }
});
test('close cancels a pending answer immediately and late answers are ignored', async () => {
  const store = new ControlDatabase(':memory:'),
    endpoint = new SignalEndpoint(),
    control = new Control(store, testGateway(endpoint));
  try {
    const a = await store.accounts.register('signal-c', 'password-c');
    await control.attachViewer(
      a.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const pending = control.offer(
      a.tenantId,
      { type: 'offer', sdp: 'v=0\r\n', attemptId: 'cancel' },
      'lease',
    );
    const failed = assert.rejects(pending, { code: 'unavailable' }),
      connection = await offered(endpoint, a.tenantId);
    await control
      .closeRtc(a.tenantId, { connectionId: connection }, 'lease')
      .catch((error) => assert.equal(error.code, 'forbidden'));
    await failed;
    endpoint.signal(a.tenantId, connection, { type: 'answer', sdp: 'v=0\r\n' });
  } finally {
    control.clearSignals();
    store.db.close();
  }
});
