import { EventEmitter } from 'node:events';
import { ServicePeers } from '../server/viewers/service-peers';
import { TenantRuntime } from '../server/tenants/tenant-runtime';
import { transitionLock, type ViewerSecurityState } from '../server/auth/viewer-security';
import type { DomainContext, DomainServices } from '../server/application';
import type { RtcSignal } from '../server/endpoint/types';
import { TestClock } from './server-fixture';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveServicePeer(path: 'authorization' | 'retirement'): OwnerFactory {
  return async (boundary) => {
    const runtime = new TenantRuntime('tenant', new TestClock());
    const security: ViewerSecurityState = {
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
    };
    runtime.viewer = {
      id: 'lease',
      security,
      authentication: { identity: 'user', valid: () => true },
      revoke: () => {},
    };
    let signal: ((event: RtcSignal) => void) | undefined;
    const node = {
      nodeId: 'node',
      state: { state: 'ready', connectionEpoch: 'epoch' },
      metrics: { predicted: () => 0 },
      onSignal: (callback: typeof signal) => {
        signal = callback;
        return () => {
          signal = undefined;
        };
      },
      request: async (
        method: string,
        _tenant: string,
        args: Record<string, unknown>,
        _timeout?: unknown,
        identity?: string,
      ) => {
        if (method === 'service.offer') {
          queueMicrotask(() =>
            signal?.({
              tenantId: 'tenant',
              connectionId: args.connectionId as string,
              signal: { type: 'answer', sdp: 'v=0' },
            }),
          );
          return { accepted: true };
        }
        if (method === (path === 'authorization' ? 'service.authorize' : 'service.close'))
          return boundary.call({ method, args, identity }, {});
        return {};
      },
    };
    const context = {
      tenants: { get: () => runtime },
      events: new EventEmitter(),
      endpoint: {
        nodes: { all: () => [node], isRemoved: () => false },
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
    await owner.offer('tenant', { type: 'offer', sdp: 'v=0', attemptId: 'attempt' }, 'lease');
    const result = operation();
    return {
      start: () => {
        if (path === 'authorization') {
          transitionLock(security, 'locked');
          return owner.tick();
        }
        result.run(() => owner.close('tenant'));
      },
      drive: () => owner.tick(),
      changeInput: () => {
        if (path === 'authorization') transitionLock(security, 'unlocked');
        else node.state.connectionEpoch = 'changed';
        return owner.tick();
      },
      error: () => security.face.error,
      dispose: () => owner.dispose(),
    };
  };
}
