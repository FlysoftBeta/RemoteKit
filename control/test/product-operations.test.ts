import { registerUser } from './server-fixture';
import { accountsFor } from './server-fixture';
import { requestViewer } from './server-fixture';
import { RemoteKitError } from '../shared/errors';
import { testGateway } from './server-fixture';
import { ControlSession } from '../client/control/control-session';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication, type DomainServices } from '../server/application';
import { projectOperations, snapshotNewer } from '../client/control/product-operations';
import type { ProductAction, ProductOperation } from '../shared/product';
class Endpoint {
  incarnation = 'browser-1';
  calls: { method: string; args: any }[] = [];
  views: any[] = [];
  failNavigate = false;
  failHideOnce = false;
  onCommand?: (args: any) => void;
  async request(method: string, _tenant: string, args: any = {}) {
    this.calls.push({ method, args });
    if (method === 'session.snapshot')
      return { running: true, browserIncarnation: this.incarnation, views: this.views };
    if (method === 'session.sitePreferences' || method === 'session.mediaPolicy')
      return { accepted: true, applied: true };
    if (method === 'view.ensure') {
      this.views.push({
        viewId: args.viewId,
        url: args.url,
        actual: 0,
        loading: false,
        instance: '1',
        document: '1',
      });
    }
    if (method === 'view.navigate' && this.failNavigate)
      throw new RemoteKitError('outcome_unknown', 'reply lost');
    if (method === 'view.command') this.onCommand?.(args);
    if (method === 'view.configure') {
      if (args.visible === false && this.failHideOnce) {
        this.failHideOnce = false;
        throw new RemoteKitError('outcome_unknown', 'hide reply lost');
      }
      const view = this.views.find((view) => view.viewId === args.viewId);
      if (view) Object.assign(view, args);
    }
    if (method === 'view.close.reply') return { accepted: true, browser: { ok: true } };
    if (method === 'view.close')
      return {
        pending: true,
        requestId: 'close-1',
        browserIncarnation: 'browser-1',
        instance: '1',
        document: '1',
      };
    return { accepted: true };
  }
}
async function fixture() {
  const store = new ControlDatabase(':memory:'),
    endpoint = new Endpoint(),
    control = createApplication(store, testGateway(endpoint));
  const { tenantId: tenant } = await registerUser(store, 'operations', 'password123');
  await control.viewers.attachViewer(
    tenant,
    'lease',
    () => {},
    { identity: 'test-account', valid: () => true },
    true,
  );
  const op = (action: ProductAction): ProductOperation => ({
    operationId: randomUUID(),
    operationGeneration: store.operations.operationGeneration(tenant),
    action,
  });
  return { store, endpoint, control, tenant, op };
}

