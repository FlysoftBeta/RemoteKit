import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonical, counter, validateDesired, type SessionDesired } from '../server/endpoint/coordination';

function desired(): SessionDesired {
  return JSON.parse(
    readFileSync(new URL('../../protocol/coordination.fixture.json', import.meta.url), 'utf8'),
  );
}

test('coordination counters reject precision loss and canonicalization preserves view order', () => {
  for (const value of ['0', '1', '18446744073709551615']) assert.equal(counter(value), true);
  for (const value of [1, '01', '-1', '18446744073709551616', '1.0']) assert.equal(counter(value), false);
  assert.equal(counter('0', true), false);
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});
test('desired rejects conflicting run and commit, duplicate views and invalid occlusion', () => {
  validateDesired(desired());
  const runningCommit = desired();
  runningCommit.commit = 'commit';
  assert.throws(() => validateDesired(runningCommit), { code: 'invalid_request' });
  const duplicate = desired();
  duplicate.views.push(duplicate.views[0]);
  assert.throws(() => validateDesired(duplicate), { code: 'invalid_request' });
  const occluded = desired();
  occluded.views[0].occludedBottom = 901;
  assert.throws(() => validateDesired(occluded), { code: 'invalid_request' });
});
