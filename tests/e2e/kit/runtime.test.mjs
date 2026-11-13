import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { fakeLearningProvider } from './learning-provider.mjs';
import { launch } from './viewer.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stageProductRuntime } from './stack.mjs';

test('runtime staging includes the snapshot helper beside the Endpoint', () => {
  const evidence = fileURLToPath(new URL('../../../develop/tmp/e2e/', import.meta.url));
  mkdirSync(evidence, { recursive: true });
  const run = mkdtempSync(join(evidence, 'runtime-unit-'));
  const endpoint = join(run, 'endpoint');
  const browser = join(run, 'browser');
  const staged = join(run, 'staged');
  mkdirSync(endpoint);
  mkdirSync(browser);
  writeFileSync(join(endpoint, 'endpoint_service.exe'), 'endpoint fixture');
  writeFileSync(join(endpoint, 'remotekit_snapshot.exe'), 'snapshot fixture');
  writeFileSync(join(browser, 'remotekit_browser.exe'), 'browser fixture');
  const executable = stageProductRuntime(
    join(endpoint, 'endpoint_service.exe'),
    join(browser, 'remotekit_browser.exe'),
    staged,
  );
  assert.equal(executable, join(staged, 'endpoint_service.exe'));
  assert.equal(readFileSync(join(staged, 'remotekit_snapshot.exe'), 'utf8'), 'snapshot fixture');
});

test('viewer initialization rolls back every acquired resource on failure', async (t) => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(
    process.env.REMOTEKIT_PLAYWRIGHT ??
      join(
        homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
      ),
  );
  t.mock.method(childProcess, 'execFileSync', () => '0');
  const evidence = fileURLToPath(new URL('../../../develop/tmp/e2e/', import.meta.url));
  for (const failure of ['context', 'page', 'cdp']) {
    const released = [];
    const run = mkdtempSync(join(evidence, 'viewer-rollback-'));
    const endpointLog = join(run, 'endpoint.log');
    writeFileSync(endpointLog, '');
    const page = { setDefaultTimeout() {}, close: async () => released.push('page') };
    const context = {
      close: async () => released.push('context'),
      newPage: async () => {
        if (failure === 'page') throw Error('injected page');
        return page;
      },
      newCDPSession: async () => {
        throw Error('injected cdp');
      },
    };
    const browser = {
      newBrowserCDPSession: async () => ({
        send: async () => ({ processInfo: [{ type: 'browser', id: 987654 }] }),
        detach: async () => {},
      }),
      close: async () => released.push('browser'),
      newContext: async () => {
        if (failure === 'context') throw Error('injected context');
        return context;
      },
    };
    const mock = t.mock.method(chromium, 'launchPersistentContext', async () => ({ browser: () => browser }));
    try {
      await assert.rejects(
        launch({ stack: { run, logs: { endpoint: endpointLog } }, initialAuth: false, pointer: 'touch' }),
        new RegExp('injected ' + failure),
      );
      assert.deepEqual(
        released,
        failure === 'context'
          ? ['browser']
          : failure === 'page'
            ? ['context', 'browser']
            : ['page', 'context', 'browser'],
      );
    } finally {
      mock.mock.restore();
    }
  }
});

test('provider startup failure closes its HTTP listener before returning', async (t) => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const evidence = fileURLToPath(new URL('../../../develop/tmp/e2e/', import.meta.url));
  const run = mkdtempSync(join(evidence, 'provider-rollback-'));
  const mock = t.mock.method(childProcess, 'execFileSync', () => {
    throw Error('injected certificate failure');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      fakeLearningProvider(run, 'browser.exe', { httpPort: port }),
      /injected certificate failure/,
    );
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', resolve);
    });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  }
});
