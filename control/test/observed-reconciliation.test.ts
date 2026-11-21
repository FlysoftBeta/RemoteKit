import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainContext, DomainServices } from '../server/application';
import { TenantRegistry } from '../server/tenants/tenant-registry';
import { PageRequests } from '../server/workspace/page-requests';
import { Reconciler } from '../server/workspace/reconciler';
import { observedSession } from './coordination-fixture';
import { FailingBoundary, settle } from './retry-loop-boundary';
import { driveReconciler } from './retry-loop-workspace-drivers';

function fixture(t: import('node:test').TestContext) {
  const tenants = new TenantRegistry();
  tenants.get('tenant').started = true;
  const owner = new Reconciler({ tenants, closed: false } as DomainContext, {} as DomainServices);
  const observation = observedSession(
    { tenantId: 'tenant', sessionId: 'a'.repeat(32), placementEpoch: 1 },
    'connection',
    'endpoint',
  );
  t.after(async () => {
    await owner.close();
    await tenants.close();
  });
  return { owner, observation };
}

test('observations coalesce by tenant, consume the newest value and rerun after an in-flight update', async (t) => {
  const { owner, observation } = fixture(t);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const revisions: string[] = [];
  t.mock.method(owner, 'reconcileProduct', async () => {
    revisions.push(observation.observedRevision);
    if (revisions.length === 1) await hold;
  });
  const work = owner.observe(observation);
  observation.observedRevision = '1';
  owner.observe(observation);
  await settle();
  assert.deepEqual(revisions, ['1']);
  observation.observedRevision = '2';
  owner.observe(observation);
  observation.observedRevision = '3';
  owner.observe(observation);
  release();
  await work;
  assert.deepEqual(revisions, ['1', '3']);
});

test('statistics, transport sequence and compositor counters are filtered; page and lifecycle changes trigger work', async (t) => {
  const { owner, observation } = fixture(t);
  const calls = t.mock.method(owner, 'reconcileProduct', async () => {});
  observation.views = [{ viewId: '1', loading: true, compositor: { frames: 1 }, renderer_pids: ['2'] }];
  await owner.observe(observation);
  observation.seq = '2';
  observation.stats = { frames: 30, fps: 60 };
  observation.views[0].compositor = { frames: 30 };
  observation.views[0].renderer_pids = ['3'];
  owner.observe(observation);
  await settle();
  assert.equal(calls.mock.callCount(), 1);
  observation.views[0].loading = false;
  await owner.observe(observation);
  observation.views[0].pageRequests = { pending: [], events: [] };
  await owner.observe(observation);
  observation.views[0].recovery = { pending: false, phase: 'restored', error: null };
  await owner.observe(observation);
  assert.equal(calls.mock.callCount(), 4);
});

test('inactive tenants retain observations without publishing product work', async (t) => {
  const tenants = new TenantRegistry();
  const owner = new Reconciler({ tenants, closed: false } as DomainContext, {} as DomainServices);
  const calls = t.mock.method(owner, 'reconcileProduct', async () => {});
  const message = observedSession(
    { tenantId: 'inactive', sessionId: 'b'.repeat(32), placementEpoch: 1 },
    'connection',
    'endpoint',
  );
  owner.observe(message);
  await settle();
  assert.equal(calls.mock.callCount(), 0);
  await owner.close();
  await tenants.close();
});

test('a newer observation is consumed even when the running reconciliation fails', async (t) => {
  const { owner, observation } = fixture(t);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  t.mock.method(owner, 'reconcileProduct', async () => {
    if (++calls === 1) {
      await hold;
      throw new Error('dependency failed');
    }
  });
  const work = owner.observe(observation);
  await settle();
  observation.observedRevision = '2';
  owner.observe(observation);
  release();
  await work;
  assert.equal(calls, 2);
});

