import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordStrictDecodeRejections } from './strict-decode.mjs';
import {
  createTrackedDirectory,
  currentCleanupRun,
  trackCleanupPid,
  trackCleanupProcess,
  watchDetachedBrowser,
} from './cleanup.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
// 9999-01-01 in Chromium microseconds since 1601-01-01, kept as an int64 JSON string.
export const passwordLastChanged = '265015238400000000';

export function failedLogonCount() {
  if (process.platform !== 'win32') return 0;
  const value = childProcess
    .execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([ADSI]"WinNT://./$env:USERNAME,user").BadPasswordAttempts',
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    .trim();
  if (!/^\d+$/.test(value)) throw Error('Cannot read Windows failed-logon counter: ' + value);
  return Number(value);
}

export async function waitForLogonBudget() {
  let count = failedLogonCount();
  if (count < 6) return count;
  do {
    console.log(`Windows failed-logon counter ${count}; browser launches paused until it reaches 0.`);
    await new Promise((done) => setTimeout(done, 30000));
    count = failedLogonCount();
  } while (count !== 0);
  return count;
}

export async function launchTestBrowser({
  profile,
  browserType,
  spawnOptions,
  ignoreDefaultArgs,
  ignoreAllDefaultArgs,
  ...options
} = {}) {
  if (ignoreDefaultArgs || ignoreAllDefaultArgs)
    throw Error('Browser launches must retain the seeded user-data-dir argument');
  await waitForLogonBudget();
  const run = resolve(
    process.env.E2E_RUN ??
      (profile ? dirname(resolve(profile)) : currentCleanupRun()) ??
      join(repository, 'develop/tmp/e2e', 'browser-' + randomUUID()),
  );
  profile = resolve(profile ?? join(run, 'profile-' + randomUUID()));
  createTrackedDirectory(run, profile, 'viewer-profile');
  const localStatePath = join(profile, 'Local State');
  const localState = existsSync(localStatePath) ? JSON.parse(readFileSync(localStatePath, 'utf8')) : {};
  localState.password_manager = {
    ...localState.password_manager,
    os_password_blank: false,
    os_password_last_changed: passwordLastChanged,
  };
  writeFileSync(localStatePath, JSON.stringify(localState));
  if (spawnOptions) {
    const { executablePath, args = [] } = options;
    if (args.some((arg) => arg.startsWith('--user-data-dir')))
      throw Error('Pass the browser profile through launchTestBrowser');
    const child = childProcess.spawn(executablePath, [`--user-data-dir=${profile}`, ...args], {
      windowsHide: true,
      ...spawnOptions,
    });
    trackCleanupProcess(run, child);
    if (spawnOptions.detached) watchDetachedBrowser(run, child);
    return child;
  }
  if (!browserType) {
    const { chromium } = createRequire(import.meta.url)(
      process.env.REMOTEKIT_PLAYWRIGHT ??
        join(
          homedir(),
          '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
        ),
    );
    browserType = chromium;
  }
  const context = await browserType.launchPersistentContext(profile, {
    headless: true,
    ...options,
    ignoreDefaultArgs: false,
  });
  try {
    const diagnostics = await context.browser().newBrowserCDPSession();
    const { processInfo } = await diagnostics.send('SystemInfo.getProcessInfo');
    const browserProcess = processInfo.find((entry) => entry.type === 'browser');
    if (!browserProcess) throw Error('Browser process ID is missing from CDP diagnostics');
    trackCleanupPid(run, browserProcess.id);
    await diagnostics.detach();
    await recordStrictDecodeRejections(context, run);
    const browser = context.browser();
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const created = await newContext(...args);
      try {
        await recordStrictDecodeRejections(created, run);
        return created;
      } catch (error) {
        await created.close();
        throw error;
      }
    };
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}
