import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { accept, decode, encode, pipeTransport } from './test-cluster-noise-interop.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const equal = arg.indexOf('=');
    if (equal < 0) throw Error('expected --name=value');
    return [arg.slice(2, equal), arg.slice(equal + 1)];
  }),
);
const endpoint = resolve(args.endpoint);
const root = resolve(args['node-root']);
const overrides = JSON.parse(args.config.startsWith('{') ? args.config : await readFile(args.config, 'utf8'));
const config = {
  encoder: 'auto',
  fps: 60,
  bitrate: 36000000,
  maxBitrate: 48000000,
  asyncDepth: null,
  gop: null,
  targetUsage: null,
  qsvLowPower: 'auto',
  bufferMs: null,
  rateControl: null,
  idleIdrMs: 150,
  maxEncodeWidth: 4096,
  maxEncodeHeight: 4096,
  dataPath: 'data',
  browser: null,
  browserTraceDir: null,
  maxSessions: 3,
  peer: { listen: '127.0.0.1:0', address: '127.0.0.1:3101' },
  rtc: { ports: null, address: null },
  diskReserveBytes: 10737418240,
  sessionMemoryBytes: 2147483648,
  ...overrides,
  nodeId: 'test',
};
const canonical = (value) =>
  value && typeof value === 'object'
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
    : value;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const configHash = sha256(JSON.stringify(canonical(config)));
let buildId = 'dev';
try {
  buildId = JSON.parse(await readFile(resolve(dirname(endpoint), '../build.json'), 'utf8')).buildId;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(root, { recursive: true });
const key = args['cluster-key'] ? Buffer.from(args['cluster-key'], 'base64') : randomBytes(32);
const child = spawn(endpoint, ['--stdio', '--node-id=test', '--node-root=' + root], {
  env: { ...process.env, REMOTEKIT_CLUSTER_KEY: key.toString('base64') },
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});
let lines;
child.once('exit', (code) => {
  lines?.close();
  process.stdin.destroy();
  process.exitCode = failed ? 1 : (code ?? 1);
});
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
  lines?.close();
  process.stdin.destroy();
});
const transport = pipeTransport(child);
const pending = new Map();
const inFlight = new Map();
const opened = new Set();
async function objectIndex() {
  if (!args['object-index']) return {};
  try {
    return JSON.parse(await readFile(args['object-index'], 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}
let drained;
let serial = 0;
let channel;
let failed = false;
function fail(error) {
  if (!failed) console.error('cluster bridge:', error.message);
  failed = true;
  child.kill();
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
  process.exitCode = 1;
  lines?.close();
  process.stdin.destroy();
}
try {
  channel = await accept(transport, key, (hello) => {
    if (
      hello.type !== 'node.hello' ||
      hello.role !== 'endpoint' ||
      hello.nodeId !== 'test' ||
      hello.buildId !== buildId ||
      !/^[0-9a-f]{32}$/.test(hello.incarnation)
    )
      throw Error('invalid endpoint hello');
    return { type: 'node.ready', connectionEpoch: randomUUID(), buildId, config, configHash, sessions: [] };
  });
  key.fill(0);
  lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (json) => transport.send(channel.send.encrypt(encode(json)));
  const received = (async () => {
    while (true) {
      const { json } = decode(channel.receive.decrypt(await transport.next(45000)));
      if (json.type === 'node.ping') {
        send({ type: 'node.pong' });
        continue;
      }
      if (json.request === 'object.committed') {
        if (args['object-index']) {
          const index = await objectIndex();
          const identity = json.tenantId + '/' + json.objectId;
          const entry = index[identity] ?? { ...json, sources: [] };
          if (entry.storedSha256 !== json.storedSha256) throw Error('conflicting stored object');
          if (!entry.sources.some((source) => source.address === config.peer.address))
            entry.sources.push({ nodeId: config.nodeId, address: config.peer.address });
          index[identity] = entry;
          await writeFile(args['object-index'], JSON.stringify(index));
        }
        send({ id: json.id, ok: true, result: { accepted: true } });
        continue;
      }
      if (json.request === 'object.locate') {
        const index = await objectIndex();
        send({
          id: json.id,
          ok: true,
          result: {
            sources: Object.fromEntries(
              json.ids.map((id) => [id, index[json.tenantId + '/' + id]?.sources ?? []]),
            ),
          },
        });
        continue;
      }
      if (json.event === 'node.metrics') {
        if (args['metrics-file']) await writeFile(args['metrics-file'], JSON.stringify(json));
        continue;
      }
      if (pending.has(json.id)) {
        const waiter = pending.get(json.id);
        pending.delete(json.id);
        if (json.ok) waiter.resolve();
        else waiter.reject(Error(JSON.stringify(json.error)));
      } else {
        const request = inFlight.get(json.id);
        if (json.ok && request?.method === 'session.open') opened.add(request.tenantId);
        if (json.ok && request?.method === 'session.hibernate') opened.delete(request.tenantId);
        process.stdout.write(JSON.stringify(json) + '\n');
        inFlight.delete(json.id);
        if (!inFlight.size) drained?.();
      }
    }
  })();
  received.catch((error) => {
    if (child.exitCode === null && child.signalCode === null && !child.stdout.readableEnded) fail(error);
    for (const waiter of pending.values()) waiter.reject(error);
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (
      request.tenantId &&
      request.method !== 'session.open' &&
      request.method !== 'shutdown' &&
      !request.method.startsWith('object.') &&
      !opened.has(request.tenantId)
    ) {
      const id = '__cluster_bridge_open_' + ++serial;
      const done = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      send({
        id,
        method: 'session.open',
        tenantId: request.tenantId,
        sessionId: sha256(request.tenantId).slice(0, 32),
        placementEpoch: 1,
        profileKey: Buffer.alloc(32, 7).toString('base64'),
        objectKey: Buffer.alloc(32, 8).toString('base64'),
        objectIdKey: Buffer.alloc(32, 9).toString('base64'),
        checkpoint: null,
      });
      await done;
      opened.add(request.tenantId);
    }
    inFlight.set(request.id, request);
    send(request);
  }
  if (inFlight.size) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('request drain timeout')), 20000);
      drained = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  child.stdin.end();
} catch (error) {
  fail(error);
} finally {
  key.fill(0);
}