test('a failed old observation cannot put a newer observation into its retry backoff', async (t) => {
  const boundary = new FailingBoundary();
  boundary.code = 'unavailable';
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  t.mock.method(boundary, 'call', async (input: unknown, value: unknown) => {
    try {
      return boundary.callSync(input, value);
    } catch (error) {
      if (first) {
        first = false;
        await hold;
      }
      throw error;
    }
  });
  const owner = await driveReconciler('observed')(boundary, t);
  const work = owner.start();
  await settle();
  boundary.code = undefined;
  owner.changeInput();
  release();
  await work;
  await settle();
  assert.equal(boundary.attempts.length, 2);
  assert.equal(owner.error(), undefined);
  await owner.dispose();
});

function pageRequestFixture(t: import('node:test').TestContext) {
  const tenants = new TenantRegistry();
  const runtime = tenants.get('tenant');
  runtime.started = true;
  runtime.viewer = { id: 'lease' } as typeof runtime.viewer;
  const observation = observedSession(
    { tenantId: 'tenant', sessionId: 'a'.repeat(32), placementEpoch: 1 },
    'connection',
    'endpoint',
  );
  observation.browser = 'running';
  observation.browserIncarnation = 'browser-1';
  let current: typeof observation | undefined = observation;
  let ready = true;
  const state = { tabs: [{ id: 'tab-1', windowId: 'window-1', webviewId: '7' }], pendingClose: null };
  const pushes: string[] = [];
  const context = {
    tenants,
    closed: false,
    fileLimits: { maxFileBytes: 1, maxBatchBytes: 1, maxFiles: 1 },
    endpoint: {
      observation: () => current,
      isReady: () => ready,
      sessionFault: () => undefined,
      invalidate: () => {},
      current: () => ({
        running: true,
        browserIncarnation: observation.browserIncarnation,
        views: observation.views,
      }),
    },
    store: { workspaces: { workspace: () => state } },
  } as unknown as DomainContext;
  const services = {
    viewers: { push: (tenant: string) => pushes.push(tenant) },
  } as unknown as DomainServices;
  const pageRequests = new PageRequests(context, services as never);
  services.pageRequests = pageRequests;
  const owner = new Reconciler(context, services);
  t.after(async () => {
    await owner.close();
    await tenants.close();
  });
  const chooser = () => ({
    viewId: '7',
    instance: '3',
    document: '4',
    pageRequests: {
      pending: [{ kind: 'file_chooser', request: '9', origin: 'https://example.test', multiple: false }],
      events: [],
    },
  });
  return {
    owner,
    observation,
    runtime,
    pushes,
    chooser,
    retire: () => {
      current = undefined;
    },
    notReady: () => {
      ready = false;
    },
  };
}

test('a file request is projected and pushed on observation arrival, not after the running reconciliation', async (t) => {
  const { owner, observation, runtime, pushes, chooser } = pageRequestFixture(t);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(owner, 'reconcileProduct', async () => {
    await hold;
  });
  const work = owner.observe(observation);
  await settle();
  assert.deepEqual(runtime.pageRequests.files ?? [], []);
  observation.views = [chooser()] as never;
  owner.observe(observation);
  assert.equal(runtime.pageRequests.files?.length, 1);
  assert.equal(runtime.pageRequests.files?.[0].binding.request, '9');
  assert.deepEqual(pushes, ['tenant']);
  release();
  await work;
});

test('an observation that is no longer current projects nothing', async (t) => {
  const { owner, observation, runtime, pushes, chooser, retire, notReady } = pageRequestFixture(t);
  t.mock.method(owner, 'reconcileProduct', async () => {});
  observation.views = [chooser()] as never;
  retire();
  owner.observe(observation);
  assert.equal(runtime.pageRequests.files, undefined);
  observation.views = [{ ...chooser(), loading: true }] as never;
  notReady();
  owner.observe(observation);
  assert.equal(runtime.pageRequests.files, undefined);
  assert.deepEqual(pushes, []);
});

test('projecting the same observation again does not push twice', async (t) => {
  const { owner, observation, pushes, chooser } = pageRequestFixture(t);
  t.mock.method(owner, 'reconcileProduct', async () => {});
  observation.views = [chooser()] as never;
  owner.observe(observation);
  observation.views = [{ ...chooser(), loading: true }] as never;
  owner.observe(observation);
  assert.deepEqual(pushes, ['tenant']);
});
