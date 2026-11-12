import { applyDesiredViews } from './coordination-fixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createApplication } from '../server/application';
import type { EndpointLink } from '../server/endpoint/link';
import { createHttp } from '../server/http/server';
import { ControlDatabase } from '../server/persistence/database';
import { RemoteKitError } from '../shared/errors';
import type { ProductAction } from '../shared/product';
import { accountsFor, registerUser, requestViewer, TestClock, testGateway } from './server-fixture';

class ProductEndpoint implements EndpointLink {
  readonly state = { state: 'ready' as const, incarnation: 'test', connectionEpoch: 'test' };
  calls: { method: string; tenant: string; args: any }[] = [];
  views = new Map<string, Map<string, any>>();
  mediaApplied: any = null;
  navigationFailure = false;
  pending = false;
  running = false;
  browserPid = 10;
  failSites = false;
  failAck = false;
  loseAdoptReply = false;
  popups: any[] = [];
  events: any[] = [];
  onAdopt?: (args: any) => void;
  stopBeforeMaintenance = false;
  loseEnsureReply = false;
  guardedLifecycle?: (view: any, args: any) => Record<string, unknown>;
  observe(tenant: string) {
    return {
      running: this.running,
      browserPid: this.browserPid,
      browserIncarnation: 'browser-' + this.browserPid,
      views: this.running ? [...(this.views.get(tenant)?.values() ?? [])].map((view) => ({ ...view })) : [],
      pendingPopups: this.popups,
      stats: { mediaPolicy: { applied: this.mediaApplied } },
    };
  }
  async request(method: string, tenant: string, args: any = {}) {
    this.calls.push({ method, tenant, args });
    let views = this.views.get(tenant);
    if (!views) this.views.set(tenant, (views = new Map()));
    if (method === 'session.desired') {
      if (this.failSites) throw new RemoteKitError('unavailable', 'UA apply failed');
      this.calls.push({ method: 'policy.sites.applied', tenant, args: args.sitePreferences });
      this.calls.push({ method: 'policy.media.applied', tenant, args: args.mediaPolicy });
      if (!this.running && args.run === 'running')
        this.calls.push({ method: 'browser.started', tenant, args: {} });
      this.running = args.run === 'running';
      for (const config of args.views) {
        if (config.adopt && !views.has(config.viewId)) {
          this.onAdopt?.({ ...config, provisionalId: config.adopt.provisionalId });
          if (
            !this.popups.some((p) => p.provisionalId === config.adopt.provisionalId && p.status === 'pending')
          )
            throw new RemoteKitError('not_found', 'popup_not_pending');
          this.popups = this.popups.filter((p) => p.provisionalId !== config.adopt.provisionalId);
          this.calls.push({
            method: 'view.adopted',
            tenant,
            args: { ...config, provisionalId: config.adopt.provisionalId },
          });
        }
      }
      for (const config of args.views) if (config.adopt) config.presence = 'ensure';
      for (const change of applyDesiredViews(views, args))
        if (!args.views.find((view: any) => view.viewId === change.args.viewId)?.adopt)
          this.calls.push({ ...change, tenant });
      if (this.loseEnsureReply || this.loseAdoptReply) {
        this.loseEnsureReply = false;
        this.loseAdoptReply = false;
        throw new RemoteKitError('outcome_unknown', 'desired acceptance reply lost');
      }
      return { accepted: true, revision: args.revision };
    }
    if (method === 'view.navigate') {
      if (this.navigationFailure) {
        this.navigationFailure = false;
        throw new RemoteKitError('outcome_unknown', 'navigation reply lost');
      }
      Object.assign(views.get(args.viewId)!, {
        url: args.url,
        navigationOperations: [
          {
            operationId: args.operationId,
            operationGeneration: args.operationGeneration,
            state: 'committed',
            url: args.url,
            documentCommitted: true,
          },
        ],
      });
      return { accepted: true, completed: true, navigation: { status: 'committed', url: args.url } };
    }
    if (method === 'view.page.reply') {
      const v = views.get(args.viewId)!;
      if (String(v.instance) !== args.instance || String(v.document) !== args.document)
        throw new RemoteKitError('conflict', 'stale_page_request');
      v.pageRequests.pending = v.pageRequests.pending.filter((p: any) => p.request !== args.requestId);
      return { accepted: true, browser: { ok: true, state: 'resolved' } };
    }
    if (method === 'view.page.exitFullscreen') {
      const view = views.get(args.viewId);
      if (
        !view ||
        args.browserIncarnation !== 'browser-' + this.browserPid ||
        args.instance !== view.instance ||
        args.document !== view.document
      )
        throw new RemoteKitError('conflict', 'stale_page_request_target');
      view.fullscreen = false;
      return { ok: true };
    }
    if (method === 'view.lifecycle') {
      const v = views.get(args.viewId)!;
      if (args.lifecycleGeneration !== undefined && this.guardedLifecycle)
        return this.guardedLifecycle(v, args);
      if (args.action === 'restore') {
        v.pending = true;
        v.desired = 0;
      } else v.actual = 2;
      return { accepted: true, completed: false, pending: true, lifecycleGeneration: '1' };
    }
    if (method === 'view.close') {
      if (this.pending && !args.force)
        return {
          pending: true,
          requestId: 'close-1',
          browserIncarnation: 'browser-' + this.browserPid,
          instance: String(views.get(args.viewId).instance),
          document: String(views.get(args.viewId).document),
        };
      views.delete(args.viewId);
      return { closed: true };
    }
    if (method === 'view.close.reply') {
      if (args.accept) views.get(args.viewId).close_state = 'closed';
      return { accepted: true, browser: { ok: true } };
    }
    if (method === 'rtc.offer') return { sdp: 'v=0\r\n' };
    return {};
  }
}
async function fixture() {
  const clock = new TestClock(),
    store = new ControlDatabase(':memory:', { clock, buildId: 'test' }),
    endpoint = new ProductEndpoint(),
    control = createApplication(store, testGateway(endpoint), undefined, clock);
  const user = await registerUser(store, 'testuser', 'password123');
  return { store, endpoint, control, user, clock };
}

