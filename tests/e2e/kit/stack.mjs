import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export const defaultBrowser = 'C:/src/chromium/src/out/rel/remotekit_browser.exe';
export const defaultEndpoint = join(root, 'build/endpoint/endpoint/endpoint_service.exe');

export async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let failure;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      failure = error;
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`Timeout: ${label}${failure ? ` (${failure.message})` : ''}`);
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

function stopTree(child) {
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
  const script = `
    import { ControlDatabase } from './control/server/persistence/database.ts';
    import { registerUser } from './control/test/server-fixture.ts';
    const store = new ControlDatabase(process.env.E2E_DATABASE);
    try { await registerUser(store, process.env.E2E_USERNAME, process.env.E2E_PASSWORD); }
    finally { store.db.close(); }
  `;
  execFileSync(
    process.execPath,
    ['--import', './control/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e', script],
    {
      cwd: root,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, E2E_DATABASE: database, E2E_USERNAME: username, E2E_PASSWORD: password },
    },
  );
}

export async function startStack({
  scenario,
  browser = defaultBrowser,
  endpoint = defaultEndpoint,
  dev = true,
  nodeDefaults = {},
  run = join(root, 'develop/tmp/e2e', `${scenario}-${Date.now()}`),
} = {}) {
  mkdirSync(run, { recursive: true });
  const allocated = new Set();
  async function port() {
    let value;
    do value = await unusedPort();
    while (allocated.has(value));
    allocated.add(value);
    return value;
  }
  const ports = { control: await port(), viewer: await port(), fixture: await port(), peer: await port() };
  const origin = `http://127.0.0.1:${dev ? ports.viewer : ports.control}`;
  const logs = {
    control: join(run, 'control.log'),
    vite: join(run, 'vite.log'),
    endpoint: join(run, 'node/logs/endpoint.log'),
    browser: () => {
      const sessions = join(run, 'endpoint/sessions');
      return readdirSync(sessions, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(sessions, entry.name, 'browser.log'));
    },
  };
  const fixture = await startFixture(ports.fixture, run);
  const children = [];
  function record(child, log) {
    children.push(child);
    child.stdout.on('data', (chunk) => appendFileSync(log, chunk));
    child.stderr.on('data', (chunk) => appendFileSync(log, chunk));
    child.on('error', (error) => appendFileSync(log, String(error)));
    return child;
  }
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    process.removeListener('exit', stopOnExit);
    for (const child of children.toReversed()) stopTree(child);
    fixture.closeAllConnections();
    await promisify(fixture.close.bind(fixture))();
  };
  const stopOnExit = () => children.forEach(stopTree);
  process.once('exit', stopOnExit);
  try {
    record(
      startProductStack({
        run,
        port: ports.control,
        endpoint,
        browser,
        dev,
        nodeDefaults: {
          ...nodeDefaults,
          peer: { listen: `127.0.0.1:${ports.peer}`, address: `127.0.0.1:${ports.peer}` },
        },
        configOverrides: {
          http: {
            listen: `127.0.0.1:${ports.control}`,
            origins: [origin, `http://127.0.0.1:${ports.control}`],
          },
        },
      }),
      logs.control,
    );
    if (dev)
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
    await until(
      async () =>
        (await fetch(`${origin}/api/auth/status`, { signal: AbortSignal.timeout(1000) })).status < 500,
      'Control ready',
    );
    await until(async () => (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok, 'Viewer ready');
    const username = `e2e-${Date.now()}`;
    const password = 'workspace-e2e-password';
    await seedUser(join(run, 'control.db'), username, password);
    return {
      run,
      ports,
      logs,
      origin,
      fixture: `http://127.0.0.1:${ports.fixture}`,
      username,
      password,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startFixture(port, run) {
  const icon = readFileSync(new URL('./fixture-icon.png', import.meta.url));
  const events = [];
  const fixture = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/icon.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(icon);
    if (path === '/manifest.json')
      return res.writeHead(200, { 'Content-Type': 'application/manifest+json' }).end(
        JSON.stringify({
          name: 'Workspace Notes',
          short_name: 'Notes',
          start_url: '/notes/',
          scope: '/notes/',
          display: 'standalone',
          theme_color: '#2660b5',
          icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }],
        }),
      );
    if (path === '/events')
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(events));
    if (path === '/event') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const event = JSON.parse(body);
      events.push(event);
      appendFileSync(join(run, 'fixture-events.jsonl'), JSON.stringify(event) + '\n');
      return res.end('ok');
    }
    const label =
      path === '/fs/'
        ? 'File System regression'
        : path.startsWith('/flow/')
          ? path.split('/').pop()
          : 'Workspace Notes';
    const filesystem =
      path === '/fs/'
        ? `<script>
      const report = (api, status, error) => fetch('/event', {method:'POST',body:JSON.stringify({api,status,error})});
      (async () => {
        try {
          const directory = await navigator.storage.getDirectory();
          const handle = await directory.getFileHandle('regression.txt', {create:true});
          const writer = await handle.createWritable();
          await writer.write('RemoteKit File System regression');
          await writer.close();
          await report('getDirectory', 'ok');
        } catch (error) { await report('getDirectory', 'error', String(error)); }
      })();
      if (window.webkitRequestFileSystem) window.webkitRequestFileSystem(TEMPORARY, 1024 * 1024, fs => {
        fs.root.getFile('legacy.txt', {create:true}, entry => entry.createWriter(writer => {
          writer.onwriteend = () => report('webkitRequestFileSystem','ok');
          writer.onerror = error => report('webkitRequestFileSystem','error',String(error));
          writer.write(new Blob(['RemoteKit legacy File System regression']));
        }), error => report('webkitRequestFileSystem','error',String(error)));
      }, error => report('webkitRequestFileSystem','error',String(error)));
      else report('webkitRequestFileSystem','unavailable');
    </script>`
        : '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      `<!doctype html>
        <html lang="en">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>${label}</title>
          <link rel="manifest" href="/manifest.json">
          <link rel="icon" href="/icon.png">
          <style>
            body { margin: 0; padding: 32px; font: 18px system-ui; background: #edf3fb; color: #234567; }
            h1 { font-size: 32px; }
            a, button, input { display: block; margin: 18px 0; }
            button { padding: 10px 18px; }
            textarea { width: 90%; height: 96px; font: 18px system-ui; }
          </style>
          <h1>${label}</h1>
          <p>A real remote page inside RemoteKit.</p>
          <textarea placeholder="Write a note"></textarea>
          <a href="/outside">Outside scope</a>
          <button onclick="window.open('/notes/popup','notes-popup','width=500,height=500')">Open popup</button>
          <a target="_blank" href="/notes/new-tab">Open browser tab</a>
          <input id="upload" type="file" multiple>
          <nav>
            <a href="/flow/A">A</a>
            <a href="/flow/B">B</a>
            <a href="/flow/C">C</a>
            <a href="/flow/D">D</a>
          </nav>
          <script>
            const note = document.querySelector('textarea');
            note.addEventListener('input', () => fetch('/event', {
              method: 'POST',
              body: JSON.stringify({ path: location.pathname, type: 'note', value: note.value }),
            }));
            document.querySelector('#upload').onchange = async event => fetch('/event', {
              method: 'POST',
              body: JSON.stringify({ files: await Promise.all([...event.target.files].map(async file => ({
                name: file.name,
                text: await file.text(),
              }))) }),
            });
            fetch('/event', {
              method: 'POST',
              body: JSON.stringify({ path: location.pathname, width: innerWidth, height: innerHeight }),
            });
          </script>
          ${filesystem}
        </html>`,
    );
  });
  await new Promise((done, reject) => {
    fixture.once('error', reject);
    fixture.listen(port, '127.0.0.1', done);
  });
  return fixture;
}

export function startProductStack({
  run,
  port,
  endpoint,
  browser = defaultBrowser,
  dev = false,
  server = join(root, 'control/dist/server.mjs'),
  nodeDefaults = {},
  configOverrides = {},
}) {
  mkdirSync(run, { recursive: true });
  const configPath = join(run, 'control.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      http: { listen: `127.0.0.1:${port}`, origins: [`http://127.0.0.1:${port}`] },
      storage: { database: join(run, 'control.db'), diagnostics: join(run, 'diagnostics') },
      nodeDefaults: {
        browser: resolve(browser),
        dataPath: join(run, 'endpoint'),
        peer: { listen: `127.0.0.1:${port + 2}`, address: `127.0.0.1:${port + 2}` },
        ...nodeDefaults,
      },
      nodes: { local: { local: { executable: resolve(endpoint), root: join(run, 'node') } } },
      ...configOverrides,
    }),
  );
  return spawn(
    process.execPath,
    dev
      ? ['--import', './control/node_modules/tsx/dist/loader.mjs', join(root, 'control/server/main.ts')]
      : [server],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        REMOTEKIT_CONTROL_CONFIG: configPath,
      },
    },
  );
}
