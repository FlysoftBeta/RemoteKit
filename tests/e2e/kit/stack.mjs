import { createControlConfig } from '../../config-fixture.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createSocketServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { stageRuntime } from '../../integration/stage-runtime.mjs';
import { startFixture } from './fixtures.mjs';
import { fakeLearningProvider } from './learning-provider.mjs';
import { cleanupRun, registerCleanup, trackCleanupProcess, trackNodeData } from './cleanup.mjs';

export const repository = fileURLToPath(new URL('../../../', import.meta.url));
const root = repository;
export const requireControl = createRequire(join(root, 'control/package.json'));
export const defaultBrowser =
  process.env.REMOTEKIT_BROWSER ?? 'C:/src/chromium/src/out/rel/remotekit_browser.exe';
export const defaultEndpoint =
  process.env.REMOTEKIT_ENDPOINT ?? join(root, 'build/endpoint/endpoint/endpoint_service.exe');
export const pause = (ms) => new Promise((done) => setTimeout(done, ms));
export const runPath = (name) =>
  resolve(process.env.E2E_RUN ?? join(root, 'develop/tmp/e2e', `${name}-${Date.now()}`));

export async function until(check, label, timeout = 45000) {
  const end = Date.now() + timeout;
  let failure;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      failure = error;
    }
    await pause(150);
  }
  throw Error(`Timeout: ${label}${failure ? ` (${failure.message})` : ''}`);
}

async function unusedPort() {
  const socket = createSocketServer();
  await new Promise((done, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', done);
  });
  const port = socket.address().port;
  await promisify(socket.close.bind(socket))();
  return port;
}

export function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {}
  } else child.kill('SIGTERM');
}

export async function seedUser(database, username, password) {
  execFileSync(
    process.execPath,
    [
      '--import',
      './control/node_modules/tsx/dist/loader.mjs',
      '--input-type=module',
      '-e',
      `
    import { ControlDatabase } from './control/server/persistence/database.ts';
    import { registerUser } from './control/test/server-fixture.ts';
    const store = new ControlDatabase(process.env.E2E_DATABASE, { buildId: 'dev' });
    try { await registerUser(store, process.env.E2E_USERNAME, process.env.E2E_PASSWORD); }
    finally { store.db.close(); }
  `,
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, E2E_DATABASE: database, E2E_USERNAME: username, E2E_PASSWORD: password },
    },
  );
}

