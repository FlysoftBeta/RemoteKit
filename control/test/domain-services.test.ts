import { registerUser } from './server-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../server/application';
import { ControlDatabase } from '../server/persistence/database';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { applyCommand } from '../server/workspace/commands';
import { MemorySaver, type MemoryObservation } from '../server/workspace/lifecycle';
import { TestClock, accountsFor, testGateway } from './server-fixture';

test('workspace planning is deterministic and leaves its input unchanged', () => {
  const workspace = emptyWorkspace('tenant');
  const before = structuredClone(workspace);
  const context = { ids: ['window', 'space', 'tab'], viewId: '1', now: 1000 };
  const first = applyCommand(
    workspace,
    { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
    context,
  );
  const second = applyCommand(
    workspace,
    { type: 'window.open', appId: 'browser', placement: { mode: 'space' } },
    context,
  );
  assert.deepEqual(workspace, before);
  assert.deepEqual(first, second);
  assert.equal(first.workspace.tabs[0].id, 'tab');
  const execution = {
    tenantId: 'tenant',
    authority: { tenantId: 'tenant', leaseId: 'lease', epoch: 1 },
    operationId: 'operation',
    operationGeneration: 'generation',
    operationSequence: '3',
  };
  const navigation = applyCommand(
    first.workspace,
    { type: 'tab.navigate', tabId: 'tab', url: 'https://example.test/' },
    { ...context, execution, browserIncarnation: 'browser' },
  );
  assert.equal(first.workspace.tabs[0].kind, 'start');
  assert.deepEqual(navigation.effects, [
    { kind: 'navigate', tabId: 'tab', url: 'https://example.test/', previousKind: 'start', ctx: execution },
  ]);
});

test('memory saver advances through public observations and pure next decisions with an injected clock', () => {
  const clock = new TestClock();
  const saver = new MemorySaver(clock);
  const observation: MemoryObservation = {
    enabled: true,
    visible: false,
    protectedByProduct: false,
    browserIncarnation: 'browser',
    current: { actual: 0, visible: false, canDiscard: true, instance: 'page' },
  };
  assert.equal(saver.observe(observation), null);
  for (let sample = 0; sample < 5; sample++) {
    clock.advance(5000);
    assert.equal(saver.observe(observation), null);
  }
  clock.advance(5000);
  assert.equal(saver.next(observation, clock.monotonicMs()), 'freeze');
  assert.equal(saver.next(observation, clock.monotonicMs()), 'freeze');
  assert.equal(saver.observe(observation), 'freeze');
  saver.freezeRequested();
  clock.advance(5000);
  assert.equal(
    saver.observe({ ...observation, current: { ...observation.current, pending: true, desired: 1 } }),
    null,
  );
  const frozen = { ...observation, current: { ...observation.current, actual: 1 } };
  for (let sample = 0; sample < 17; sample++) {
    clock.advance(5000);
    assert.equal(saver.observe(frozen), null);
  }
  clock.advance(5000);
  assert.equal(saver.observe(frozen), 'discard');
  assert.equal(saver.observe({ ...frozen, current: { ...frozen.current, audible: true } }), null);
  clock.advance(5000);
  assert.equal(saver.observe(observation), null);
});

test('a blocked tenant does not stop later reconciliation ticks for another tenant', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  let blockedTenant: string | undefined;
  let blocked = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const snapshots = new Map<string, number>();
  const endpoint = testGateway({
    async request(method, tenant) {
      if (method === 'session.snapshot') {
        snapshots.set(tenant, (snapshots.get(tenant) ?? 0) + 1);
        if (blocked && tenant === blockedTenant) await gate;
        return { running: true, browserIncarnation: tenant, views: [] };
      }
      return { accepted: true, applied: true };
    },
  });
  const services = createApplication(store, endpoint);
  try {
    const first = await registerUser(store, 'blocked', 'password123');
    const second = await registerUser(store, 'progress', 'password123');
    for (const tenant of [first.tenantId, second.tenantId]) {
      await services.viewers.attachViewer(
        tenant,
        'lease',
        () => {},
        { identity: tenant, valid: () => true },
        true,
      );
    }
    blockedTenant = first.tenantId;
    blocked = true;
    const firstTick = services.reconciler.tick();
    await services.tenants.serial(second.tenantId, async () => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = snapshots.get(second.tenantId)!;
    const secondTick = services.reconciler.tick();
    await services.tenants.serial(second.tenantId, async () => {});
    assert.ok(snapshots.get(second.tenantId)! > before);
    release();
    await Promise.all([firstTick, secondTick]);
  } finally {
    release();
    await services.close();
    store.db.close();
  }
});
