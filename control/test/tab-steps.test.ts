import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteKitError } from '../shared/errors';
import type { OperationReceipt, ProductTab } from '../shared/product';
import type { DomainContext, DomainServices } from '../server/application';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { TenantRegistry } from '../server/tenants/tenant-registry';
import { UncertainRecovery, type BackgroundStep } from '../server/workspace/lifecycle';
import { Navigation } from '../server/workspace/navigation';
import { Reconciler } from '../server/workspace/reconciler';
import { observedSession } from './coordination-fixture';

const clock = { wallMs: () => 1000, monotonicMs: () => 1000 };
const tabFixture = (): ProductTab => ({
  id: 'tab',
  windowId: 'window',
  webviewId: 'view',
  kind: 'remote',
  url: 'https://example.test/',
  title: '',
  idleKeepAlive: false,
});
const hold = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const idle = () => new Promise<void>((resolve) => setImmediate(resolve));

function recoveryFixture(t: import('node:test').TestContext) {
  const workspace = emptyWorkspace('tenant');
  const tab = tabFixture();
  workspace.tabs = [tab];
  const tenants = new TenantRegistry(clock);
  const requests: unknown[] = [];
  let reply: () => Promise<unknown> = async () => ({ accepted: true });
  const saves: number[] = [];
  const context = {
    clock,
    tenants,
    endpoint: {
      lifecycle: (_tenant: string, request: unknown) => {
        requests.push(request);
        return reply();
      },
    },
  } as unknown as DomainContext;
  const services = {
    operations: { saveWorkspace: () => saves.push(saves.length) },
  } as unknown as DomainServices;
  const owner = new UncertainRecovery(context, services);
  const current = { actual: 3, pending: false, lifecycle_generation: '1', lifecycle_uncertain: true };
  t.after(() => tenants.close());
  return {
    owner,
    workspace,
    tab,
    current,
    requests,
    saves,
    failWith: (error: RemoteKitError) => {
      reply = async () => {
        throw error;
      };
    },
    plan: () => owner.planLifecycleRecovery(workspace, tab, current, 'browser', true)!,
  };
}

test('a recovery plan registers the attempt under the lock and makes no Browser call', (t) => {
  const { tab, requests, saves, plan } = recoveryFixture(t);
  const step = plan();
  assert.equal(step.request.action, 'unload');
  assert.equal(tab.lifecycleRecovery?.phase, 'unload');
  assert.equal(tab.restoring, true);
  assert.equal(saves.length, 1);
  assert.deepEqual(requests, []);
});

test('an accepted recovery request leaves the registered attempt for observation to complete', async (t) => {
  const { owner, workspace, tab, requests, plan } = recoveryFixture(t);
  const step = plan();
  const outcome = await owner.callLifecycleRecovery(step);
  assert.equal(requests.length, 1);
  owner.commitLifecycleRecovery(workspace, tab, step, outcome);
  assert.equal(tab.lifecycleRecovery?.phase, 'unload');
  assert.equal(tab.restoring, true);
  assert.equal(tab.lifecycleRecoveryError, undefined);
});

test('a retryable recovery failure takes the attempt back; a final one ends it; an unknown one waits for observation', async (t) => {
  const fixture = recoveryFixture(t);
  const { owner, workspace, tab } = fixture;
  fixture.failWith(new RemoteKitError('unavailable', 'node away'));
  let step = fixture.plan();
  owner.commitLifecycleRecovery(workspace, tab, step, await owner.callLifecycleRecovery(step));
  assert.equal(tab.lifecycleRecovery, undefined);
  assert.equal(tab.restoring, false);
  fixture.failWith(new RemoteKitError('invalid_request', 'refused'));
  fixture.current.lifecycle_generation = '2';
  step = fixture.plan();
  owner.commitLifecycleRecovery(workspace, tab, step, await owner.callLifecycleRecovery(step));
  assert.equal(tab.lifecycleRecoveryError?.code, 'invalid_request');
  assert.equal(tab.restoring, false);
  delete tab.lifecycleRecoveryError;
  delete tab.lifecycleRecovery;
  fixture.failWith(new RemoteKitError('outcome_unknown', 'lost'));
  fixture.current.lifecycle_generation = '3';
  step = fixture.plan();
  owner.commitLifecycleRecovery(workspace, tab, step, await owner.callLifecycleRecovery(step));
  assert.equal((tab as ProductTab).lifecycleRecovery?.generation, '3');
  assert.equal(tab.lifecycleRecoveryError, undefined);
});

