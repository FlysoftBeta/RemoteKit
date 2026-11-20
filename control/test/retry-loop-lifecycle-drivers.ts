import { UncertainRecovery } from '../server/workspace/lifecycle';
import { Navigation } from '../server/workspace/navigation';
import { PageRequests } from '../server/workspace/page-requests';
import { ControlDatabase } from '../server/persistence/database';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { TenantRegistry } from '../server/tenants/tenant-registry';
import type { DomainContext, DomainServices } from '../server/application';
import type { ProductTab } from '../shared/product';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveLifecycle(path: 'pressure' | 'idle' | 'ordinary' | 'uncertain'): OwnerFactory {
  return (boundary) => {
    const clock = { wallMs: () => Date.now(), monotonicMs: () => Date.now() };
    const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
    const workspace = emptyWorkspace('tenant');
    const tab: ProductTab = {
      id: 'tab',
      windowId: 'window',
      webviewId: 'view',
      kind: 'remote',
      url: 'https://example.test',
      title: '',
      idleKeepAlive: false,
    };
    workspace.tabs = [tab];
    workspace.windows = [{ id: 'window', activeTabId: 'tab', appId: 'browser', lastActiveAt: 0 }];
    workspace.spaces = [
      {
        name: null,
        id: 'space',
        windowIds: ['window'],
        weights: [1],
        focusedWindowId: 'window',
        lastActiveAt: 0,
      },
    ];
    workspace.activeSpaceId = 'space';
    store.workspaces.writeWorkspace(workspace);
    const tenants = new TenantRegistry(clock);
    tenants.get('tenant').viewerAbsentSince = 0;
    const placement = { nodeId: 'node', sessionId: 'session', placementEpoch: 1, runState: 'running' };
    const node = {
      nodeId: 'node',
      state: { state: 'ready', connectionEpoch: 'epoch' },
      allocationFailedAt: undefined,
      metrics: {
        latest: () => ({ at: Date.now(), pressure: 1, value: { memory: { available: 10, total: 100 } } }),
        underPressure: () => path === 'pressure',
        predicted: () => 1,
        relieved: () => false,
      },
    };
    const current = {
      actual: 3,
      pending: false,
      lifecycle_generation: '1',
      lifecycle_uncertain: path === 'uncertain',
      canDiscard: true,
    };
    const snapshot = {
      running: true,
      browserIncarnation: 'browser',
      stopBlockers: {
        inFlightUploads: 0,
        pendingNativeSelections: 0,
        downloadsInProgress: 0,
        pendingDownloadImports: 0,
        pendingPageRequests: 0,
        unacknowledgedEvents: 0,
        rtcConnected: false,
        lifecycleUncertain: false,
      },
      views: [],
    };
    const context = {
      store,
      clock,
      tenants,
      endpoint: {
        nodes: { all: () => [node], get: () => node, isRemoved: () => false },
        placement: { peek: () => placement, activeTenants: () => ['tenant'], boundNodeId: () => null },
        isPlacedOn: () => true,
        snapshot: () =>
          path === 'pressure' ? boundary.call({ tenant: 'tenant' }, snapshot) : Promise.resolve(snapshot),
        stop: () =>
          path === 'idle'
            ? boundary.call(
                { session: placement.sessionId, placementEpoch: placement.placementEpoch },
                undefined,
              )
            : Promise.resolve(),
        lifecycle: (_tenant: string, request: unknown) => boundary.call(request, { accepted: true }),
      },
    } as unknown as DomainContext;
    const services = {
      operations: { saveWorkspace: store.workspaces.saveWorkspace.bind(store.workspaces) },
    } as unknown as DomainServices;
    const owner = new UncertainRecovery(context, services);
    const run = () =>
      path === 'pressure'
        ? owner.relieve()
        : path === 'idle'
          ? owner.stop('tenant', snapshot as never)
          : path === 'ordinary'
            ? owner.prepareVisible('tenant', 'view', true, current, false)
            : owner.advanceLifecycleRecovery(workspace, tab, current, 'browser', true);
    return {
      start: run,
      drive: run,
      changeInput: () => {
        node.state.connectionEpoch = 'changed';
        current.lifecycle_generation = '2';
        Object.defineProperty(store, 'buildId', { value: 'changed', configurable: true });
        return run();
      },
      error: () => owner.failures()[0],
      dispose: async () => {
        await tenants.close();
        store.db.close();
      },
    };
  };
}

