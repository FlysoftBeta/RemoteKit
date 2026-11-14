import { EventEmitter } from 'node:events';
import { Reconciler } from '../server/workspace/reconciler';
import { TenantRegistry } from '../server/tenants/tenant-registry';
import { ControlDatabase } from '../server/persistence/database';
import { emptyWorkspace } from '../server/persistence/workspaces';
import type { DomainContext, DomainServices } from '../server/application';
import type { ProductTab } from '../shared/product';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveReconciler(path: 'product' | 'reconnect' | 'ua' | 'reclaim'): OwnerFactory {
  return (boundary, t) => {
    let clockOffset = 0;
    const clock = { wallMs: () => Date.now(), monotonicMs: () => Date.now() + clockOffset };
    const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
    const state = emptyWorkspace('tenant');
    const tab: ProductTab = {
      id: 'tab',
      windowId: 'window',
      webviewId: 'view',
      url: 'https://example.test/',
      title: '',
      kind: 'remote',
      idleKeepAlive: false,
    };
    if (path === 'ua') {
      state.windows = [{ id: 'window', activeTabId: 'tab', appId: 'browser', lastActiveAt: 0 }];
      state.tabs = [{ ...tab, pendingUaReloadOrigin: 'https://example.test' }];
      state.spaces = [
        { id: 'space', windowIds: ['window'], weights: [1], focusedWindowId: 'window', lastActiveAt: 0 },
      ];
      state.activeSpaceId = 'space';
    }
    store.workspaces.writeWorkspace(state);
    const tenants = new TenantRegistry(clock);
    const runtime = tenants.get('tenant');
    runtime.browserIncarnation = 'browser';
    if (path !== 'reclaim')
      runtime.viewer = {
        id: 'lease',
        security: { locked: false },
        authentication: { identity: 'user', valid: () => true },
        revoke: () => {},
      } as unknown as typeof runtime.viewer;
    const snapshot = {
      running: true,
      browserIncarnation: 'browser',
      views:
        path === 'ua'
          ? [{ viewId: 'view', url: tab.url, title: '', pending: false, actual: 0, canDiscard: true }]
          : [],
    };
    const context = {
      store,
      clock,
      tenants,
      events: new EventEmitter(),
      endpoint: {
        invalidate: () => {},
        isReady: () => true,
        sessionFault: () => undefined,
        placement: { peek: () => ({ nodeId: 'node', runState: 'running', pendingCommit: null }) },
        observation: () => ({ connectionEpoch: String(boundary.version) }),
        current: () => snapshot,
        published: () =>
          path === 'ua'
            ? Promise.resolve({ run: 'stopped', revision: '1' })
            : boundary.call({ tenant: 'tenant' }, { run: 'stopped', revision: '1' }),
        command: (_tenant: string, args: unknown) => boundary.call(args, { accepted: true }),
      },
    } as unknown as DomainContext;
    if (path === 'reclaim') {
      clockOffset = 10000;
      const prepare = store.db.prepare.bind(store.db);
      t.mock.method(store.db, 'prepare', (sql: string) => {
        const statement = prepare(sql);
        return sql.startsWith('INSERT OR REPLACE INTO control_heartbeat')
          ? boundary.callSync({ sql }, statement)
          : statement;
      });
    }
    const noop = () => {};
    const services = {
      policy: { reset: noop, observeMedia: noop, qualityFor: () => ({ effectiveDpr: 1 }) },
      lifecycle: {
        relieve: async () => {},
        observeWanted: noop,
        retain: noop,
        observeLifecycleRecovery: () => false,
        observeReclaimed: noop,
        wantedVisible: () => true,
        forget: noop,
        prepareVisible: async () => true,
        maintainBackgroundTab: async () => {},
      },
      operations: { saveWorkspace: store.workspaces.saveWorkspace.bind(store.workspaces) },
      navigation: { observeRetired: noop, observe: async () => {} },
      learning: { signIn: { reconcile: noop } },
      pageRequests: {
        clear: noop,
        continueWindowClose: async () => {},
        observeFullscreen: () => false,
        collectDialogs: noop,
      },
      popups: { observePopups: async () => {} },
      rtc: { checkReconnectedRtc: async () => {} },
      viewers: { push: noop },
    } as unknown as DomainServices;
    const owner = new Reconciler(context, services);
    const result = operation();
    const run = () =>
      result.run(() =>
        path === 'reconnect'
          ? owner.endpointReady({ processChanged: false, nodeId: 'node' })
          : path === 'reclaim'
            ? owner.tick()
            : owner.reconcileProduct('tenant'),
      );
    return {
      start: run,
      drive: path === 'reconnect' ? () => result.run(() => owner.reconcileProduct('tenant')) : run,
      changeInput: () => {
        boundary.version++;
        Object.defineProperty(store, 'buildId', { value: 'changed', configurable: true });
        const next = store.workspaces.workspace('tenant');
        next.revision++;
        store.workspaces.writeWorkspace(next);
        run();
      },
      error: () => (path === 'reclaim' ? owner.backgroundFailure : runtime.lastError),
      dispose: async () => {
        await tenants.close();
        store.db.close();
      },
    };
  };
}
