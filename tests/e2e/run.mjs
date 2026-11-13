import { checkBrowserLaunchPolicy } from './kit/browser-launch-policy.mjs';
import { cleanupMarkdown, cleanupRun } from './kit/cleanup.mjs';
import { waitForLogonBudget } from './kit/browser.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scenarios } from './kit/scenarios.mjs';
import { defaultBrowser, defaultEndpoint, repository, stopTree, until } from './kit/stack.mjs';
import { parseViewport } from './kit/viewer.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    group: { type: 'string', multiple: true },
    payload: { type: 'string' },
    'package-root': { type: 'string' },
    browser: { type: 'string', multiple: true },
    pointer: { type: 'string', multiple: true },
    viewport: { type: 'string', multiple: true },
    dpr: { type: 'string' },
    jobs: { type: 'string', default: '2' },
    out: { type: 'string' },
    port: { type: 'string', default: '35000' },
    'browser-build': { type: 'string', default: 'rel' },
    control: { type: 'string', default: 'source' },
    release: { type: 'string' },
    endpoint: { type: 'string' },
    verify1: { type: 'boolean' },
    'keep-profiles': { type: 'boolean' },
    list: { type: 'boolean' },
    timeout: { type: 'string', default: '1200000' },
  },
});
const jobs = Number(values.jobs),
  basePort = Number(values.port),
  timeout = Number(values.timeout);
if (!Number.isInteger(jobs) || jobs < 1 || !Number.isInteger(basePort) || basePort < 1024 || !(timeout > 0))
  throw Error('Invalid jobs, port or timeout');
if (!['rel', 'dev'].includes(values['browser-build']) || !['source', 'release'].includes(values.control))
  throw Error('Invalid browser-build or control');
if (values.control === 'release' && !values.release)
  throw Error('--release is required with --control release');
for (const browser of values.browser ?? [])
  if (!['edge', 'chrome89'].includes(browser)) throw Error('Expected browser edge|chrome89');
for (const pointer of values.pointer ?? [])
  if (!['mouse', 'touch'].includes(pointer)) throw Error('Expected pointer mouse|touch');
for (const viewport of values.viewport ?? []) parseViewport(viewport);
const names = positionals.flatMap((value) => value.split(','));
for (const name of names)
  if (!scenarios.some((entry) => entry.name === name)) throw Error('Unknown scenario: ' + name);
for (const group of values.group ?? [])
  if (!['all', 'shell', 'input', 'files', 'cluster'].includes(group)) throw Error('Unknown group: ' + group);
const selected = scenarios.filter(
  (entry) =>
    (!names.length || names.includes(entry.name)) &&
    (!values.group || values.group.includes('all') || values.group.includes(entry.group)),
);
if (values.list) {
  console.table(
    selected.map(({ name, group, pointer, serial, chrome89 }) => ({
      name,
      group,
      pointer,
      serial,
      chrome89,
    })),
  );
  process.exit(0);
}
checkBrowserLaunchPolicy();

const out = resolve(values.out ?? join(repository, 'develop/tmp/e2e', `run-${Date.now()}`));
mkdirSync(out, { recursive: true });
const playwright =
  process.env.REMOTEKIT_PLAYWRIGHT ??
  join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const endpoint = resolve(values.endpoint ?? defaultEndpoint);
const embedder =
  values['browser-build'] === 'dev' ? 'C:/src/chromium/src/out/dev/remotekit_browser.exe' : defaultBrowser;
const queue = [];
for (const scenario of selected) {
  const browsers = values.browser ?? (values.verify1 && scenario.chrome89 ? ['edge', 'chrome89'] : ['edge']);
  for (const browser of browsers)
    for (const pointer of values.pointer ?? [
      values.verify1 && scenario.name === 'workspace-ui' ? 'touch' : scenario.pointer,
    ])
      for (const viewport of values.viewport ?? ['default'])
        queue.push({ scenario, browser, pointer, viewport });
}
const results = [];
const active = new Set();
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true;
    for (const child of active) stopTree(child);
  });
