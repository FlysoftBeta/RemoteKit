import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundJob } from '../server/background';
import { RemoteKitError, type ErrorCode } from '../shared/errors';
import { log } from '../server/log';
import { RetryUnit } from '../shared/retry-unit';

test('retry policy caps unavailable at five minutes and honors producer delays', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const state = new RetryUnit();
  assert(state.ready('one'));
  for (let attempt = 0; attempt < 12; attempt++) {
    const expected = Math.min(300_000, 1000 * 2 ** attempt);
    assert.equal(state.fail(new RemoteKitError('unavailable', 'fixture')).delay, expected);
    t.mock.timers.tick(expected);
    assert(state.ready('one'));
  }
  assert(state.succeed());
  assert.equal(state.fail(new RemoteKitError('unavailable', 'fixture')).delay, 1000);
  state.succeed();
  assert.equal(state.fail(new RemoteKitError('rate_limited', 'fixture', { retryAfterMs: 1234 })).delay, 1234);
});

for (const code of ['busy', 'rate_limited', 'unavailable', 'outcome_unknown', 'conflict'] as const) {
  test(`background ${code} follows policy and logs one streak`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    t.mock.method(Math, 'random', () => 0.5);
    const warnings: unknown[] = [];
    const recoveries: unknown[] = [];
    t.mock.method(log, 'warn', (...args: unknown[]) => warnings.push(args));
    t.mock.method(log, 'info', (...args: unknown[]) => recoveries.push(args));
    const job = new BackgroundJob('background.run', { job: code });
    let calls = 0;
    let fail = true;
    const work = async () => {
      calls++;
      if (fail) throw new RemoteKitError(code, 'fixture', { errorId: 'e-0123456789' });
    };
    const firstDelay = code === 'busy' ? 250 : code === 'rate_limited' ? 30_000 : 1000;
    const secondDelay = code === 'rate_limited' ? 30_000 : firstDelay * 2;
    await job.run(work, 'one');
    t.mock.timers.tick(firstDelay - 1);
    await job.run(work, 'one');
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await job.run(work, 'one');
    assert.equal(calls, 2);
    t.mock.timers.tick(secondDelay - 1);
    await job.run(work, 'one');
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    fail = false;
    await job.run(work, 'one');
    assert.equal(calls, 3);
    assert.equal(warnings.length, 1);
    assert.equal(recoveries.length, 1);
    fail = true;
    await job.run(work, 'one');
    t.mock.timers.tick(firstDelay);
    await job.run(work, 'one');
    assert.equal(calls, 5);
    assert.equal(warnings.length, 2);
  });
}

for (const code of [
  'not_found',
  'invalid_request',
  'internal',
  'rejected',
  'limit_exceeded',
  'forbidden',
  'locked',
  'unauthenticated',
  'canceled',
] satisfies ErrorCode[]) {
  test(`background ${code} waits for changed input`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const warnings: unknown[] = [];
    t.mock.method(log, 'warn', (...args: unknown[]) => warnings.push(args));
    t.mock.method(log, 'info', () => {});
    const job = new BackgroundJob('background.run', {});
    let calls = 0;
    await job.run(async () => {
      calls++;
      throw new RemoteKitError(code, 'fixture');
    }, 'one');
    t.mock.timers.tick(1_000_000);
    await job.run(async () => {
      calls++;
    }, 'one');
    assert.equal(calls, 1);
    await job.run(async () => {
      calls++;
    }, 'two');
    assert.equal(calls, 2);
    assert.equal(warnings.length, code === 'canceled' ? 0 : 1);
  });
}
