import assert from 'node:assert/strict';
import test from 'node:test';
import { CpuProfile } from '../server/diagnostics/cpu-profile';

function spin(ms: number) {
  const end = performance.now() + ms;
  let value = 0;
  while (performance.now() < end) value += Math.sqrt(value + 1);
  return value;
}

test('concurrent collections each get their own main-thread profile', async () => {
  const first = new CpuProfile();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = new CpuProfile();
  await new Promise((resolve) => setTimeout(resolve, 10));
  spin(50);
  const [a, again] = await Promise.all([first.stop(), first.stop()]);
  assert.equal(a, again);
  spin(20);
  const b = await second.stop();
  for (const result of [a, b]) {
    assert.ok('data' in result);
    const profile = JSON.parse(result.data.toString());
    assert.ok(profile.nodes.length > 0);
    assert.equal(profile.samples.length, profile.timeDeltas.length);
    assert.ok(profile.endTime > profile.startTime);
  }
});
