import { EventEmitter } from 'node:events';
import { BackgroundJob } from '../server/background';
import { SessionPurge } from '../server/cluster/session-purge';
import { ControlDatabase } from '../server/persistence/database';
import type { NodeRegistry } from '../server/cluster/node-link';
import { RtcSignaling } from '../server/viewers/rtc-signaling';
import { TenantRuntime } from '../server/tenants/tenant-runtime';
import type { DomainContext, DomainServices } from '../server/application';
import { SessionEvents } from '../server/workspace/session-events';
import { TenantRegistry } from '../server/tenants/tenant-registry';
import { systemClock } from '../server/util/clock';
import { emptyWorkspace } from '../server/persistence/workspaces';
import type { EventsAck, SessionEvent } from '../server/endpoint/coordination';
import { testGateway, TestClock } from './server-fixture';
import { installDesiredSource } from './coordination-fixture';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export const driveBackground: OwnerFactory = (boundary) => {
  const owner = new BackgroundJob('matrix.background', {});
  const run = () =>
    owner.run(() => boundary.call({ input: boundary.version }, undefined), String(boundary.version));
  return {
    start: run,
    drive: run,
    changeInput: () => {
      boundary.version++;
      return run();
    },
    error: () => owner.retry.error,
    dispose: () => owner.close(),
  };
};

export function drivePublicationKind(kind: 'desired' | 'clipboard'): OwnerFactory {
  return (boundary) => {
    const owner = testGateway({ request: async () => ({}) });
    owner.placement.resolve('tenant');
    installDesiredSource(owner);
    const node = owner.nodes.get('fixture')!;
    node.coordinate = async () => {};
    node.publish = (message) =>
      (message as { method: string }).method === 'session.' + kind
        ? boundary.call(message, {})
        : Promise.resolve({});
    let error: unknown;
    const run = async () => {
      try {
        await owner.published('tenant');
        error = undefined;
      } catch (cause) {
        error = cause;
      }
    };
    return {
      start: run,
      drive: run,
      changeInput: () => {
        owner.placement.resolve('tenant').placementEpoch++;
        return run();
      },
      error: () => error,
      dispose: () => owner.setDesiredSource(),
    };
  };
}
export const drivePublication = drivePublicationKind('desired');

export const drivePurge: OwnerFactory = (boundary) => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const node = {
    nodeId: 'node',
    state: { state: 'ready', connectionEpoch: 'one' },
    request: (_method: string, _tenant: string, fields: unknown, _timeout: unknown, identity: string) =>
      boundary.call({ fields, identity }, {}),
  };
  const nodes = Object.assign(new EventEmitter(), {
    all: () => [node],
    get: () => node,
    options: { buildId: 'test' },
  }) as unknown as NodeRegistry;
  const owner = new SessionPurge(store, nodes);
  owner.enqueue('session');
  return {
    start: () => owner.flush(),
    drive: () => owner.flush(),
    changeInput: () => {
      node.state.connectionEpoch = 'changed';
      return owner.flush();
    },
    error: () => owner.failures()[0]?.error,
    dispose: async () => {
      await owner.close();
      store.db.close();
    },
  };
};

export const driveRtcRetirement: OwnerFactory = (boundary) => {
  const runtime = new TenantRuntime('tenant', new TestClock());
  let epoch = 'one';
  const context = {
    tenants: { get: () => runtime, forConnection: () => runtime },
    store: { buildId: 'test' },
    endpoint: {
      placement: { peek: () => ({ sessionId: 'session', placementEpoch: 1 }) },
      observation: () => ({ connectionEpoch: epoch }),
      closeRtc: (_tenant: string, args: unknown) => boundary.call(args, { accepted: true }),
    },
  } as unknown as DomainContext;
  const owner = new RtcSignaling(context, {} as DomainServices);
  runtime.beginRtc('peer', 'attempt', 'lease');
  return {
    start: () => owner.closeMedia('tenant'),
    drive: () => owner.closeMedia('tenant'),
    changeInput: () => {
      epoch = 'changed';
      return owner.closeMedia('tenant');
    },
    error: () => runtime.lastError,
    dispose: () => {},
  };
};

