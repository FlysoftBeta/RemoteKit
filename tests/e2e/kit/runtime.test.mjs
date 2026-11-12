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
