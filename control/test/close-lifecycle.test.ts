import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildAction } from '../client/control/action-builder';
import { createApplication } from '../server/application';
import { log } from '../server/log';
import { ControlDatabase } from '../server/persistence/database';
import { PENDING_CLOSE_DETAIL, RemoteKitError } from '../shared/errors';
import type { ProductAction } from '../shared/product';
import { applyDesiredViews, publishAndObserve } from './coordination-fixture';
import { registerUser, TestClock, testGateway } from './server-fixture';

class CloseEndpoint {
  views = new Map<string, any>();
  browser = 'browser';
  mode: 'user' | 'prompt' | 'missing' | 'unknown' = 'user';
  unknownReply = false;
  detail = 'view_not_in_session';
  closeCalls = 0;
  beforeFailure?: () => void;
  afterAccept?: () => void;
  observe() {
    return { running: true, browserIncarnation: this.browser, views: [...this.views.values()] };
  }
  async request(method: string, _tenant: string, args: any = {}) {
    if (method === 'session.desired') applyDesiredViews(this.views, args);
    if (method === 'view.close') {
      this.closeCalls++;
      if (this.mode === 'unknown') throw new RemoteKitError('outcome_unknown', 'close reply lost');
      if (this.mode === 'missing') {
        this.beforeFailure?.();
        throw new RemoteKitError('not_found', 'missing', { detail: this.detail });
      }
      const view = this.views.get(args.viewId);
      view.close_state = 'closing';
      if (this.mode === 'user') view.pending_close = { requestId: 'native-close' };
      this.afterAccept?.();
      return {
        accepted: true,
        browserIncarnation: this.browser,
        instance: view.instance,
        document: view.document,
        ...(this.mode === 'user' ? { requestId: 'native-close' } : {}),
      };
    }
    if (method === 'view.close.reply') {
      if (this.unknownReply) throw new RemoteKitError('outcome_unknown', 'confirmation reply lost');
      const view = this.views.get(args.viewId);
      view.close_state = args.accept ? 'closing' : 'open';
      delete view.pending_close;
      return { accepted: true, browser: { ok: true } };
    }
    return { accepted: true };
  }
}

async function fixture(t: test.TestContext, windows = 2) {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', { clock, buildId: 'test' });
  const endpoint = new CloseEndpoint();
  const control = createApplication(store, testGateway(endpoint), undefined, clock);
  t.after(async () => {
    await control.close();
    store.db.close();
  });
  const { tenantId: tenant } = await registerUser(store, 'close-user', 'password123');
  await control.viewers.attachViewer(
    tenant,
    'lease',
    () => {},
    { identity: 'test', valid: () => true },
    true,
  );
  for (let i = 0; i < windows; i++) {
    await control.operations.productAction(
      tenant,
      buildAction({
        type: 'window.open',
        appId: 'browser',
        placement: { mode: 'space' },
        url: 'https://close.test/',
      }),
      'lease',
    );
    await publishAndObserve(control.endpoint, tenant);
  }
  const observation = structuredClone(control.endpoint.observation(tenant)!);
  t.mock.method(control.endpoint, 'observation', () => observation);
  const state = () => store.workspaces.workspace(tenant);
  const submit = (action: ProductAction) =>
    control.operations.submitOperation(
      tenant,
      {
        operationId: randomUUID(),
        operationGeneration: store.operations.operationGeneration(tenant),
        action,
      },
      'lease',
    );
  const status = (receipt: { operationId: string; operationGeneration: string }) =>
    control.operations.operationStatus(tenant, receipt);
  const observe = () => {
    observation.seq = String(BigInt(observation.seq) + 1n);
    observation.observedRevision = store.coordination.desiredRevision(tenant)!;
    observation.applied.viewsRevision = observation.observedRevision;
    observation.views = structuredClone([...endpoint.views.values()]);
    control.pageRequests.observePendingClose(state());
  };
  return { clock, store, endpoint, control, tenant, observation, state, submit, status, observe };
}

test('view_not_in_session completes every target and commits the multi-space close receipt', async (t) => {
  const f = await fixture(t);
  f.endpoint.mode = 'missing';
  const receipt = await f.submit({
    type: 'space.close',
    spaceIds: f.state().spaces.map((space) => space.id),
  });
  assert.equal(receipt.status, 'committed');
  assert.equal(f.state().tabs.length, 0);
  assert.equal(f.state().windows.length, 0);
  assert.equal(f.state().pendingWindowCloseId, null);
  assert.equal(f.endpoint.closeCalls, 2);
});

