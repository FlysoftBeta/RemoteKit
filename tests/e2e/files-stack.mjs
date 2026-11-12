// Files-group isolation: source Control, fixed ports, and private run directories.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, existsSync, linkSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startProductStack as product, seedUser, until as wait } from './kit/stack.mjs';
export { seedUser } from './kit/stack.mjs';
export const until = (check, label, timeout = 90000) => wait(check, label, timeout);
const root = resolve('.');
export const basePort = Number(process.env.FILES_PORT ?? 34200);
export const runPath = (name) => resolve('develop/tmp/e2e-files', `${name}-${Date.now()}`);
export function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {}
}
export function startProductStack(options) {
  const { port, run } = options;
  if (port < 34200 || port + 9 > 34299) throw Error('Files port outside assigned range');
  mkdirSync(run, { recursive: true });
  const child = product({
    ...options,
    port: port + 3,
    dev: true,
    peer: { listen: `127.0.0.1:${port + 2}`, address: `127.0.0.1:${port + 2}` },
    configOverrides: {
      http: {
        listen: `127.0.0.1:${port + 3}`,
        origins: [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port + 3}`],
      },
      ...options.configOverrides,
    },
  });
  const stagedBrowser = join(run, 'runtime/bin/remotekit_browser.exe');
  if (!existsSync(stagedBrowser)) linkSync(resolve(options.browser), stagedBrowser);
  for (const name of ['documents', 'models', 'face-models']) {
    const source = resolve('build/endpoint/endpoint', name),
      target = join(run, 'runtime/bin', name);
    if (existsSync(source) && !existsSync(target)) symlinkSync(source, target, 'junction');
  }
  const vite = spawn(
    process.execPath,
    [join(root, 'tests/e2e/kit/vite.mjs'), String(port), join(run, 'vite-cache')],
    {
      cwd: join(root, 'control'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, REMOTEKIT_VITE_CONTROL: `http://127.0.0.1:${port + 3}` },
    },
  );
  for (const stream of ['stdout', 'stderr'])
    vite[stream].on('data', (b) => appendFileSync(join(run, 'vite.log'), b));
  writeFileSync(join(run, 'started-pids.json'), JSON.stringify({ control: child.pid, vite: vite.pid }));
  child.once('exit', () => stopTree(vite));
  child.filesStop = () => {
    stopTree(vite);
    stopTree(child);
  };
  process.once('exit', child.filesStop);
  return child;
}
export async function startStack({
  scenario,
  browser = 'C:/src/chromium/src/out/rel/remotekit_browser.exe',
  run = runPath(scenario),
  ...options
} = {}) {
  run = resolve(run);
  const port = Number(process.env.FILES_PORT ?? basePort);
  const child = startProductStack({
    ...options,
    run,
    port,
    browser,
    endpoint: resolve('build/endpoint/endpoint/endpoint_service.exe'),
  });
  for (const stream of ['stdout', 'stderr'])
    child[stream].on('data', (b) => appendFileSync(join(run, 'control.log'), b));
  const origin = `http://127.0.0.1:${port}`;
  try {
    await until(
      async () => (await fetch(origin + '/api/auth/setup', { signal: AbortSignal.timeout(2000) })).ok,
      'source Control ready',
    );
    await until(async () => (await fetch(origin)).ok, 'source Viewer ready');
    const username = `files-${Date.now()}`,
      password = 'workspace-e2e-password';
    await seedUser(join(run, 'control.db'), username, password);
    return {
      run,
      origin,
      username,
      password,
      ports: { control: port + 3, viewer: port, fixture: port + 1, peer: port + 2 },
      logs: { control: join(run, 'control.log'), endpoint: join(run, 'node/logs/endpoint.log') },
      stop: async () => child.filesStop(),
    };
  } catch (error) {
    child.filesStop();
    throw error;
  }
}
