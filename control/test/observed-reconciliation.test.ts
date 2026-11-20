import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainContext, DomainServices } from '../server/application';
import { TenantRegistry } from '../server/tenants/tenant-registry';
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