test('closure observation arriving before the RPC response is newer than the request baseline', async (t) => {
  const f = await fixture(t, 1);
  f.endpoint.afterAccept = () => {
    f.endpoint.views.clear();
    f.observation.views = [];
    f.observation.seq = String(BigInt(f.observation.seq) + 1n);
  };
  const receipt = await f.submit({ type: 'tab.close', tabId: f.state().tabs[0].id });
  f.control.pageRequests.observePendingClose(f.state());
  assert.equal(f.state().tabs.length, 0);
  assert.equal(f.status(receipt).status, 'committed');
});

for (const differentBrowser of [false, true]) {
  test(`not_found preserves the target for ${differentBrowser ? 'a replaced Browser' : 'another detail'}`, async (t) => {
    const f = await fixture(t, 1);
    f.endpoint.mode = 'missing';
    if (differentBrowser)
      f.endpoint.beforeFailure = () => {
        f.observation.browserIncarnation = 'replacement';
      };
    else f.endpoint.detail = 'other_missing';
    const receipt = await f.submit({ type: 'window.close', windowId: f.state().windows[0].id });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.error?.code, 'not_found');
    assert.equal(f.state().tabs.length, 1);
  });
}

for (const missing of ['tab', 'window', 'view'] as const) {
  test(`${missing} disappearance completes the pending target and advances the batch`, async (t) => {
    const f = await fixture(t, 1);
    const receipt = await f.submit({ type: 'space.close', spaceIds: [f.state().spaces[0].id] });
    const tab = f.state().tabs[0];
    if (missing === 'view') f.endpoint.views.clear();
    else {
      const state = f.state();
      state.tabs = [];
      state.windows[0].activeTabId = null;
      if (missing === 'window') {
        state.windows = [];
        state.spaces = [];
        state.activeSpaceId = null;
      }
      f.store.workspaces.saveWorkspace(state);
    }
    f.observe();
    assert.equal(f.state().pendingClose, null);
    await f.control.pageRequests.continueWindowClose(f.state());
    assert.equal(f.state().windows.length, 0);
    assert.equal(f.status(receipt).status, 'committed');
    assert.equal(
      f.state().tabs.some((item) => item.id === tab.id),
      false,
    );
  });
}

for (const stale of ['sequence', 'convergence', 'revision', 'error'] as const) {
  test(`missing View in ${stale} observation does not remove the product tab`, async (t) => {
    const f = await fixture(t, 1);
    await f.submit({ type: 'tab.close', tabId: f.state().tabs[0].id });
    f.observation.views = [];
    if (stale !== 'sequence') f.observation.seq = String(BigInt(f.observation.seq) + 1n);
    if (stale === 'convergence') f.observation.converged = false;
    if (stale === 'revision') f.observation.applied.viewsRevision = '0';
    if (stale === 'error') f.observation.lastError = { code: 'unavailable', message: 'partial' };
    f.control.pageRequests.observePendingClose(f.state());
    assert.equal(f.state().tabs.length, 1);
    assert.ok(f.state().pendingClose);
  });
}

test('disappeared user request cancels its batch and every repeated close receipt, preserving remaining targets', async (t) => {
  const f = await fixture(t);
  const receipt = await f.submit({
    type: 'space.close',
    spaceIds: f.state().spaces.map((space) => space.id),
  });
  const pending = f.state().pendingClose!;
  const repeated = await f.submit({ type: 'tab.close', tabId: pending.id });
  assert.equal(f.endpoint.closeCalls, 1);
  const view = f.endpoint.views.get(f.state().tabs.find((tab) => tab.id === pending.id)!.webviewId);
  view.close_state = 'open';
  delete view.pending_close;
  f.observe();
  for (const operation of [receipt, repeated]) {
    assert.equal(f.status(operation).status, 'failed');
    assert.equal(f.status(operation).error?.code, 'canceled');
  }
  assert.equal(f.state().pendingClose, null);
  assert.equal(f.state().pendingWindowCloseId, null);
  assert.equal(f.state().tabs.length, 2);
});

test('same window close reuses its confirmation, another group returns structured pending conflict', async (t) => {
  const f = await fixture(t);
  const [first, second] = f.state().windows;
  await f.submit({ type: 'window.close', windowId: first.id });
  const pending = f.state().pendingClose;
  const repeated = await f.submit({ type: 'window.close', windowId: first.id });
  assert.equal(repeated.status, 'committed');
  assert.deepEqual(f.state().pendingClose, pending);
  assert.equal(f.endpoint.closeCalls, 1);
  const other = await f.submit({
    type: 'space.close',
    spaceIds: [f.state().spaces.find((space) => space.windowIds.includes(second.id))!.id],
  });
  assert.equal(other.status, 'failed');
  assert.equal(other.error?.code, 'conflict');
  assert.equal(other.error?.detail, PENDING_CLOSE_DETAIL);
});

