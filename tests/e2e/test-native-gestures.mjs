import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { until } from './kit/stack.mjs';

const { values } = parseArgs({
  options: {
    browser: { type: 'string', default: 'edge' },
    out: { type: 'string' },
    port: { type: 'string', default: '34180' },
    'peer-port': { type: 'string', default: '34189' },
  },
});
if (!values.out || !['edge', 'chrome89'].includes(values.browser))
  throw Error('Expected --out and --browser edge|chrome89');
const run = resolve(values.out);
await mkdir(run, { recursive: true });
const log = await import('node:fs').then(({ createWriteStream }) =>
  createWriteStream(join(run, 'server.log')),
);
const server = spawn(
  process.execPath,
  ['--import', './control/node_modules/tsx/dist/loader.mjs', 'tests/e2e/client-gesture-qa-server.mts', run],
  {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLIENT_GESTURE_QA_READY: '1',
      CLIENT_GESTURE_QA_GPU_GRANTED: '1',
      CLIENT_GESTURE_QA_ENDPOINT: resolve('build/endpoint/endpoint/endpoint_service.exe'),
      CLIENT_GESTURE_QA_BROWSER: 'C:/src/chromium/src/out/rel/remotekit_browser.exe',
      CLIENT_GESTURE_QA_CLIENT_DIR: resolve('control/dist/client'),
      CLIENT_GESTURE_QA_PORT: values.port,
      CLIENT_GESTURE_QA_PEER_PORT: values['peer-port'],
    },
  },
);
server.stdout.pipe(log);
server.stderr.pipe(log);
const { chromium } = createRequire(import.meta.url)(
  process.env.REMOTEKIT_PLAYWRIGHT ??
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
);
const viewerExe =
  values.browser === 'edge'
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    : 'C:/src/tmp/chrome89-google/app/chrome.exe';
const host = {
  context: () => ({
    browser: () => ({
      browserType: () => ({
        launchPersistentContext: (profile, options) =>
          chromium.launchPersistentContext(profile, {
            ...options,
            executablePath: viewerExe,
          }),
      }),
    }),
  }),
};
const results = [];
try {
  await until(
    async () =>
      server.exitCode === null && (await fetch(`http://127.0.0.1:${values.port}/api/auth/setup`)).ok,
    'native gesture server',
    90000,
  );
  for (const name of [
    'robust-viewer-qa-browser.js',
    'client-gesture-qa-browser.js',
    'client-gesture-retirement-qa-browser.js',
  ]) {
    const source = (await readFile(new URL(name, import.meta.url), 'utf8')).trim().replace(/;$/, '');
    await new Function(`return (${source})`)()(host);
  }
  const qa = host._clientGestureQA;
  await qa.launch({
    ready: true,
    gpuGranted: true,
    version: values.browser === 'chrome89' ? 89 : 157,
    port: Number(values.port),
    run,
    password: 'native-gesture-fixture-password',
  });
  const journeys = [
    ...[
      'tap',
      'root-scroll',
      'nested',
      'action-pan-x',
      'action-pan-y',
      'action-none',
      'action-pinch-zoom',
      'off-axis-pan-x',
      'off-axis-pan-y',
      'prevent-start',
      'prevent-firstmove',
      'pinch',
      'pinch-none',
      'pinch-only',
      'second-finger-none',
      'oopif',
    ].map((name) => [name, () => qa.functionalCases({ only: [name] })]),
    ...['invalidationCases', 'lifecycleCases'].map((name) => [name, () => qa[name]()]),
    ...Object.entries(host._retirementQA),
  ];
  for (const [name, journey] of journeys) {
    try {
      results.push({ name, result: await journey() });
      console.log('Verified', name);
    } catch (error) {
      results.push({ name, error: error.stack });
      process.exitCode = 1;
      console.log('Failed', name, error.message);
      await qa.base.page.screenshot({ path: join(run, name + '-failure.png') }).catch(() => {});
    }
    await writeFile(join(run, 'results.json'), JSON.stringify(results, null, 2));
  }
} catch (error) {
  const page = host._robustViewerQA?.page;
  if (page) {
    await page.screenshot({ path: join(run, 'failure.png') }).catch(() => {});
    await writeFile(
      join(run, 'failure.json'),
      JSON.stringify(
        await page.evaluate(() => ({
          text: document.body.innerText,
          html: document.querySelector('#root')?.innerHTML,
          state: window.robustQA?.state,
        })),
        null,
        2,
      ),
    ).catch(() => {});
  }
  throw error;
} finally {
  await host._clientGestureQA?.close();
  if (server.exitCode === null)
    execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  log.end();
}
