import { NodeRegistry } from '../server/cluster/node-link';
import type { SessionPlacement } from '../server/cluster/placement';
import { nodeDefaults } from '../server/config';
import { RemoteKitError } from '../shared/errors';
import { EndpointGateway } from '../server/endpoint/gateway';
import type { EndpointLink, EndpointLinkState } from '../server/endpoint/link';
import type { Clock } from '../server/util/clock';
export function testGateway(
  link: Pick<EndpointLink, 'request' | 'onSignal' | 'onClientAction'> & { state?: EndpointLinkState },
): EndpointGateway {
  const nodes = new NodeRegistry({
    nodes: { fixture: { config: { ...nodeDefaults, nodeId: 'fixture' }, configHash: 'fixture' } },
    key: Buffer.alloc(32).toString('base64'),
    buildId: 'dev',
  });
  const node = nodes.get('fixture')!;
  Object.defineProperty(node, 'state', {
    get: () => link.state ?? { state: 'ready', incarnation: 'fixture', connectionEpoch: 'fixture' },
  });
  node.request = async (method, tenant, args) =>
    method === 'session.open' ? {} : link.request(method, tenant, args);
  if (link.onSignal) node.onSignal = link.onSignal.bind(link);
  if (link.onClientAction) node.onClientAction = link.onClientAction.bind(link);
  const placements = new Map<string, SessionPlacement>();
  return new EndpointGateway(nodes, {
    peek: (tenant) => placements.get(tenant),
    resolve: (tenant) => {
      if (node.state.state !== 'ready') throw new RemoteKitError('unavailable', 'Fixture offline');
      let placement = placements.get(tenant);
      if (!placement) {
        placement = {
          tenant,
          sessionId: tenant,
          nodeId: 'fixture',
          placementEpoch: 1,
          keyCiphertext: '',
          state: 'active',
          checkpointId: null,
          checkpoint: null,
        };
        placements.set(tenant, placement);
      }
      return placement;
    },
    keys: () => ({
      profileKey: Buffer.alloc(32).toString('base64'),
    }),
    underPressure: () => false,
    beginHibernation: (tenant) => {
      const placement = placements.get(tenant);
      if (!placement || placement.state === 'hibernated')
        throw new RemoteKitError('conflict', 'Session is not active');
      placement.state = 'hibernating';
      return { ...placement, state: 'hibernating' as const };
    },
    settleHibernation: (placement, state) => {
      const current = placements.get(placement.tenant);
      if (!current || current.placementEpoch !== placement.placementEpoch) return false;
      current.state = state;
      return true;
    },
    commitCheckpoint: () => 1,
    markWarm: () => {},
    activeSessions: (nodeId) =>
      [...placements.values()].filter((p) => p.nodeId === nodeId && p.state === 'active').length,
    evacuate: () => {},
    activeTenants: (nodeId) =>
      [...placements.values()]
        .filter((p) => p.nodeId === nodeId && p.state === 'active')
        .map((p) => p.tenant),
    forgetTenant: (tenant) => {
      const sessionId = placements.get(tenant)?.sessionId;
      placements.delete(tenant);
      return sessionId;
    },
    checkpoints: () => ({ count: 0, latestAt: null, latestBytes: 0 }),
  });
}
export class TestClock implements Clock {
  private monotonic = 0;
  private wall = 1800000000000;
  monotonicMs() {
    return this.monotonic;
  }
  wallMs() {
    return this.wall;
  }
  advance(ms: number) {
    this.monotonic += ms;
    this.wall += ms;
  }
}

import type { DomainServices } from '../server/application';
import { dispatchViewerRequest } from '../server/http/viewer-socket';
export function requestViewer(
  services: DomainServices,
  tenantId: string,
  leaseId: string,
  method: string,
  params: any,
): Promise<any> {
  return dispatchViewerRequest(
    services,
    { tenantId, leaseId, epoch: services.viewers.productEpoch(tenantId, leaseId)! },
    method,
    params,
  );
}

import { AccountService } from '../server/auth/accounts';
import type { ControlDatabase } from '../server/persistence/database';
export function accountsFor(store: ControlDatabase) {
  return new AccountService(store);
}
// The first account is created by setup; later accounts are created by the administrator.
export async function registerUser(store: ControlDatabase, username: string, password: string) {
  const accounts = new AccountService(store);
  if (accounts.setupStatus().setupRequired) return accounts.setup(username, password);
  await accounts.createUser(username, password);
  return accounts.login(username, password);
}