test('a recovery result is discarded when the tab moved on while the Browser call ran', async (t) => {
  const fixture = recoveryFixture(t);
  const { owner, workspace, tab } = fixture;
  fixture.failWith(new RemoteKitError('invalid_request', 'refused'));
  const step = fixture.plan();
  const outcome = await owner.callLifecycleRecovery(step);
  // A reconciliation completed the attempt and a later one started another.
  tab.lifecycleRecovery = { ...tab.lifecycleRecovery!, generation: '9' };
  owner.commitLifecycleRecovery(workspace, tab, step, outcome);
  assert.equal(tab.lifecycleRecovery?.generation, '9');
  assert.equal(tab.lifecycleRecoveryError, undefined);
  // A tab closed in the meantime has nothing to settle and nothing to fail.
  owner.commitLifecycleRecovery(workspace, undefined, step, outcome);
});

test('a background step is recorded only for the tab it was decided for', (t) => {
  const { owner, workspace, tab } = recoveryFixture(t);
  const tenants = (owner as any).context.tenants as TenantRegistry;
  const step: BackgroundStep = {
    tenant: 'tenant',
    tabId: 'tab',
    viewId: 'view',
    key: 'tenant/view',
    action: 'freeze',
    exhaustion: false,
    generation: '1',
    request: { viewId: 'view', action: 'freeze', requireRunning: true },
  };
  owner.commitBackgroundTab(workspace, tab, step, false);
  owner.commitBackgroundTab(workspace, undefined, step, true);
  owner.commitBackgroundTab(workspace, { ...tab, webviewId: 'replaced' }, step, true);
  assert.equal(tenants.get('tenant').lifecycle.transitions.get('tenant/view'), undefined);
  owner.commitBackgroundTab(workspace, tab, step, true);
  assert.equal(tenants.get('tenant').lifecycle.transitions.get('tenant/view')?.action, 'freeze');
});

function reloadFixture() {
  const workspace = emptyWorkspace('tenant');
  const tab: ProductTab = { ...tabFixture(), pendingUaReloadOrigin: 'https://example.test' };
  workspace.tabs = [tab];
  const receipts = new Map<string, OperationReceipt>();
  const calls: unknown[] = [];
  const saved: OperationReceipt[] = [];
  let reply: () => Promise<unknown> = async () => ({ accepted: true });
  const pushes: string[] = [];
  const context = {
    store: {
      operations: {
        operation: (_tenant: string, id: string) =>
          receipts.has(id) ? { receipt: receipts.get(id) } : undefined,
        operationGeneration: () => 'generation',
        reserveOperation: (_tenant: string, _action: unknown, receipt: OperationReceipt) => {
          receipt.operationSequence = '5';
          receipts.set(receipt.operationId, receipt);
          return true;
        },
        saveOperation: (_state: unknown, receipt: OperationReceipt) => saved.push({ ...receipt }),
      },
      workspaces: { saveWorkspace: () => {} },
    },
    endpoint: {
      command: (_tenant: string, request: unknown) => {
        calls.push(request);
        return reply();
      },
    },
  } as unknown as DomainContext;
  const navigation = new Navigation(context, { viewers: { push: (t: string) => pushes.push(t) } } as never);
  return {
    navigation,
    workspace,
    tab,
    calls,
    saved,
    pushes,
    failWith: (error: unknown) => {
      reply = async () => {
        throw error;
      };
    },
    plan: () => navigation.planSiteIdentityReload(workspace, tab, { viewId: 'view' }, 'browser')!,
  };
}

test('a site reload is reserved under the lock, sent outside it and cleared once it was sent', async () => {
  const { navigation, workspace, tab, calls, saved, pushes, plan } = reloadFixture();
  const step = plan();
  assert.deepEqual(calls, []);
  assert.equal(tab.pendingUaReloadIdentity?.operationId, step.receipt.operationId);
  assert.equal(saved.length, 1);
  navigation.commitSiteIdentityReload(workspace, tab, step, await navigation.callSiteIdentityReload(step));
  assert.equal(calls.length, 1);
  assert.equal(tab.pendingUaReloadOrigin, undefined);
  assert.equal(tab.pendingUaReloadIdentity, undefined);
  assert.deepEqual(pushes, ['tenant']);
});

