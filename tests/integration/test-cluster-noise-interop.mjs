import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX = 4 * 1024 * 1024;
const hash = (data) => crypto.createHash('sha256').update(data).digest();
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function hkdf(key, input) {
  const temp = hmac(key, input);
  const out = [];
  let last = Buffer.alloc(0);
  for (let i = 1; i <= 2; ++i) {
    last = hmac(temp, Buffer.concat([last, Buffer.from([i])]));
    out.push(last);
  }
  temp.fill(0);
  return out;
}
export class Cipher {
  constructor(key) {
    this.key = key;
    this.n = 0n;
  }
  crypt(data, ad, encrypt) {
    assert(this.n < 0xffffffffffffffffn);
    assert(data.length <= MAX + (encrypt ? 0 : 16));
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.n++, 4);
    const cipher = encrypt
      ? crypto.createCipheriv('aes-256-gcm', this.key, iv)
      : crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(ad);
    if (!encrypt) {
      cipher.setAuthTag(data.subarray(-16));
      data = data.subarray(0, -16);
    }
    const out = Buffer.concat([cipher.update(data), cipher.final()]);
    return encrypt ? Buffer.concat([out, cipher.getAuthTag()]) : out;
  }
  encrypt(data, ad = Buffer.alloc(0)) {
    return this.crypt(data, ad, true);
  }
  decrypt(data, ad = Buffer.alloc(0)) {
    return this.crypt(data, ad, false);
  }
}
const privateObject = (key) =>
  crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), key]),
    format: 'der',
    type: 'pkcs8',
  });
export const publicKey = (key) =>
  crypto.createPublicKey(privateObject(key)).export({ format: 'der', type: 'spki' }).subarray(-32);
const dh = (key, remote) =>
  crypto.diffieHellman({
    privateKey: privateObject(key),
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), remote]),
      format: 'der',
      type: 'spki',
    }),
  });
