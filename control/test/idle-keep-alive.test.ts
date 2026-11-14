import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import {
  IdleKeepAliveNotice,
  IdleKeepAliveReturns,
  idleKeepAliveText,
} from '../client/failures/idle-keep-alive';
import type { ProductAction, ProductTab } from '../shared/product';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { applyCommand } from '../server/workspace/commands';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication } from '../server/application';
import { registerUser, TestClock, testGateway } from './server-fixture';
import type { EndpointSnapshot } from '../server/endpoint/types';

const tab = (): ProductTab => ({
  id: 'tab',
  windowId: 'window',
  webviewId: '1',
  title: '',
  url: 'https://example.test/',
  kind: 'remote',
  idleKeepAlive: true,
  idleKeepAliveState: { enabledAt: 0, eligibleSince: 0 },
  idleKeepAliveOutcome: {
    enabledAt: 0,
    eligibleSince: 0,
    leftAt: 0,
    outcome: 'survived',
    at: 0,
    reason: 'statistics',
    returnedAt: 133 * 60_000,
  },
});

test('keep-alive operation and acknowledgment preserve newer outcomes', () => {
  const state = emptyWorkspace('tenant');
  state.tabs = [tab()];
  state.windows = [{ id: 'window', appId: 'browser', activeTabId: 'tab', lastActiveAt: 0 }];
  const command = (action: ProductAction) =>
    applyCommand(state, action, { ids: [], viewId: '', now: 100 }).workspace.tabs[0];
  const record = state.tabs[0].idleKeepAliveOutcome!;
  assert.ok(
    command({ type: 'tab.ackIdleKeepAliveOutcome', tabId: 'tab', at: 1, returnedAt: record.returnedAt! })
      .idleKeepAliveOutcome,
  );
  assert.equal(
    command({
      type: 'tab.ackIdleKeepAliveOutcome',
      tabId: 'tab',
      at: record.at,
      returnedAt: record.returnedAt!,
    }).idleKeepAliveOutcome,
    undefined,
  );
  const disabled = command({ type: 'tab.setIdleKeepAlive', tabId: 'tab', enabled: false });
  assert.equal(disabled.idleKeepAlive, false);
  assert.equal(disabled.idleKeepAliveState, undefined);
  const returns = new IdleKeepAliveReturns();
  assert.equal(returns.take('tenant', tab())?.outcome, 'survived');
  assert.equal(returns.take('tenant', tab()), undefined);
  assert.equal(idleKeepAliveText(record), '挂机期间页面保持运行（2 小时 13 分）');
  for (const [reason, text] of [
    ['statistics', '统计判断长时间未使用'],
    ['pressure', '节点资源紧张'],
    ['exhaustion', '节点内存不足'],
  ] as const)
    assert.ok(idleKeepAliveText({ ...record, reason, outcome: 'stopped' }).includes(text));
});

