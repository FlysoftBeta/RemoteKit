import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication } from '../server/application';
import { registerUser, requestViewer, TestClock, testGateway } from './server-fixture';
import { openSignInTab } from '../server/workspace/sign-in';
import { applyCommand } from '../server/workspace/commands';

test('sign-in tabs pass purpose to Endpoint, skip usage, previews, popups and Memory Saver and close with the window', async () => {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', clock);
  const calls: { method: string; args: any }[] = [];
  const views: any[] = [];
  const endpoint = testGateway({
    request: async (method, _tenant, args) => {
      calls.push({ method, args });
      if (method === 'session.snapshot') return { running: true, browserIncarnation: 'browser', views };
      if (method === 'view.ensure')
        views.push({ ...args, instance: '1', document: '1', actual: 0, canDiscard: true });
      return { accepted: true, applied: true, closed: true };
    },
  });
  const app = createApplication(store, endpoint, undefined, clock);
  const user = await registerUser(store, 'learning-workspace', 'learning-password123');
  await app.viewers.attachViewer(
    user.tenantId,
    'lease',
    () => {},
    { identity: 'test', valid: () => true },
    true,
  );
  try {
    await app.operations.productAction(
      user.tenantId,
      { type: 'window.open', appId: 'questions', placement: { mode: 'space' } },
      'lease',
    );
    const windowId = store.workspaces.workspace(user.tenantId).windows[0].id;
    await requestViewer(app, user.tenantId, 'lease', 'learning.signIn', { provider: 'xinjiaoyu', windowId });
    await app.tenants.serial(user.tenantId, async () => {});
    const state = store.workspaces.workspace(user.tenantId);
    const tab = state.tabs[0];
    assert.equal(tab.signIn, 'xinjiaoyu');
    await app.tenants.serial(user.tenantId, () => app.reconciler.reconcileProduct(user.tenantId));
    assert.equal(calls.find((call) => call.method === 'view.ensure')?.args.signIn, 'xinjiaoyu');
    assert.equal(app.viewers.productState(user.tenantId).learning.accounts.xinjiaoyu.status, 'signing_in');
    app.workspace.recordPage(state, tab, { instance: '1', document: '1' }, 'browser');
    assert.equal(
      store.workspaces.items
        .usage(user.tenantId, clock.wallMs())
        .filter((item) => item.item.startsWith('page:')).length,
      0,
    );
    assert.deepEqual(
      app.workspace.savePreview(user.tenantId, { url: tab.url, image: 'data:image/jpeg;base64,/9j/' }),
      { saved: false },
    );
    assert.throws(() =>
      applyCommand(
        state,
        { type: 'tab.navigate', tabId: tab.id, url: 'https://example.test' },
        { ids: [], viewId: 'unused' },
      ),
    );
    await app.popups.observePopups(state, {
      pendingPopups: [
        {
          provisionalId: 'popup',
          openerViewId: tab.webviewId,
          disposition: 5,
          userGesture: true,
          status: 'pending',
          url: 'https://example.test',
        },
      ],
    });
    assert.equal(state.tabs.length, 1);
    await app.lifecycle.maintainBackgroundTab(state, tab, views[0], false, 'browser');
    clock.advance(3600_000);
    await app.lifecycle.maintainBackgroundTab(state, tab, views[0], false, 'browser');
    assert.equal(calls.filter((call) => call.method === 'view.lifecycle').length, 0);
    await app.operations.productAction(user.tenantId, { type: 'window.close', windowId }, 'lease');
    await app.tenants.serial(user.tenantId, async () => {});
    assert.equal(store.workspaces.workspace(user.tenantId).tabs.length, 0);
    assert.equal(app.learning.state(user.tenantId).accounts.xinjiaoyu.status, 'signed_out');
    assert.ok(calls.some((call) => call.method === 'view.close' && call.args.force === true));
  } finally {
    await app.close();
    store.db.close();
  }
});

test('Control restart removes interrupted sign-in tabs before any navigation restore', async () => {
  const store = new ControlDatabase(':memory:');
  const user = await registerUser(store, 'restart-user', 'learning-password123');
  const state = store.workspaces.workspace(user.tenantId);
  state.windows.push({ id: 'questions', appId: 'questions', activeTabId: null, lastActiveAt: 1 });
  state.spaces.push({
    id: 'space',
    windowIds: ['questions'],
    weights: [1],
    focusedWindowId: 'questions',
    lastActiveAt: 1,
  });
  state.activeSpaceId = 'space';
  openSignInTab(state, 'xinjiaoyu', 'questions', 'https://www.xinjiaoyu.com/auth/login', '1');
  store.workspaces.saveWorkspace(state);
  const app = createApplication(store, testGateway({ request: async () => ({}) }));
  try {
    assert.equal(store.workspaces.workspace(user.tenantId).tabs.length, 0);
    assert.equal(store.workspaces.workspace(user.tenantId).windows[0].activeTabId, null);
    assert.equal(app.learning.state(user.tenantId).accounts.xinjiaoyu.status, 'failed');
  } finally {
    await app.close();
    store.db.close();
  }
});
