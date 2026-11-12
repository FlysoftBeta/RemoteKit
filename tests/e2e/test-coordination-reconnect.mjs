import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, createServer as createProxy } from 'node:net';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { stageRuntime } from '../integration/stage-runtime.mjs';
import {
  buildHarness,
  instrumentViewer,
  pause,
  requireControl,
  startControl,
  until,
} from './cluster-test-support.mjs';

const [modulePath, edge, endpoint, browser, output, portArg = '33951'] = process.argv.slice(2);
assert([modulePath, edge, endpoint, browser, output].every(Boolean));
const run = resolve(output),
  port = Number(portArg),
  origin = 'http://127.0.0.1:' + port;
await mkdir(run);
let management = true,
  closePage = false,
  childLoads = 0,
  geometry;
const sockets = new Set();
const proxy = createProxy((socket) => {
  if (!management) {
    socket.destroy();
    return;
  }
  const upstream = connect(port, '127.0.0.1');
  sockets.add(socket);
  sockets.add(upstream);
  for (const peer of [socket, upstream]) {
    peer.on('error', () => {});
    peer.on('close', () => {
      sockets.delete(peer);
      socket.destroy();
      upstream.destroy();
    });
  }
  socket.pipe(upstream);
  upstream.pipe(socket);
});
await new Promise((done) => proxy.listen(port + 2, '127.0.0.1', done));
const fixture = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/close') {
    response.end(JSON.stringify(closePage));
    return;
  }
  if (request.method === 'POST') {
    let text = '';
    for await (const bytes of request) text += bytes;
    geometry = JSON.parse(text);
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/child') {
    childLoads++;
    response.end(
      '<title>Self closing child</title><script>setInterval(async()=>{if(await(await fetch("/close")).json()) window.close()},100)</script>',
    );
    return;
  }
  response.end(
    '<title>Parent</title><button style="position:fixed;inset:0;width:100vw;height:100vh" onclick="window.open(\'/child\')">Open child</button><canvas width="24" height="24"></canvas><script>const report=()=>fetch("/geometry",{method:"POST",body:JSON.stringify({width:innerWidth,height:innerHeight})});report();addEventListener("resize",report);let tick=0;setInterval(()=>{const c=document.querySelector("canvas").getContext("2d");c.fillStyle=++tick%2?"red":"blue";c.fillRect(0,0,24,24)},100)</script>',
  );
});
await new Promise((done) => fixture.listen(port + 1, '127.0.0.1', done));
const server = await buildHarness(join(run, 'runtime'));
const configPath = join(run, 'control.json'),
  nodeRoot = join(run, 'node');
