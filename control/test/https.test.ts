import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { Store } from '../server/store';
import { Control } from '../server/control';
import { createHttp } from '../server/http';
test('optional HTTPS serves trusted local test TLS, secure cookies and configured LAN bind', async context => {
  const openssl = process.env.REMOTEKIT_TEST_OPENSSL ?? (existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  const scratch = resolve(process.cwd(), '../develop/tmp'); await mkdir(scratch, { recursive: true }); const directory = await mkdtemp(resolve(scratch, 'control-tls-'));
  const keyPath = resolve(directory, 'test-key.pem'), certPath = resolve(directory, 'test-cert.pem');
  try { await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { windowsHide: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { context.skip('OpenSSL unavailable for ephemeral test certificate'); return; } throw error; }
  const store = new Store(':memory:'), control = new Control(store, { request: async () => ({ views: [] }) }), origins: string[] = [];
  const cert = await readFile(certPath), server = createHttp(control, { origins, clientDir: resolve(process.cwd(), 'dist/client'), metricsDir: directory, tls: { key: await readFile(keyPath), cert } });
  server.listen(0, '0.0.0.0'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error(); assert.equal(address.address, '0.0.0.0');
  const origin = `https://127.0.0.1:${address.port}`; origins.push(origin);
  try {
    const result = await new Promise<{ status: number; cookie: string; body: string }>((resolve, reject) => { request(origin + '/api/state', { ca: cert }, response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, cookie: response.headers['set-cookie']![0], body })); }).on('error', reject).end(); });
    assert.equal(result.status, 200); assert.match(result.cookie, /HttpOnly/); assert.match(result.cookie, /SameSite=Strict/); assert.match(result.cookie, /; Secure/); assert.ok(JSON.parse(result.body).tenantId);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.db.close(); }
});
