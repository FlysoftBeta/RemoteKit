import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const group = process.argv[2],
  port = process.argv[3] ?? '34220';
const root = resolve('develop/tmp/e2e-files');
mkdirSync(root, { recursive: true });
const playwright =
  process.env.REMOTEKIT_PLAYWRIGHT ??
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js',
  );
const endpoint = resolve('build/endpoint/endpoint/endpoint_service.exe');
const embedder = 'C:/src/chromium/src/out/rel/remotekit_browser.exe';
const results = [];
for (const browser of ['edge', 'chrome89'])
  for (const pointer of ['mouse', 'touch']) {
    if (process.env.FILES_ONLY && !process.env.FILES_ONLY.split(',').includes(`${browser}-${pointer}`))
      continue;
    if (process.env.FILES_SKIP === `${browser}-${pointer}`) continue;
    const viewer =
      browser === 'edge'
        ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
        : 'C:/src/tmp/chrome89-google/app/chrome.exe';
    const run = join(root, `${group}-${browser}-${pointer}-${Date.now()}`);
    let args;
    if (group === 'library' || group === 'camera')
      args = [
        `tests/e2e/test-${group === 'library' ? 'file-library' : 'camera-scan'}.mjs`,
        playwright,
        viewer,
        endpoint,
        embedder,
        run,
        port,
      ];
    else if (group === 'files-ui') args = ['tests/e2e/test-files-ui.mjs', `--device=${browser}`];
    else if (group === 'learning') args = ['tests/e2e/test-learning-server.mjs', embedder];
    else if (group === 'signin')
      args = [
        'tests/e2e/test-learning-sign-in.mjs',
        '--browser',
        browser,
        '--pointer',
        pointer,
        '--port',
        port,
      ];
    else throw Error('Unknown files scenario');
    mkdirSync(run, { recursive: true });
    console.log('START', group, browser, pointer, run);
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FILES_PORT: port,
        FILES_RUN: run,
        FILES_POINTER: pointer,
        FILES_VIEWER: viewer,
        REMOTEKIT_CAMERA_PYTHON: resolve('develop/tmp/doc-scan/exp/venv/Scripts/python.exe'),
      },
    });
    for (const stream of ['stdout', 'stderr'])
      child[stream].on('data', (b) => appendFileSync(join(run, `scenario.${stream}.log`), b));
    const code = await new Promise((done) => child.once('exit', done));
    results.push({ browser, pointer, code, run });
    writeFileSync(join(root, `${group}-matrix-${port}.json`), JSON.stringify(results, null, 2));
    console.log('END', group, browser, pointer, code);
  }