test('a native request still listed in pageRequests is not canceled as missing', async (t) => {
  const f = await fixture(t, 1);
  const receipt = await f.submit({ type: 'tab.close', tabId: f.state().tabs[0].id });
  const view = [...f.endpoint.views.values()][0];
  view.close_state = 'open';
  view.pageRequests = {
    pending: [{ kind: 'beforeunload', request: view.pending_close.requestId }],
    events: [],
  };
  delete view.pending_close;
  f.observe();
  assert.ok(f.state().pendingClose);
  assert.equal(f.status(receipt).status, 'applying');
});

for (const identity of ['browserIncarnation', 'instance', 'document'] as const) {
  test(`missing ${identity} ends the pending operation as resolved unknown`, async (t) => {
    const f = await fixture(t, 1);
    const warning = t.mock.method(log, 'warn');
    const receipt = await f.submit({ type: 'window.close', windowId: f.state().windows[0].id });
    const state = f.state();
    delete state.pendingClose![identity];
    f.store.workspaces.saveWorkspace(state);
    f.control.pageRequests.observePendingClose(f.state());
    assert.equal(f.state().pendingClose, null);
    assert.equal(f.status(receipt).status, 'unknown');
    assert.equal(f.status(receipt).resolved, true);
    assert.equal(f.status(receipt).error?.code, 'outcome_unknown');
    assert.equal(f.state().tabs.length, 1);
    f.control.pageRequests.observePendingClose(f.state());
    const failures = warning.mock.calls.filter((call) => call.arguments[0] === 'close.failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].arguments[1]?.tenant, f.tenant);
    assert.equal(failures[0].arguments[1]?.operationId, receipt.operationId);
    assert.equal(failures[0].arguments[1]?.reason, 'invalid_identity');
    assert.equal(failures[0].arguments[1]?.newPhase, 'unknown');
  });
}

for (const phase of ['awaitingPrompt', 'awaitingCloseEvidence'] as const) {
  test(`${phase} expires after 10 seconds without resending close`, async (t) => {
    const f = await fixture(t, 1);
    f.endpoint.mode = phase === 'awaitingPrompt' ? 'prompt' : 'user';
    const receipt = await f.submit({ type: 'window.close', windowId: f.state().windows[0].id });
    if (phase === 'awaitingCloseEvidence') {
      f.clock.advance(2_000);
      await f.submit({
        type: 'tab.close',
        tabId: f.state().pendingClose!.id,
        requestId: f.state().pendingClose!.requestId,
        confirm: true,
      });
    }
    const calls = f.endpoint.closeCalls;
    f.clock.advance(9_999);
    f.observe();
    assert.ok(f.state().pendingClose);
    f.clock.advance(1);
    t.mock.method(f.control.endpoint, 'isReady', () => false);
    await f.control.reconciler.reconcileProduct(f.tenant);
    assert.equal(f.state().pendingClose, null);
    assert.equal(f.state().pendingWindowCloseId, null);
    assert.equal(f.status(receipt).status, 'unknown');
    assert.equal(f.status(receipt).error?.code, 'outcome_unknown');
    assert.equal(f.endpoint.closeCalls, calls);
    assert.equal(f.state().tabs.length, 1);
  });
}

test('deadline checks latest complete closure evidence before deciding unknown', async (t) => {
  const f = await fixture(t, 1);
  f.endpoint.mode = 'prompt';
  const receipt = await f.submit({ type: 'tab.close', tabId: f.state().tabs[0].id });
  f.clock.advance(10_000);
  f.endpoint.views.clear();
  f.observe();
  assert.equal(f.status(receipt).status, 'committed');
  assert.equal(f.state().tabs.length, 0);
});

for (const unknownReply of [false, true]) {
  test(`${unknownReply ? 'confirmation' : 'close'} RPC unknown outcome terminates pending without replaying the side effect`, async (t) => {
    const f = await fixture(t, 1);
    if (!unknownReply) f.endpoint.mode = 'unknown';
    const receipt = await f.submit({ type: 'window.close', windowId: f.state().windows[0].id });
    if (unknownReply) {
      f.endpoint.unknownReply = true;
      const reply = await f.submit({
        type: 'tab.close',
        tabId: f.state().pendingClose!.id,
        requestId: f.state().pendingClose!.requestId,
        confirm: true,
      });
      assert.equal(reply.status, 'unknown');
      assert.equal(reply.resolved, true);
    }
    assert.equal(f.status(receipt).status, 'unknown');
    assert.equal(f.status(receipt).resolved, true);
    assert.equal(f.state().pendingClose, null);
    assert.equal(f.state().pendingWindowCloseId, null);
    f.clock.advance(20_000);
    await f.control.pageRequests.continueWindowClose(f.state());
    assert.equal(f.endpoint.closeCalls, 1);
    assert.equal(f.state().tabs.length, 1);
  });
}

test('prompt observation enters user confirmation once and duplicate close does not renew its timing', async (t) => {
  const f = await fixture(t, 1);
  f.endpoint.mode = 'prompt';
  await f.submit({ type: 'tab.close', tabId: f.state().tabs[0].id });
  f.clock.advance(500);
  [...f.endpoint.views.values()][0].pending_close = { requestId: 'appeared' };
  f.observe();
  const pending = f.state().pendingClose!;
  assert.equal(pending.awaiting, false);
  assert.equal(pending.enteredAt, f.clock.wallMs());
  f.clock.advance(20_000);
  f.observe();
  await f.submit({ type: 'tab.close', tabId: pending.id });
  assert.deepEqual(f.state().pendingClose, pending);
  assert.equal(f.endpoint.closeCalls, 1);
});

for (const replacement of ['stopped', 'browser', 'document'] as const) {
  test(`${replacement} retirement settles the original close as unknown and retains the product target`, async (t) => {
    const f = await fixture(t, 1);
    const receipt = await f.submit({ type: 'window.close', windowId: f.state().windows[0].id });
    if (replacement === 'stopped') f.observation.browser = 'stopped';
    if (replacement === 'browser') f.observation.browserIncarnation = 'replacement';
    if (replacement === 'document') [...f.endpoint.views.values()][0].document = '2';
    f.observe();
    assert.equal(f.state().pendingClose, null);
    assert.equal(f.state().pendingWindowCloseId, null);
    assert.equal(f.status(receipt).status, 'unknown');
    assert.equal(f.status(receipt).resolved, true);
    assert.equal(f.state().tabs.length, 1);
  });
}

test('a later receipt write failure rolls back earlier receipt settlement and the pending transition', async (t) => {
  const f = await fixture(t, 1);
  const first = await f.submit({ type: 'window.close', windowId: f.state().windows[0].id });
  const second = await f.submit({ type: 'tab.close', tabId: f.state().pendingClose!.id });
  const before = f.state();
  const view = [...f.endpoint.views.values()][0];
  view.close_state = 'open';
  delete view.pending_close;
  f.store.db.exec(
    `CREATE TRIGGER fail_later_receipt BEFORE UPDATE ON operation_receipts WHEN NEW.id='${second.operationId}' BEGIN SELECT RAISE(ABORT,'later receipt failed'); END`,
  );
  assert.throws(f.observe, /later receipt failed/);
  assert.deepEqual(f.state(), before);
  assert.equal(f.status(first).status, 'applying');
  assert.equal(f.status(second).status, 'applying');
  f.store.db.exec('DROP TRIGGER fail_later_receipt');
  f.observe();
  assert.equal(f.status(first).error?.code, 'canceled');
  assert.equal(f.status(second).error?.code, 'canceled');
});

for (const transition of ['missing_view', 'request_disappeared', 'identity_missing', 'timeout'] as const) {
  for (const table of ['workspaces', 'operation_receipts']) {
    test(`${transition} atomically rolls back pending and receipt when ${table} persistence fails`, async (t) => {
      const f = await fixture(t, 1);
      if (transition === 'timeout') f.endpoint.mode = 'prompt';
      const receipt = await f.submit({ type: 'tab.close', tabId: f.state().tabs[0].id });
      if (transition === 'missing_view') f.endpoint.views.clear();
      if (transition === 'request_disappeared') {
        const view = [...f.endpoint.views.values()][0];
        view.close_state = 'open';
        delete view.pending_close;
      }
      if (transition === 'identity_missing') {
        const state = f.state();
        delete state.pendingClose!.instance;
        f.store.workspaces.saveWorkspace(state);
      }
      if (transition === 'timeout') f.clock.advance(10_000);
      const before = f.state();
      const storedReceipt = f.status(receipt);
      f.store.db.exec(
        `CREATE TRIGGER fail_close BEFORE ${table === 'workspaces' ? 'INSERT' : 'UPDATE'} ON ${table} BEGIN SELECT RAISE(ABORT,'injected close failure'); END`,
      );
      assert.throws(f.observe, /injected close failure/);
      assert.deepEqual(f.state(), before);
      assert.deepEqual(f.status(receipt), storedReceipt);
      f.store.db.exec('DROP TRIGGER fail_close');
      f.observe();
      assert.equal(f.state().pendingClose, null);
      assert.notEqual(f.status(receipt).status, 'applying');
    });
  }
}
