import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Control } from '../server/control';
import { Store } from '../server/store';
import type { ClientActionEvent } from '../server/endpoint';
import { parseNetworkSimulation } from '../server/network-sim.mjs';

const sdp =
  'v=0\r\na=group:BUNDLE 0\r\nm=video 12345 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 127.0.0.1\r\na=rtcp-mux\r\na=candidate:1 1 udp 100 127.0.0.1 12345 typ host\r\n';
class Endpoint {
  listener?: (event: ClientActionEvent) => void;
  calls: { method: string; args: any }[] = [];
  views: any[] = [];
  offerReply?: Promise<any>;
  ensureReply?: Promise<void>;
  onClientAction(listener: (event: ClientActionEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async request(method: string, _tenant: string, args: any = {}) {
    this.calls.push({ method, args });
    if (method === 'session.snapshot')
      return { running: true, browserIncarnation: 'browser', views: this.views };
    if (method === 'rtc.offer') return this.offerReply ?? { sdp };
    if (method === 'view.ensure')
      this.views.push({ viewId: args.viewId, url: args.url, instance: '1', document: '1' });
    if (method === 'view.navigate') await this.ensureReply;
    return { accepted: true, applied: true };
  }
}
async function fixture(simulation = false) {
  const store = new Store(':memory:'),
    endpoint = new Endpoint(),
    control = new Control(store, endpoint, simulation ? parseNetworkSimulation('{}') : undefined);
  const { tenantId: tenant } = await store.register('offer-actions', 'password123');
  await control.attachViewer(tenant, 'lease', () => {});
  const operation = () => ({
    operationId: randomUUID(),
    operationGeneration: store.operationGeneration(tenant),
    action: { type: 'window.create' as const },
  });
  return { store, endpoint, control, tenant, operation };
}
for (const simulation of [false, true])
  test(`full-gather ${simulation ? 'simulation' : 'compatibility'} accepts product.action and returns durable receipt`, async () => {
    const f = await fixture(simulation);
    try {
      const answer = await f.control.offer(f.tenant, { type: 'offer', sdp }, 'lease');
      assert.equal(answer.signalingMode, simulation ? 'full-gather-simulation' : 'full-gather-compatibility');
      const op = f.operation();
      f.endpoint.listener!({ ...op, tenantId: f.tenant, connectionId: answer.connectionId });
      await f.control.serial(f.tenant, async () => {});
      const result = f.endpoint.calls.find((call) => call.method === 'rtc.actionResult')?.args;
      assert.equal(result?.connectionId, answer.connectionId);
      assert.equal(result?.result.status, 'committed');
      assert.deepEqual(f.control.operationStatus(f.tenant, op), result.result);
      assert.equal(f.store.workspace(f.tenant).windows.length, 1);
      await f.control.closeRtc(f.tenant, { connectionId: answer.connectionId }, 'lease');
      f.endpoint.listener!({ ...f.operation(), tenantId: f.tenant, connectionId: answer.connectionId });
      await f.control.serial(f.tenant, async () => {});
      assert.equal(f.store.workspace(f.tenant).windows.length, 1);
      assert.equal((f.control as any).connectionLeases.size, 0);
    } finally {
      await f.control.close();
      f.store.db.close();
    }
  });

for (const simulation of [false, true])
  test(`full-gather ${simulation ? 'simulation' : 'compatibility'} late answer after takeover cannot publish the old peer or action lease`, async () => {
    const f = await fixture(simulation);
    try {
      let release!: (value: any) => void;
      f.endpoint.offerReply = new Promise((resolve) => {
        release = resolve;
      });
      const offer = f.control.offer(f.tenant, { type: 'offer', sdp }, 'lease');
      const rejected = assert.rejects(offer, /接管/);
      for (let i = 0; i < 30 && !f.endpoint.calls.some((call) => call.method === 'rtc.offer'); i++)
        await new Promise((resolve) => setImmediate(resolve));
      const old = f.endpoint.calls.find((call) => call.method === 'rtc.offer')!.args.connectionId;
      const takeover = f.control.attachViewer(f.tenant, 'replacement', () => {});
      release({ sdp });
      await rejected;
      await takeover;
      assert.equal((f.control as any).connections.has(f.tenant), false);
      assert.equal((f.control as any).connectionLeases.has(old), false);
      assert.equal((f.control as any).relays.size, 0);
      assert.ok(
        f.endpoint.calls.some((call) => call.method === 'rtc.close' && call.args.connectionId === old),
      );
      f.endpoint.offerReply = undefined;
      const answer = await f.control.offer(f.tenant, { type: 'offer', sdp }, 'replacement');
      assert.equal((f.control as any).connectionLeases.get(answer.connectionId), 'replacement');
      await f.control.handleEndpointAction({ ...f.operation(), tenantId: f.tenant, connectionId: old });
      assert.equal(f.store.workspace(f.tenant).windows.length, 0);
    } finally {
      await f.control.close();
      f.store.db.close();
    }
  });

test('late Control completion remains status-queryable after Native uncertain receipt without replay', async () => {
  const f = await fixture();
  try {
    const answer = await f.control.offer(f.tenant, { type: 'offer', sdp }, 'lease');
    await f.control.productAction(f.tenant, { type: 'window.create', url: 'https://old.test/' }, 'lease');
    let release!: () => void;
    f.endpoint.ensureReply = new Promise((resolve) => {
      release = resolve;
    });
    const op = {
      ...f.operation(),
      action: {
        type: 'tab.navigate' as const,
        tabId: f.store.workspace(f.tenant).tabs[0].id,
        url: 'https://example.test/',
      },
    };
    const pending = f.control.handleEndpointAction({
      ...op,
      tenantId: f.tenant,
      connectionId: answer.connectionId,
    });
    for (let i = 0; i < 30 && !f.endpoint.calls.some((call) => call.method === 'view.navigate'); i++)
      await new Promise((resolve) => setImmediate(resolve));
    const during = f.control.operationStatus(f.tenant, op).status;
    // Native may already have returned unknown; it does not change Control's
    // durable receipt or cancel the accepted work.
    release();
    await pending;
    assert.equal(during, 'applying');
    f.endpoint.views[0].navigationOperations = [{ ...op, state: 'committed', url: 'https://example.test/' }];
    await f.control.tick();
    assert.equal(
      (await f.control.viewerRequest(f.tenant, 'lease', 'operation.status', op)).status,
      'committed',
    );
    assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.navigate').length, 1);
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});