for (const initial of ['start', 'remote'] as const) {
  test(`stop retains the ${initial} pending navigation owner and settles both receipts without committing a document`, async () => {
    const f = await fixture();
    try {
      await f.control.operations.productAction(
        f.tenant,
        {
          type: 'window.open',
          appId: 'browser',
          placement: { mode: 'space' },
          ...(initial === 'remote' ? { url: 'https://old.test/' } : {}),
        },
        'lease',
      );
      const tab = f.store.workspaces.workspace(f.tenant).tabs[0];
      await requestViewer(f.control, f.tenant, 'lease', 'viewport', {
        devicePixelRatio: 1,
        windows: [{ windowId: tab.windowId, width: 900, height: 600, visible: true }],
      });
      const navigate = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://slow.test/' });
      await f.control.operations.submitOperation(f.tenant, navigate, 'lease');
      const owner = f.store.workspaces.workspace(f.tenant).tabs[0].navigation,
        view = f.endpoint.views[0];
      // A new Native view has no committed URL while its first load is pending.
      view.url = initial === 'start' ? '' : 'https://old.test/';
      view.loading = true;
      await f.control.reconciler.tick();
      assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].loading, true);
      const stop = f.op({ type: 'tab.command', tabId: tab.id, command: 'stop' });
      f.endpoint.onCommand = (args) => {
        view.loading = false;
        view.navigationOperations = [
          {
            ...f.control.operations.operationStatus(f.tenant, navigate),
            state: 'cancelled',
            error: 'stopped',
            documentCommitted: false,
          },
          { ...args, state: 'committed', url: '', documentCommitted: false },
        ];
      };
      assert.equal((await f.control.operations.submitOperation(f.tenant, stop, 'lease')).status, 'committed');
      const actual = f.store.workspaces.workspace(f.tenant).tabs[0];
      assert.equal(actual.navigation?.operationId, owner?.operationId);
      assert.equal(actual.navigation?.previousKind, initial);
      assert.equal(actual.navigation?.status, 'rejected');
      assert.equal(actual.kind, initial);
      assert.equal(actual.url, tab.url);
      assert.equal(actual.pendingUrl, undefined);
      assert.equal(actual.loading, false);
      assert.equal(f.control.operations.operationStatus(f.tenant, navigate).status, 'rejected');
      assert.equal(f.control.operations.operationStatus(f.tenant, stop).status, 'committed');
      for (const op of [navigate, stop])
        assert.ok(
          f.endpoint.calls.some(
            (call) => call.method === 'view.navigation.ack' && call.args.operationId === op.operationId,
          ),
        );
      assert.equal(view.visible, initial === 'remote');
      if (initial === 'start')
        assert.ok(
          f.endpoint.calls.some(
            (call) =>
              call.method === 'view.configure' &&
              call.args.visible === false &&
              call.args.requireRunning === true,
          ),
        );
      assert.equal(
        f.endpoint.calls.some((call) => call.method === 'view.close' || call.method === 'view.lifecycle'),
        false,
      );
      await f.control.reconciler.tick();
      assert.equal(f.control.operations.operationStatus(f.tenant, stop).status, 'committed');
      assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].loading, false);
      assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.command').length, 1);
    } finally {
      await f.control.close();
      f.store.db.close();
    }
  });
}

