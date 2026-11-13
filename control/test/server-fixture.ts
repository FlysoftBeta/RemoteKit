import { randomUUID } from 'node:crypto';
import type { ProductAction, ProductOperation } from '../shared/product';
import { nativeError } from '../shared/errors';
import { createHash } from 'node:crypto';
import { observedSession } from './coordination-fixture';
import type { SessionDesired } from '../server/endpoint/coordination';
import type { EndpointSnapshot } from '../server/endpoint/types';
import { NodeRegistry } from '../server/cluster/node-link';
import type { SessionPlacement } from '../server/cluster/placement';
import { endpointDefaults, testNode, nodePrivateKey } from './node-fixture';
import { RemoteKitError } from '../shared/errors';
import { EndpointGateway } from '../server/endpoint/gateway';
import type { EndpointLink, EndpointLinkState } from '../server/endpoint/link';
import type { Clock } from '../server/util/clock';
export function testGateway(
  link: Pick<EndpointLink, 'request' | 'onSignal'> & {
    state?: EndpointLinkState;
    observe?: (tenant: string) => Partial<EndpointSnapshot>;
  },
): EndpointGateway {
  const nodes = new NodeRegistry({
    nodes: { fixture: testNode('fixture') },
    privateKey: Buffer.alloc(32).toString('base64'),
    buildId: 'dev',
  });
  const node = nodes.get('fixture')!;
  Object.defineProperty(node, 'state', {
    get: () => link.state ?? { state: 'ready', incarnation: 'fixture', connectionEpoch: 'fixture' },
  });
  if (link.onSignal) node.onSignal = link.onSignal.bind(link);
  const placements = new Map<string, SessionPlacement>();
  const gateway = new EndpointGateway(nodes, {
    peek: (tenant) => placements.get(tenant),
    resolve: (tenant) => {
      if (node.state.state !== 'ready') throw new RemoteKitError('unavailable', 'Fixture offline');
      let placement = placements.get(tenant);
      if (!placement) {
        placement = {
          tenant,
          sessionId: createHash('sha256').update(tenant).digest('hex').slice(0, 32),
          nodeId: 'fixture',
          placementEpoch: 1,
          keyCiphertext: '',
          runState: 'running',
          dataState: 'dirty',
          pendingCommit: null,
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
    beginStop: (tenant) => {
      const placement = placements.get(tenant);
      if (!placement || (placement.runState === 'stopped' && placement.dataState === 'clean'))
        throw new RemoteKitError('conflict', 'Session is not active');
      placement.runState = 'stopped';
      placement.pendingCommit ??= 'fixture-commit';
      return { ...placement, runState: 'stopped' as const, pendingCommit: placement.pendingCommit };
    },
    cancelStop: (placement) => {
      const current = placements.get(placement.tenant);
      if (!current || current.placementEpoch !== placement.placementEpoch) return false;
      current.runState = 'running';
      current.dataState = 'dirty';
      current.pendingCommit = null;
      return true;
    },
    newestComplete: () => null,
    transfer: (tenant) => {
      const current = placements.get(tenant)!;
      current.runState = 'stopped';
      current.dataState = 'clean';
      current.pendingCommit = null;
      current.placementEpoch++;
      return { ...current, runState: 'stopped' as const, dataState: 'clean' as const };
    },
    commitCheckpoint: (placement, manifestId) => {
      Object.assign(placements.get(placement.tenant)!, {
        runState: 'stopped',
        dataState: 'clean',
        pendingCommit: null,
        checkpoint: manifestId,
        checkpointId: 1,
      });
      return 1;
    },
    markWarm: () => {},
    activeSessions: (nodeId) =>
      [...placements.values()].filter((p) => p.nodeId === nodeId && p.runState === 'running').length,
    evacuate: () => {},
    activeTenants: (nodeId) =>
      [...placements.values()]
        .filter((p) => p.nodeId === nodeId && p.runState === 'running')
        .map((p) => p.tenant),
    forgetTenant: (tenant) => {
      const sessionId = placements.get(tenant)?.sessionId;
      placements.delete(tenant);
      return sessionId;
    },
    checkpoints: () => ({ count: 0, latestAt: null, latestBytes: 0 }),
  });
  const documents = new Map<string, SessionDesired>();
  const failures = new Map<string, any>();
  const applied = new Map<string, SessionDesired>();
  let sequence = 0n;
  node.coordinate = async () => {
    for (const [tenant, document] of documents)
      if (failures.has(tenant)) {
        try {
          await link.request('session.desired', tenant, { ...document });
          failures.delete(tenant);
          applied.set(tenant, document);
        } catch {}
      }
  };
  const refresh = (tenant: string) => {
    const placement = placements.get(tenant);
    if (!placement || node.state.state !== 'ready') return;
    const desired = documents.get(tenant);
    const value = observedSession(
      { tenantId: tenant, sessionId: placement.sessionId, placementEpoch: placement.placementEpoch },
      node.state.connectionEpoch,
      node.state.incarnation,
      desired,
      link.observe?.(tenant),
    );
    value.seq = String(++sequence);
    const appliedRevision = applied.get(tenant)?.revision ?? '0';
    value.applied.sitePreferencesRevision = appliedRevision;
    value.applied.viewsRevision = appliedRevision;
    value.applied.mediaPolicyRevision = appliedRevision;
    value.applied.clipboardRevision = applied.get(tenant)?.clipboard.revision ?? '0';
    value.converged = appliedRevision === (desired?.revision ?? '0');
    if (applied.has(tenant)) {
      const actual = applied.get(tenant)!;
      value.authorization = {
        ...actual.authorization,
        revoked: !actual.authorization.unlocked,
        filesApplied: actual.authorization.unlocked,
      };
      value.lock = actual.lock;
    }
    if (failures.has(tenant)) {
      value.lastError = failures.get(tenant);
      value.converged = false;
    }
    return value;
  };
  node.observations.get = (tenant: string) => refresh(tenant);
  node.publish = async (message: any) => {
    if (message.method === 'session.events.ack' || message.method === 'session.clipboard')
      return link.request(message.method, message.tenantId, message);
    documents.set(message.tenantId, message);
    void (async () => {
      try {
        await link.request('session.desired', message.tenantId, message);
        if (BigInt(applied.get(message.tenantId)?.revision ?? '0') <= BigInt(message.revision)) {
          failures.delete(message.tenantId);
          applied.set(message.tenantId, message);
        }
      } catch (error: any) {
        if (documents.get(message.tenantId) === message)
          failures.set(message.tenantId, {
            code: error.code ?? 'internal',
            message: error.message ?? String(error),
          });
      }
      const observation = refresh(message.tenantId)!;
      nodes.emit('session.observed', { nodeId: 'fixture', message: observation });
      node.emit('session.observed', observation);
    })();
    return { accepted: true, revision: message.revision };
  };
  node.invoke = async (request) => link.request(request.method, request.tenantId, request.params);
  return gateway;
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

export async function submitViewerAction(
  services: DomainServices,
  tenant: string,
  lease: string,
  action: ProductAction,
) {
  const receipt = await requestViewer(services, tenant, lease, 'operation.submit', {
    operationId: randomUUID(),
    operationGeneration: services.store.operations.operationGeneration(tenant),
    action,
  });
  if (receipt.status === 'failed') throw nativeError(receipt.error);
  return receipt;
}

export async function observedProductAction(
  services: DomainServices,
  tenant: string,
  action: ProductAction,
  lease?: string,
) {
  const result = await services.operations.productAction(tenant, action, lease);
  await services.reconciler.reconcileProduct(tenant);
  return { ...result, state: services.viewers.productState(tenant) };
}

export async function observedOperation(
  services: DomainServices,
  tenant: string,
  operation: ProductOperation,
  lease: string,
) {
  await services.operations.submitOperation(tenant, operation, lease);
  await services.reconciler.reconcileProduct(tenant);
  return services.operations.operationStatus(tenant, operation);
}
