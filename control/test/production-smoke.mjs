// Proves the bundled server runs in an isolated deployment with only native runtime dependencies.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = resolve(root, '../develop/tmp');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'control-production-')),
  deployment = resolve(scratch, 'control');
await mkdir(resolve(deployment, 'dist'), { recursive: true });
await cp(resolve(root, 'dist/server.mjs'), resolve(deployment, 'dist/server.mjs'));
await cp(resolve(root, 'dist/client'), resolve(deployment, 'dist/client'), { recursive: true });
await cp(resolve(root, 'dist/runtime/node_modules'), resolve(deployment, 'node_modules'), {
  recursive: true,
});
const configPath = resolve(scratch, 'control.json');
let imapConnections = 0;
const imap = createServer((socket) => {
  imapConnections++;
  socket.destroy();
});
imap.listen(0, '127.0.0.1');
await once(imap, 'listening');
await writeFile(
  configPath,
  JSON.stringify({
    http: { host: '127.0.0.1', port: 0, origins: ['http://production.test'] },
    database: resolve(deployment, 'data/control.db'),
    nodes: { production: {} },
    sessionImport: {
      mailbox: 'production@example.test',
      imap: { host: '127.0.0.1', port: imap.address().port, user: 'test', password: 'test' },
    },
  }),
);
const child = spawn(process.execPath, [resolve(deployment, 'dist/server.mjs')], {
  cwd: scratch,
  env: {
    ...process.env,
    REMOTEKIT_CONTROL_CONFIG: configPath,
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  windowsHide: true,
});
let output = '';
child.stderr.on('data', (data) => {
  output += data;
});
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Production startup timeout: ${output}`)), 5000);
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && Number(match[1])) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Production exited ${code}: ${output}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RemoteKit/);
  const response = await fetch(base + '/api/auth/setup', {
    method: 'POST',
    headers: { Origin: 'http://production.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'production-user', password: 'production-password123' }),
  });
  assert.equal(response.status, 200);
  const { user } = await response.json();
  assert.equal(user.isAdmin, true);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const me = await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.id, user.id);
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/socket', {
    origin: 'http://production.test',
    headers: { Cookie: cookie },
  });
  try {
    const auth = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Viewer authentication timeout')), 5000);
      socket.on('error', reject);
      socket.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (message.type === 'auth') {
          clearTimeout(timer);
          resolve(message.auth);
        }
      });
    });
    assert.equal(auth.user.id, user.id);
    assert.equal(auth.locked, false);
    let sequence = 0;
    const importState = () =>
      new Promise((resolve, reject) => {
        const id = 'import-' + ++sequence;
        const timer = setTimeout(() => {
          socket.off('message', receive);
          reject(new Error('Import state timeout'));
        }, 5000);
        const receive = (data) => {
          const message = JSON.parse(String(data));
          if (message.id !== id) return;
          clearTimeout(timer);
          socket.off('message', receive);
          if (message.type === 'error') reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        };
        socket.on('message', receive);
        socket.send(JSON.stringify({ id, method: 'sessionImport.state', params: {} }));
      });
    let state;
    for (let attempt = 0; attempt < 40; attempt++) {
      state = await importState();
      if (state.mailbox.lastErrorAt) break;
      await sleep(50);
    }
    assert.ok(imapConnections > 0, 'Bundled ImapFlow client reached the local TCP server');
    assert.equal(state.mailbox.configured, true);
    assert.ok(state.mailbox.lastErrorAt);
    assert.match(state.mailbox.lastError, /TLS|socket|closed|ECONNRESET/i);
    assert.doesNotMatch(state.mailbox.lastError, /Dynamic require|Cannot find module|not defined/);
  } finally {
    socket.terminate();
  }
  assert.ok((await stat(resolve(deployment, 'data/control.db'))).isFile());
  await writeFile(
    resolve(scratch, 'result.json'),
    JSON.stringify({ passed: true, node: process.version, deployment, runtimeOnly: true }, null, 2),
  );
  console.log(`Production startup smoke passed: ${scratch}`);
} finally {
  const exited = once(child, 'exit');
  if (child.connected) child.disconnect();
  const kill = setTimeout(() => child.kill(), 4000);
  await exited;
  clearTimeout(kill);
  await new Promise((resolve) => imap.close(resolve));
}
