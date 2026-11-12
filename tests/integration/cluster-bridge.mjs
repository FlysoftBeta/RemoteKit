import { stageRuntime } from './stage-runtime.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { accept, decode, encode, pipeTransport, publicKey } from './test-cluster-noise-interop.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const equal = arg.indexOf('=');
    if (equal < 0) throw Error('expected --name=value');
    return [arg.slice(2, equal), arg.slice(equal + 1)];
  }),
);
const endpoint = stageRuntime(
  resolve(args.endpoint),
  resolve(args.browser),
  resolve(args['node-root'], 'runtime/bin'),
);
const root = resolve(args['node-root']);
const overrides = JSON.parse(args.config.startsWith('{') ? args.config : await readFile(args.config, 'utf8'));
const nodeId = 'test-' + createHash('sha256').update(root).digest('hex').slice(0, 16);
const config = {
  nodeId,
  peer: overrides.peer ?? { listen: '127.0.0.1:0', address: '127.0.0.1:3101' },
  rtc: overrides.rtc ?? { ports: null, address: null },
  media: {
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
    ...overrides.media,
  },
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
const configHash = sha256(JSON.stringify(canonical({ peer: config.peer, rtc: config.rtc })));
let buildId = 'dev';
try {
  buildId = JSON.parse(await readFile(resolve(dirname(endpoint), '../build.json'), 'utf8')).buildId;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(root, { recursive: true });
let key;
if (args['control-private-key']) key = Buffer.from(args['control-private-key'], 'base64');
else {
  const file = resolve(root, 'control.key');
  try {
    key = Buffer.from(JSON.parse(await readFile(file, 'utf8')).privateKey, 'base64');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = randomBytes(32);
    await writeFile(file, JSON.stringify({ version: 1, privateKey: key.toString('base64') }) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
}
let identity;
try {
  identity = JSON.parse(await readFile(resolve(root, 'node.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  identity = {
    version: 1,
    nodeId,
    privateKey: randomBytes(32).toString('base64'),
    controlPublicKey: publicKey(key).toString('base64'),
  };
  await writeFile(resolve(root, 'node.json'), JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
}
const peerRegistry = args['object-index'] ? args['object-index'] + '.peers.json' : undefined;
async function readPeers() {
  if (!peerRegistry) return [];
  try {
    return JSON.parse(await readFile(peerRegistry, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
if (peerRegistry) {
  const peers = (await readPeers()).filter((peer) => peer.nodeId !== nodeId);
  peers.push({
    nodeId,
    address: config.peer.address,
    publicKey: publicKey(Buffer.from(identity.privateKey, 'base64')).toString('base64'),
  });
  await writeFile(peerRegistry, JSON.stringify(peers));
}
const child = spawn(endpoint, ['--stdio', '--node-root=' + root], {
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
await writeFile(resolve(root, 'endpoint.pid'), String(child.pid));
let placements = [];
try {
  placements = JSON.parse(await readFile(resolve(root, 'bridge-sessions.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const pending = new Map();
const inFlight = new Map();
const reverse = new Map();
const results = new Map();
const observations = new Map();
const connectionEpoch = randomUUID();
let endpointIncarnation;
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
  const initialPeers = (await readPeers()).filter((peer) => peer.nodeId !== nodeId);
  channel = await accept(transport, key, (hello, remoteKey) => {
    if (!remoteKey.equals(publicKey(Buffer.from(identity.privateKey, 'base64'))))
      throw Error('node identity mismatch');
    if (
      hello.type !== 'node.hello' ||
      hello.role !== 'endpoint' ||
      hello.nodeId !== nodeId ||
      hello.buildId !== buildId ||
      !/^[0-9a-f]{32}$/.test(hello.incarnation)
    )
      throw Error('invalid endpoint hello');
    endpointIncarnation = hello.incarnation;
    return {
      type: 'node.ready',
      peers: initialPeers,
      connectionEpoch,
      buildId,
      config,
      configHash,
      objectKey: Buffer.alloc(32, 8).toString('base64'),
      objectIdKey: Buffer.alloc(32, 9).toString('base64'),
    };
  });
  key.fill(0);
  lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (json) => {
    const request = reverse.get(json.id);
    if (request && typeof json.ok === 'boolean') {
      json.opId = request.opId;
      results.set(request.opId, { fingerprint: request.fingerprint, reply: json });
      while (results.size > 1024) results.delete(results.keys().next().value);
      reverse.delete(json.id);
    }
    return transport.send(channel.send.encrypt(encode(json)));
  };
  let peerSet = JSON.stringify(initialPeers);
  let pollingPeers = false;
  const peerTimer = setInterval(async () => {
    if (pollingPeers) return;
    pollingPeers = true;
    try {
      const peers = (await readPeers()).filter((peer) => peer.nodeId !== nodeId);
      const next = JSON.stringify(peers);
      if (next !== peerSet) {
        send({ type: 'node.peers', peers });
        peerSet = next;
      }
    } catch (error) {
      fail(error);
    } finally {
      pollingPeers = false;
    }
  }, 100);
  peerTimer.unref();
  child.once('exit', () => clearInterval(peerTimer));
  const received = (async () => {
    while (true) {
      let { json } = decode(channel.receive.decrypt(await transport.next(45000)));
      if (json.request) {
        if (
          !json.params ||
          typeof json.opId !== 'string' ||
          typeof json.replay !== 'boolean' ||
          json.endpointIncarnation !== endpointIncarnation
        )
          throw Error('invalid Endpoint RPC envelope');
        const { id, replay, ...body } = json;
        const fingerprint = JSON.stringify(canonical(body));
        const previous = results.get(json.opId);
        reverse.set(id, { opId: json.opId, fingerprint });
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            send({ id, ok: false, error: { code: 'conflict', message: 'opId payload conflicts' } });
          else send({ ...previous.reply, id });
          continue;
        }
        if (replay) {
          send({ id, ok: false, error: { code: 'outcome_unknown', message: 'RPC result is not retained' } });
          continue;
        }
        json = { ...json.params, id, request: json.request, tenantId: json.tenantId, opId: json.opId };
      }
      if (json.type === 'node.ping') {
        send({ type: 'node.pong' });
        continue;
      }
      if (json.request === 'object.committed.batch') {
        if (args['object-index']) {
          const index = await objectIndex();
          for (const object of json.objects) {
            const identity = json.tenantId + '/' + object.objectId;
            const entry = index[identity] ?? { ...object, tenantId: json.tenantId, sources: [] };
            if (entry.storedSha256 !== object.storedSha256) throw Error('conflicting stored object');
            if (!entry.sources.some((source) => source.address === config.peer.address))
              entry.sources.push({ nodeId: config.nodeId, address: config.peer.address });
            index[identity] = entry;
            if (!json.tenantId)
              for (const known of Object.values(index))
                if (
                  known.objectId === object.objectId &&
                  !known.sources.some((source) => source.nodeId === config.nodeId)
                )
                  known.sources.push({ nodeId: config.nodeId, address: config.peer.address });
          }
          await writeFile(args['object-index'], JSON.stringify(index));
        }
        send({ id: json.id, ok: true, result: { ok: true } });
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
      if (json.request === 'object.claims.refresh') {
        send({ id: json.id, ok: true, result: { ok: true } });
        continue;
      }
      if (json.event === 'session.observed') {
        observations.set(json.tenantId, json);
        process.stdout.write(JSON.stringify(json) + '\n');
        continue;
      }
      if (json.event === 'session.event') {
        process.stdout.write(JSON.stringify(json) + '\n');
        continue;
      }
      if (json.event === 'node.metrics') {
        if (args['metrics-file']) await writeFile(args['metrics-file'], JSON.stringify(json));
        continue;
      }
      if (pending.has(json.id)) {
        const waiter = pending.get(json.id);
        pending.delete(json.id);
        if (json.ok) waiter.resolve(json.result);
        else waiter.reject(Error(JSON.stringify(json.error)));
      } else {
        const request = inFlight.get(json.id);
        if (json.ok && request?.method === 'node.desired') {
          placements = request.sessions;
          await writeFile(resolve(root, 'bridge-sessions.json'), JSON.stringify(placements));
        }
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
  const fenceId = '__initial_fence';
  const fenced = new Promise((resolve, reject) => pending.set(fenceId, { resolve, reject }));
  send({ id: fenceId, method: 'node.desired', connectionEpoch, revision: '1', sessions: placements });
  await fenced;
  process.stdout.write(
    JSON.stringify({ event: 'test.ready', connectionEpoch, endpointIncarnation, placements }) + '\n',
  );
  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === 'test.observe') {
      const value = observations.get(request.tenantId);
      process.stdout.write(
        JSON.stringify({
          id: request.id,
          ok: !!value,
          ...(value ? { result: value } : { error: { code: 'not_found', message: 'Session not observed' } }),
        }) + '\n',
      );
      continue;
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
