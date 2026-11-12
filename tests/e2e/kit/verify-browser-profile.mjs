import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { failedLogonCount, launchTestBrowser, waitForLogonBudget } from './browser.mjs';
import { checkBrowserLaunchPolicy } from './browser-launch-policy.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert(values.out, 'Provide --out with a fresh evidence directory');
checkBrowserLaunchPolicy();
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const results = [];
for (const [name, options] of [
  ['edge', { channel: 'msedge' }],
  ['chrome89', { executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe' }],
]) {
  await waitForLogonBudget();
  const profile = join(out, name);
  const before = failedLogonCount();
  const result = { browser: name, before, samples: [], profile };
  results.push(result);
  let context;
  try {
    context = await launchTestBrowser({ profile, ...options });
    result.version = context.browser().version();
    const isolated = await context.browser().newContext({ viewport: { width: 800, height: 600 } });
    const page = await isolated.newPage();
    await page.goto('data:text/html,<title>Seeded browser verification</title>');
    assert.equal(await page.title(), 'Seeded browser verification');
    const started = Date.now();
    for (let sample = 1; sample <= 3; sample++) {
      await new Promise((done) => setTimeout(done, 30000));
      const count = failedLogonCount();
      const elapsedMs = Date.now() - started;
      result.samples.push({ elapsedMs, count });
      console.log(`${name}: ${elapsedMs} ms, failed logons ${before} -> ${count}`);
      assert(count < 6, 'Counter reached six; stop browser launches until zero');
      assert(count <= before, 'Seeded profile increased the failed-logon counter');
    }
    result.passed = true;
  } catch (error) {
    result.error = String(error);
    throw error;
  } finally {
    await context?.close();
    result.after = failedLogonCount();
    if (result.after > before) result.passed = false;
    result.preferences = JSON.parse(readFileSync(join(profile, 'Local State'), 'utf8')).password_manager;
    writeFileSync(join(out, 'verification.json'), JSON.stringify(results, null, 2));
  }
  assert(
    result.after < 6 && result.after <= before,
    'Failed-logon counter increased during browser shutdown',
  );
}
