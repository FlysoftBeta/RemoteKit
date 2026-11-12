import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchTestBrowser, passwordLastChanged, waitForLogonBudget } from './browser.mjs';
import { checkBrowserLaunchPolicy } from './browser-launch-policy.mjs';

const evidence = fileURLToPath(new URL('../../../develop/tmp/e2e/', import.meta.url));
mkdirSync(evidence, { recursive: true });

test('all test and tool browser launch sites use the seeded launcher', checkBrowserLaunchPolicy);

test('fresh profile directories are seeded before browser startup', async (t) => {
  t.mock.method(childProcess, 'execFileSync', () => '0');
  const profile = join(mkdtempSync(join(evidence, 'profile-fresh-unit-')), 'viewer');
  assert.equal(existsSync(profile), false);
  const context = {};
  const browserType = {
    launchPersistentContext(path) {
      assert.equal(path, profile);
      const state = JSON.parse(readFileSync(join(profile, 'Local State'), 'utf8'));
      assert.equal(state.password_manager.os_password_blank, false);
      assert.equal(state.password_manager.os_password_last_changed, passwordLastChanged);
      return context;
    },
  };
  assert.equal(await launchTestBrowser({ profile, browserType }), context);
});

test('persistent and raw launches receive the seeded Local State before starting', async (t) => {
  t.mock.method(childProcess, 'execFileSync', () => '0');
  const profile = mkdtempSync(join(evidence, 'profile-seed-unit-'));
  writeFileSync(join(profile, 'Local State'), JSON.stringify({ unrelated: true }));
  function checkSeed(path) {
    assert.equal(path, profile);
    const state = JSON.parse(readFileSync(join(profile, 'Local State'), 'utf8'));
    assert.equal(state.unrelated, true);
    assert.equal(state.password_manager.os_password_blank, false);
    assert.equal(state.password_manager.os_password_last_changed, passwordLastChanged);
    assert.equal(typeof state.password_manager.os_password_last_changed, 'string');
    const currentChromiumTime = (BigInt(Date.now()) + 11644473600000n) * 1000n;
    assert(BigInt(passwordLastChanged) > currentChromiumTime);
  }
  const context = {};
  const browserType = {
    launchPersistentContext(path, options) {
      checkSeed(path);
      assert.equal(options.headless, true);
      assert.equal(options.ignoreDefaultArgs, false);
      return context;
    },
  };
  assert.equal(await launchTestBrowser({ profile, browserType }), context);
  for (const options of [
    { ignoreDefaultArgs: true },
    { ignoreDefaultArgs: ['--enable-automation'] },
    { ignoreAllDefaultArgs: true },
  ]) {
    await assert.rejects(launchTestBrowser({ profile, browserType, ...options }), /retain the seeded/);
  }

  const child = {};
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    checkSeed(profile);
    assert.equal(executable, 'viewer.exe');
    assert.equal(args[0], '--user' + '-data-dir=' + profile);
    assert.equal(options.windowsHide, true);
    return child;
  });
  assert.equal(await launchTestBrowser({ profile, executablePath: 'viewer.exe', spawnOptions: {} }), child);
  await assert.rejects(
    launchTestBrowser({ profile, args: ['--user' + '-data-dir=other'], spawnOptions: {} }),
    /Pass the browser profile/,
  );
});

test('a counter at six pauses launches until zero', async (t) => {
  if (process.platform !== 'win32') return;
  t.mock.method(console, 'log', () => {});
  const counts = [6, 5, 0];
  t.mock.method(childProcess, 'execFileSync', () => String(counts.shift()));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completed = false;
  const waiting = waitForLogonBudget().then(() => {
    completed = true;
  });
  assert.equal(completed, false);
  t.mock.timers.tick(30000);
  await Promise.resolve();
  assert.equal(completed, false);
  t.mock.timers.tick(30000);
  await waiting;
  assert.equal(completed, true);
  assert.equal(counts.length, 0);
});