test('offline startup does not create Browsers; multi-window mutations preserve tab ownership and empty windows', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.reconciler.reconcileAll();
    await control.reconciler.tick();
    assert.equal(endpoint.calls.length, 0);
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    let result = await control.operations.productAction(
      user.tenantId,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://a.test/' },
      'lease',
    );
    const a = result.state.workspace.windows[0],
      tabA = result.state.workspace.tabs[0];
    result = await control.operations.productAction(
      user.tenantId,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
      'lease',
    );
    const b = result.state.workspace.windows[1],
      tabB = result.state.workspace.tabs[1];
    await requestViewer(control, user.tenantId, 'lease', 'viewport', {
      devicePixelRatio: 2,
      windows: [
        { windowId: a.id, width: 800, height: 600, visible: true, occludedBottom: 0, occlusionRevision: '1' },
        { windowId: b.id, width: 700, height: 600, visible: true, occludedBottom: 0, occlusionRevision: '1' },
      ],
    });
    assert.equal(endpoint.views.get(user.tenantId)!.get(tabA.webviewId).visible, false);
    assert.equal(endpoint.views.get(user.tenantId)!.get(tabB.webviewId).width, 700);
    const next = await control.operations.productAction(
      user.tenantId,
      { type: 'tab.move', tabId: tabA.id, windowId: b.id },
      'lease',
    );
    assert.equal(next.state.workspace.windows.find((w) => w.id === a.id)!.activeTabId, null);
    assert.equal(next.state.workspace.tabs.find((t) => t.id === tabA.id)!.webviewId, tabA.webviewId);
    await control.operations.productAction(user.tenantId, { type: 'tab.close', tabId: tabA.id }, 'lease');
    await control.operations.productAction(user.tenantId, { type: 'tab.close', tabId: tabB.id }, 'lease');
    assert.equal(store.workspaces.workspace(user.tenantId).windows.length, 2);
    assert.equal(store.workspaces.workspace(user.tenantId).tabs.length, 0);
    await control.operations.productAction(user.tenantId, { type: 'window.close', windowId: a.id }, 'lease');
    assert.equal(store.workspaces.workspace(user.tenantId).windows.length, 1);
    await control.reconciler.tick();
    const revision = store.workspaces.workspace(user.tenantId).revision;
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(user.tenantId).revision, revision);
    const invalid = store.workspaces.workspace(user.tenantId);
    invalid.windows[0].activeTabId = 'foreign-tab';
    assert.throws(() => store.workspaces.saveWorkspace(invalid), { code: 'internal' });
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('window beforeunload cancellation retains remaining tabs; settings and site rules persist independently of viewport', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    let state = (
      await control.operations.productAction(
        user.tenantId,
        {
          type: 'window.open',
          appId: 'browser',
          placement: { mode: 'space' },
          url: 'https://EXAMPLE.com/path',
        },
        'lease',
      )
    ).state;
    const w = state.workspace.windows[0],
      tab = state.workspace.tabs[0];
    endpoint.pending = true;
    state = (
      await control.operations.productAction(user.tenantId, { type: 'window.close', windowId: w.id }, 'lease')
    ).state;
    assert.equal(state.workspace.tabs.length, 1);
    assert.equal(state.workspace.pendingClose?.nativeRequestId, 'close-1');
    state = (
      await control.operations.productAction(
        user.tenantId,
        {
          type: 'tab.close',
          tabId: tab.id,
          requestId: state.workspace.pendingClose!.requestId,
          cancel: true,
        },
        'lease',
      )
    ).state;
    assert.equal(state.workspace.windows.length, 1);
    assert.equal(state.workspace.pendingWindowCloseId, null);
    const site = await control.operations.productAction(
      user.tenantId,
      { type: 'site.set', origin: 'https://EXAMPLE.com:443/foo', tabletUa: true },
      'lease',
    );
    assert.equal(site.application, undefined);
    assert.deepEqual(site.state.workspace.sites, { 'https://example.com': { tabletUa: true } });
    state = (
      await control.operations.productAction(
        user.tenantId,
        {
          type: 'settings.update',
          settings: { workspace: { uiScale: 1.5, topDeadZone: 32, qualityPreference: 'smooth' } },
        },
        'lease',
      )
    ).state;
    assert.equal(state.workspace.settings.workspace.uiScale, 1.5);
    assert.equal(state.workspace.settings.workspace.topDeadZone, 32);
    assert.ok(
      endpoint.calls
        .filter((c) => c.method === 'view.configured')
        .every((c) => c.args.device.mode === 'desktop'),
    );
    for (const settings of [
      { uiScale: 5 },
      { uiScale: 0.25 },
      { topDeadZone: 0 },
      { topDeadZone: 12.5 },
      { topDeadZone: 'top' },
      { clientScaleOverride: 1.5 },
    ])
      await assert.rejects(
        control.operations.productAction(
          user.tenantId,
          { type: 'settings.update', settings: { workspace: settings as never } },
          'lease',
        ),
        JSON.stringify(settings),
      );
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('automatic Viewer fullscreen and AV sync default off and save explicit booleans', async () => {
  const {
    store,
    control,
    user: { tenantId },
  } = await fixture();
  try {
    store.db.prepare('UPDATE user_settings SET data=? WHERE tenant=?').run(
      JSON.stringify({
        ...store.workspaces.workspace(tenantId).settings,
        browser: { ...store.workspaces.workspace(tenantId).settings.browser, searchEngine: 'bing' },
      }),
      tenantId,
    );
    assert.equal(store.workspaces.workspace(tenantId).settings.workspace.autoFullscreen, false);
    assert.equal(store.workspaces.workspace(tenantId).settings.workspace.avSync, false);
    await control.viewers.attachViewer(
      tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    await control.operations.productAction(
      tenantId,
      { type: 'settings.update', settings: { workspace: { autoFullscreen: true, avSync: true } } },
      'lease',
    );
    await assert.rejects(
      requestViewer(control, tenantId, 'lease', 'action', {
        type: 'settings.update',
        settings: { workspace: { autoFullscreen: 'true' } },
      }),
      { code: 'invalid_request' },
    );
    for (const avSync of ['true', 1, null]) {
      await assert.rejects(
        requestViewer(control, tenantId, 'lease', 'action', {
          type: 'settings.update',
          settings: { workspace: { avSync } },
        }),
        { code: 'invalid_request' },
      );
    }
    const attached = await control.viewers.attachViewer(
      tenantId,
      'replacement',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.equal(attached?.workspace.settings.workspace.autoFullscreen, true);
    assert.equal(attached?.workspace.settings.workspace.avSync, true);
    assert.equal(attached?.workspace.settings.browser.searchEngine, 'bing');
  } finally {
    await control.viewers.detachViewer(tenantId, 'replacement');
    await control.close();
    store.db.close();
  }
});

test('remote page fullscreen follows the live document, with a document-bound exit and reconnect reconciliation', async () => {
  const {
    store,
    endpoint,
    control,
    user: { tenantId },
  } = await fixture();
  try {
    await control.viewers.attachViewer(
      tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const { state } = await control.operations.productAction(
      tenantId,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://fullscreen.test' },
      'lease',
    );
    const [tab] = state.workspace.tabs,
      view = endpoint.views.get(tenantId)!.get(tab.webviewId);
    const page = () => control.viewers.productState(tenantId).pageFullscreen;
    view.fullscreen = true;
    await control.reconciler.tick();
    const first = page()!;
    assert.equal(first.tabId, tab.id);
    assert.equal(first.windowId, tab.windowId);
    assert.equal(store.workspaces.workspace(tenantId).settings.workspace.autoFullscreen, false);
    assert.equal(store.workspaces.workspace(tenantId).settings.workspace.avSync, false);
    assert.equal('pageFullscreen' in store.workspaces.workspace(tenantId), false);
    view.document = '2';
    await control.reconciler.tick();
    const second = page()!;
    assert.notEqual(second.target, first.target);
    await assert.rejects(
      control.operations.productAction(
        tenantId,
        { type: 'page.exitFullscreen', target: first.target },
        'lease',
      ),
      { code: 'conflict' },
    );
    assert.equal(
      endpoint.calls.some((call) => call.method === 'view.page.exitFullscreen'),
      false,
    );
    await control.viewers.detachViewer(tenantId, 'lease');
    assert.equal(page(), undefined);
    await control.viewers.attachViewer(
      tenantId,
      'replacement',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.equal(page()?.target, second.target);
    await control.operations.productAction(
      tenantId,
      { type: 'page.exitFullscreen', target: second.target },
      'replacement',
    );
    assert.equal(page(), undefined);
    assert.deepEqual(endpoint.calls.find((call) => call.method === 'view.page.exitFullscreen')?.args, {
      browserIncarnation: 'browser-10',
      viewId: tab.webviewId,
      instance: '1',
      document: '2',
    });
    view.fullscreen = true;
    await control.reconciler.tick();
    assert.ok(page());
    view.fullscreen = false;
    view.document = '3';
    await control.reconciler.tick();
    assert.equal(page(), undefined);
  } finally {
    await control.viewers.detachViewer(tenantId, 'replacement');
    await control.close();
    store.db.close();
  }
});

test('automatic reclaim uses eligible background time and canDiscard; activating a discarded page waits for actual live completion', async () => {
  const { store, endpoint, control, user, clock } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const created = await control.operations.productAction(
        user.tenantId,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
        'lease',
      ),
      tab = created.state.workspace.tabs[0],
      w = created.state.workspace.windows[0];
    const view = endpoint.views.get(user.tenantId)!.get(tab.webviewId);
    view.canDiscard = false;
    await control.reconciler.tick();
    assert.equal(endpoint.calls.filter((c) => c.method === 'view.lifecycle').length, 0);
    view.canDiscard = true;
    await control.reconciler.tick();
    for (let i = 0; i < 13; i++) {
      clock.advance(10000);
      await control.reconciler.tick();
    }
    assert.equal(view.actual, 2);
    await requestViewer(control, user.tenantId, 'lease', 'viewport', {
      devicePixelRatio: 1,
      windows: [
        {
          windowId: w.id,
          width: 1200,
          height: 800,
          visible: true,
          occludedBottom: 0,
          occlusionRevision: '1',
        },
      ],
    });
    assert.equal(view.pending, true);
    assert.equal(
      endpoint.calls.filter((c) => c.method === 'view.lifecycle' && c.args.action === 'restore').length,
      1,
    );
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(user.tenantId).tabs[0].restoring, true);
    view.actual = 0;
    view.pending = false;
    await control.reconciler.tick();
    assert.equal(view.visible, true);
    await control.viewers.detachViewer(user.tenantId, 'lease');
    assert.equal(view.visible, false);
    assert.equal(view.width, 1200);
    assert.equal(view.height, 800);
  } finally {
    await control.close();
    store.db.close();
  }
});

async function uncertainTab() {
  const f = await fixture(),
    tenant = f.user.tenantId;
  await f.control.viewers.attachViewer(
    tenant,
    'lease',
    () => {},
    { identity: 'test-account', valid: () => true },
    true,
  );
  const { workspace } = (
    await f.control.operations.productAction(
      tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://saved.test/' },
      'lease',
    )
  ).state;
  const tab = workspace.tabs[0],
    window = workspace.windows[0];
  const viewport = {
    devicePixelRatio: 1,
    windows: [
      {
        windowId: window.id,
        width: 1200,
        height: 800,
        visible: true,
        occludedBottom: 0,
        occlusionRevision: '1',
      },
    ],
  };
  await requestViewer(f.control, tenant, 'lease', 'viewport', viewport);
  const view = f.endpoint.views.get(tenant)!.get(tab.webviewId);
  Object.assign(view, {
    lifecycle_uncertain: true,
    lifecycle_generation: '41',
    last_lifecycle: { generation: '41', action: 0, succeeded: false },
  });
  const tabState = () => f.store.workspaces.workspace(tenant).tabs[0];
  const lifecycleCalls = () =>
    f.endpoint.calls.filter((call) => call.method === 'view.lifecycle').map((call) => call.args);
  return { ...f, tenant, tab, view, viewport, tabState, lifecycleCalls };
}

test('uncertain recovery uses matching unload and restore snapshot evidence after both replies are lost', async () => {
  const f = await uncertainTab();
  try {
    f.endpoint.guardedLifecycle = (view, args) => {
      assert.equal(view.visible, false);
      if (args.action === 'unload')
        Object.assign(view, {
          actual: 3,
          instance: '2',
          pending: false,
          lifecycle_uncertain: false,
          lifecycle_generation: '42',
          last_lifecycle: { generation: '42', action: 2, succeeded: true },
        });
      else Object.assign(view, { pending: true, desired: 0, lifecycle_generation: '43', url: 'about:blank' });
      throw new RemoteKitError('outcome_unknown', 'lifecycle response lost');
    };
    f.endpoint.calls = [];
    await f.control.reconciler.tick();
    assert.equal(f.tabState().lifecycleRecovery?.phase, 'unload');
    assert.equal(f.view.visible, false);
    assert.deepEqual(f.lifecycleCalls(), [
      {
        viewId: f.tab.webviewId,
        action: 'unload',
        requireRunning: true,
        browserIncarnation: 'browser-10',
        lifecycleGeneration: '41',
      },
    ]);
    f.view.last_lifecycle.generation = '40';
    await f.control.reconciler.tick();
    assert.equal(f.lifecycleCalls().length, 1);
    f.view.last_lifecycle.generation = '42';
    await f.control.reconciler.tick();
    assert.equal(f.tabState().lifecycleRecovery?.phase, 'restore');
    assert.deepEqual(f.lifecycleCalls()[1], {
      viewId: f.tab.webviewId,
      action: 'restore',
      requireRunning: true,
      browserIncarnation: 'browser-10',
      lifecycleGeneration: '42',
    });
    await f.control.reconciler.tick();
    assert.equal(f.tabState().url, 'https://saved.test/');
    assert.equal(f.lifecycleCalls().length, 2);
    Object.assign(f.view, {
      actual: 0,
      pending: false,
      url: 'https://saved.test/',
      last_lifecycle: { generation: '43', action: 3, succeeded: true },
    });
    await f.control.reconciler.tick();
    assert.equal(f.view.visible, true);
    assert.equal(f.tabState().lifecycleRecovery, undefined);
    assert.equal(f.tabState().lifecycleRecoveryError, undefined);
    assert.equal(
      f.endpoint.calls.some((c) => c.method === 'view.navigate' || c.method === 'view.created'),
      false,
    );
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('unconfirmed unload survives Control restart and is retired on Browser incarnation change', async () => {
  const f = await uncertainTab();
  let control = f.control;
  try {
    f.endpoint.guardedLifecycle = () => {
      throw new RemoteKitError('outcome_unknown', 'lifecycle response lost');
    };
    const workspace = f.store.workspaces.workspace(f.tenant);
    workspace.tabs[0].pendingUrl = 'https://unconfirmed.test/';
    f.store.workspaces.saveWorkspace(workspace);
    await control.reconciler.tick();
    await control.close();
    control = createApplication(f.store, testGateway(f.endpoint));
    await control.viewers.attachViewer(
      f.tenant,
      'new-lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    await requestViewer(control, f.tenant, 'new-lease', 'viewport', f.viewport);
    await control.reconciler.tick();
    assert.equal(f.lifecycleCalls().length, 1);
    assert.equal(f.tabState().lifecycleRecovery?.generation, '41');
    assert.equal(f.tabState().lifecycleRecoveryError, undefined);
    assert.equal(f.tabState().lifecycleRecovery?.phase, 'unload');
    f.endpoint.browserPid++;
    f.endpoint.views.get(f.tenant)!.clear();
    await control.reconciler.tick();
    assert.equal(f.lifecycleCalls().length, 1);
    assert.equal(f.tabState().lifecycleRecovery, undefined);
    assert.equal(f.tabState().lifecycleRecoveryError, undefined);
    assert.equal(f.endpoint.views.get(f.tenant)!.get(f.tab.webviewId).url, 'https://saved.test/');
  } finally {
    await control.close();
    f.store.db.close();
  }
});

test('unsafe POST checkpoint leaves an explicit tab error and never repeats unload or restores', async () => {
  const f = await uncertainTab();
  try {
    f.endpoint.guardedLifecycle = () => {
      throw new RemoteKitError('rejected', 'POST requires repost confirmation');
    };
    f.endpoint.calls = [];
    await f.control.reconciler.tick();
    const revision = f.store.workspaces.workspace(f.tenant).revision;
    await f.control.reconciler.tick();
    assert.equal(f.store.workspaces.workspace(f.tenant).revision, revision);
    assert.deepEqual(
      f.lifecycleCalls().map((c) => c.action),
      ['unload'],
    );
    assert.equal(f.view.actual, 0);
    assert.equal(f.view.visible, false);
    assert.match(f.tabState().lifecycleRecoveryError!.message, /POST requires repost confirmation/);
    await f.control.operations.productAction(f.tenant, { type: 'tab.close', tabId: f.tab.id }, 'lease');
    await f.control.operations.productAction(
      f.tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://saved.test/' },
      'lease',
    );
    assert.equal(f.tabState().lifecycleRecoveryError, undefined);
  } finally {
    await f.control.close();
    f.store.db.close();
  }
});

test('showStats defaults off, persists as a boolean and rejects other values', async () => {
  const { store, control, user } = await fixture();
  try {
    assert.equal(store.workspaces.workspace(user.tenantId).settings.workspace.showStats, false);
    const result = await control.operations.productAction(user.tenantId, {
      type: 'settings.update',
      settings: { workspace: { showStats: true } },
    });
    assert.equal(result.state.workspace.settings.workspace.showStats, true);
    await assert.rejects(
      control.operations.productAction(user.tenantId, {
        type: 'settings.update',
        settings: { workspace: { showStats: 'true' } },
      } as any),
    );
  } finally {
    await control.close();
    store.db.close();
  }
});

test('UA table precedes Browser/view creation; failed application persists desired and retries before current-tab-only reload', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const firstSites = endpoint.calls.findIndex((c) => c.method === 'policy.sites.applied'),
      ensure = endpoint.calls.findIndex((c) => c.method === 'browser.started');
    assert.ok(firstSites >= 0 && firstSites < ensure);
    const created = await control.operations.productAction(
        user.tenantId,
        {
          type: 'window.open',
          appId: 'browser',
          placement: { mode: 'space' },
          url: 'https://example.test/a',
        },
        'lease',
      ),
      w = created.state.workspace.windows[0],
      a = created.state.workspace.tabs[0];
    const second = await control.operations.productAction(
        user.tenantId,
        { type: 'tab.create', windowId: w.id, url: 'https://example.test/b' },
        'lease',
      ),
      b = second.state.workspace.tabs[1];
    endpoint.calls = [];
    endpoint.failSites = true;
    const pending = await control.operations.productAction(
      user.tenantId,
      { type: 'site.set', origin: 'https://example.test', tabletUa: true, tabId: b.id },
      'lease',
    );
    assert.equal(pending.application?.status, 'pending');
    assert.equal(store.workspaces.workspace(user.tenantId).sites['https://example.test'].tabletUa, true);
    assert.equal(endpoint.calls.filter((c) => c.method === 'view.command').length, 0);
    endpoint.calls = [];
    const unchanged = await control.operations.productAction(
      user.tenantId,
      { type: 'site.set', origin: 'https://example.test', tabletUa: true, tabId: b.id },
      'lease',
    );
    assert.equal(unchanged.application, undefined);
    assert.equal(
      unchanged.state.workspace.tabs.find((t) => t.id === b.id)?.pendingUaReloadOrigin,
      'https://example.test',
    );
    assert.deepEqual(endpoint.calls, []);
    endpoint.failSites = false;
    endpoint.calls = [];
    control.tenants.get(user.tenantId).reconciliation.retryAt = 0;
    await control.reconciler.tick();
    const applied = endpoint.calls.findIndex((c) => c.method === 'policy.sites.applied'),
      reloaded = endpoint.calls.findIndex((c) => c.method === 'view.command');
    assert.ok(applied >= 0 && reloaded > applied);
    assert.deepEqual(
      endpoint.calls.filter((c) => c.method === 'view.command').map((c) => c.args.viewId),
      [b.webviewId],
    );
    assert.notEqual(a.webviewId, b.webviewId);
    assert.equal(
      store.workspaces.workspace(user.tenantId).tabs.find((t) => t.id === b.id)!.pendingUaReloadOrigin,
      undefined,
    );
    endpoint.calls = [];
    endpoint.browserPid++;
    await control.reconciler.tick();
    assert.equal(endpoint.calls.filter((c) => c.method === 'session.desired').length, 0);
    await control.reconciler.reconcileAll();
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('auto keyboard persists globally, has a committed receipt, and leaves site UA preferences independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rk-site-settings-')),
    path = join(dir, 'control.db');
  const endpoint = new ProductEndpoint();
  let store = new ControlDatabase(path, { buildId: 'test' }),
    control = createApplication(store, testGateway(endpoint));
  try {
    const { tenantId } = await registerUser(store, 'site-settings', 'password123');
    const origin = 'https://example.test',
      unrelated = 'https://other.test';
    store.db
      .prepare('INSERT INTO site_preferences VALUES (?,?,?)')
      .run(tenantId, origin, JSON.stringify({ tabletUa: true }));
    await control.viewers.attachViewer(
      tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.deepEqual(control.viewers.productState(tenantId).workspace.sites[origin], { tabletUa: true });
    const { state } = await control.operations.productAction(
      tenantId,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: origin + '/a' },
      'lease',
    );
    const tabId = state.workspace.tabs[0].id;
    assert.equal(state.workspace.settings.workspace.autoKeyboard, false);
    const keyboard = {
      operationId: randomUUID(),
      operationGeneration: store.operations.operationGeneration(tenantId),
      action: {
        type: 'settings.update',
        settings: { workspace: { autoKeyboard: true } },
      } as const,
    };
    endpoint.calls = [];
    const receipt = await control.operations.submitOperation(tenantId, keyboard, 'lease');
    assert.equal(receipt.status, 'committed');
    assert.equal(receipt.application, undefined);
    assert.deepEqual(control.viewers.productState(tenantId).workspace.sites, {
      [origin]: { tabletUa: true },
    });
    await control.operations.productAction(
      tenantId,
      { type: 'site.set', origin: 'https://EXAMPLE.test:443/path', tabletUa: true, tabId },
      'lease',
    );
    await control.reconciler.tick();
    assert.deepEqual(
      endpoint.calls.filter((c) => ['policy.sites.applied', 'view.command'].includes(c.method)),
      [],
    );

    endpoint.calls = [];
    await control.operations.productAction(
      tenantId,
      { type: 'site.set', origin, tabletUa: false, tabId },
      'lease',
    );
    assert.equal(store.workspaces.workspace(tenantId).sites[origin], undefined);
    assert.equal(store.workspaces.workspace(tenantId).settings.workspace.autoKeyboard, true);
    const cleared = endpoint.calls.filter((c) => c.method === 'policy.sites.applied');
    assert.ok(cleared.length);
    for (const call of cleared) assert.deepEqual(call.args.sites, {});
    assert.deepEqual(
      endpoint.calls.filter((c) => c.method === 'view.command').map((c) => c.args.command),
      ['reload'],
    );

    endpoint.calls = [];
    await control.operations.productAction(
      tenantId,
      { type: 'site.set', origin, tabletUa: true, tabId },
      'lease',
    );
    assert.deepEqual(store.workspaces.workspace(tenantId).sites[origin], {
      tabletUa: true,
    });
    const applied = endpoint.calls.filter((c) => c.method === 'policy.sites.applied');
    assert.ok(applied.length);
    for (const call of applied) assert.deepEqual(call.args.sites, { [origin]: { tabletUa: true } });
    assert.deepEqual(
      endpoint.calls.filter((c) => c.method === 'view.command').map((c) => c.args.command),
      ['reload'],
    );

    endpoint.calls = [];
    await control.operations.productAction(
      tenantId,
      { type: 'site.set', origin, tabletUa: true, tabId },
      'lease',
    );
    assert.deepEqual(endpoint.calls, []);
    for (const patch of [
      {},
      { manualKeyboard: true },
      { tabletUa: true, manualKeyboard: true },
      { tabletUa: 'true' },
      { tabletUa: true, manualKeyboard: 0 },
      { tabletUa: true, unknown: true },
    ]) {
      await assert.rejects(
        control.operations.productAction(
          tenantId,
          { type: 'site.set', origin, ...patch } as ProductAction,
          'lease',
        ),
        (error: any) => error.code === 'invalid_request',
      );
    }
    await assert.rejects(
      control.operations.productAction(
        tenantId,
        { type: 'site.set', origin: unrelated, tabletUa: false, tabId },
        'lease',
      ),
      (error: any) => error.code === 'invalid_request',
    );
    await assert.rejects(
      control.operations.productAction(
        tenantId,
        { type: 'site.set', origin: 'file:///tmp/a', tabletUa: true },
        'lease',
      ),
      (error: any) => error.code === 'invalid_request',
    );
    assert.deepEqual(endpoint.calls, []);

    for (const autoKeyboard of ['true', 1, null]) {
      await assert.rejects(
        control.operations.productAction(
          tenantId,
          {
            type: 'settings.update',
            settings: { workspace: { autoKeyboard } },
          } as unknown as ProductAction,
          'lease',
        ),
        { code: 'invalid_request' },
      );
    }
    await control.viewers.detachViewer(tenantId, 'lease');
    await control.close();
    store.db.close();
    store = new ControlDatabase(path, { buildId: 'test' });
    control = createApplication(store, testGateway(endpoint));
    await control.viewers.attachViewer(
      tenantId,
      'new-lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.deepEqual(control.viewers.productState(tenantId).workspace.sites, {
      [origin]: { tabletUa: true },
    });
    assert.equal(control.viewers.productState(tenantId).workspace.settings.workspace.autoKeyboard, true);
    assert.deepEqual(control.operations.operationStatus(tenantId, keyboard), receipt);
    await control.viewers.detachViewer(tenantId, 'new-lease');
  } finally {
    await control.close();
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('popup adoption persists identity first; background stays unfocused, new windows are independent, replay is idempotent', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const initial = (
        await control.operations.productAction(
          user.tenantId,
          { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://opener.test' },
          'lease',
        )
      ).state.workspace,
      opener = initial.tabs[0];
    endpoint.onAdopt = (args) => {
      const persisted = store.workspaces
        .workspace(user.tenantId)
        .tabs.find((t) => t.webviewId === args.viewId);
      assert.equal(persisted?.popup?.provisionalId, args.provisionalId);
      assert.equal(persisted?.popup?.status, 'pending');
    };
    endpoint.popups = [
      {
        provisionalId: 'background',
        openerViewId: opener.webviewId,
        url: 'about:blank',
        disposition: 4,
        userGesture: true,
        status: 'pending',
      },
    ];
    endpoint.calls = [];
    await control.reconciler.tick();
    await control.reconciler.tick();
    let state = store.workspaces.workspace(user.tenantId),
      child = state.tabs.find((t) => t.popup?.provisionalId === 'background')!;
    assert.ok(child);
    assert.equal(child.kind, 'remote');
    assert.equal(child.url, 'about:blank');
    assert.equal(child.popup!.status, 'adopted');
    assert.equal(child.windowId, opener.windowId);
    assert.equal(state.windows[0].activeTabId, opener.id);
    assert.equal(state.activeSpaceId, initial.activeSpaceId);
    assert.equal(endpoint.calls.filter((c) => c.method === 'view.created').length, 0);
    endpoint.popups = [
      {
        provisionalId: 'background',
        openerViewId: opener.webviewId,
        url: child.url,
        disposition: 4,
        userGesture: true,
        status: 'pending',
      },
    ];
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(user.tenantId).tabs.length, 2);
    endpoint.popups = [
      {
        provisionalId: 'new-window',
        openerViewId: opener.webviewId,
        url: 'https://child.test/w',
        disposition: 6,
        userGesture: true,
        status: 'pending',
      },
    ];
    endpoint.loseAdoptReply = false;
    await control.reconciler.tick();
    state = store.workspaces.workspace(user.tenantId);
    const newWindow = state.tabs.find((t) => t.popup?.provisionalId === 'new-window')!;
    assert.notEqual(newWindow.windowId, opener.windowId);
    assert.equal(state.windows.length, 2);
    endpoint.calls = [];
    await control.reconciler.tick();
    state = store.workspaces.workspace(user.tenantId);
    assert.equal(state.tabs.find((t) => t.id === newWindow.id)!.popup!.status, 'adopted');
    assert.equal(endpoint.calls.filter((c) => c.method === 'view.created').length, 0);
    assert.equal(state.tabs.length, 3);
    endpoint.popups = [
      {
        provisionalId: 'no-gesture',
        openerViewId: opener.webviewId,
        url: 'https://child.test/',
        disposition: 6,
        userGesture: false,
        status: 'pending',
      },
    ];
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(user.tenantId).tabs.length, 3);
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('expired pending popup is never URL-recreated; closing its product tab does not resurface it', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const opener = (
      await control.operations.productAction(
        user.tenantId,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
        'lease',
      )
    ).state.workspace.tabs[0];
    const popup = {
      provisionalId: 'expired',
      openerViewId: opener.webviewId,
      url: 'https://expired.test/',
      disposition: 3,
      userGesture: true,
      status: 'pending',
    };
    endpoint.popups = [popup];
    endpoint.onAdopt = () => {
      throw new RemoteKitError('outcome_unknown', 'temporary transport failure');
    };
    await control.reconciler.tick();
    const pending = store.workspaces
      .workspace(user.tenantId)
      .tabs.find((t) => t.popup?.provisionalId === popup.provisionalId)!;
    endpoint.onAdopt = undefined;
    popup.status = 'timed_out';
    endpoint.calls = [];
    await control.reconciler.tick();
    assert.equal(
      store.workspaces.workspace(user.tenantId).tabs.find((t) => t.id === pending.id)!.popup!.status,
      'failed',
    );
    assert.equal(
      endpoint.calls.filter((c) => c.method === 'view.created' || c.method === 'view.adopted').length,
      0,
    );
    await control.operations.productAction(user.tenantId, { type: 'tab.close', tabId: pending.id }, 'lease');
    popup.status = 'pending';
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(user.tenantId).tabs.length, 1);
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('pageDialogs are transient, tenant/token bound and cancellation never deletes tabs or duplicates pendingClose', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const tab = (
      await control.operations.productAction(
        user.tenantId,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
        'lease',
      )
    ).state.workspace.tabs[0];
    const view = endpoint.views.get(user.tenantId)!.get(tab.webviewId);
    Object.assign(view, {
      instance: '1',
      document: '2',
      pageRequests: {
        pending: [
          {
            request: '7',
            kind: 'prompt',
            message: 'private dialog text',
            default_prompt: 'initial',
            origin: 'https://page.test',
          },
        ],
      },
    });
    await control.reconciler.tick();
    const dialog = control.viewers.productState(user.tenantId).pageDialogs[0];
    assert.equal(dialog.kind, 'prompt');
    assert.equal(dialog.defaultPrompt, 'initial');
    assert.ok(!JSON.stringify(store.workspaces.workspace(user.tenantId)).includes('private dialog text'));
    assert.ok(
      !(store.db.prepare('SELECT data FROM workspace_tabs WHERE tenant=?').all(user.tenantId) as any[]).some(
        (row) => row.data.includes('private dialog text'),
      ),
    );
    const other = await registerUser(store, 'another-user', 'password123');
    await assert.rejects(
      control.operations.productAction(other.tenantId, {
        type: 'page.reply',
        dialogId: dialog.id,
        reply: { kind: 'dialog', accept: true },
      }),
    );
    await control.operations.productAction(
      user.tenantId,
      { type: 'page.reply', dialogId: dialog.id, reply: { kind: 'dialog', accept: false, text: '取消' } },
      'lease',
    );
    assert.equal(control.viewers.productState(user.tenantId).pageDialogs.length, 0);
    assert.equal(store.workspaces.workspace(user.tenantId).tabs.length, 1);
    assert.equal(endpoint.calls.find((c) => c.method === 'view.page.reply')!.args.document, '2');
    await assert.rejects(
      control.operations.productAction(
        user.tenantId,
        { type: 'page.reply', dialogId: dialog.id, reply: { kind: 'dialog', accept: true } },
        'lease',
      ),
      { code: 'conflict' },
    );
    view.pageRequests.pending = [{ request: '8', kind: 'confirm', message: 'old document' }];
    await control.reconciler.tick();
    const old = control.viewers.productState(user.tenantId).pageDialogs[0];
    view.document = '3';
    await assert.rejects(
      control.operations.productAction(
        user.tenantId,
        { type: 'page.reply', dialogId: old.id, reply: { kind: 'dialog', accept: true } },
        'lease',
      ),
      { code: 'conflict' },
    );
    await control.reconciler.tick();
    const previousBrowser = control.viewers.productState(user.tenantId).pageDialogs[0];
    endpoint.browserPid++;
    await assert.rejects(
      control.operations.productAction(
        user.tenantId,
        { type: 'page.reply', dialogId: previousBrowser.id, reply: { kind: 'dialog', accept: true } },
        'lease',
      ),
      { code: 'conflict' },
    );
    const state = store.workspaces.workspace(user.tenantId);
    state.pendingClose = {
      id: tab.id,
      requestId: 'opaque-9',
      nativeRequestId: '9',
      browserIncarnation: 'browser-' + endpoint.browserPid,
      instance: String(view.instance),
      document: String(view.document),
      awaiting: false,
    };
    store.workspaces.saveWorkspace(state);
    view.pageRequests.pending = [{ request: '9', kind: 'beforeunload', message: 'close' }];
    await control.reconciler.tick();
    assert.equal(control.viewers.productState(user.tenantId).pageDialogs.length, 0);
    assert.equal(store.workspaces.workspace(user.tenantId).tabs.length, 1);
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('product media policy precedes ensure and feedback only updates diagnostic observations', async () => {
  const { store, endpoint, control, user, clock } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const firstPolicy = endpoint.calls.findIndex((c) => c.method === 'policy.media.applied'),
      firstEnsure = endpoint.calls.findIndex((c) => c.method === 'browser.started');
    assert.ok(firstPolicy >= 0 && firstPolicy < firstEnsure);
    const ws = (
      await control.operations.productAction(
        user.tenantId,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
        'lease',
      )
    ).state.workspace;
    await requestViewer(control, user.tenantId, 'lease', 'viewport', {
      devicePixelRatio: 1,
      windows: [
        {
          windowId: ws.windows[0].id,
          width: 800,
          height: 600,
          visible: true,
          occludedBottom: 0,
          occlusionRevision: '1',
        },
      ],
    });
    endpoint.calls = [];
    let now = clock.wallMs();
    for (let sequence = 1; sequence <= 3; sequence++) {
      clock.advance(2000);
      now = clock.wallMs();
      const result: any = await requestViewer(control, user.tenantId, 'lease', 'feedback', {
        sequence,
        sourceCaptureId: String(sequence),
        sampledAtServerMs: now,
        visible: true,
        presentationLatencyMs: 400,
        latencySource: 'capture-end-to-paint',
        clockUncertaintyMs: 2,
        sampleCount: 50,
        windowMs: 2000,
      });
      assert.equal(result.accepted, true);
    }
    assert.equal(control.viewers.productState(user.tenantId).quality.effectiveDpr, 1);
    assert.equal(endpoint.views.get(user.tenantId)!.get(ws.tabs[0].webviewId).device.deviceScaleFactor, 1);
    assert.equal(endpoint.calls.length, 0);
    assert.equal(control.viewers.productState(user.tenantId).quality.estimatedLatencyMs, 400);
    const other = await registerUser(store, 'quality-other', 'password123');
    assert.equal(control.viewers.productState(other.tenantId).quality.estimatedLatencyMs, null);
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('quality preference updates only WebRTC degradation policy while client display and DPR stay independent', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const ws = (
      await control.operations.productAction(
        user.tenantId,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
        'lease',
      )
    ).state.workspace;
    await requestViewer(control, user.tenantId, 'lease', 'viewport', {
      devicePixelRatio: 2,
      refreshHz: 120,
      windows: [
        {
          windowId: ws.windows[0].id,
          width: 800,
          height: 600,
          visible: true,
          occludedBottom: 0,
          occlusionRevision: '1',
        },
      ],
    });
    for (const [qualityPreference, degradationPreference] of [
      ['quality', 'maintain-resolution'],
      ['auto', 'balanced'],
      ['smooth', 'maintain-framerate'],
    ] as const) {
      endpoint.calls = [];
      const result = await control.operations.productAction(
        user.tenantId,
        { type: 'settings.update', settings: { workspace: { qualityPreference } } },
        'lease',
      );
      assert.deepEqual(result.state.quality.requested, { degradationPreference, maxFps: 120, audio: true });
      assert.equal(result.state.quality.effectiveDpr, 2);
      assert.equal(endpoint.views.get(user.tenantId)!.get(ws.tabs[0].webviewId).device.deviceScaleFactor, 2);
      const policies = endpoint.calls.filter((call) => call.method === 'policy.media.applied');
      assert.ok(policies.length > 0);
      for (const policy of policies)
        assert.deepEqual(policy.args, { degradationPreference, maxFps: 120, audio: true });
      assert.ok(
        !endpoint.calls.some((call) => call.method === 'session.rtc.close' || call.method === 'view.resize'),
      );
    }
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('audio channel changes reapply the audio policy without replacing RTC', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    await control.operations.productAction(
      user.tenantId,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
      'lease',
    );
    for (const [left, right] of [
      [false, false],
      [true, false],
      [false, false],
      [false, true],
    ]) {
      endpoint.calls = [];
      const result = await control.operations.productAction(
        user.tenantId,
        { type: 'settings.update', settings: { workspace: { audioChannels: { left, right } } } },
        'lease',
      );
      const policies = endpoint.calls.filter((call) => call.method === 'policy.media.applied');
      assert.ok(policies.length > 0);
      assert.equal(result.state.quality.requested.audio, left || right);
      for (const policy of policies) assert.equal(policy.args.audio, left || right);
      assert.ok(!endpoint.calls.some((call) => ['rtc.close', 'rtc.offer'].includes(call.method)));
    }
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('explicit no-peer media policy clears the previous applied diagnostic', async () => {
  const { store, endpoint, control, user } = await fixture();
  const request = endpoint.request.bind(endpoint);
  let applied: { degradationPreference: string; maxFps: number; audio: boolean } | null = {
    degradationPreference: 'balanced',
    audio: true,
    maxFps: 60,
  };
  const observe = endpoint.observe.bind(endpoint);
  endpoint.observe = (tenant) => ({ ...observe(tenant), stats: { mediaPolicy: { applied } } });
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    assert.deepEqual(control.viewers.productState(user.tenantId).quality.applied, applied);
    applied = null;
    await control.reconciler.tick();
    assert.equal(control.viewers.productState(user.tenantId).quality.applied, null);
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

function connect(url: string, cookie: string, origin = 'http://product.test') {
  const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } }),
    messages: any[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  ws.on('error', () => {});
  const wait = async (predicate: (m: any) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for socket response');
  };
  return {
    ws,
    wait,
    request: async (id: string, method: string, params: unknown) => {
      ws.send(JSON.stringify({ id, method, params }));
      return wait((m) => m.id === id);
    },
  };
}

test('HTTP auth and WS isolate users, reject origin/scope, revoke a replaced Viewer and hide on disconnect', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' }),
    endpoint = new ProductEndpoint(),
    control = createApplication(store, testGateway(endpoint)),
    server = createHttp(control, { origins: ['http://product.test'], clientDir: '.' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as any,
    base = `http://127.0.0.1:${address.port}`,
    socketUrl = base.replace('http:', 'ws:') + '/api/socket';
  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        Origin: 'http://product.test',
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const peers: ReturnType<typeof connect>[] = [];
  try {
    assert.equal(
      (await fetch(base + '/api/state?diagnostics=1', { headers: { 'X-RemoteKit-Diagnostics': '1' } }))
        .status,
      404,
    );
    assert.equal((await fetch(base + '/api/auth/me')).status, 401);
    assert.deepEqual(await (await fetch(base + '/api/auth/setup')).json(), { setupRequired: true });
    const register = await post('/api/auth/setup', { username: 'alice', password: 'password123' });
    assert.equal(register.status, 200);
    const cookieA = register.headers.get('set-cookie')!.split(';')[0];
    assert.match(register.headers.get('set-cookie')!, /HttpOnly.*SameSite=Strict/);
    assert.equal((await register.json()).user.isAdmin, true);
    assert.equal(
      (await (await fetch(base + '/api/auth/me', { headers: { Cookie: cookieA } })).json()).user.isAdmin,
      true,
    );
    assert.deepEqual(await (await fetch(base + '/api/auth/setup')).json(), { setupRequired: false });
    assert.equal(
      (await post('/api/auth/setup', { username: 'closed-user', password: 'password123' })).status,
      403,
    );
    assert.equal(
      (await post('/api/auth/register', { username: 'closed-user', password: 'password123' })).status,
      404,
    );
    const a = connect(socketUrl, cookieA);
    peers.push(a);
    await a.wait((m) => m.type === 'state');
    assert.deepEqual(
      (
        await a.request('create', 'admin.createUser', { username: 'bob', password: 'password123' })
      ).result.map((user: any) => user.username),
      ['alice', 'bob'],
    );
    const registerB = await post('/api/auth/login', { username: 'bob', password: 'password123' });
    const cookieB = registerB.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await post('/api/auth/login', { username: 'alice', password: 'wrong-pass' })).status, 401);
    assert.equal(
      (await post('/api/actions', { type: 'tab.create', url: 'about:blank' }, cookieA)).status,
      404,
    );
    assert.equal(
      (
        await a.request('1', 'action', {
          type: 'window.open',
          appId: 'browser',
          placement: { mode: 'space' },
          url: 'about:blank',
        })
      ).error.code,
      'invalid_request',
    );
    const stateA = (
        await control.operations.productAction(store.accounts.authenticated(cookieA.split('=')[1])!, {
          type: 'window.open',
          appId: 'browser',
          placement: { mode: 'space' },
          url: 'about:blank',
        })
      ).state,
      win = stateA.workspace.windows[0],
      tab = stateA.workspace.tabs[0];
    const b = connect(socketUrl, cookieB);
    peers.push(b);
    const initialB = await b.wait((m) => m.type === 'state');
    assert.equal(initialB.state.workspace.tabs.length, 0);
    assert.equal(initialB.state.user.isAdmin, false);
    for (const method of ['admin.users', 'admin.createUser', 'admin.deleteUser'])
      assert.equal(
        (
          await b.request('admin-' + method, method, {
            username: 'alice',
            password: 'password123',
            isAdmin: true,
          })
        ).error.code,
        'forbidden',
      );
    const foreign = await b.request('2', 'action', { type: 'tab.activate', tabId: tab.id });
    assert.equal(foreign.error.code, 'invalid_request');
    const scope = await b.request('3', 'action', {
      type: 'window.open',
      appId: 'browser',
      placement: { mode: 'space' },
      tenantId: stateA.workspace.tenantId,
    });
    assert.equal(scope.error.code, 'invalid_request');
    await a.request('4', 'viewport', {
      devicePixelRatio: 1,
      windows: [
        {
          windowId: win.id,
          width: 900,
          height: 700,
          visible: true,
          occludedBottom: 0,
          occlusionRevision: '1',
        },
      ],
    });
    assert.equal(endpoint.views.get(stateA.workspace.tenantId)!.get(tab.webviewId).visible, true);
    const replacement = connect(socketUrl, cookieA);
    peers.push(replacement);
    const revoked = await a.wait((m) => m.type === 'lease');
    assert.equal(revoked.outcome, 'replaced');
    assert.equal((await replacement.wait((m) => m.type === 'auth')).auth.locked, true);
    await replacement.request('unlock', 'auth.verify', { method: 'password', secret: 'password123' });
    await replacement.wait((m) => m.type === 'state');
    await assert.rejects(
      requestViewer(control, stateA.workspace.tenantId, 'stale-lease', 'action', {
        type: 'window.open',
        appId: 'browser',
        placement: { mode: 'space' },
        url: 'about:blank',
      }),
    );
    await replacement.request('5', 'viewport', {
      devicePixelRatio: 1,
      windows: [
        {
          windowId: win.id,
          width: 901,
          height: 700,
          visible: true,
          occludedBottom: 0,
          occlusionRevision: '1',
        },
      ],
    });
    const detached = new Promise<void>((resolve) => {
      const observed = (tenant: string, state: any) => {
        if (tenant === stateA.workspace.tenantId && !state.viewer.connected) {
          control.events.off('state', observed);
          resolve();
        }
      };
      control.events.on('state', observed);
    });
    replacement.ws.close();
    await once(replacement.ws, 'close');
    await detached;
    assert.equal(endpoint.views.get(stateA.workspace.tenantId)!.get(tab.webviewId).visible, false);
    const badOrigin = connect(socketUrl, cookieB, 'http://evil.test');
    await once(badOrigin.ws, 'error');
    assert.notEqual(badOrigin.ws.readyState, WebSocket.OPEN);
    const logout = await post('/api/auth/logout', {}, cookieB);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: cookieB } })).status, 401);
    const hashes = store.db.prepare('SELECT password_hash,salt FROM users ').all() as any[];
    assert.equal(hashes.length, 2);
    assert.notEqual(hashes[0].salt, hashes[1].salt);
    assert.ok(hashes.every((h) => h.password_hash !== 'password123'));
  } finally {
    for (const { ws } of peers) {
      if (ws.readyState !== WebSocket.CLOSED) {
        const closed = once(ws, 'close');
        ws.terminate();
        await closed;
      }
    }
    for (const tenant of store.workspaces.all()) await control.tenants.serial(tenant, async () => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await control.close();
    store.db.close();
  }
});

test('cookie logout/login replacement cannot revoke another token Viewer of the same user', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' }),
    control = createApplication(store, testGateway(new ProductEndpoint()));
  const server = createHttp(control, { origins: ['http://product.test'], clientDir: '.' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`,
    url = base.replace('http:', 'ws:') + '/api/socket';
  const peers: ReturnType<typeof connect>[] = [];
  const post = (path: string, body: unknown, cookie: string) =>
    fetch(base + path, {
      method: 'POST',
      headers: { Origin: 'http://product.test', 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
  try {
    for (const operation of ['logout', 'login']) {
      const name = 'scope-' + operation,
        a = await registerUser(store, name, 'password123'),
        b = await accountsFor(store).login(name, 'password123');
      const old = connect(url, `rk_session=${a.token}`);
      peers.push(old);
      await old.wait((m) => m.type === 'auth');
      const current = connect(url, `rk_session=${b.token}`);
      peers.push(current);
      await current.wait((m) => m.type === 'auth');
      await old.wait((m) => m.type === 'lease');
      const response = await post(
        '/api/auth/' + operation,
        operation === 'logout' ? {} : { username: name, password: 'password123' },
        `rk_session=${a.token}`,
      );
      assert.equal(response.status, 200);
      assert.equal(store.accounts.identity(a.token), undefined);
      const ping = await current.request(operation, 'clock.ping', {});
      assert.equal(ping.type, 'result');
      assert.equal(control.viewers.productState(b.tenantId).viewer.connected, true);
      // Same-token tabs share revocation even though only the latest owns media.
      const sameToken = connect(url, `rk_session=${b.token}`);
      peers.push(sameToken);
      await sameToken.wait((m) => m.type === 'auth');
      await current.wait((m) => m.type === 'lease');
      const revoked = sameToken.wait((m) => m.type === 'lease' && m.outcome === 'logged_out');
      assert.equal(
        (
          await post(
            '/api/auth/' + operation,
            operation === 'logout' ? {} : { username: name, password: 'password123' },
            `rk_session=${b.token}`,
          )
        ).status,
        200,
      );
      await revoked;
      assert.equal(store.accounts.identity(b.token), undefined);
      assert.equal(control.viewers.productState(b.tenantId).viewer.connected, false);
    }
  } finally {
    for (const { ws } of peers)
      if (ws.readyState !== WebSocket.CLOSED) {
        const closed = once(ws, 'close');
        ws.terminate();
        await closed;
      }
    for (const tenant of store.workspaces.all()) await control.tenants.serial(tenant, async () => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await control.close();
    store.db.close();
  }
});

test('lease authentication is checked inside queued operations and late old close cannot detach replacement', async () => {
  const { store, control, user } = await fixture();
  let valid = true;
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'old',
      () => {},
      { identity: 'hash-A', valid: () => valid },
      true,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = control.tenants.serial(user.tenantId, () => gate);
    const pending = control.operations.productAction(
      user.tenantId,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
      'old',
    );
    valid = false;
    release();
    await blocked;
    await assert.rejects(pending, (e: any) => e.code === 'unauthenticated');
    await control.viewers.attachViewer(
      user.tenantId,
      'new',
      () => {},
      { identity: 'hash-B', valid: () => true },
      true,
    );
    await control.viewers.logout(user.tenantId, 'hash-A');
    await control.viewers.detachViewer(user.tenantId, 'old');
    assert.equal(control.viewers.productState(user.tenantId).viewer.connected, true);
    assert.ok(await requestViewer(control, user.tenantId, 'new', 'clock.ping', {}));
    await control.viewers.logout(user.tenantId, 'hash-B');
    assert.equal(control.viewers.productState(user.tenantId).viewer.connected, false);
  } finally {
    await control.close();
    store.db.close();
  }
});

test('impossible viewport is rejected without replacing valid geometry; limited state stays usable and can recover', async () => {
  const { store, control, endpoint, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const state = (
      await control.operations.productAction(
        user.tenantId,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
        'lease',
      )
    ).state.workspace;
    const w = state.windows[0],
      tab = state.tabs[0];
    await requestViewer(control, user.tenantId, 'lease', 'viewport', {
      devicePixelRatio: 1,
      windows: [
        { windowId: w.id, width: 800, height: 600, visible: true, occludedBottom: 0, occlusionRevision: '1' },
      ],
    });
    await assert.rejects(
      requestViewer(control, user.tenantId, 'lease', 'viewport', {
        devicePixelRatio: 1,
        windows: [
          {
            windowId: w.id,
            width: 8192,
            height: 8192,
            visible: true,
            occludedBottom: 0,
            occlusionRevision: '1',
          },
        ],
      }),
      (error: any) => error.code === 'limit_exceeded',
    );
    assert.equal(endpoint.views.get(user.tenantId)!.get(tab.webviewId).width, 800);
    assert.equal(control.viewers.productState(user.tenantId).quality.resourceLimitation, null);
    // An empty window may receive geometry before it has a tab. A later tab
    // creation must surface a limitation rather than break state serialization.
    await control.operations.productAction(user.tenantId, { type: 'tab.close', tabId: tab.id }, 'lease');
    await requestViewer(control, user.tenantId, 'lease', 'viewport', {
      devicePixelRatio: 1,
      windows: [
        {
          windowId: w.id,
          width: 8192,
          height: 8192,
          visible: true,
          occludedBottom: 0,
          occlusionRevision: '1',
        },
      ],
    });
    endpoint.calls = [];
    const limited = (
      await control.operations.productAction(
        user.tenantId,
        { type: 'tab.create', windowId: w.id, url: 'about:blank' },
        'lease',
      )
    ).state;
    assert.match(limited.quality.resourceLimitation!, /画面尺寸上限/);
    assert.equal(limited.quality.effectiveDpr, 0.5);
    assert.equal(limited.quality.reason, 'resource-limited');
    assert.ok(limited.endpointError);
    assert.ok(
      !endpoint.calls.some((c) => ['browser.started', 'view.created', 'view.configured'].includes(c.method)),
    );
    endpoint.views.get(user.tenantId)!.set('99999', { viewId: '99999' });
    endpoint.calls = [];
    await control.reconciler.tick();
    await control.reconciler.tick();
    assert.equal(
      endpoint.views.get(user.tenantId)!.size,
      store.workspaces.workspace(user.tenantId).tabs.filter((tab) => tab.kind !== 'start').length,
    );
    assert.ok(
      !endpoint.calls.some((c) => ['browser.started', 'view.created', 'view.configured'].includes(c.method)),
    );
    assert.ok(control.viewers.productState(user.tenantId).quality.resourceLimitation);
    await requestViewer(control, user.tenantId, 'lease', 'viewport', {
      devicePixelRatio: 1,
      windows: [
        { windowId: w.id, width: 900, height: 700, visible: true, occludedBottom: 0, occlusionRevision: '1' },
      ],
    });
    assert.equal(control.viewers.productState(user.tenantId).quality.resourceLimitation, null);
    assert.equal(control.viewers.productState(user.tenantId).endpointError, null);
    await control.operations.productAction(user.tenantId, { type: 'window.close', windowId: w.id }, 'lease');
    assert.equal(control.viewers.productState(user.tenantId).workspace.windows.length, 0);
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('start tabs stay local, first navigation ensures the real target, and explicit blank stays remote', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    let state = (
      await control.operations.productAction(
        user.tenantId,
        { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
        'lease',
      )
    ).state.workspace;
    const tab = state.tabs[0],
      win = state.windows[0];
    assert.equal(tab.kind, 'start');
    assert.equal(tab.url, '');
    assert.equal(
      endpoint.calls.some((c) => c.method === 'view.created'),
      false,
    );
    await requestViewer(control, user.tenantId, 'lease', 'viewport', {
      devicePixelRatio: 1,
      windows: [
        {
          windowId: win.id,
          width: 800,
          height: 600,
          visible: true,
          occludedBottom: 0,
          occlusionRevision: '1',
        },
      ],
    });
    assert.equal(
      endpoint.calls.some((c) => c.method === 'view.created'),
      false,
    );
    await control.operations.productAction(
      user.tenantId,
      { type: 'tab.command', tabId: tab.id, command: 'reload' },
      'lease',
    );
    assert.equal(
      endpoint.calls.some((c) => c.method === 'view.command'),
      false,
    );
    await control.operations.productAction(
      user.tenantId,
      { type: 'settings.update', settings: { browser: { searchEngine: 'baidu' } } },
      'lease',
    );
    state = (
      await control.operations.productAction(
        user.tenantId,
        { type: 'tab.navigate', tabId: tab.id, url: '中文 & hello' },
        'lease',
      )
    ).state.workspace;
    assert.equal(state.tabs[0].kind, 'remote');
    assert.equal(state.tabs[0].webviewId, tab.webviewId);
    assert.equal(state.tabs[0].url, 'https://www.baidu.com/s?wd=' + encodeURIComponent('中文 & hello'));
    const ensures = endpoint.calls.filter((c) => c.method === 'view.created');
    assert.equal(ensures.length, 1);
    assert.equal(ensures[0].args.url, '');
    assert.equal(
      endpoint.calls.some((c) => c.method === 'view.navigate'),
      true,
    );
    const blank = (
      await control.operations.productAction(
        user.tenantId,
        { type: 'tab.create', windowId: win.id, url: 'about:blank' },
        'lease',
      )
    ).state.workspace.tabs[1];
    assert.equal(blank.kind, 'remote');
    assert.equal(blank.url, 'about:blank');
    const start = (
      await control.operations.productAction(user.tenantId, { type: 'tab.create', windowId: win.id }, 'lease')
    ).state.workspace.tabs[2];
    const closeCount = endpoint.calls.filter((c) => c.method === 'view.close').length;
    await control.operations.productAction(user.tenantId, { type: 'tab.close', tabId: start.id }, 'lease');
    assert.equal(endpoint.calls.filter((c) => c.method === 'view.close').length, closeCount);
    await assert.rejects(
      control.operations.productAction(
        user.tenantId,
        { type: 'settings.update', settings: { browser: { searchEngine: 'unsafe' } } as any },
        'lease',
      ),
    );
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('native file chooser anchor exposes only viewport bounds bound to the pending document', async () => {
  const { store, endpoint, control, user } = await fixture();
  const tenant = user.tenantId,
    lease = 'lease';
  try {
    await control.viewers.attachViewer(
      tenant,
      lease,
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const { state } = await control.operations.productAction(
      tenant,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'https://a.test/' },
      lease,
    );
    const view = endpoint.views.get(tenant)!.get(state.workspace.tabs[0].webviewId);
    const anchor = {
      x: 5,
      y: 7,
      width: 9,
      height: 11,
      viewportWidth: 800,
      viewportHeight: 600,
      deviceScaleFactor: 1.25,
      instance: view.instance,
      document: view.document,
      layoutGeneration: '42',
    };
    view.pageRequests = {
      pending: [
        { kind: 'file_chooser', request: '7', input_anchor: { ...anchor, ignored: 'secret' } },
        { kind: 'file_chooser', request: '8', input_anchor: { ...anchor, document: '99' } },
        { kind: 'file_chooser', request: '9', input_anchor: { ...anchor, x: 795 } },
      ],
    };
    await control.reconciler.tick();
    const requests = control.viewers.productState(tenant).fileRequests;
    assert.equal(requests.length, 3);
    assert.deepEqual(
      requests.map((request) => request.anchor),
      [anchor, undefined, undefined],
    );
    assert.equal('binding' in requests[0], false);
  } finally {
    await control.viewers.detachViewer(tenant, lease);
    await control.close();
    store.db.close();
  }
});

test('viewport accepts all sixteen workspace windows and rejects a seventeenth observation', async () => {
  const { store, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    let state = control.viewers.productState(user.tenantId);
    for (let i = 0; i < 16; i++) {
      ({ state } = await control.operations.productAction(
        user.tenantId,
        { type: 'window.open', appId: 'files', placement: { mode: 'space' } },
        'lease',
      ));
      if ([7, 8, 15].includes(i))
        await requestViewer(control, user.tenantId, 'lease', 'viewport', {
          devicePixelRatio: 1,
          windows: state.workspace.windows.map((win) => ({
            windowId: win.id,
            width: 800,
            height: 600,
            visible: false,
            occludedBottom: 0,
            occlusionRevision: '1',
          })),
        });
    }
    assert.equal(state.workspace.windows.length, 16);
    await assert.rejects(
      requestViewer(control, user.tenantId, 'lease', 'viewport', {
        devicePixelRatio: 1,
        windows: Array.from({ length: 17 }, (_, i) => ({
          windowId: state.workspace.windows[i % 16].id,
          width: 800,
          height: 600,
          visible: false,
          occludedBottom: 0,
          occlusionRevision: '1',
        })),
      }),
      { code: 'invalid_request' },
    );
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});

test('viewport revisions reject stale occlusion without changing stable geometry or plan budget', async () => {
  const { store, endpoint, control, user } = await fixture();
  try {
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'test-account', valid: () => true },
      true,
    );
    const { state } = await control.operations.productAction(
      user.tenantId,
      { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
      'lease',
    );
    const win = state.workspace.windows[0];
    const tab = state.workspace.tabs[0];
    const viewport = {
      devicePixelRatio: 2,
      windows: [
        {
          windowId: win.id,
          width: 800,
          height: 900,
          visible: true,
          occludedBottom: 0,
          occlusionRevision: '10',
        },
      ],
    };
    await requestViewer(control, user.tenantId, 'lease', 'viewport', viewport);
    const closed = control.viewers.productState(user.tenantId).quality;
    viewport.windows[0].occludedBottom = 380;
    viewport.windows[0].occlusionRevision = '11';
    await requestViewer(control, user.tenantId, 'lease', 'viewport', viewport);
    const view = endpoint.views.get(user.tenantId)!.get(tab.webviewId);
    assert.equal(view.height, 900);
    assert.equal(view.occludedBottom, 380);
    assert.equal(view.occlusionRevision, '11');
    assert.equal(control.viewers.productState(user.tenantId).quality.effectiveDpr, closed.effectiveDpr);
    assert.equal(
      control.viewers.productState(user.tenantId).quality.resourceLimitation,
      closed.resourceLimitation,
    );
    await requestViewer(control, user.tenantId, 'lease', 'viewport', {
      ...viewport,
      windows: [{ ...viewport.windows[0], occludedBottom: 0, occlusionRevision: '10' }],
    });
    assert.equal(view.occludedBottom, 380);
    assert.equal(view.occlusionRevision, '11');
    await assert.rejects(
      requestViewer(control, user.tenantId, 'lease', 'viewport', {
        ...viewport,
        windows: [{ ...viewport.windows[0], occlusionRevision: '18446744073709551616' }],
      }),
      (error: any) => error.code === 'invalid_request',
    );
  } finally {
    await control.viewers.detachViewer(user.tenantId, 'lease');
    await control.close();
    store.db.close();
  }
});
