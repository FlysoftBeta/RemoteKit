import { registerUser } from './server-fixture';
import { accountsFor } from './server-fixture';
import { requestViewer } from './server-fixture';
import { testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication, type DomainServices } from '../server/application';
import type { EndpointLink } from '../server/endpoint/link';

class RecoveryEndpoint implements EndpointLink {
  readonly state = { state: 'ready' as const, incarnation: 'test', connectionEpoch: 'test' };
  view: any;
  configured: any[] = [];
  desiredVisible = false;
  navigated?: string;
  async request(method: string, _tenant: string, args: any = {}): Promise<any> {
    if (method === 'session.ensure') return { browserPid: 10, browserIncarnation: 'recovery-browser' };
    if (method === 'session.sitePreferences' || method === 'session.mediaPolicy')
      return { accepted: true, applied: true };
    if (method === 'session.snapshot')
      return {
        running: true,
        browserPid: 10,
        browserIncarnation: 'recovery-browser',
        views: this.view ? [{ ...this.view }] : [],
      };
    if (method === 'view.ensure')
      this.view = { ...args, instance: '1', document: '1', actual: 0, pending: false };
    if (method === 'view.configure') {
      this.configured.push(args);
      this.desiredVisible = args.visible;
      Object.assign(this.view, args, { visible: this.view.recovery?.pending ? false : args.visible });
    }
    if (method === 'view.navigate') this.navigated = args.url;
    return {};
  }
}
async function fixture() {
  const store = new ControlDatabase(':memory:'),
    endpoint = new RecoveryEndpoint(),
    control = createApplication(store, testGateway(endpoint));
  const { tenantId: tenant } = await registerUser(store, 'recovery-observer', 'password123');
  await control.viewers.attachViewer(
    tenant,
    'lease',
    () => {},
    { identity: 'test-account', valid: () => true },
    true,
  );
  const tab = (
    await control.operations.productAction(
      tenant,
      { type: 'window.create', url: 'https://saved.test/history' },
      'lease',
    )
  ).state.workspace.tabs[0];
  const state = store.workspaces.workspace(tenant);
  Object.assign(state.tabs[0], { title: 'Saved title', canGoBack: true, canGoForward: true });
  store.workspaces.saveWorkspace(state);
  Object.assign(endpoint.view, {
    recovery: { pending: true, phase: 'begin', error: '' },
    pending: true,
    desired: 0,
    actual: 3,
    visible: false,
    url: 'about:blank',
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  });
  return { store, endpoint, control, tenant, tab };
}

test('pending recovery preserves product URL/title/history and desired visibility until complete', async () => {
  const { store, endpoint, control, tenant, tab } = await fixture();
  try {
    await requestViewer(control, tenant, 'lease', 'viewport', {
      devicePixelRatio: 1,
      windows: [{ windowId: tab.windowId, width: 1000, height: 600, visible: true }],
    });
    let current = store.workspaces.workspace(tenant).tabs[0];
    assert.equal(current.url, 'https://saved.test/history');
    assert.equal(current.title, 'Saved title');
    assert.equal(current.canGoBack, true);
    assert.equal(current.canGoForward, true);
    assert.equal(current.restoring, true);
    assert.equal(endpoint.desiredVisible, true);
    assert.equal(endpoint.view.visible, false);
    assert.equal(endpoint.view.recovery.pending, true);
    const count = endpoint.configured.length;
    await control.reconciler.tick();
    assert.equal(endpoint.configured.length, count);
    Object.assign(endpoint.view, {
      recovery: { pending: false, phase: 'complete', error: '' },
      pending: false,
      actual: 0,
      visible: true,
      url: 'https://restored.test/selected',
      title: 'Restored title',
      canGoForward: false,
    });
    await control.reconciler.tick();
    current = store.workspaces.workspace(tenant).tabs[0];
    assert.equal(current.url, 'https://restored.test/selected');
    assert.equal(current.title, 'Restored title');
    assert.equal(current.canGoForward, false);
    assert.equal(current.restoring, false);
    endpoint.view.url = 'https://ordinary.test/loading';
    endpoint.view.loading = true;
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(tenant).tabs[0].url, 'https://ordinary.test/loading');
  } finally {
    await control.close();
    store.db.close();
  }
});

test('new navigation intent during recovery survives blank snapshot and normal completion clears pending URL', async () => {
  const { store, endpoint, control, tenant, tab } = await fixture();
  try {
    const address = 'https://new-intent.test/target';
    await control.operations.productAction(
      tenant,
      { type: 'tab.navigate', tabId: tab.id, url: address },
      'lease',
    );
    let current = store.workspaces.workspace(tenant).tabs[0];
    assert.equal(endpoint.navigated, address);
    assert.equal(current.url, address);
    assert.equal(current.pendingUrl, address);
    assert.equal(current.restoring, true);
    // Native explicit navigation cancels recovery. The following snapshot is a
    // regular loading navigation, where the existing pending-URL guard applies.
    Object.assign(endpoint.view, {
      recovery: undefined,
      pending: false,
      desired: 0,
      actual: 0,
      loading: true,
    });
    await control.reconciler.tick();
    current = store.workspaces.workspace(tenant).tabs[0];
    assert.equal(current.url, address);
    assert.equal(current.pendingUrl, address);
    Object.assign(endpoint.view, { url: address, loading: false });
    await control.reconciler.tick();
    current = store.workspaces.workspace(tenant).tabs[0];
    assert.equal(current.url, address);
    assert.equal(current.pendingUrl, undefined);
    assert.equal(current.restoring, false);
  } finally {
    await control.close();
    store.db.close();
  }
});