export const driveRtcReconnection: OwnerFactory = (boundary) => {
  const runtime = new TenantRuntime('tenant', new TestClock());
  runtime.beginRtc('peer', 'attempt', 'lease');
  runtime.pendingRtcCheck = true;
  const context = {
    tenants: { get: () => runtime },
    endpoint: {
      placement: { peek: () => ({ sessionId: 'session', placementEpoch: boundary.version }) },
      observation: () => ({ connectionEpoch: 'epoch' }),
      snapshot: () => boundary.call({ tenant: 'tenant' }, { rtc: { active: true, connectionId: 'peer' } }),
    },
  } as unknown as DomainContext;
  const owner = new RtcSignaling(context, {} as DomainServices);
  const result = operation();
  const run = () => result.run(() => owner.checkReconnectedRtc('tenant'));
  return {
    start: run,
    drive: run,
    changeInput: () => {
      boundary.version++;
      run();
    },
    error: () => runtime.lastError,
    dispose: () => {},
  };
};

export function driveEvents(path: 'delivery' | 'download' | 'dispatch'): OwnerFactory {
  return (boundary, t) => {
    const store = new ControlDatabase(':memory:', { buildId: 'test' });
    store.accounts.insertUser({
      id: 'user',
      username: 'user',
      tenant: 'tenant',
      salt: '',
      password_hash: '',
      is_admin: 0,
    });
    store.workspaces.writeWorkspace(emptyWorkspace('tenant'));
    let epoch = 'one';
    let fault: unknown;
    const callbacks: (() => void)[] = [];
    if (path === 'dispatch') {
      const interval = setInterval;
      t.mock.method(globalThis, 'setInterval', (callback: () => void, ms: number) => {
        callbacks.push(callback);
        return interval(callback, ms);
      });
      const pending = store.coordination.pendingDownloads.bind(store.coordination);
      t.mock.method(store.coordination, 'pendingDownloads', () =>
        boundary.callSync({ query: 'pending-downloads' }, pending()),
      );
    }
    const context = {
      store,
      clock: systemClock,
      events: new EventEmitter(),
      tenants: new TenantRegistry(systemClock),
      endpoint: {
        nodes: Object.assign(new EventEmitter(), {
          get: () => ({ state: { state: 'ready', connectionEpoch: epoch } }),
        }),
        placement: { peek: () => ({ nodeId: 'node', sessionId: 'a'.repeat(32), placementEpoch: 1 }) },
        sessionFault: () => fault,
        faultSession: (_tenant: string, error: unknown) => {
          fault = error;
        },
        acknowledge: (ack: EventsAck) =>
          path === 'delivery'
            ? boundary.call({ streamId: ack.streamId, upTo: ack.upTo }, {})
            : Promise.resolve({}),
      },
    } as unknown as DomainContext;
    const owner = new SessionEvents(context, {
      viewers: { push: () => {} },
      pageRequests: { removeProductTab: () => {} },
      library: { consumeDownload: (_tenant: string, event: unknown) => boundary.call(event, undefined) },
    } as unknown as DomainServices);
    const result = operation();
    const receive = () =>
      result.run(() =>
        owner.receive('node', {
          event: 'session.event',
          tenantId: 'tenant',
          sessionId: 'a'.repeat(32),
          placementEpoch: 1,
          connectionEpoch: epoch,
          streamId: 'stream',
          seq: '1',
          eventId: 'event',
          browserIncarnation: 'browser',
          ...(path === 'download'
            ? {
                type: 'download.imported',
                body: {
                  name: 'file',
                  assetId: 'a'.repeat(64),
                  size: '1',
                  mimeType: 'text/plain',
                  origin: 'https://example.test',
                },
              }
            : { type: 'view.closed', body: { viewId: '1', reason: 'script' } }),
        } as SessionEvent),
      );
    const run = () =>
      path === 'dispatch'
        ? callbacks.forEach((callback) => callback())
        : path === 'download'
          ? owner.reconcileDownloads()
          : receive();
    return {
      start: path === 'download' ? receive : run,
      drive: run,
      changeInput: () => {
        epoch = 'changed';
        fault = undefined;
        Object.defineProperty(store, 'buildId', { value: 'changed', configurable: true });
        return run();
      },
      error: () =>
        owner.failures()[0]?.error ?? fault ?? context.tenants.get('tenant').lastError ?? result.error(),
      dispose: async () => {
        await owner.close();
        await context.tenants.close();
        store.db.close();
      },
    };
  };
}
export const driveEventDelivery = driveEvents('delivery');