export class Noise {
  constructor(
    initiator,
    key,
    responderPublicKey,
    prologue = Buffer.from('remotekit-cluster-2'),
    ephemeral = crypto.randomBytes(32),
  ) {
    this.initiator = initiator;
    this.key = key;
    this.ephemeral = ephemeral;
    this.publicKey = publicKey(ephemeral);
    this.remoteStatic = initiator ? responderPublicKey : undefined;
    if (initiator) assert.equal(responderPublicKey.length, 32);
    this.h = Buffer.alloc(32);
    this.h.write('Noise_IK_25519_AESGCM_SHA256');
    this.ck = this.h;
    this.mixHash(prologue);
    this.mixHash(initiator ? responderPublicKey : publicKey(key));
    this.step = 0;
  }
  mixHash(bytes) {
    this.h = hash(Buffer.concat([this.h, bytes]));
  }
  mixKey(bytes) {
    const [ck, key] = hkdf(this.ck, bytes);
    this.ck = ck;
    this.cipher = new Cipher(key);
  }
  encrypt(bytes) {
    const result = this.cipher.encrypt(bytes, this.h);
    this.mixHash(result);
    return result;
  }
  decrypt(bytes) {
    const result = this.cipher.decrypt(bytes, this.h);
    this.mixHash(bytes);
    return result;
  }
  write(bytes) {
    assert.equal(this.step, this.initiator ? 0 : 1);
    this.mixHash(this.publicKey);
    const parts = [this.publicKey];
    if (this.step === 0) {
      this.mixKey(dh(this.ephemeral, this.remoteStatic));
      parts.push(this.encrypt(publicKey(this.key)));
      this.mixKey(dh(this.key, this.remoteStatic));
    } else {
      this.mixKey(dh(this.ephemeral, this.remoteEphemeral));
      this.mixKey(dh(this.ephemeral, this.remoteStatic));
    }
    parts.push(this.encrypt(bytes));
    ++this.step;
    return Buffer.concat(parts);
  }
  read(bytes) {
    assert.equal(this.step, this.initiator ? 1 : 0);
    assert(bytes.length >= (this.step === 0 ? 96 : 48) && bytes.length <= 65535);
    this.remoteEphemeral = bytes.subarray(0, 32);
    this.mixHash(this.remoteEphemeral);
    let offset = 32;
    if (this.step === 0) {
      this.mixKey(dh(this.key, this.remoteEphemeral));
      this.remoteStatic = this.decrypt(bytes.subarray(32, 80));
      this.mixKey(dh(this.key, this.remoteStatic));
      offset = 80;
    } else {
      this.mixKey(dh(this.ephemeral, this.remoteEphemeral));
      this.mixKey(dh(this.key, this.remoteEphemeral));
    }
    const plain = this.decrypt(bytes.subarray(offset));
    ++this.step;
    return plain;
  }
  split() {
    assert.equal(this.step, 2);
    const [a, b] = hkdf(this.ck, Buffer.alloc(0));
    return { send: new Cipher(this.initiator ? a : b), receive: new Cipher(this.initiator ? b : a) };
  }
}
export class Queue {
  items = [];
  waiters = [];
  closed = false;
  push(item) {
    if (this.waiters.length) this.waiters.shift().resolve(item);
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(Error('carrier closed'));
  }
  next(timeout = 10000) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.reject(Error('carrier closed'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(Error('carrier timeout'));
      }, timeout);
      this.waiters.push(waiter);
    });
  }
}
export function socketTransport(socket) {
  const queue = new Queue();
  socket.on('message', (bytes, binary) => {
    assert(binary);
    queue.push(Buffer.from(bytes));
  });
  socket.on('close', () => queue.close());
  socket.on('error', () => queue.close());
  return { send: (bytes) => socket.send(bytes), next: (timeout) => queue.next(timeout) };
}
export function pipeTransport(child) {
  const queue = new Queue();
  let pending = Buffer.alloc(0);
  child.stdout.on('data', (bytes) => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 4) {
      const n = pending.readUInt32LE();
      assert(n <= MAX + 16);
      if (pending.length < n + 4) break;
      queue.push(pending.subarray(4, n + 4));
      pending = pending.subarray(n + 4);
    }
  });
  child.stdout.on('end', () => queue.close());
  return {
    next: (timeout) => queue.next(timeout),
    send: (bytes) => {
      const n = Buffer.alloc(4);
      n.writeUInt32LE(bytes.length);
      child.stdin.write(Buffer.concat([n, bytes]));
    },
  };
}
export function encode(json, bytes) {
  const text = Buffer.from(JSON.stringify(json));
  if (!bytes) return Buffer.concat([Buffer.from([1]), text]);
  const prefix = Buffer.alloc(5);
  prefix[0] = 2;
  prefix.writeUInt32LE(text.length, 1);
  return Buffer.concat([prefix, text, bytes]);
}
export function decode(plain) {
  if (plain[0] === 1) return { json: JSON.parse(plain.subarray(1)) };
  assert.equal(plain[0], 2);
  const n = plain.readUInt32LE(1);
  return { json: JSON.parse(plain.subarray(5, 5 + n)), bytes: plain.subarray(5 + n) };
}
export async function accept(transport, key, reply) {
  const noise = new Noise(false, key);
  const hello = JSON.parse(noise.read(await transport.next(5000)));
  if (typeof reply !== 'function') assert.deepEqual(noise.remoteStatic, publicKey(Buffer.alloc(32, 6)));
  transport.send(
    noise.write(
      Buffer.from(JSON.stringify(typeof reply === 'function' ? reply(hello, noise.remoteStatic) : reply)),
    ),
  );
  return { ...noise.split(), hello, publicKey: noise.remoteStatic };
}
async function vectorTest() {
  const {
    vectors: [v],
  } = JSON.parse(await readFile(new URL('../../protocol/cluster-noise-vectors.json', import.meta.url)));
  const unhex = (s) => Buffer.from(s, 'hex');
  const a = new Noise(
    true,
    unhex(v.init_static),
    unhex(v.init_remote_static),
    unhex(v.init_prologue),
    unhex(v.init_ephemeral),
  );
  const b = new Noise(
    false,
    unhex(v.resp_static),
    undefined,
    unhex(v.resp_prologue),
    unhex(v.resp_ephemeral),
  );
  for (let i = 0; i < 2; ++i) {
    const payload = unhex(v.messages[i].payload);
    const wire = (i ? b : a).write(payload);
    assert.equal(wire.toString('hex'), v.messages[i].ciphertext);
    assert.deepEqual((i ? a : b).read(wire), payload);
  }
  assert.equal(a.h.toString('hex'), v.handshake_hash);
  const ak = a.split(),
    bk = b.split();
  for (let i = 2; i < 6; ++i) {
    const payload = unhex(v.messages[i].payload);
    const wire = (i % 2 ? bk : ak).send.encrypt(payload);
    assert.equal(wire.toString('hex'), v.messages[i].ciphertext);
    assert.deepEqual((i % 2 ? ak : bk).receive.decrypt(wire), payload);
  }
}
async function exercise(transport, state, waitForPing = false) {
  const receive = async (timeout) => decode(state.receive.decrypt(await transport.next(timeout)));
  const send = (json, bytes) => transport.send(state.send.encrypt(encode(json, bytes)));
  assert.deepEqual((await receive()).json, { side: 'cpp' });
  send({ side: 'node' });
  send({ type: 'node.ping' });
  const header = { type: 'blob' };
  const bytes = Buffer.alloc(MAX - 5 - Buffer.byteLength(JSON.stringify(header)), 91);
  send(header, bytes);
  assert.deepEqual((await receive()).json, { type: 'node.pong' });
  assert.deepEqual((await receive()).bytes, bytes);
  assert.deepEqual((await receive()).json, { done: true });
  if (waitForPing) {
    assert.deepEqual((await receive(20000)).json, { type: 'node.ping' });
    send({ type: 'node.pong' });
  }
  send({ stop: true });
}
async function childTest(executable, mode) {
  const child = spawn(executable, [mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const transport = pipeTransport(child);
  try {
    let state;
    if (mode === 'initiator') state = await accept(transport, Buffer.alloc(32, 7), { type: 'node.ready' });
    else {
      const noise = new Noise(true, Buffer.alloc(32, 6), publicKey(Buffer.alloc(32, 7)));
      transport.send(
        noise.write(
          Buffer.from(
            JSON.stringify({
              type: 'node.hello',
              role: 'endpoint',
              nodeId: 'test-node',
              buildId: 'dev',
              incarnation: '1'.repeat(32),
            }),
          ),
        ),
      );
      assert.equal(JSON.parse(noise.read(await transport.next())).type, 'node.ready');
      state = noise.split();
    }
    await exercise(transport, state, mode === 'initiator');
    assert.equal(await exited, 0, stderr);
  } finally {
    child.kill();
  }
}
async function webSocketTest(executable) {
  const require = createRequire(new URL('../../control/package.json', import.meta.url));
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX + 16 });
  await new Promise((resolve) => server.once('listening', resolve));
  let resolveWork, rejectWork;
  const work = new Promise((resolve, reject) => {
    resolveWork = resolve;
    rejectWork = reject;
  });
  server.once('connection', (socket, request) => {
    (async () => {
      assert.equal(request.url, '/api/node');
      assert.equal(request.headers.authorization, undefined);
      const transport = socketTransport(socket);
      const state = await accept(transport, Buffer.alloc(32, 7), { type: 'node.ready' });
      assert.equal(state.hello.nodeId, 'test-node');
      await exercise(transport, state);
    })().then(resolveWork, rejectWork);
  });
  const child = spawn(executable, ['websocket', `ws://127.0.0.1:${server.address().port}/api/node`]);
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    await work;
    assert.equal(await exited, 0, stderr);
  } finally {
    child.kill();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await vectorTest();
  await childTest(process.argv[2], 'initiator');
  await childTest(process.argv[2], 'responder');
  await webSocketTest(process.argv[2]);
}
