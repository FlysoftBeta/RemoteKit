import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('develop/tmp/e2e-input');
mkdirSync(root, { recursive: true });
const pw =
  process.env.REMOTEKIT_PLAYWRIGHT ??
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js',
  );
const endpoint = resolve('build/endpoint/endpoint/endpoint_service.exe');
const remote = 'C:/src/chromium/src/out/rel/remotekit_browser.exe';
const engines = {
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  chrome89: 'C:/src/tmp/chrome89-google/app/chrome.exe',
};
const results = [];
async function run(name, args, env = {}) {
  console.log('START', name);
  const log = createWriteStream(join(root, name + '.log'));
  const child = spawn(process.execPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  writeFileSync(
    join(root, 'matrix-active.json'),
    JSON.stringify({ runner: process.pid, child: child.pid, name }),
  );
  const code = await new Promise((done) => child.once('exit', done));
  results.push({ name, code });
  writeFileSync(join(root, 'matrix-results.json'), JSON.stringify(results, null, 2));
  console.log('END', name, code);
}
for (const [engine, viewer] of Object.entries(engines)) {
  for (const scenario of [
    'mobile-ime',
    'keyboard-viewport',
    'keyboard-recovery',
    'touch-selection',
    'clipboard',
  ]) {
    const name = `${scenario}-${engine}-matrix`;
    await run(
      name,
      [
        `tests/e2e/test-${scenario}.mjs`,
        pw,
        viewer,
        endpoint,
        remote,
        join(root, name),
        scenario.startsWith('keyboard') ? '34110' : '34120',
      ],
      { E2E_INPUT_PORT: '34111' },
    );
  }
}
const vite = spawn(process.execPath, ['tests/e2e/kit/vite.mjs', '34180', join(root, 'local-vite-cache')], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = createWriteStream(join(root, 'local-vite.log'));
vite.stdout.pipe(log);
vite.stderr.pipe(log);
try {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch('http://127.0.0.1:34180')
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await new Promise((done) => setTimeout(done, 200));
  }
  for (const engine of Object.keys(engines))
    await run(`local-selection-${engine}-matrix`, [
      'tests/e2e/test-local-selection.mjs',
      engine,
      'http://127.0.0.1:34180',
      join(root, `local-selection-${engine}-matrix`),
    ]);
} finally {
  vite.kill();
}