await mkdir(nodeRoot);
await writeFile(
  configPath,
  JSON.stringify({
    http: { listen: '127.0.0.1:' + port, origins: [origin] },
    storage: { database: join(run, 'control.db') },
    nodes: {
      alpha: {
        remote: { control: 'ws://127.0.0.1:' + (port + 2) + '/api/node' },
        peer: { listen: '127.0.0.1:' + (port + 3), address: '127.0.0.1:' + (port + 3) },
      },
    },
  }),
);
const control = startControl(server, configPath, run);
let native, viewers, context;
try {
  await until('remote bootstrap', async () =>
    readFile(join(run, 'nodes/alpha/node.json')).catch(() => false),
  );
  await copyFile(join(run, 'nodes/alpha/node.json'), join(nodeRoot, 'node.json'));
  const executable = stageRuntime(endpoint, browser, join(run, 'bin'));
  native = spawn(executable, ['--node-root=' + nodeRoot], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  for (const stream of ['stdout', 'stderr'])
    native[stream].on('data', (bytes) => void appendFile(join(run, 'endpoint.' + stream + '.log'), bytes));
  await until('remote node ready', () =>
    Promise.resolve(control.events.some((event) => event.event === 'node.ready')),
  );
  const { chromium } = createRequire(import.meta.url)(resolve(modulePath));
  viewers = await chromium.launch({
    executablePath: edge,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  context = await viewers.newContext({ viewport: { width: 1100, height: 800 } });
  const password = randomUUID();
  const setup = await context.request.post(origin + '/api/auth/setup', {
    headers: { Origin: origin },
    data: { username: 'coordination', password },
  });
  assert.equal(setup.status(), 200, await setup.text());
  const viewer = await instrumentViewer(context, run, 'viewer');
  await viewer.page.goto(origin);
  await viewer.ready();
  await viewer.call('auth.settings', {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  await viewer.action({
    type: 'window.open',
    appId: 'browser',
    placement: { mode: 'space' },
    url: 'http://127.0.0.1:' + (port + 1) + '/parent',
  });
  await viewer.media();
  await until('parent geometry', () => geometry);
  const viewport = viewer.page.locator('.remote-viewport').first();
  await viewer.page.waitForFunction(() => {
    const viewport = document.querySelector('.remote-viewport');
    const tab = clusterQA.state?.workspace.tabs[0];
    return (
      clusterQA.layout?.views.some((view) => view.id === tab?.webviewId && !view.stale) &&
      viewport?.querySelector('video')?.videoWidth > 0 &&
      !viewport.classList.contains('resize-waiting') &&
      !viewport.querySelector('canvas[data-video-input]')?.classList.contains('no-frame')
    );
  });
  const box = await viewport.boundingBox();
  await viewer.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const child = await until('adopted child tab', async () =>
    (await viewer.state()).workspace.tabs.find(
      (tab) => tab.url.endsWith('/child') && tab.popup?.status === 'adopted',
    ),
  );
  const before = await control.call('inspect');
  const placement = before.placements[0],
    actual = before.observations[placement.tenant],
    loads = childLoads;
  management = false;
  for (const socket of sockets) socket.destroy();
  await until('management disconnected', () =>
    Promise.resolve(control.events.some((event) => event.event === 'node.offline')),
  );
  closePage = true;
  const Database = requireControl('better-sqlite3');
  await until('durable disconnected close', () => {
    const db = new Database(join(nodeRoot, 'data/sessions', placement.session_id, 'session.db'), {
      readonly: true,
    });
    try {
      return db
        .prepare("SELECT body FROM events WHERE type='view.closed'")
        .all()
        .some(
          (row) =>
            JSON.parse(row.body).body?.viewId === child.webviewId ||
            JSON.parse(row.body).viewId === child.webviewId,
        );
    } finally {
      db.close();
    }
  });
  management = true;
  await until(
    'node reconnected',
    () => Promise.resolve(control.events.filter((event) => event.event === 'node.ready').length >= 2),
    60000,
  );
  await viewer.call('auth.verify', { method: 'password', secret: password });
  await until(
    'product removed closed tab',
    async () => !(await viewer.state()).workspace.tabs.some((tab) => tab.id === child.id),
    60000,
  );
  await pause(1500);
  const after = await control.call('inspect'),
    observed = after.observations[placement.tenant];
  assert.equal(native.exitCode, null);
  assert.equal(observed.browserIncarnation, actual.browserIncarnation);
  assert.equal(observed.browserPid, actual.browserPid);
  assert.equal(
    observed.views.some((view) => view.viewId === child.webviewId),
    false,
  );
  assert.equal(childLoads, loads);
  await writeFile(join(run, 'result.json'), JSON.stringify({ before, after, child, childLoads }, null, 2));
  console.log('Disconnected self-close persisted, removed the tab, and did not recreate its page: ' + run);
} finally {
  management = false;
  for (const socket of sockets) socket.destroy();
  await context?.close();
  await viewers?.close();
  if (native && native.exitCode === null) {
    native.stdin.end();
    await new Promise((done) => native.once('exit', done));
  }
  await control.stop();
  await new Promise((done) => proxy.close(done));
  await new Promise((done) => fixture.close(done));
}
