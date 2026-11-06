import { registerUser } from './server-fixture';
import { accountsFor } from './server-fixture';
import { requestViewer } from './server-fixture';
import { testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication, type DomainServices } from '../server/application';
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
    if (method === 'rtc.offer')
      return { accepted: true, avSync: args.avSync, pending: true, connectionId: args.connectionId };
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
    control = createApplication(store, testGateway(endpoint));
  try {
    const a = await registerUser(store, 'signal-a', 'password-a');
    const b = await registerUser(store, 'signal-b', 'password-b');
    await control.viewers.attachViewer(
      a.tenantId,
      'lease-a',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    await control.viewers.attachViewer(
      b.tenantId,
      'lease-b',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    await requestViewer(control, a.tenantId, 'lease-a', 'action', {
      type: 'settings.update',
      settings: { avSync: true },
    });
    const events: any[] = [];
    control.events.on('rtc.signal', (...event) => events.push(event));
    const first = control.rtc.offer(
      a.tenantId,
      { type: 'offer', sdp: 'v=0\r\n', attemptId: 'attempt-a' },
      'lease-a',
    );
    const connection = await offered(endpoint, a.tenantId);
    assert.equal(endpoint.calls.find((c) => c.method === 'rtc.offer')?.args.avSync, true);
    await requestViewer(control, b.tenantId, 'lease-b', 'clock.ping', {});
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
      requestViewer(control, a.tenantId, 'lease-a', 'rtc.ice', {
        connectionId: connection,
        attemptId: 'old',
        candidate,
      }),
      { code: 'forbidden' },
    );
    await requestViewer(control, a.tenantId, 'lease-a', 'rtc.ice', {
      connectionId: connection,
      attemptId: 'attempt-a',
      candidate,
    });
    endpoint.signal(a.tenantId, connection, { type: 'answer', sdp: 'v=0\r\n' });
    const reply = await first;
    assert.equal(reply.signalingMode, 'trickle');
    assert.equal(reply.avSync, true);
    await control.viewers.detachViewer(a.tenantId, 'lease-a');
    endpoint.signal(a.tenantId, connection, { type: 'ice', candidate });
    assert.equal(events.length, 1);
  } finally {
    control.rtc.clearSignals();
    store.db.close();
  }
});
test('close cancels a pending answer immediately and late answers are ignored', async () => {
  const store = new ControlDatabase(':memory:'),
    endpoint = new SignalEndpoint(),
    control = createApplication(store, testGateway(endpoint));
  try {
    const a = await registerUser(store, 'signal-c', 'password-c');
    await control.viewers.attachViewer(
      a.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const pending = control.rtc.offer(
      a.tenantId,
      { type: 'offer', sdp: 'v=0\r\n', attemptId: 'cancel' },
      'lease',
    );
    const failed = assert.rejects(pending, { code: 'unavailable' }),
      connection = await offered(endpoint, a.tenantId);
    await control.rtc
      .closeRtc(a.tenantId, { connectionId: connection }, 'lease')
      .catch((error) => assert.equal(error.code, 'forbidden'));
    await failed;
    endpoint.signal(a.tenantId, connection, { type: 'answer', sdp: 'v=0\r\n' });
  } finally {
    control.rtc.clearSignals();
    store.db.close();
  }
});