test('a retryable reload failure keeps the reload pending; any other ends it with a failed receipt', async () => {
  const fixture = reloadFixture();
  const { navigation, workspace, tab, saved } = fixture;
  fixture.failWith(new RemoteKitError('unavailable', 'node away'));
  let step = fixture.plan();
  await assert.rejects(
    async () =>
      navigation.commitSiteIdentityReload(
        workspace,
        tab,
        step,
        await navigation.callSiteIdentityReload(step),
      ),
    (error: RemoteKitError) => error.code === 'unavailable',
  );
  assert.equal(tab.pendingUaReloadOrigin, 'https://example.test');
  fixture.failWith(new RemoteKitError('invalid_request', 'bad'));
  step = fixture.plan();
  assert.equal(step.receipt.operationId, tab.pendingUaReloadIdentity?.operationId);
  navigation.commitSiteIdentityReload(workspace, tab, step, await navigation.callSiteIdentityReload(step));
  assert.equal(tab.pendingUaReloadOrigin, undefined);
  assert.equal(saved[saved.length - 1]?.status, 'failed');
});

test('a reload result settles its receipt but leaves a tab that moved on alone', async () => {
  const fixture = reloadFixture();
  const { navigation, workspace, tab, saved, pushes } = fixture;
  fixture.failWith(new RemoteKitError('invalid_request', 'bad'));
  const step = fixture.plan();
  const outcome = await navigation.callSiteIdentityReload(step);
  tab.pendingUaReloadIdentity = { ...tab.pendingUaReloadIdentity!, operationId: 'newer' };
  navigation.commitSiteIdentityReload(workspace, tab, step, outcome);
  assert.equal(saved[saved.length - 1]?.status, 'failed');
  assert.equal(tab.pendingUaReloadIdentity.operationId, 'newer');
  assert.deepEqual(pushes, []);
  navigation.commitSiteIdentityReload(workspace, undefined, step, outcome);
});

function maintenanceFixture(t: import('node:test').TestContext) {
  const tenants = new TenantRegistry();
  const runtime = tenants.get('tenant');
  runtime.started = true;
  runtime.viewer = { id: 'lease' } as typeof runtime.viewer;
  const workspace = emptyWorkspace('tenant');
  const tab = tabFixture();
  workspace.tabs = [tab];
  const observation = observedSession(
    { tenantId: 'tenant', sessionId: 'a'.repeat(32), placementEpoch: 1 },
    'connection',
    'endpoint',
  );
  const views = [{ viewId: 'view', actual: 0, pending: false }];
  const log: string[] = [];
  const call = hold();
  const context = {
    tenants,
    closed: false,
    endpoint: {
      observation: () => observation,
      isReady: () => true,
      current: () => ({ running: true, browserIncarnation: 'browser', views }),
    },
    store: { workspaces: { workspace: () => workspace } },
  } as unknown as DomainContext;
  const services = {
    policy: { qualityFor: () => ({}) },
    lifecycle: {
      wantedVisible: () => false,
      forget: () => {},
      prepareVisible: async () => true,
      planBackgroundTab: (_state: unknown, planned: ProductTab) => {
        log.push('plan');
        return { id: planned.id };
      },
      callBackgroundTab: async () => {
        log.push('call');
        await call.promise;
        log.push('called');
        return true;
      },
      commitBackgroundTab: (_state: unknown, committed: ProductTab | undefined) => {
        log.push(committed ? 'commit' : 'commit-without-tab');
      },
    },
  } as unknown as DomainServices;
  const owner = new Reconciler(context, services);
  t.after(async () => {
    await owner.close();
    await tenants.close();
  });
  return {
    owner,
    tenants,
    workspace,
    tab,
    log,
    call,
    maintain: () => (owner as any).maintainTabs('tenant', runtime, []) as Promise<void>,
  };
}

test('a slow Browser call of a maintenance step does not hold the tenant lock', async (t) => {
  const { tenants, log, call, maintain } = maintenanceFixture(t);
  const work = maintain();
  for (let spin = 0; spin < 20 && !log.includes('call'); spin++) await idle();
  assert.deepEqual(log, ['plan', 'call']);
  // Other work on the tenant runs while the Browser call is pending.
  assert.equal(await tenants.serial('tenant', async () => 'ran'), 'ran');
  call.release();
  await work;
  assert.deepEqual(log, ['plan', 'call', 'called', 'commit']);
});

test('the commit sees the latest state: a tab closed during the call is absent', async (t) => {
  const { workspace, log, call, maintain } = maintenanceFixture(t);
  const work = maintain();
  for (let spin = 0; spin < 20 && !log.includes('call'); spin++) await idle();
  workspace.tabs = [];
  call.release();
  await work;
  assert.deepEqual(log, ['plan', 'call', 'called', 'commit-without-tab']);
});
