// Proves the bundled server runs outside the source tree with only native runtime dependencies.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = tmpdir();
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'control-production-')),
  deployment = resolve(scratch, 'control');
await mkdir(resolve(deployment, 'dist'), { recursive: true });
await cp(resolve(root, 'dist/server.mjs'), resolve(deployment, 'dist/server.mjs'));
await cp(resolve(root, 'dist/client'), resolve(deployment, 'dist/client'), { recursive: true });
await cp(resolve(root, 'dist/runtime/node_modules'), resolve(deployment, 'node_modules'), {
  recursive: true,
});
await cp(resolve(root, 'test/stdio-fixture.mjs'), resolve(scratch, 'endpoint-fixture.mjs'));
const child = spawn(process.execPath, [resolve(deployment, 'dist/server.mjs')], {
  cwd: scratch,
  env: {
    ...process.env,
    PORT: '0',
    REMOTEKIT_CONTROL_HOST: '127.0.0.1',
    REMOTEKIT_HTTPS_KEY: '',
    REMOTEKIT_HTTPS_CERT: '',
    REMOTEKIT_CONTROL_DB: resolve(deployment, 'data/control.db'),
    REMOTEKIT_ENDPOINT: process.execPath,
    REMOTEKIT_ENDPOINT_ARGS: JSON.stringify([resolve(scratch, 'endpoint-fixture.mjs')]),
    REMOTEKIT_CONTROL_ORIGINS: 'http://production.test',
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
  const response = await fetch(base + '/api/auth/register', {
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
}