export const driveNavigationAck: OwnerFactory = (boundary) => {
  const workspace = emptyWorkspace('tenant');
  const tab = { id: 'tab', webviewId: 'view', kind: 'remote' } as ProductTab;
  const receipt = { operationId: 'operation', operationGeneration: 'generation', status: 'committed' };
  const context = {
    store: {
      operations: {
        operation: () => ({ receipt, action: { type: 'tab.navigate', tabId: 'tab' } }),
        saveOperation: () => {},
      },
    },
    endpoint: { ackNavigation: (_tenant: string, request: unknown) => boundary.call(request, undefined) },
  } as unknown as DomainContext;
  const owner = new Navigation(context, {} as never);
  const current = {
    navigationOperations: [
      { operationId: 'operation', operationGeneration: 'generation', state: 'committed' },
    ],
  };
  const run = () =>
    owner.observe(workspace, tab, current, { browserIncarnation: 'browser-' + boundary.version });
  return {
    start: run,
    drive: run,
    changeInput: () => {
      boundary.version++;
      return run();
    },
    error: () => owner.failures()[0],
    dispose: () => {},
  };
};

export const driveCloseBatch: OwnerFactory = (boundary) => {
  const clock = { wallMs: () => Date.now(), monotonicMs: () => Date.now() };
  const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
  const workspace = emptyWorkspace('tenant');
  workspace.tabs = ['one', 'two'].map((id) => ({
    id,
    webviewId: id,
    windowId: 'window-' + id,
    kind: 'remote',
    url: 'https://example.test',
    title: '',
    idleKeepAlive: false,
  }));
  workspace.windows = ['one', 'two'].map((id) => ({
    id: 'window-' + id,
    activeTabId: id,
    appId: 'browser',
    lastActiveAt: 0,
  }));
  workspace.spaces = ['one', 'two'].map((id) => ({
    name: null,
    id: 'space-' + id,
    windowIds: ['window-' + id],
    weights: [1],
    focusedWindowId: 'window-' + id,
    lastActiveAt: 0,
  }));
  workspace.activeSpaceId = 'space-one';
  workspace.pendingWindowCloseId = 'window-one';
  workspace.pendingWindowCloseIds = ['window-two'];
  store.workspaces.writeWorkspace(workspace);
  const reserve = () =>
    store.operations.reserveOperation(
      'tenant',
      { type: 'space.close', spaceIds: ['space-one', 'space-two'] },
      {
        operationId: 'operation-' + boundary.version,
        operationGeneration: store.operations.operationGeneration('tenant'),
        status: 'accepted',
      },
    );
  reserve();
  const context = {
    clock,
    tenants: { get: () => ({ browserIncarnation: 'browser', pageRequests: {} }) },
    store,
    endpoint: {
      invalidate() {},
      sessionFault: () => undefined,
      placement: { peek: () => ({ nodeId: 'node' }), boundNodeId: () => null },
      nodes: {
        get: () => ({ state: { state: 'ready' } }),
        all: () => [{ nodeId: 'node', state: { state: 'ready' } }],
        isRemoved: () => false,
      },
      observation: () => ({
        browser: 'running',
        browserIncarnation: 'browser',
        endpointIncarnation: 'endpoint',
        connectionEpoch: 'connection',
        seq: '1',
      }),
      closeView: (_tenant: string, request: { viewId: string }) =>
        request.viewId === 'one'
          ? Promise.resolve({ closed: true })
          : boundary.call(request, { closed: true }),
    },
  } as unknown as DomainContext;
  const owner = new PageRequests(context, {
    lifecycle: { remove() {} },
    viewers: { push() {} },
    operations: { saveWorkspace() {} },
  } as never);
  const result = operation();
  const run = () => result.run(() => owner.continueWindowClose(workspace));
  return {
    start: run,
    drive: run,
    changeInput: () => {
      boundary.version++;
      workspace.pendingWindowCloseId = 'window-two';
      workspace.pendingWindowCloseIds = [];
      reserve();
      run();
    },
    error: () => owner.failures()[0],
    dispose: () => {
      store.db.close();
    },
  };
};
