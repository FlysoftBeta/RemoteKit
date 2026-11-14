import assert from 'node:assert/strict';
import test from 'node:test';
import { RetryUnit } from '../shared/retry-unit';
import { RemoteKitError } from '../shared/errors';

test('busy exhausts a per-input budget and a changed input resets it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(Math, 'random', () => 0.5);
  const warnings: unknown[] = [],
    recoveries: unknown[] = [];
  const unit = new RetryUnit({
    failed: (error) => warnings.push(error),
    recovered: () => recoveries.push(true),
  });
  for (let attempt = 0; attempt < 9; attempt++) {
    await unit.execute('input', async () => {
      throw new RemoteKitError('busy', 'injected');
    });
    if (unit.state.phase === 'waiting') t.mock.timers.tick(unit.state.until - Date.now());
  }
  assert.equal(unit.state.phase, 'faulted');
  assert.equal(warnings.length, 1);
  await unit.execute('changed', async () => 'ready');
  assert.equal(unit.state.phase, 'idle');
  assert.equal(recoveries.length, 1);
});

test('persisted deadlines and uncertain request identity survive restoration', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const unit = new RetryUnit({ failed: () => {} });
  unit.ready('request');
  unit.fail(new RemoteKitError('rate_limited', 'injected', { retryAfterMs: 300000 }));
  const restored = new RetryUnit().restore(JSON.parse(JSON.stringify(unit.record())));
  t.mock.timers.tick(299999);
  assert.equal(restored.ready('request'), false);
  assert.equal(restored.identity, unit.identity);
  t.mock.timers.tick(1);
  assert.equal(restored.ready('request'), true);
});

test('close cancels timers and waits and prevents late continuations from reopening a unit', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const unit = new RetryUnit({ failed: () => assert.fail('a retired unit must not log a new failure') });
  unit.restore({
    identity: 'request',
    input: 'input',
    attempts: 1,
    streak: true,
    state: { phase: 'waiting', attempt: 1, until: 1000 },
  });
  let calls = 0;
  unit.schedule(() => calls++);
  const waiting = assert.rejects(unit.wait(), { code: 'canceled' });
  unit.close();
  await waiting;
  unit.fail(new RemoteKitError('unavailable', 'late failure'));
  unit.succeed();
  unit.restore({
    identity: 'replacement',
    input: 'changed',
    attempts: 0,
    streak: false,
    state: { phase: 'idle' },
  });
  unit.schedule(() => calls++);
  t.mock.timers.tick(60000);
  assert.equal(calls, 0);
  assert.equal(unit.ready('changed again'), false);
  await assert.rejects(unit.wait(), { code: 'canceled' });
  const result = await unit.execute('changed again', async () =>
    assert.fail('closed unit entered dependency'),
  );
  assert.equal(result.ran, false);
});

for (const code of ['conflict', 'outcome_unknown'] as const)
  test(`${code} discards an unsupported retry hint and backs off`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const unit = new RetryUnit({ failed: () => {} });
    unit.fail(new RemoteKitError(code, 'injected', { retryAfterMs: 12000 }));
    assert.equal(unit.error?.retryAfterMs, undefined);
    assert.deepEqual(unit.state, { phase: 'waiting', attempt: 1, until: 1000 });
  });
