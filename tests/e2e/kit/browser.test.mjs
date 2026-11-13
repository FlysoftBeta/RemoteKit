import { EventEmitter } from 'node:events';
import { observeChildExit } from '../../../tools/child-process.mjs';
import { assertBrowserLogInterval, typeOnce } from './viewer.mjs';
import { createCdpInteraction } from './cdp-interaction.mjs';
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

function mockContext() {
  return {
    browser: () => ({
      newBrowserCDPSession: async () => ({
        send: async () => ({ processInfo: [{ type: 'browser', id: 987654 }] }),
        detach: async () => {},
      }),
    }),
  };
}

test('all test and tool browser launch sites use the seeded launcher', checkBrowserLaunchPolicy);

test('fresh profile directories are seeded before browser startup', async (t) => {
  t.mock.method(childProcess, 'execFileSync', () => '0');
  const profile = join(mkdtempSync(join(evidence, 'profile-fresh-unit-')), 'viewer');
  assert.equal(existsSync(profile), false);
  const context = mockContext();
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
  const context = mockContext();
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

test('lost input fails with expected and actual values without correction', async () => {
  const actions = [];
  await assert.rejects(
    typeOnce({
      click: async () => actions.push('click'),
      page: {
        keyboard: { press: async () => actions.push('select'), type: async () => actions.push('type') },
      },
      locator: { inputValue: async () => 'lost' },
      value: 'expected',
    }),
    /Expected "expected", actual "lost"/,
  );
  assert.deepEqual(actions, ['click', 'select', 'type']);
});

test('browser crash detection spans steps and respects an explicit interval', () => {
  const prefix = JSON.stringify({ ev: 'browser.replacing', reason: 'process_exited' }) + '\n';
  assert.throws(() => assertBrowserLogInterval(prefix, 0), /Browser restarted/);
  assert.doesNotThrow(() => assertBrowserLogInterval(prefix, prefix.length));
  const normal = JSON.stringify({ ev: 'browser.launched' }) + '\n';
  assert.throws(
    () =>
      assertBrowserLogInterval(
        JSON.stringify({ ev: 'browser.replacing', reason: 'control_pipe_disconnected' }) + '\n',
        0,
      ),
    /control_pipe_disconnected/,
  );
  assert.doesNotThrow(() => assertBrowserLogInterval(normal, 0));
  const crash = JSON.stringify({ ev: 'browser.crashed', exitCode: 42 }) + '\n';
  assert.throws(() => assertBrowserLogInterval(prefix + normal + crash, prefix.length), /browser.crashed/);
});

test('shared CDP fill inputs once and waits for the observed value', async () => {
  for (const succeeds of [true, false]) {
    const actions = [];
    let reads = 0;
    const driver = createCdpInteraction({
      cdp: {
        send: async (method, { expression, userGesture }) => {
          assert.equal(userGesture, false);
          const value = expression.includes('?.value')
            ? ++reads >= 3 && succeeds
              ? 'expected'
              : 'lost'
            : { x: 1, y: 2 };
          return { result: { value } };
        },
      },
      page: {
        mouse: { click: async () => actions.push('click') },
        keyboard: {
          press: async () => actions.push('select'),
          insertText: async () => actions.push('insert'),
        },
      },
      sleep: async () => {},
      until: async (check, label) => {
        for (let i = 0; i < 4; i++) {
          const value = await check();
          if (value) return value;
        }
        throw Error(label);
      },
    });
    if (succeeds) await driver.fill('input', 'expected');
    else await assert.rejects(driver.fill('input', 'expected'), /Expected "expected", actual "lost"/);
    assert.deepEqual(actions, ['click', 'select', 'insert']);
    assert(reads >= 3);
  }
});

test('business waits and final cleanup share the exit observed at spawn', async () => {
  const child = new EventEmitter();
  const { exited, wait } = observeChildExit(child, () => 'stderr');
  const waiting = wait(new Promise(() => {}));
  child.emit('exit', 7, null);
  await assert.rejects(waiting, /Child exited 7\/null: stderr/);
  assert.deepEqual(await exited, { code: 7, signal: null });
  await assert.rejects(wait(new Promise(() => {})), /Child exited 7/);
  assert.equal(child.listenerCount('exit'), 0);
  const failedChild = new EventEmitter();
  const failed = observeChildExit(failedChild);
  failedChild.emit('error', Error('spawn failed'));
  await assert.rejects(failed.wait(new Promise(() => {})), /spawn failed/);
  await assert.rejects(failed.exited, /spawn failed/);
});