function summary() {
  writeFileSync(join(out, 'summary.json'), JSON.stringify(results, null, 2));
  const table = [
    '| Scenario | Browser | Pointer | Viewport | Result | Evidence |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (r) => `| ${r.scenario} | ${r.browser} | ${r.pointer} | ${r.viewport} | ${r.status} | ${r.evidence} |`,
    ),
  ];
  writeFileSync(join(out, 'summary.md'), table.join('\n') + '\n' + cleanupMarkdown(results));
}
async function run(item, slot) {
  const failedLogonsBefore = await waitForLogonBudget();
  if (interrupted) return;
  const { scenario, browser, pointer, viewport } = item;
  const port = basePort + slot * 20;
  if (port + 19 > 65535) throw Error('Port allocation exceeds 65535');
  const evidence = join(out, `${scenario.name.replaceAll('/', '-')}-${browser}-${pointer}-${viewport}`);
  mkdirSync(evidence, { recursive: true });
  const viewer =
    browser === 'chrome89'
      ? 'C:/src/tmp/chrome89-google/app/chrome.exe'
      : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const file = join(repository, 'tests/e2e', scenario.name + (scenario.kind === 'package' ? '.py' : '.mjs'));
  if (scenario.kind === 'package' && !values.payload && !values['package-root']) {
    results.push({
      scenario: scenario.name,
      browser,
      pointer,
      viewport,
      status: 'BLOCKED',
      failedLogonsBefore,
      reason: 'Requires --payload or --package-root',
      evidence,
    });
    summary();
    console.log('BLOCKED package: requires --payload or --package-root');
    return;
  }
  let args = [];
  switch (scenario.kind) {
    case 'driver':
    case 'standard':
      args = ['--browser', browser, '--pointer', pointer, '--out', evidence, '--port', String(port)];
      if (scenario.name === 'test-native-gestures')
        args = [
          '--browser',
          browser,
          '--out',
          evidence,
          '--port',
          String(port),
          '--peer-port',
          String(port + 9),
        ];
      break;
    case 'positional':
      args = [playwright, viewer, endpoint, embedder, evidence, String(port)];
      break;
    case 'local':
      args = [browser, '', evidence];
      break;
    case 'learning':
      args = [embedder];
      break;
    case 'cluster':
      args = [browser, pointer, String(port), evidence];
      break;
    case 'output-port':
      args = [evidence, String(port)];
      break;
    case 'package':
      args = [
        ...(values.payload
          ? ['--payload', resolve(values.payload)]
          : ['--root', resolve(values['package-root'] ?? '.')]),
        '--work-dir',
        evidence,
      ];
      break;
    case 'output':
      args = [evidence];
      break;
    case 'node':
      args = [endpoint, embedder, evidence, String(port)];
      break;
  }
  const env = {
    ...process.env,
    REMOTEKIT_PLAYWRIGHT: playwright,
    REMOTEKIT_BROWSER: embedder,
    REMOTEKIT_ENDPOINT: endpoint,
    E2E_RUN: evidence,
    E2E_CLEANUP_ID: randomUUID(),
    E2E_KEEP_PROFILES: values['keep-profiles'] ? '1' : '0',
    E2E_PORT: String(port),
    E2E_BROWSER: browser,
    E2E_POINTER: pointer,
    E2E_VIEWER: viewer,
    E2E_BROWSER_BUILD: values['browser-build'],
    E2E_CONTROL: values.control,
    E2E_RELEASE: values.release ?? '',
    REMOTEKIT_E2E_PORT: String(port),
  };
  if (viewport !== 'default') env.E2E_VIEWPORT = viewport;
  if (values.dpr) env.E2E_DPR = values.dpr;
  console.log(`START ${scenario.name} ${browser} ${pointer} ${evidence} failedLogons=${failedLogonsBefore}`);
  const log = createWriteStream(join(evidence, 'scenario.log'));
  const executable =
    scenario.kind === 'package'
      ? execFileSync('C:/src/depot_tools/python3.bat', ['-c', '"import sys; print(sys.executable)"'], {
          shell: true,
          windowsHide: true,
          encoding: 'utf8',
        }).trim()
      : process.execPath;
  const child = spawn(executable, [file, ...args], {
    cwd: repository,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  active.add(child);
  let driverFailure;
  const driverJourney =
    scenario.kind === 'driver'
      ? (async () => {
          try {
            const origin = 'http://127.0.0.1:' + port;
            await until(async () => (await fetch(origin + '/tabs')).ok, 'driver ready', 90000);
            const shot = await fetch(origin + '/shot?name=runner-smoke');
            if (!shot.ok) throw Error(await shot.text());
            await fetch(origin + '/quit');
          } catch (error) {
            driverFailure = String(error);
            stopTree(child);
          }
        })()
      : undefined;
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopTree(child);
  }, timeout);
  const code = await new Promise((done) => {
    child.once('error', (error) => {
      log.write(String(error));
      done(-1);
    });
    child.once('exit', done);
  });
  await driverJourney;
  clearTimeout(timer);
  active.delete(child);
  stopTree(child);
  await new Promise((done) => log.end(done));
  const result = {
    scenario: scenario.name,
    browser,
    pointer,
    viewport,
    status: timedOut ? 'TIMEOUT' : code === 0 && !driverFailure ? 'PASS' : 'FAIL',
    ...(driverFailure ? { reason: driverFailure } : {}),
    code,
    failedLogonsBefore,
    endpoint,
    embedder,
    evidence,
    cleanup: await cleanupRun(evidence, { keepProfiles: values['keep-profiles'] ?? false }),
  };
  writeFileSync(join(evidence, 'scenario-summary.json'), JSON.stringify(result, null, 2));
  results.push(result);
  summary();
  console.log(`END ${scenario.name} ${browser} ${pointer} ${result.status}`);
}
// Global-resource journeys get the entire runner; independent stacks use disjoint ports and roots.
let pending = [];
async function flush() {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, pending.length) }, (_, slot) =>
      (async () => {
        while (index < pending.length && !interrupted) await run(pending[index++], slot);
      })(),
    ),
  );
  pending = [];
}
for (const item of queue) {
  if (interrupted) break;
  if (item.scenario.serial) {
    await flush();
    await run(item, 0);
  } else pending.push(item);
}
await flush();
console.table(
  results.map(({ scenario, browser, pointer, viewport, status, evidence }) => ({
    scenario,
    browser,
    pointer,
    viewport,
    status,
    evidence,
  })),
);
console.log('Summary: ' + join(out, 'summary.md'));
if (interrupted || results.some((result) => result.status !== 'PASS')) process.exitCode = 1;
