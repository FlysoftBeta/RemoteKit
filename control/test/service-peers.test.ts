import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { DomainContext, DomainServices } from '../server/application';
import type { ViewerSecurityState } from '../server/auth/viewer-security';
import type { RtcSignal } from '../server/endpoint/types';
import { TenantRuntime } from '../server/tenants/tenant-runtime';
import { ServicePeers } from '../server/viewers/service-peers';
import { RemoteKitError } from '../shared/errors';
import { TestClock } from './server-fixture';

test('an offline service peer retains cleanup without blocking a surviving node', async () => {
  const runtime = new TenantRuntime('tenant', new TestClock());
  const security = {
    user: { id: 'user', username: 'user', isAdmin: false },
    lock: { state: 'unlocked', epoch: 1 },
    get locked() {
      return this.lock.state !== 'unlocked';
    },
    get epoch() {
      return this.lock.epoch;
    },
    face: { available: true },
    polling: false,
    mutating: false,
  } as ViewerSecurityState;
  runtime.viewer = {
    generation: 1,
    id: 'lease',
    security,
    authentication: { identity: 'user', valid: () => true },
    revoke: () => {},
  };
  const calls: { nodeId: string; method: string; params: Record<string, unknown>; identity?: string }[] = [];
  const nodes = ['alpha', 'beta'].map((nodeId, index) => {
    let signal: ((event: RtcSignal) => void) | undefined;
    return {
      nodeId,
      state: { state: 'ready', connectionEpoch: `${nodeId}-epoch`, incarnation: `${nodeId}-process` },
      metrics: { predicted: () => index },
      onFaceChanged: () => () => {},
      onSignal(callback: typeof signal) {
        signal = callback;
        return () => {
          signal = undefined;
        };
      },
      async request(
        method: string,
        _tenant: string,
        params: Record<string, unknown>,
        _timeout?: unknown,
        identity?: string,
      ) {
        calls.push({ nodeId, method, params, identity });
        if (this.state.state !== 'ready') throw new RemoteKitError('unavailable', 'Node is offline');
        if (method === 'service.offer')
          queueMicrotask(() =>
            signal?.({
              tenantId: 'tenant',
              connectionId: params.connectionId as string,
              signal: { type: 'answer', sdp: 'v=0' },
            }),
          );
        return { accepted: true, closed: true };
      },
    };
  });
  const context = {
    tenants: { get: () => runtime },
    events: new EventEmitter(),
    endpoint: {
      nodes: { all: () => nodes, isRemoved: () => false },
      placement: { peek: () => undefined },
    },
  } as unknown as DomainContext;
  const services = {
    viewers: { assertViewer: () => {}, authState: () => ({}) },
    security: {
      capabilities: async () => {},
      forgetServicePeer: () => {
        security.servicePeer = undefined;
        security.face = { available: false };
      },
    },
  } as unknown as DomainServices;
  const owner = new ServicePeers(context, services);
  try {
    const first = await owner.offer('tenant', { type: 'offer', sdp: 'v=0', attemptId: 'first' }, 'lease');
    assert.equal(owner.hasGrant('tenant', 'alpha'), true);
    nodes[0].state.state = 'offline';
    await owner.tick();
    assert.equal(owner.hasGrant('tenant', 'alpha'), false);
    const second = await owner.offer('tenant', { type: 'offer', sdp: 'v=0', attemptId: 'second' }, 'lease');
    assert.notEqual(second.connectionId, first.connectionId);
    assert.equal(owner.hasGrant('tenant', 'beta'), true);
    const peer = security.servicePeer;
    nodes[0].state.state = 'ready';
    nodes[0].state.connectionEpoch = 'alpha-reconnected';
    await owner.tick();
    const closes = calls.filter((call) => call.nodeId === 'alpha' && call.method === 'service.close');
    assert.ok(closes.length >= 2);
    assert.ok(closes.every((call) => call.params.connectionId === first.connectionId));
    assert.ok(closes.every((call) => call.identity === closes[0].identity));
    assert.equal(security.servicePeer, peer);
    assert.equal(security.face.error, undefined);
    assert.equal(owner.hasGrant('tenant', 'beta'), true);
    nodes[1].state.state = 'offline';
    await owner.tick();
    await owner.offer('tenant', { type: 'offer', sdp: 'v=0', attemptId: 'third' }, 'lease');
    const betaCloses = calls.filter(
      (call) => call.nodeId === 'beta' && call.method === 'service.close',
    ).length;
    nodes[1].state.state = 'ready';
    nodes[1].state.connectionEpoch = 'beta-replaced';
    nodes[1].state.incarnation = 'beta-new-process';
    await owner.tick();
    assert.equal(
      calls.filter((call) => call.nodeId === 'beta' && call.method === 'service.close').length,
      betaCloses,
      'a replacement Endpoint proves the old peer is gone without receiving its cleanup',
    );
    assert.equal(owner.hasGrant('tenant', 'alpha'), true);
  } finally {
    nodes[0].state.state = 'ready';
    nodes[0].state.connectionEpoch = 'alpha-cleanup';
    await owner.dispose();
  }
});
