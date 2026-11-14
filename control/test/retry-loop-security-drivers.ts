import { ViewerSecurity, transitionLock } from '../server/auth/viewer-security';
import type { ControlDatabase } from '../server/persistence/database';
import type { EndpointGateway } from '../server/endpoint/gateway';
import type { ServicePeers } from '../server/viewers/service-peers';
import type { AuthState } from '../shared/security';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveSecurity(
  path: 'capabilities' | 'status' | 'authorization' | 'revocation',
): OwnerFactory {
  return (boundary) => {
    let viewer: ReturnType<ViewerSecurity['create']>;
    const endpoint = {
      invalidate: () => {},
      isReady: () => true,
      sessionFault: () => undefined,
      published: () =>
        boundary.call(
          { connectionId: viewer.peer?.connectionId, epoch: viewer.peer?.epoch, locked: viewer.locked },
          { revision: '1' },
        ),
      waitObserved: async () => ({
        authorization: {
          connectionId: viewer.peer?.connectionId,
          epoch: viewer.peer?.epoch,
          unlocked: !viewer.locked,
        },
        lastError: null,
      }),
    } as unknown as EndpointGateway;
    const service = {
      faceCapabilities: () =>
        path === 'capabilities'
          ? boundary.call({ capabilities: 'tenant' }, { available: true, modelVersion: 'test' })
          : Promise.resolve({ available: true, modelVersion: 'test' }),
      faceStatus: (_tenant: string, args: unknown) =>
        path === 'status'
          ? boundary.call(args, { challengeId: 'challenge', status: 'pending' })
          : Promise.resolve({ challengeId: 'challenge', status: 'pending' }),
      cancelFace: async () => ({}),
    } as unknown as ServicePeers;
    const owner = new ViewerSecurity(
      {} as ControlDatabase,
      endpoint,
      service,
      () => {},
      () => true,
      () => {},
    );
    viewer = owner.create({ id: 'user' } as AuthState['user'], true);
    viewer.peer = { connectionId: 'connection', epoch: 0, appliedEpoch: 0, requests: 0 };
    viewer.servicePeer = { connectionId: 'service', epoch: 1, appliedEpoch: 1, requests: 0 };
    viewer.challenge = {
      id: 'challenge',
      peer: viewer.servicePeer,
      epoch: 1,
      purpose: 'presence',
      expires: Infinity,
      modelVersion: 'test',
      started: true,
    };
    const result = operation();
    const run = () => {
      if (path === 'capabilities') return owner.capabilities('tenant', viewer);
      if (path === 'status') return owner.poll('tenant', viewer);
      if (path === 'revocation') return owner.retryRevocations();
      result.run(() => owner.restore('tenant', viewer));
    };
    return {
      start: () => (path === 'revocation' ? owner.revokePeer('tenant', viewer) : run()),
      drive: run,
      changeInput: () => {
        transitionLock(viewer, viewer.lock.state);
        if (path === 'revocation') return owner.revokePeer('tenant', viewer);
        return run();
      },
      error: () =>
        path === 'authorization'
          ? result.error()
          : path === 'revocation' && !viewer.peer
            ? undefined
            : viewer.face.error,
      dispose: () => owner.close(),
    };
  };
}
