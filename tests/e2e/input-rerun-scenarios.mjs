import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('develop/tmp/e2e-input');
const pw =
  process.env.REMOTEKIT_PLAYWRIGHT ??
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js',
  );
const endpoint = resolve('build/endpoint/endpoint/endpoint_service.exe');
const remote = 'C:/src/chromium/src/out/rel/remotekit_browser.exe';
const cases = process.argv.slice(2);
const results = existsSync(join(root, 'isolated-results.json'))
  ? JSON.parse(readFileSync(join(root, 'isolated-results.json'), 'utf8'))
  : [];
for (const value of cases) {
  const [scenario, engine] = value.split(':');
  const viewer =
    engine === 'edge'
      ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
      : 'C:/src/tmp/chrome89-google/app/chrome.exe';
  const name = `${scenario}-${engine}-isolated-${Date.now()}`;
  const log = createWriteStream(join(root, name + '.log'));
  const child = spawn(
    process.execPath,
    [
      `tests/e2e/test-${scenario}.mjs`,
      pw,
      viewer,
      endpoint,
      remote,
      join(root, name),
      scenario.startsWith('keyboard') ? '34110' : '34120',
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, E2E_INPUT_PORT: '34111' },
    },
  );
  console.log('START', name, child.pid);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise((done) => child.on('exit', done));
  results.push({ name, code });
  console.log('END', name, code);
  writeFileSync(join(root, 'isolated-results.json'), JSON.stringify(results, null, 2));
}