test('a stop receipt arriving before the cancelled navigation does not commit its pending URL', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
      navigate = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://slow.test/' });
    await f.control.operations.submitOperation(f.tenant, navigate, 'lease');
    const stop = f.op({ type: 'tab.command', tabId: tab.id, command: 'stop' }),
      view = f.endpoint.views[0];
    view.url = '';
    await f.control.operations.submitOperation(f.tenant, stop, 'lease');
    const stopTerminal = {
      ...f.control.operations.operationStatus(f.tenant, stop),
      state: 'committed',
      url: '',
      documentCommitted: false,
    };
    view.navigationOperations = [stopTerminal];
    await f.control.reconciler.tick();
    let actual = f.store.workspaces.workspace(f.tenant).tabs[0];
    assert.equal(actual.navigation?.operationId, navigate.operationId);
    assert.equal(actual.pendingUrl, 'https://slow.test/');
    assert.equal(actual.url, '');
    assert.equal(f.control.operations.operationStatus(f.tenant, navigate).status, 'applying');
    assert.equal(f.control.operations.operationStatus(f.tenant, stop).status, 'committed');
    view.navigationOperations = [
      {
        ...f.control.operations.operationStatus(f.tenant, navigate),
        state: 'cancelled',
        error: 'stopped',
        documentCommitted: false,
      },
    ];
    await f.control.reconciler.tick();
    actual = f.store.workspaces.workspace(f.tenant).tabs[0];
    assert.equal(actual.kind, 'start');
    assert.equal(actual.pendingUrl, undefined);
    // The stop result may be redelivered after the local start state is restored.
    view.navigationOperations = [stopTerminal];
    await f.control.reconciler.tick();
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].kind, 'start');
    assert.ok(
      f.endpoint.calls.some(
        (call) => call.method === 'view.navigation.ack' && call.args.operationId === stop.operationId,
      ),
    );
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('late old stop and cancelled navigation settle their receipts without rolling back a newer navigation', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
      old = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://slow.test/' });
    await f.control.operations.submitOperation(f.tenant, old, 'lease');
    const stop = f.op({ type: 'tab.command', tabId: tab.id, command: 'stop' });
    await f.control.operations.submitOperation(f.tenant, stop, 'lease');
    const current = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://current.test/' });
    await f.control.operations.submitOperation(f.tenant, current, 'lease');
    const view = f.endpoint.views[0],
      late = [
        {
          ...f.control.operations.operationStatus(f.tenant, old),
          state: 'cancelled',
          error: 'stopped',
          documentCommitted: false,
        },
        {
          ...f.control.operations.operationStatus(f.tenant, stop),
          state: 'committed',
          url: '',
          documentCommitted: false,
        },
      ];
    view.navigationOperations = late;
    await f.control.reconciler.tick();
    let actual = f.store.workspaces.workspace(f.tenant).tabs[0];
    assert.equal(actual.navigation?.operationId, current.operationId);
    assert.equal(actual.pendingUrl, 'https://current.test/');
    assert.equal(f.control.operations.operationStatus(f.tenant, old).status, 'rejected');
    assert.equal(f.control.operations.operationStatus(f.tenant, stop).status, 'committed');
    view.url = 'https://current.test/';
    view.navigationOperations = [
      ...late,
      {
        ...f.control.operations.operationStatus(f.tenant, current),
        state: 'committed',
        url: view.url,
        documentCommitted: true,
      },
    ];
    await f.control.reconciler.tick();
    view.navigationOperations = late;
    await f.control.reconciler.tick();
    actual = f.store.workspaces.workspace(f.tenant).tabs[0];
    assert.equal(actual.url, view.url);
    assert.equal(actual.kind, 'remote');
    assert.equal(actual.pendingUrl, undefined);
    assert.equal(f.control.operations.operationStatus(f.tenant, current).status, 'committed');
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('a delayed stop terminal settles after the cancelled navigator has restored the local start page', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
      navigate = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://slow.test/' });
    await f.control.operations.submitOperation(f.tenant, navigate, 'lease');
    const stop = f.op({ type: 'tab.command', tabId: tab.id, command: 'stop' });
    await f.control.operations.submitOperation(f.tenant, stop, 'lease');
    const view = f.endpoint.views[0];
    view.url = '';
    view.navigationOperations = [
      {
        ...f.control.operations.operationStatus(f.tenant, navigate),
        state: 'cancelled',
        error: 'stopped',
        documentCommitted: false,
      },
    ];
    await f.control.reconciler.tick();
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].kind, 'start');
    assert.equal(f.control.operations.operationStatus(f.tenant, stop).status, 'applying');
    const ensureCount = f.endpoint.calls.filter((call) => call.method === 'view.ensure').length;
    view.navigationOperations = [
      {
        ...f.control.operations.operationStatus(f.tenant, stop),
        state: 'committed',
        url: '',
        documentCommitted: false,
      },
    ];
    await f.control.reconciler.tick();
    assert.equal(f.control.operations.operationStatus(f.tenant, stop).status, 'committed');
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].kind, 'start');
    assert.ok(
      f.endpoint.calls.some(
        (call) => call.method === 'view.navigation.ack' && call.args.operationId === stop.operationId,
      ),
    );
    assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.ensure').length, ensureCount);
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('lost stop reply stays unknown without replaying or replacing the pending navigation owner', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
      navigate = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://slow.test/' });
    await f.control.operations.submitOperation(f.tenant, navigate, 'lease');
    const owner = f.store.workspaces.workspace(f.tenant).tabs[0].navigation,
      stop = f.op({ type: 'tab.command', tabId: tab.id, command: 'stop' });
    f.endpoint.onCommand = () => {
      throw new RemoteKitError('outcome_unknown', 'stop reply lost');
    };
    assert.equal((await f.control.operations.submitOperation(f.tenant, stop, 'lease')).status, 'unknown');
    await f.control.reconciler.tick();
    await f.control.operations.submitOperation(f.tenant, stop, 'lease');
    assert.deepEqual(f.store.workspaces.workspace(f.tenant).tabs[0].navigation, owner);
    assert.equal(f.control.operations.operationStatus(f.tenant, stop).status, 'unknown');
    assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.command').length, 1);
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

for (const outcome of ['committed', 'failed'] as const) {
  test(`stop preserves an already ${outcome} main-frame document from a first start navigation`, async () => {
    const f = await fixture();
    try {
      await f.control.operations.productAction(
        f.tenant,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
        'lease',
      );
      const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
        navigate = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://document.test/' });
      await f.control.operations.submitOperation(f.tenant, navigate, 'lease');
      const view = f.endpoint.views[0];
      view.url = 'https://document.test/';
      view.document = '2';
      // The document committed in Browser, but DomainServices has not observed it yet.
      const documentTerminal = {
        ...f.control.operations.operationStatus(f.tenant, navigate),
        state: outcome,
        url: view.url,
        documentCommitted: true,
        isErrorPage: outcome === 'failed',
      };
      f.endpoint.onCommand = (args) => {
        view.navigationOperations = [
          documentTerminal,
          { ...args, state: 'committed', url: '', documentCommitted: false },
        ];
      };
      const stop = f.op({ type: 'tab.command', tabId: tab.id, command: 'stop' });
      assert.equal((await f.control.operations.submitOperation(f.tenant, stop, 'lease')).status, 'committed');
      const actual = f.store.workspaces.workspace(f.tenant).tabs[0];
      assert.equal(actual.kind, 'remote');
      assert.equal(actual.url, view.url);
      assert.equal(actual.pendingUrl, undefined);
      assert.equal(actual.navigation?.operationId, navigate.operationId);
      assert.equal(
        f.control.operations.operationStatus(f.tenant, navigate).status,
        outcome === 'committed' ? 'committed' : 'rejected',
      );
      assert.equal(
        f.endpoint.calls.some(
          (call) => call.method === 'view.configure' && call.args.requireRunning === true,
        ),
        false,
      );
    } finally {
      await f.control.close();
      f.store.db.close();
    }
  });
}

for (const initial of ['start', 'remote'] as const) {
  test(`${initial} navigation failure with a committed error document preserves the remote document and rejects receipt`, async () => {
    const f = await fixture();
    try {
      await f.control.operations.productAction(
        f.tenant,
        {
          type: 'window.open',
          appId: 'browser',
          placement: { mode: 'space' },
          ...(initial === 'remote' ? { url: 'https://old.test/' } : {}),
        },
        'lease',
      );
      const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
        url = 'http://127.0.0.1:33479/unreachable-start';
      const op = f.op({ type: 'tab.navigate', tabId: tab.id, url });
      assert.equal((await f.control.operations.submitOperation(f.tenant, op, 'lease')).status, 'applying');
      const view = f.endpoint.views[0];
      view.url = url;
      view.title = url;
      view.document = '2';
      view.navigationOperations = [
        {
          ...op,
          state: 'failed',
          url,
          error: 'ERR_CONNECTION_REFUSED',
          documentCommitted: true,
          isErrorPage: true,
        },
      ];
      await f.control.reconciler.tick();
      const actual = f.store.workspaces.workspace(f.tenant).tabs[0];
      assert.equal(f.control.operations.operationStatus(f.tenant, op).status, 'rejected');
      assert.equal(actual.kind, 'remote');
      assert.equal(actual.url, url);
      assert.equal(actual.pendingUrl, undefined);
      assert.equal(actual.navigation?.status, 'rejected');
    } finally {
      await f.control.close();
      f.store.db.close();
    }
  });
}

for (const state of ['failed', 'cancelled'] as const) {
  test(`first start navigation ${state} without a document commit restores the local start page`, async () => {
    const f = await fixture();
    try {
      await f.control.operations.productAction(
        f.tenant,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
        'lease',
      );
      const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
        previousUrl = tab.url;
      const op = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://provisional.test/' });
      await f.control.operations.submitOperation(f.tenant, op, 'lease');
      const view = f.endpoint.views[0];
      view.url = 'https://provisional.test/';
      view.title = 'not a committed document';
      view.navigationOperations = [{ ...op, state, documentCommitted: false }];
      await f.control.reconciler.tick();
      const actual = f.store.workspaces.workspace(f.tenant).tabs[0];
      assert.equal(f.control.operations.operationStatus(f.tenant, op).status, 'rejected');
      assert.equal(actual.kind, 'start');
      assert.equal(actual.url, previousUrl);
      assert.equal(actual.pendingUrl, undefined);
      assert.equal(actual.title, tab.title);
    } finally {
      await f.control.close();
      f.store.db.close();
    }
  });
}

test('late committed-error terminal cannot replace a newer navigation or reverse its settled receipt', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0];
    const old = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://failed.test/' });
    await f.control.operations.submitOperation(f.tenant, old, 'lease');
    const current = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://current.test/' });
    await f.control.operations.submitOperation(f.tenant, current, 'lease');
    const view = f.endpoint.views[0];
    view.url = 'https://current.test/';
    const stale = {
      ...old,
      state: 'failed',
      url: 'https://failed.test/',
      documentCommitted: true,
      isErrorPage: true,
    };
    view.navigationOperations = [stale];
    await f.control.reconciler.tick();
    let actual = f.store.workspaces.workspace(f.tenant).tabs[0];
    assert.equal(actual.navigation?.operationId, current.operationId);
    assert.equal(actual.pendingUrl, 'https://current.test/');
    assert.equal(f.control.operations.operationStatus(f.tenant, current).status, 'applying');
    view.navigationOperations = [
      stale,
      { ...current, state: 'committed', url: view.url, documentCommitted: true },
    ];
    await f.control.reconciler.tick();
    actual = f.store.workspaces.workspace(f.tenant).tabs[0];
    assert.equal(actual.url, 'https://current.test/');
    assert.equal(actual.kind, 'remote');
    view.navigationOperations = [
      stale,
      { ...current, state: 'failed', url: 'https://failed.test/', documentCommitted: false },
    ];
    await f.control.reconciler.tick();
    assert.equal(f.control.operations.operationStatus(f.tenant, current).status, 'committed');
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].url, 'https://current.test/');
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('an unrelated Browser incarnation cannot settle a retired navigation with a matching terminal identity', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://old.test/' },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
      op = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://failed.test/' });
    await f.control.operations.submitOperation(f.tenant, op, 'lease');
    f.endpoint.incarnation = 'browser-2';
    const view = f.endpoint.views[0];
    view.url = 'https://old.test/';
    view.navigationOperations = [
      { ...op, state: 'failed', url: 'https://failed.test/', documentCommitted: true, isErrorPage: true },
    ];
    await f.control.reconciler.tick();
    const actual = f.store.workspaces.workspace(f.tenant).tabs[0],
      receipt = f.control.operations.operationStatus(f.tenant, op);
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.resolution, 'target-retired');
    assert.equal(actual.url, 'https://old.test/');
    assert.equal(actual.pendingUrl, undefined);
    assert.equal(
      f.endpoint.calls.some(
        (call) => call.method === 'view.navigation.ack' && call.args.operationId === op.operationId,
      ),
      false,
    );
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('provisional start rollback hides its existing Native plane, retries failures, and reapplies full config on later navigation', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0];
    await requestViewer(f.control, f.tenant, 'lease', 'viewport', {
      devicePixelRatio: 1,
      windows: [{ windowId: tab.windowId, width: 900, height: 600, visible: true }],
    });
    const op = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://provisional.test/' });
    await f.control.operations.submitOperation(f.tenant, op, 'lease');
    const view = f.endpoint.views[0];
    assert.equal(view.visible, true);
    view.navigationOperations = [{ ...op, state: 'failed', documentCommitted: false }];
    f.endpoint.failHideOnce = true;
    await f.control.reconciler.tick();
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].kind, 'start');
    assert.equal(view.visible, true);
    await f.control.reconciler.tick();
    assert.equal(view.visible, false);
    assert.equal(f.endpoint.views.length, 1);
    const hides = () =>
      f.endpoint.calls.filter(
        (call) =>
          call.method === 'view.configure' &&
          call.args.requireRunning === true &&
          call.args.visible === false,
      );
    assert.equal(hides().length, 2);
    assert.equal(
      f.endpoint.calls.some((call) => call.method === 'view.close'),
      false,
    );
    await f.control.reconciler.tick();
    assert.equal(hides().length, 2);
    // When the snapshot omits visibility, a successful hide cache avoids work.
    delete view.visible;
    await f.control.reconciler.tick();
    assert.equal(hides().length, 2);
    const next = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://working.test/' });
    await f.control.operations.submitOperation(f.tenant, next, 'lease');
    assert.equal(view.visible, true);
    assert.equal(view.width, 900);
    assert.equal(view.height, 600);
    assert.equal(view.device.deviceScaleFactor, 1);
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].kind, 'remote');
    assert.equal(f.endpoint.views.length, 1);
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('a local start page hides an existing Native plane during resource limitation and never creates a missing view', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
      before = f.endpoint.calls.filter((call) => call.method === 'view.ensure').length;
    await f.control.reconciler.tick();
    assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.ensure').length, before);
    assert.equal(
      f.endpoint.calls.some((call) => call.method === 'view.configure'),
      false,
    );
    const other = (
      await f.control.operations.productAction(
        f.tenant,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
        'lease',
      )
    ).state.workspace.windows[1];
    await requestViewer(f.control, f.tenant, 'lease', 'viewport', {
      devicePixelRatio: 1,
      windows: [{ windowId: other.id, width: 8192, height: 8192, visible: true }],
    });
    await f.control.operations.productAction(
      f.tenant,
      { type: 'tab.create', windowId: other.id, url: 'https://limited.test/' },
      'lease',
    );
    assert.ok(f.control.viewers.productState(f.tenant).quality.resourceLimitation);
    f.endpoint.views.push({ viewId: tab.webviewId, visible: true, url: 'about:blank', actual: 0 });
    await f.control.reconciler.tick();
    assert.equal(f.endpoint.views[0].visible, false);
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].kind, 'start');
    assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.ensure').length, before);
    assert.equal(
      f.endpoint.calls.some((call) => call.method === 'view.lifecycle' || call.method === 'view.close'),
      false,
    );
    const hide = f.endpoint.calls.find((call) => call.method === 'view.configure')!;
    assert.deepEqual(hide.args, { viewId: tab.webviewId, visible: false, requireRunning: true });
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});
test('durable same-ID receipt survives response loss and rejects payload conflict without duplicate create', async () => {
  const f = await fixture();
  try {
    const op = f.op({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
    const first = await f.control.operations.submitOperation(f.tenant, op, 'lease');
    assert.equal(first.status, 'committed');
    const second = await f.control.operations.submitOperation(f.tenant, op, 'lease');
    assert.deepEqual(second, first);
    assert.equal(f.store.workspaces.workspace(f.tenant).windows.length, 1);
    await assert.rejects(
      f.control.operations.submitOperation(
        f.tenant,
        {
          ...op,
          action: {
            type: 'window.open',
            appId: 'browser',
            placement: { mode: 'space' },
            url: 'https://different.test/',
          },
        },
        'lease',
      ),
      { code: 'conflict' },
    );
    assert.equal(f.control.operations.operationStatus(f.tenant, op).status, 'committed');
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});
test('navigation accepted stays applying, stale loading=false cannot finish it, exact cancellation rolls back atomically', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://old.test/' },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0];
    const op = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://new.test/' });
    assert.equal((await f.control.operations.submitOperation(f.tenant, op, 'lease')).status, 'applying');
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].pendingUrl, 'https://new.test/');
    await f.control.reconciler.tick();
    assert.equal(f.control.operations.operationStatus(f.tenant, op).status, 'applying');
    f.endpoint.views[0].navigationOperations = [{ ...op, state: 'cancelled' }];
    await f.control.reconciler.tick();
    assert.equal(f.control.operations.operationStatus(f.tenant, op).status, 'rejected');
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].url, 'https://old.test/');
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].pendingUrl, undefined);
    const call = f.endpoint.calls.find((call) => call.method === 'view.navigate')!;
    assert.match(call.args.operationSequence, /^[1-9][0-9]*$/);
    assert.ok(f.endpoint.calls.some((call) => call.method === 'view.navigation.ack'));
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});
test('lost native navigation reply is unknown, status and tick never replay it, missing view does not ensure intent', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://old.test/' },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
      op = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://new.test/' });
    f.endpoint.failNavigate = true;
    assert.equal((await f.control.operations.submitOperation(f.tenant, op, 'lease')).status, 'unknown');
    f.endpoint.views = [];
    const before = f.endpoint.calls.filter((call) => call.method === 'view.ensure').length;
    await f.control.reconciler.tick();
    await f.control.operations.submitOperation(f.tenant, op, 'lease');
    assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.navigate').length, 1);
    assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.ensure').length, before);
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});
test('lease is checked at queued acceptance; fast clock does not queue behind a stalled product operation', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const blocked = f.control.tenants.serial(
      f.tenant,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const queued = f.control.operations.submitOperation(
      f.tenant,
      f.op({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
      'lease',
    );
    const takeover = f.control.viewers.attachViewer(
      f.tenant,
      'new',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    release();
    await blocked;
    await assert.rejects(queued, { code: 'conflict' });
    await takeover;
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs.length, 0);
    let releaseClock!: () => void;
    const stalled = f.control.tenants.serial(
      f.tenant,
      () =>
        new Promise<void>((resolve) => {
          releaseClock = resolve;
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      typeof (await requestViewer(f.control, f.tenant, 'new', 'clock.ping', {})).serverTime,
      'number',
    );
    releaseClock();
    await stalled;
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});
test('equal revision runtime snapshots order independently and pending close projection retains actual tab', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
      'lease',
    );
    const first = f.control.viewers.productState(f.tenant),
      next = f.control.viewers.productState(f.tenant);
    assert.equal(first.workspace.revision, next.workspace.revision);
    assert.equal(snapshotNewer(first, next), false);
    assert.equal(snapshotNewer(next, first), true);
    const op = f.op({ type: 'tab.close', tabId: first.workspace.tabs[0].id });
    assert.equal(projectOperations(first, [op])!.workspace.tabs.length, 1);
    const create = f.op({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
    assert.equal(projectOperations(first, [create])!.workspace.windows.length, 2);
    const receipt = await f.control.operations.submitOperation(f.tenant, create, 'lease'),
      final = f.control.viewers.productState(f.tenant);
    assert.equal(projectOperations(final, [{ ...create, receipt }])!.workspace.windows.length, 2);
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('beforeunload close receipt stays applying until explicit cancellation, retaining the tab', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://old.test/' },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
      op = f.op({ type: 'tab.close', tabId: tab.id });
    assert.equal((await f.control.operations.submitOperation(f.tenant, op, 'lease')).status, 'applying');
    const workspace = f.store.workspaces.workspace(f.tenant);
    assert.equal(workspace.tabs.length, 1);
    const cancel = f.op({
      type: 'tab.close',
      tabId: tab.id,
      requestId: workspace.pendingClose!.requestId,
      cancel: true,
    });
    assert.equal((await f.control.operations.submitOperation(f.tenant, cancel, 'lease')).status, 'committed');
    assert.equal(f.control.operations.operationStatus(f.tenant, op).status, 'rejected');
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs.length, 1);
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('terminal receipt capacity rotates generation explicitly while unresolved outcomes prohibit eviction', async () => {
  const f = await fixture();
  try {
    const generation = f.store.operations.operationGeneration(f.tenant);
    f.store.db.transaction(() => {
      const insert = f.store.db.prepare('INSERT INTO operation_receipts VALUES (?,?,?,?)');
      for (let i = 0; i < 4096; i++)
        insert.run(
          f.tenant,
          'old-' + i,
          '{}',
          JSON.stringify({ operationId: 'old-' + i, operationGeneration: generation, status: 'committed' }),
        );
    })();
    const old = f.op({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
    assert.equal((await f.control.operations.submitOperation(f.tenant, old, 'lease')).status, 'expired');
    assert.notEqual(f.store.operations.operationGeneration(f.tenant), generation);
    assert.equal(f.control.operations.operationStatus(f.tenant, old).status, 'expired');
    assert.equal(f.store.workspaces.workspace(f.tenant).windows.length, 0);
    const next = f.op({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
    assert.equal((await f.control.operations.submitOperation(f.tenant, next, 'lease')).status, 'committed');
    const currentGeneration = f.store.operations.operationGeneration(f.tenant);
    f.store.db.transaction(() => {
      const insert = f.store.db.prepare('INSERT INTO operation_receipts VALUES (?,?,?,?)');
      for (let i = 0; i < 4095; i++)
        insert.run(
          f.tenant,
          'unresolved-' + i,
          '{}',
          JSON.stringify({
            operationId: 'unresolved-' + i,
            operationGeneration: currentGeneration,
            status: i === 0 ? 'unknown' : 'committed',
          }),
        );
    })();
    await assert.rejects(
      f.control.operations.submitOperation(
        f.tenant,
        f.op({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
        'lease',
      ),
      {
        code: 'limit_exceeded',
      },
    );
    assert.equal(f.store.operations.operationGeneration(f.tenant), currentGeneration);
    f.store.db
      .prepare(
        "UPDATE operation_receipts SET receipt=json_set(receipt,'$.resolved',json('true')) WHERE tenant=? AND id='unresolved-0'",
      )
      .run(f.tenant);
    assert.equal(
      (
        await f.control.operations.submitOperation(
          f.tenant,
          f.op({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
          'lease',
        )
      ).status,
      'expired',
    );
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});
test('SQLite completion fault rolls back the workspace mutation and leaves a queryable rejection', async () => {
  const f = await fixture();
  try {
    f.store.db.exec(
      "CREATE TRIGGER reject_operation_commit BEFORE UPDATE ON operation_receipts WHEN json_extract(NEW.receipt,'$.status')='committed' BEGIN SELECT RAISE(ABORT,'receipt fault'); END",
    );
    const op = f.op({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
    const result = await f.control.operations.submitOperation(f.tenant, op, 'lease');
    assert.equal(result.status, 'rejected');
    assert.equal(f.store.workspaces.workspace(f.tenant).windows.length, 0);
    assert.equal(f.control.operations.operationStatus(f.tenant, op).status, 'rejected');
    assert.equal((await f.control.operations.submitOperation(f.tenant, op, 'lease')).status, 'rejected');
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('WS connection rejects out-of-order runtime states, old socket callbacks, and incarnation changes within one socket', async (t) => {
  const f = await fixture();
  try {
    const sockets: any[] = [];
    class Socket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 0;
      onopen?: () => void;
      onmessage?: (event: any) => void;
      onclose?: (event: any) => void;
      onerror?: () => void;
      constructor(_url: string) {
        sockets.push(this);
      }
      close() {
        this.readyState = 3;
      }
      send() {}
    }
    for (const [name, value] of Object.entries({
      WebSocket: Socket,
      location: { protocol: 'http:', host: 'localhost' },
    })) {
      const old = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, value });
      t.after(() => {
        if (old) Object.defineProperty(globalThis, name, old);
        else Reflect.deleteProperty(globalThis, name);
      });
    }
    const seen: any[] = [],
      connection = new ControlSession(
        (state) => seen.push(state),
        () => {},
      );
    t.after(() => connection.close());
    connection.connect();
    const first = sockets[0],
      state = f.control.viewers.productState(f.tenant),
      emit = (socket: any, value: any) =>
        socket.onmessage({
          data: JSON.stringify({ type: 'state', revision: state.workspace.revision, state: value }),
        });
    emit(first, { ...state, snapshotSequence: 2 });
    emit(first, { ...state, snapshotSequence: 1 });
    assert.equal(seen.length, 1);
    emit(first, { ...state, snapshotSequence: 3 });
    assert.equal(seen.length, 2);
    first.readyState = 3;
    connection.restart();
    const replacement = sockets[1];
    emit(replacement, { ...state, serverIncarnation: 'replacement', snapshotSequence: 1 });
    emit(first, { ...state, snapshotSequence: 100 });
    emit(replacement, { ...state, snapshotSequence: 100 });
    assert.equal(seen.length, 3);
    assert.equal(seen[2].serverIncarnation, 'replacement');
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('retired Browser resolves resource eligibility while retaining unknown navigation outcome and never replaying intent', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://old.test/' },
      'lease',
    );
    const tab = f.store.workspaces.workspace(f.tenant).tabs[0],
      op = f.op({ type: 'tab.navigate', tabId: tab.id, url: 'https://new.test/' });
    f.endpoint.failNavigate = true;
    await f.control.operations.submitOperation(f.tenant, op, 'lease');
    f.endpoint.incarnation = 'browser-2';
    f.endpoint.views = [];
    await f.control.reconciler.tick();
    const receipt = f.control.operations.operationStatus(f.tenant, op);
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.resolved, true);
    assert.equal(receipt.resolution, 'target-retired');
    assert.equal(f.store.workspaces.workspace(f.tenant).tabs[0].pendingUrl, undefined);
    assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.navigate').length, 1);
    assert.equal(
      f.endpoint.calls.filter((call) => call.method === 'view.ensure').slice(-1)[0]?.args.url,
      'https://old.test/',
    );
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});