export async function stageControlRelease(runtime) {
  const control = join(runtime, 'control');
  mkdirSync(join(control, 'dist'), { recursive: true });
  for (const [source, target] of [
    ['control/node_modules', 'node_modules'],
    ['control/dist/client', 'dist/client'],
  ]) {
    const destination = join(control, target);
    if (!existsSync(destination)) symlinkSync(join(root, source), destination, 'junction');
  }
  const server = join(control, 'dist/server.mjs');
  await requireControl('esbuild').build({
    entryPoints: [join(root, 'tests/e2e/kit/control.mts')],
    outfile: server,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  return server;
}

export async function startStack({
  scenario = 'stack',
  run = runPath(scenario),
  browser = defaultBrowser,
  browserBuild = process.env.E2E_BROWSER_BUILD ?? 'rel',
  endpoint = defaultEndpoint,
  control = process.env.E2E_CONTROL ?? 'source',
  release = process.env.E2E_RELEASE,
  dev = true,
  media = {},
  port: basePort = process.env.E2E_PORT,
  ports: requested = {},
  nodes: nodeOptions = 1,
  nodeLimits = {},
  viewerOrigin,
  seed = true,
  fixtures = { kind: 'workspace' },
  learning = false,
  configOverrides = {},
  env = {},
  deployment,
} = {}) {
  run = resolve(run);
  mkdirSync(run, { recursive: true });
  registerCleanup(run);
  if (browser === defaultBrowser && browserBuild === 'dev')
    browser = 'C:/src/chromium/src/out/dev/remotekit_browser.exe';
  if (!['rel', 'dev'].includes(browserBuild)) throw Error('Expected browserBuild rel|dev');
  if (!['source', 'release'].includes(control)) throw Error('Expected control source|release');
  const allocated = new Set();
  const allocate = async (value) => {
    if (value === undefined) {
      do {
        value = await unusedPort();
      } while (allocated.has(value));
    }
    value = Number(value);
    if (!Number.isInteger(value) || value < 1024 || value > 65535 || allocated.has(value))
      throw Error('Invalid or duplicate port: ' + value);
    allocated.add(value);
    return value;
  };
  const base = basePort === undefined ? undefined : Number(basePort);
  const offset = (n) => (base === undefined ? undefined : base + n);
  const nodeIds =
    typeof nodeOptions === 'number'
      ? Array.from({ length: nodeOptions }, (_, i) => (nodeOptions === 1 ? 'local' : `node-${i + 1}`))
      : Array.isArray(nodeOptions)
        ? nodeOptions
        : Object.keys(nodeOptions);
  const ports = {
    control: await allocate(requested.control ?? offset(0)),
    viewer: await allocate(requested.viewer ?? offset(1)),
    fixture: await allocate(requested.fixture ?? offset(2)),
    peers: [],
  };
  for (let i = 0; i < nodeIds.length; i++)
    ports.peers.push(
      await allocate(requested.peers?.[i] ?? (i === 0 ? requested.peer : undefined) ?? offset(3 + i)),
    );
  ports.peer = ports.peers[0];
  // LibreOffice's profile files exceed its Windows path limit under descriptive evidence paths.
  const runtimeRoot = join(root, 'develop/tmp/e2e', `.stack-${randomUUID().slice(0, 8)}`);
  mkdirSync(dirname(runtimeRoot), { recursive: true });
  symlinkSync(run, runtimeRoot, 'junction');
  const sourceViewer = control === 'source' && dev;
  const origin = viewerOrigin ?? `http://127.0.0.1:${sourceViewer ? ports.viewer : ports.control}`;
  const children = [];
  const servers = [];
  const logs = {
    control: join(run, 'control.log'),
    vite: join(run, 'vite.log'),
    endpoint: join(
      run,
      nodeIds.length === 1 && nodeIds[0] === 'local' ? 'node' : `${nodeIds[0]}/root`,
      'logs/endpoint.log',
    ),
    nodes: Object.fromEntries(
      nodeIds.map((id) => [id, join(run, id === 'local' ? 'node' : `${id}/root`, 'logs/endpoint.log')]),
    ),
    diagnostics: join(run, 'diagnostics'),
    events: join(run, 'logs/control.jsonl'),
    pids: join(run, 'pids.jsonl'),
    browser: () =>
      Object.values(logs.nodes).flatMap((log) => {
        const directory = join(dirname(log), 'browser');
        return existsSync(directory)
          ? readdirSync(directory)
              .filter((name) => name.endsWith('.log'))
              .map((name) => join(directory, name))
          : [];
      }),
  };
  function record(child, log) {
    writeFileSync(log, '');
    children.push(child);
    trackCleanupProcess(run, child);
    appendFileSync(join(run, 'pids.jsonl'), JSON.stringify({ pid: child.pid, log }) + '\n');
    for (const stream of ['stdout', 'stderr'])
      child[stream]?.on('data', (chunk) => appendFileSync(log, chunk));
    child.on('error', (error) => appendFileSync(log, String(error)));
    return child;
  }
  let provider;
  let stopped = false;
  const onExit = () => {
    children.toReversed().forEach(stopTree);
    unlinkSync(runtimeRoot);
  };
  process.once('exit', onExit);
  async function stop() {
    if (stopped) return;
    stopped = true;
    process.removeListener('exit', onExit);
    for (const child of children.toReversed()) {
      if (child.connected) child.disconnect();
      if (child.exitCode === null) {
        await Promise.race([new Promise((done) => child.once('exit', done)), pause(8000)]);
        stopTree(child);
        if (child.exitCode === null)
          await Promise.race([new Promise((done) => child.once('exit', done)), pause(10000)]);
      }
    }
    for (const server of servers) {
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
    }
    await provider?.close();
    unlinkSync(runtimeRoot);
  }
  try {
    if (learning) {
      ports.learningHttp = await allocate(requested.learningHttp);
      ports.learningTls = await allocate(requested.learningTls);
      provider = await fakeLearningProvider(run, browser, {
        ...(typeof learning === 'object' ? learning : {}),
        httpPort: ports.learningHttp,
        tlsPort: ports.learningTls,
      });
      browser = provider.launcher;
      env = { ...env, ...provider.env };
    }
    const configNodes = {};
    let executable;
    for (const [i, id] of nodeIds.entries()) {
      const options = typeof nodeOptions === 'object' && !Array.isArray(nodeOptions) ? nodeOptions[id] : {};
      if (!options.remote && !executable)
        executable = stageProductRuntime(endpoint, browser, join(runtimeRoot, 'runtime/bin'));
      configNodes[id] = {
        limits: { diskReserveBytes: 2 * 1024 ** 3, ...nodeLimits, ...options.limits },
        ...(options.remote
          ? { remote: options.remote }
          : { local: { executable, root: join(runtimeRoot, id === 'local' ? 'node' : `${id}/root`) } }),
        peer: { listen: `127.0.0.1:${ports.peers[i]}`, address: `127.0.0.1:${ports.peers[i]}` },
      };
    }
    const configPath = join(run, 'control.json');
    let config = {
      http: { listen: `127.0.0.1:${ports.control}`, origins: [origin, `http://127.0.0.1:${ports.control}`] },
      storage: { database: join(run, 'control.db'), diagnostics: logs.diagnostics, logs: join(run, 'logs') },
      media,
      nodes: configNodes,
    };
    for (const [key, value] of Object.entries(configOverrides))
      config[key] = value && typeof value === 'object' ? { ...config[key], ...value } : value;
    config = createControlConfig(config);
    for (const node of Object.values(config.nodes)) {
      if (node.local) {
        const nodeRoot = node.local.root.startsWith(runtimeRoot)
          ? join(run, relative(runtimeRoot, node.local.root))
          : node.local.root;
        trackNodeData(run, nodeRoot);
      }
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const server =
      control === 'release'
        ? join(resolve(release), 'control/dist/server.mjs')
        : join(root, 'tests/e2e/kit/control.mts');
    const child = record(
      spawn(
        deployment ? join(deployment, 'remotekit_control.exe') : process.execPath,
        deployment
          ? ['run', '--root=' + deployment]
          : control === 'release'
            ? [server]
            : [
                '--import',
                pathToFileURL(join(root, 'control/node_modules/tsx/dist/loader.mjs')).href,
                server,
              ],
        {
          cwd: root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, ...env, REMOTEKIT_CONTROL_CONFIG: configPath },
        },
      ),
      logs.control,
    );
    const pending = new Map();
    const events = [];
    child.on('message', (message) => {
      if (message.event) {
        events.push(message);
        appendFileSync(join(run, 'control-events.jsonl'), JSON.stringify(message) + '\n');
      }
      pending.get(message.id)?.(message);
    });
    const call = async (method, params = {}, timeout = 60000) =>
      new Promise((done, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('Control timeout: ' + method));
        }, timeout);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          message.error ? reject(Error(message.error)) : done(message.result);
        });
        child.send({ id, method, ...params });
      });
    if (sourceViewer)
      record(
        spawn(
          process.execPath,
          [join(root, 'tests/e2e/kit/vite.mjs'), String(ports.viewer), join(run, 'vite-cache')],
          {
            cwd: join(root, 'control'),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, REMOTEKIT_VITE_CONTROL: `http://127.0.0.1:${ports.control}` },
          },
        ),
        logs.vite,
      );
    await Promise.race([
      new Promise((_, reject) =>
        child.once('exit', (code) => reject(Error('Control exited ' + code + ': ' + logs.control))),
      ),
      until(async () => {
        if (child.exitCode !== null) throw Error('Control exited ' + child.exitCode + ': ' + logs.control);
        return (
          await fetch(`http://127.0.0.1:${ports.control}/api/auth/setup`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      }, 'Control ready'),
    ]);
    await until(async () => (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok, 'Viewer ready');
    if (fixtures)
      servers.push(await startFixture(fixtures.kind, ports.fixture, { ...fixtures.context, run, call }));
    const username = `e2e-${Date.now()}`;
    const password = 'workspace-e2e-password';
    if (seed) await seedUser(join(run, 'control.db'), username, password);
    return {
      run,
      nodes: configNodes,
      ports,
      logs,
      origin,
      fixture: `http://127.0.0.1:${ports.fixture}`,
      username,
      password,
      provider,
      control: { child, events, call },
      call,
      advance: (ms) => call('advance', { ms }),
      readLog: (name) => readFileSync(logs[name], 'utf8'),
      async startRemote(id, nodeRoot = join(run, id, 'root')) {
        trackNodeData(run, nodeRoot);
        nodeRoot = join(runtimeRoot, relative(run, nodeRoot));
        await until(() => existsSync(join(run, 'nodes', id, 'node.json')), 'remote bootstrap');
        mkdirSync(nodeRoot, { recursive: true });
        copyFileSync(join(run, 'nodes', id, 'node.json'), join(nodeRoot, 'node.json'));
        const binary = stageProductRuntime(endpoint, browser, join(runtimeRoot, 'runtime/bin'));
        return record(
          spawn(binary, ['--node-root=' + nodeRoot], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
          join(run, id + '-endpoint.log'),
        );
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function stageProductRuntime(endpoint, browser, destination) {
  const executable = stageRuntime(endpoint, browser, destination);
  const browserTarget = join(destination, 'remotekit_browser.exe');
  if (!existsSync(browserTarget)) linkSync(resolve(browser), browserTarget);
  const snapshot = join(dirname(resolve(endpoint)), 'remotekit_snapshot.exe');
  const snapshotTarget = join(destination, 'remotekit_snapshot.exe');
  if (existsSync(snapshot) && !existsSync(snapshotTarget)) linkSync(snapshot, snapshotTarget);
  for (const name of ['face-models', 'models', 'documents']) {
    const source = join(dirname(resolve(endpoint)), name);
    const target = join(destination, name);
    if (existsSync(source) && !existsSync(target)) symlinkSync(source, target, 'junction');
  }
  return executable;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(process.env.E2E_STACK_OPTIONS ?? '{}');
  const stack = await startStack(options);
  console.log(
    JSON.stringify({
      origin: stack.origin,
      run: stack.run,
      ports: stack.ports,
      username: stack.username,
      password: stack.password,
    }),
  );
  const close = async () => {
    await stack.stop();
    await cleanupRun(stack.run);
    process.exit();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdin.resume();
  process.stdin.once('end', close);
}
