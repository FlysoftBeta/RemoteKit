import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteKitError } from '../shared/errors';
import { OperationsStore } from '../client/control/operations-store';
import { recover } from '../client/failures/recovery';
import { presentFailure } from '../client/failures/present';
import { OfferResults } from '../server/viewers/offer-results';
import { productSnapshot } from './client-fixture';
import { ControlDatabase } from '../server/persistence/database';
import { RetryLedger } from '../server/persistence/retry-units';
import { testGateway } from './server-fixture';

test('allocation relief uses typed pressure evidence independently of diagnostic text', () => {
  let pressure = false;
  let message = 'allocation out of memory';
  const gateway = testGateway({
    request: async () => ({}),
    observe: () => ({
      status: { code: 'unavailable', message, reason: 'output_failed' },
      stats: { allocationPressure: pressure },
    }),
  });
  gateway.placement.resolve('tenant');
  const node = gateway.nodes.get('fixture')!;
  gateway.current('tenant');
  assert.equal(node.allocationFailedAt, undefined);
  pressure = true;
  message = 'renderer stopped';
  gateway.current('tenant');
  assert.equal(typeof node.allocationFailedAt, 'number');
});

test('an unidentified mutation remains unknown and is never executed twice', async () => {
  let password = 'old';
  let calls = 0;
  const failure = new RemoteKitError('outcome_unknown', 'reply lost', { errorId: 'e-0123456789' });
  await assert.rejects(
    recover(async () => {
      calls++;
      assert.equal(password, 'old');
      password = 'new';
      throw failure;
    }, new AbortController().signal),
    failure,
  );
  assert.equal(calls, 1);
  assert.equal(password, 'new');
  const presentation = presentFailure(failure, { operation: '修改密码', scope: 'surface' });
  assert.equal(presentation.class, 'C');
  assert(!/正在|自动继续/.test(presentation.text));
});

for (const code of ['internal', 'locked', 'forbidden', 'not_found', 'rejected'] as const) {
  test(`receipt query ${code} never fabricates an operation failure`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    let submitted: { operationId: string; operationGeneration: string } | undefined;
    let queries = 0;
    const store = new OperationsStore({
      ready: () => true,
      submit: async (operation) => {
        submitted = operation;
        throw new RemoteKitError('outcome_unknown', 'reply lost');
      },
      status: async () => {
        queries++;
        throw new RemoteKitError(code, 'query rejected');
      },
    });
    t.after(() => store.reset());
    const snapshot = productSnapshot();
    store.acceptSnapshot(snapshot);
    const failed = assert.rejects(
      store.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
      { code },
    );
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
    await failed;
    assert.equal(store.getSnapshot().pending.length, 1);
    assert.equal(store.getSnapshot().pending[0].phase, 'unknown');
    assert.equal(store.getSnapshot().pending[0].receipt?.status, 'unknown');
    t.mock.timers.tick(600000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queries, 1);
    store.acceptSnapshot({
      ...snapshot,
      snapshotSequence: (snapshot.snapshotSequence ?? 0) + 1,
      operationReceipts: [{ ...submitted!, status: 'committed', revision: 0 }],
    });
    assert.equal(store.getSnapshot().pending.length, 0);
  });
}

test('RTC reconciliation queries the same attempt and observes retirement without a second offer', async () => {
  const results = new OfferResults<{ connectionId: string }>();
  const input = { attemptId: 'attempt', sdp: 'v=0' };
  let calls = 0;
  const work = async () => {
    calls++;
    throw new RemoteKitError('outcome_unknown', 'lost native answer');
  };
  await assert.rejects(results.execute('tenant', 'lease', input, work), { code: 'outcome_unknown' });
  await assert.rejects(results.execute('tenant', 'lease', input, work), { code: 'outcome_unknown' });
  assert.equal(calls, 1);
  assert.equal(results.status('tenant', 'lease', 'attempt').state, 'unknown');
  results.retire('tenant', 'lease', 'attempt');
  assert.equal(results.status('tenant', 'lease', 'attempt').state, 'retired');
  const changed = { ...input, sdp: 'different' };
  await assert.rejects(results.execute('tenant', 'lease', changed, work), { code: 'conflict' });
  assert.equal(calls, 1);
});

test('durable unit failure and its owner mutation roll back together', (t) => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  t.after(() => store.db.close());
  const ledger = new RetryLedger(store, 'injection');
  const unit = ledger.unit('one');
  const before = unit.record();
  unit.ready('revision');
  unit.fail(new RemoteKitError('unavailable', 'injected', { retryAfterMs: 300000, errorId: 'e-0123456789' }));
  assert.throws(() =>
    ledger.save('one', () => {
      throw new Error('owner write failed');
    }),
  );
  assert.deepEqual(unit.record(), before);
  assert.equal(store.db.prepare("SELECT 1 FROM retry_units WHERE owner='injection'").get(), undefined);
  unit.ready('revision');
  unit.fail(new RemoteKitError('outcome_unknown', 'injected', { errorId: 'e-0123456789' }));
  const identity = unit.identity;
  ledger.save('one');
  const restored = new RetryLedger(store, 'injection').unit('one');
  assert.equal(restored.state.phase, 'waiting');
  assert.equal(restored.error?.code, 'outcome_unknown');
  assert.equal(restored.error?.errorId, 'e-0123456789');
  assert.equal(restored.identity, identity);
});