test('return notice is an informational window surface, dismissible, once only and expires after ten seconds', async (t) => {
  const dom = new JSDOM('<html><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const host = document.getElementById('app')!;
  const root = createRoot(host);
  const actions: ProductAction[] = [];
  const current = tab();
  const render = (visible = true) =>
    root.render(
      createElement(IdleKeepAliveNotice, {
        tenant: 'notice-tenant',
        tab: current,
        visible,
        acknowledge: (action) => actions.push(action),
      }),
    );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await act(async () => render(false));
    assert.equal(actions.length, 0);
    await act(async () => render());
    assert.ok(host.querySelector('.failure-surface-live .failure-info'));
    assert.equal(actions.length, 1);
    await act(async () => render());
    assert.equal(actions.length, 1);
    await act(async () => t.mock.timers.tick(9999));
    assert.ok(host.textContent);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(host.textContent, '');
    await act(async () => render());
    assert.equal(host.textContent, '');
    current.idleKeepAliveOutcome = { ...current.idleKeepAliveOutcome!, at: 1, returnedAt: 2 };
    await act(async () => render());
    assert.equal(actions.length, 2);
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    assert.equal(host.textContent, '');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test('Session protection accrues only while eligible; every automatic stop commits and records the exhaustion override', async () => {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
  const calls: { method: string; args: any }[] = [];
  const gateway = testGateway({
    async request(method, _tenant, args) {
      calls.push({ method, args });
      return { accepted: true };
    },
  });
  const control = createApplication(store, gateway, undefined, clock);
  const { tenantId } = await registerUser(store, 'keep-alive-user', 'password123');
  const snapshot: EndpointSnapshot = {
    views: [],
    stopBlockers: {
      unacknowledgedEvents: 0,
      pendingNativeSelections: 0,
      inFlightUploads: 0,
      pendingPageRequests: 0,
      downloadsInProgress: 0,
      pendingDownloadImports: 0,
      rtcConnected: false,
      lifecycleUncertain: false,
    },
  };
  try {
    const state = store.workspaces.workspace(tenantId);
    state.tabs = [tab()];
    state.windows = [{ id: 'window', appId: 'browser', activeTabId: 'tab', lastActiveAt: 0 }];
    state.spaces = [
      { id: 'space', windowIds: ['window'], focusedWindowId: 'window', weights: [1], lastActiveAt: 0 },
    ];
    state.activeSpaceId = 'space';
    state.tabs[0].idleKeepAliveState = { enabledAt: clock.wallMs() };
    delete state.tabs[0].idleKeepAliveOutcome;
    store.workspaces.saveWorkspace(state);
    gateway.placement.resolve(tenantId);
    const current = { actual: 0, visible: false, canDiscard: true, instance: '1' };
    assert.ok(control.lifecycle.stopBlocker(tenantId, snapshot, true));
    for (let index = 0; index < 360; index++) {
      assert.ok(control.lifecycle.stopBlocker(tenantId, snapshot, false));
      await control.lifecycle.maintainBackgroundTab(state, state.tabs[0], current, false, 'browser');
      clock.advance(5000);
    }
    assert.equal(calls.filter((call) => call.method === 'view.lifecycle').length, 0);
    assert.equal(control.lifecycle.stopBlocker(tenantId, snapshot, false), undefined);
    snapshot.stopBlockers!.inFlightUploads = 1;
    assert.ok(control.lifecycle.stopBlocker(tenantId, snapshot, false));
    snapshot.stopBlockers!.inFlightUploads = 0;
    assert.ok(control.lifecycle.stopBlocker(tenantId, snapshot, false));
    gateway.nodes.get('fixture')!.allocationFailedAt = Date.now();
    assert.equal(await control.lifecycle.stop(tenantId, snapshot), true);
    const stop = calls.find((call) => call.method === 'session.desired' && call.args.run === 'stopped')!;
    assert.equal(stop.args.commit, 'fixture-commit');
    const result = store.workspaces.workspace(tenantId).tabs[0];
    assert.equal(result.idleKeepAliveOutcome?.outcome, 'stopped');
    assert.equal(result.idleKeepAliveOutcome?.reason, 'exhaustion');
    const runtime = control.tenants.get(tenantId);
    runtime.viewer = {
      id: 'returned',
      security: { locked: false },
      viewport: { windows: [{ windowId: 'window', visible: true }] },
    } as any;
    control.lifecycle.observeWanted(store.workspaces.workspace(tenantId));
    const returned = store.workspaces.workspace(tenantId);
    const record = returned.tabs[0].idleKeepAliveOutcome!;
    assert.equal(record.returnedAt, clock.wallMs());
    const acknowledged = applyCommand(
      returned,
      { type: 'tab.ackIdleKeepAliveOutcome', tabId: 'tab', at: record.at, returnedAt: record.returnedAt! },
      { ids: [], viewId: '', now: clock.wallMs() },
    ).workspace;
    store.workspaces.saveWorkspace(acknowledged);
    control.lifecycle.observeWanted(store.workspaces.workspace(tenantId));
    assert.equal(store.workspaces.workspace(tenantId).tabs[0].idleKeepAliveOutcome, undefined);
  } finally {
    await control.close();
    store.db.close();
  }
});

test('Endpoint allocation failures trigger exhaustion; other output failures do not', async () => {
  let message = 'OSR handle duplicate failed';
  let allocationPressure = false;
  const gateway = testGateway({
    async request() {
      return {};
    },
    observe() {
      return {
        status: { code: 'unavailable', reason: 'output_failed', message },
        stats: { allocationPressure },
        views: [],
      };
    },
  });
  const node = gateway.nodes.get('fixture')!;
  gateway.placement.resolve('tenant');
  await assert.rejects(gateway.snapshot('tenant'), { reason: 'output_failed' });
  assert.equal(node.allocationFailedAt, undefined);
  message = 'OSR plane resources allocation failed';
  allocationPressure = true;
  await assert.rejects(gateway.snapshot('tenant'), { reason: 'output_failed' });
  assert.equal(typeof node.allocationFailedAt, 'number');
});
