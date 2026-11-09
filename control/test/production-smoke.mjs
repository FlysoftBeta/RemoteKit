// Proves the bundled server runs in an isolated deployment with only native runtime dependencies.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import Sqlite from 'better-sqlite3';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert(
  !(await readFile(resolve(root, 'dist/server.mjs'), 'utf8')).includes('REMOTEKIT_TEST_LEARNING_ENDPOINTS'),
);
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
let smtpConnections = 0;
const smtp = createServer((socket) => {
  smtpConnections++;
  socket.destroy();
});
smtp.listen(465, '127.0.0.1');
await once(smtp, 'listening');
imap.listen(0, '127.0.0.1');
await once(imap, 'listening');
await writeFile(
  configPath,
  JSON.stringify({
    http: { listen: '127.0.0.1:0', origins: ['http://production.test'] },
    storage: { database: resolve(deployment, 'data/control.db') },
    cluster: { controlUrl: 'ws://127.0.0.1:1/api/node' },
    nodes: { production: {} },
    sessionImport: {
      mailbox: 'production@example.test',
      appMailbox: 'app@example.test',
      smtp: { host: '127.0.0.1', port: 465, user: 'test', password: 'test' },
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
  const seed = new Sqlite(resolve(deployment, 'data/control.db'));
  const tenant = seed.prepare('SELECT tenant FROM users WHERE id=?').get(user.id).tenant;
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      Buffer.from(Array.from({ length: 32 }, (_, i) => i + 33)),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const event = { seq: 1, at: Date.now() - 600000, type: 'paired', ref: 1, username: 'production-user' };
  seed.transaction(() => {
    seed
      .prepare('INSERT INTO session_import_devices VALUES (?,?,?,?,?,1,1,0,NULL)')
      .run(keyId, tenant, publicKey, 'Production smoke', event.at);
    seed
      .prepare("INSERT INTO session_import_events VALUES (?,?,'out',?,?,?,?,?,NULL)")
      .run(tenant, keyId, 1, event.at, 'paired', 1, JSON.stringify(event));
  })();
  seed.close();
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
    const request = (method = 'admin.overview', params = {}) =>
      new Promise((resolve, reject) => {
        const id = 'overview-' + ++sequence;
        const timer = setTimeout(() => {
          socket.off('message', receive);
          reject(new Error('Mailbox status timeout'));
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
        socket.send(JSON.stringify({ id, method, params }));
      });
    const pairing = await request('sessionImport.pairing', { open: true });
    assert.equal(pairing.code.length, 5);
    assert.ok(pairing.code.every((word) => /^[a-z]+$/.test(word)));
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = (await request()).sessionImport;
      if (state.lastErrorAt && state.outbox.lastErrorAt) break;
      await sleep(250);
    }
    assert.ok(imapConnections > 0, 'Bundled ImapFlow client reached the local TCP server');
    assert.equal(state.configured, true);
    assert.ok(state.lastErrorAt);
    assert.equal(state.errorCode, 'unavailable');
    assert.doesNotMatch(state.lastError, /Dynamic require|Cannot find module|not defined/);
    assert.ok(smtpConnections > 0, 'Bundled nodemailer reached the local TCP server');
    assert.equal(state.outbox.pending, 1);
    assert.ok(state.outbox.lastErrorAt);
    assert.equal(state.outbox.errorCode, 'outcome_unknown');
    assert.doesNotMatch(state.outbox.lastError, /Dynamic require|Cannot find module|not defined/);
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
  await Promise.all([
    new Promise((resolve) => imap.close(resolve)),
    new Promise((resolve) => smtp.close(resolve)),
  ]);
}
