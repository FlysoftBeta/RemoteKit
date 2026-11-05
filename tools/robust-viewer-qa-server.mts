// Isolated ordinary Viewer fixture. Start only after root grants artifact/GPU readiness.
// Explicit artifact paths prevent accidentally testing a previously published package.
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { Store } from '../control/server/store.ts';
import { Control } from '../control/server/control.ts';
import { EndpointProcess } from '../control/server/endpoint.ts';
import { EndpointNode } from '../control/server/endpoint-node.ts';
import { createHttp } from '../control/server/http.ts';
const root = resolve('.'),
  run = resolve(process.argv[2] ?? `develop/tmp/robust-viewer-qa-${Date.now()}`);
function required(name: string) {
  const value = process.env[name];
  if (!value) throw Error(`${name} must name this batch's artifact`);
  return resolve(value);
}
const executable = required('ROBUST_QA_ENDPOINT'),
  browser = required('ROBUST_QA_BROWSER'),
  clientDir = required('ROBUST_QA_CLIENT_DIR');
if (process.env.ROBUST_QA_GPU_GRANTED !== '1') throw Error('Root GPU grant is required');
const artifactPaths = [executable, browser, join(clientDir, 'index.html')];
const artifacts = await Promise.all(
  artifactPaths.map(async (path) => ({
    path,
    mtime: (await stat(path)).mtime.toISOString(),
    bytes: (await stat(path)).size,
  })),
);
const port = Number(process.env.ROBUST_QA_PORT ?? 33471),
  fixturePort = port + 1;
await mkdir(run, { recursive: true });
const events: any[] = [];
const fixtures = await readFile(join(root, 'tools/robust-viewer-qa-page.html'));
const nodeMode = process.env.ROBUST_QA_ENDPOINT_MODE === 'node',
  nodeToken = randomUUID() + randomUUID(),
  nodeId = 'robust-qa';
let native: ChildProcess | undefined;
const store = new Store(join(run, 'control.db')),
  endpointNode = nodeMode ? new EndpointNode({ nodeId, token: nodeToken }) : undefined;
const endpoint =
    endpointNode ??
    new EndpointProcess(executable, [`--browser=${browser}`, `--data-path=${join(run, 'endpoint')}`]),
  control = new Control(store, endpoint);
const server = createHttp(control, {
  origins: [`http://127.0.0.1:${port}`],
  clientDir,
  metricsDir: join(run, 'metrics'),
  diagnostics: false,
  endpointNode,
});
endpoint.on('ready', (identity) => void control.endpointReady(identity));
const fixture = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${fixturePort}`);
    if (url.pathname === '/shutdown') {
      res.end('stopping');
      setTimeout(() => void close(), 100);
      return;
    }
    // Test hook touches only this fixture's own configured node management socket.
    if (url.pathname === '/management-disconnect' && req.method === 'POST') {
      if (!endpointNode) {
        res.writeHead(409).end('node mode required');
        return;
      }
      (endpointNode as any).current?.socket.terminate();
      res.end('management socket terminated');
      return;
    }
    if (url.pathname === '/inspect') {
      const users = store.db.prepare('SELECT username,tenant FROM users').all() as {
        username: string;
        tenant: string;
      }[];
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          events,
          users: await Promise.all(
            users.map(async (user) => ({
              username: user.username,
              state: control.productState(user.tenant),
              snapshot: await endpoint
                .request('session.snapshot', user.tenant, { outputDiagnostics: true })
                .catch((error) => ({ error: String(error) })),
            })),
          ),
        }),
      );
      return;
    }
    if (url.pathname === '/event' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 128 * 1024) {
          res.writeHead(413).end();
          return;
        }
      }
      events.push(JSON.parse(body));
      if (events.length > 2048) events.shift();
      await writeFile(join(run, 'fixture-events.json'), JSON.stringify(events, null, 2));
      res.end('ok');
      return;
    }
    if (url.pathname === '/slow') {
      events.push({ type: 'slow-request', label: url.searchParams.get('label'), at: Date.now() });
      const timer = setTimeout(
        () => {
          if (!res.destroyed) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(fixtures);
          }
        },
        Math.min(5000, Math.max(1, Number(url.searchParams.get('ms')) || 5000)),
      );
      res.on('close', () => clearTimeout(timer));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fixtures);
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
let closing = false;
const timer = setInterval(() => void control.tick(), 1500);
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await server.shutdown();
  await control.close();
  if (native) {
    await endpoint.request('shutdown', '').catch(() => {});
    if (native.exitCode === null) {
      await Promise.race([
        new Promise<void>((r) => native!.once('exit', () => r())),
        new Promise<void>((r) => setTimeout(r, 3000)),
      ]);
      if (native.exitCode === null) native.kill();
    }
  }
  await endpoint.stop();
  await new Promise<void>((r) => fixture.close(() => r()));
  store.db.close();
  process.exitCode = 0;
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
await new Promise<void>((r) => fixture.listen(fixturePort, '127.0.0.1', r));
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
endpoint.start();
if (endpointNode) {
  native = spawn(
    executable,
    [
      `--browser=${browser}`,
      `--data-path=${join(run, 'endpoint')}`,
      `--control-url=http://127.0.0.1:${port}/api/endpoint`,
      `--node-id=${nodeId}`,
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, REMOTEKIT_ENDPOINT_TOKEN: nodeToken },
    },
  );
  native.stderr?.pipe(process.stderr);
  native.on('error', (error) => {
    console.error('Own Endpoint failed:', error);
    void close();
  });
}
await writeFile(
  join(run, 'service.json'),
  JSON.stringify(
    {
      pid: process.pid,
      nativePid: native?.pid,
      mode: nodeMode ? 'WinHTTP-EndpointNode' : 'stdio',
      run,
      port,
      fixturePort,
      artifacts,
      runId: randomUUID(),
      started: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(`READY ${run}`);
