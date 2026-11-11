import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { accept, encode, decode, socketTransport } from './test-cluster-noise-interop.mjs';

const [harness, dummy, updater, replacementProbe] = process.argv.slice(2);
const require = createRequire(new URL('../../control/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const repository = fileURLToPath(new URL('../../', import.meta.url));
const scratch = path.join(repository, 'develop/tmp');
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(path.join(scratch, 'node-updater-'));
const key = Buffer.alloc(32, 7);
const ids = ['a'.repeat(64), 'b'.repeat(64)];
const archives = new Map();
const children = new Set();
let failed;
let phase = 'update';
let bInterrupted = false;
const offsets = [];
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => server.once('listening', resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (filename) =>
  stat(filename).then(
    () => true,
    () => false,
  );
async function until(predicate, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failed) throw failed;
    if (await predicate()) return;
    await delay(40);
  }
  throw Error(`updater integration deadline (${phase})`);
}
async function makeArchive(id, replacement = updater) {
  const tarPath = path.join(temporary, `${id}.tar`);
  const args = [
    path.join(repository, 'endpoint/tests/updater_fixtures.py'),
    'node',
    tarPath,
    id,
    dummy,
    replacement,
  ];
  // cmd requires explicit quoting when the repository is under a path with spaces.
  const command = ['"C:\\src\\depot_tools\\python3.bat"', ...args.map((s) => `"${s}"`)].join(' ');
  const result = spawnSync(command, { shell: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const tar = await readFile(tarPath);
  const frames = [];
  for (let start = 0; start < tar.length; start += 65536)
    frames.push(zstdCompressSync(tar.subarray(start, start + 65536)));
  const bytes = Buffer.concat(frames);
  archives.set(id, {
    bytes,
    descriptor: { buildId: id, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
  });
}
server.on('connection', (socket, request) => {
  (async () => {
    assert.equal(request.url, '/api/node');
    assert.equal(request.headers.authorization, undefined);
    const transport = socketTransport(socket);
    let release;
    const state = await accept(transport, key, (hello) => {
      assert.equal(hello.type, 'node.hello');
      assert.equal(hello.role, 'updater');
      assert.equal(hello.nodeId, 'test-node');
      assert.equal(hello.incarnation, undefined);
      release = archives.get(hello.buildId === 'dev' ? ids[0] : ids[1]);
      if (phase === 'equal') release = archives.get(ids[0]);
      if (phase === 'bad-hash')
        release = { ...release, descriptor: { ...release.descriptor, sha256: '0'.repeat(64) } };
      if (phase === 'bad-build')
        release = {
          ...archives.get(ids[0]),
          descriptor: { ...archives.get(ids[0]).descriptor, buildId: ids[1] },
        };
      return phase === 'no-release'
        ? { type: 'node.reject', code: 'no_release', message: 'fixture', buildId: ids[0] }
        : { type: 'node.release', release: release.descriptor };
    });
    if (phase === 'no-release') {
      socket.close();
      return;
    }
    if (phase === 'equal') return;
    const message = decode(state.receive.decrypt(await transport.next())).json;
    assert.equal(message.type, 'package.get');
    assert.equal(message.buildId, release.descriptor.buildId);
    const offset = message.offset;
    assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= release.bytes.length);
    offsets.push({ id: release.descriptor.buildId, offset });
    const send = (json, bytes) => socket.send(state.send.encrypt(encode(json, bytes)));
    if (message.buildId === ids[1] && !bInterrupted) {
      bInterrupted = true;
      const cut = Math.floor(release.bytes.length / 2);
      assert.equal(offset, 0);
      send({ type: 'package.chunk', offset }, release.bytes.subarray(0, cut));
      // Let the native reader persist the first chunk, then drop the carrier.
      await delay(100);
      socket.terminate();
      return;
    }
    for (let at = offset; at < release.bytes.length; at += 1024 * 1024)
      send({ type: 'package.chunk', offset: at }, release.bytes.subarray(at, at + 1024 * 1024));
    send({ type: 'package.end', size: release.bytes.length });
  })().catch((error) => {
    failed = error;
    socket.terminate();
  });
});
async function prepare(name, sequence, current) {
  const root = path.join(temporary, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'node.json'),
    JSON.stringify({
      control: `ws://127.0.0.1:${server.address().port}/api/node`,
      key: key.toString('base64'),
      nodeId: 'test-node',
    }),
  );
  await writeFile(path.join(root, 'dummy.json'), JSON.stringify(sequence));
  await writeFile(path.join(root, 'remotekit_node.exe.old'), 'leftover');
  await writeFile(path.join(root, 'remotekit_node.exe.new'), 'staged');
  if (current) {
    const bin = path.join(root, 'runtime', current, 'bin');
    await mkdir(bin, { recursive: true });
    await copyFile(dummy, path.join(bin, 'endpoint_service.exe'));
    await writeFile(path.join(bin, '..', 'build.json'), JSON.stringify({ buildId: current }));
    await writeFile(path.join(root, 'current'), current);
  }
  return root;
}
function run(root, installed) {
  const child = spawn(installed ?? harness, installed ? ['run', '--root=' + root] : [root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  children.add(child);
  const exited = new Promise((resolve) =>
    child.once('exit', (code) => {
      children.delete(child);
      resolve({ code, stderr });
    }),
  );
  return { child, exited };
}
async function stop(root, running) {
  await writeFile(path.join(root, 'test-stop'), 'stop');
  const result = await running.exited;
  assert.equal(result.code, 0, result.stderr);
}
try {
  for (const id of ids) await makeArchive(id);
  const root = await prepare('node', [4, 0, 1, 3, null]);
  const obsolete = path.join(root, 'runtime', 'c'.repeat(64));
  await mkdir(obsolete, { recursive: true });
  await mkdir(path.join(root, 'downloads'));
  const seed = Math.min(12345, Math.floor(archives.get(ids[0]).bytes.length / 3));
  await writeFile(
    path.join(root, 'downloads', `${ids[0]}.tar.zst.partial`),
    archives.get(ids[0]).bytes.subarray(0, seed),
  );
  const running = run(root);
  await until(
    async () => Number(await readFile(path.join(root, 'dummy-step'), 'utf8').catch(() => '0')) === 5,
  );
  assert.equal(await readFile(path.join(root, 'current'), 'utf8'), ids[1]);
  assert.deepEqual((await readdir(path.join(root, 'runtime'))).sort(), [ids[1]]);
  assert.deepEqual(await readdir(path.join(root, 'downloads')), []);
  assert.equal(await exists(path.join(root, 'remotekit_node.exe.old')), false);
  assert.equal(await exists(path.join(root, 'remotekit_node.exe.new')), false);
  const runs = (await readFile(path.join(root, 'dummy-runs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(runs.length, 5);
  assert(runs[1].time - runs[0].time < 1000, 'exit 4 restarts immediately');
  assert(runs[2].time - runs[1].time >= 900, 'exit 0 uses 1 s backoff');
  assert(runs[3].time - runs[2].time >= 1900, 'failure uses 2 s backoff');
  assert.deepEqual(offsets[0], { id: ids[0], offset: 0 });
  assert.deepEqual(
    offsets.filter(({ id }) => id === ids[1]).slice(0, 2),
    [
      { id: ids[1], offset: 0 },
      { id: ids[1], offset: Math.floor(archives.get(ids[1]).bytes.length / 2) },
    ],
    await readFile(path.join(root, 'logs/supervisor.log'), 'utf8'),
  );
  await stop(root, running);
  assert.equal(await readFile(path.join(root, 'dummy-stopped'), 'utf8'), 'stdin EOF');
  const log = await readFile(path.join(root, 'logs/supervisor.log'), 'utf8');
  assert(
    log
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .some((record) => record.ev === 'endpoint.exited' && record.exitCode === 3),
  );
  assert(
    log
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .some((record) => record.ev === 'runtime.activated' && record.buildId === ids[1]),
  );
  assert(!log.includes(key.toString('base64')));
  assert((await readFile(path.join(root, 'logs/endpoint.log'), 'utf8')).includes('dummy endpoint step 4'));
  for (const mode of ['equal', 'no-release']) {
    phase = mode;
    const retryRoot = await prepare(mode, [3, null], ids[0]);
    const retryRun = run(retryRoot);
    await until(async () =>
      (await readFile(path.join(retryRoot, 'logs/supervisor.log'), 'utf8').catch(() => '')).includes(
        mode === 'equal' ? 'equals current runtime' : 'no node release',
      ),
    );
    await delay(250);
    assert.equal((await readFile(path.join(retryRoot, 'dummy-step'), 'utf8')).trim(), '1');
    await stop(retryRoot, retryRun);
  }
  for (const mode of ['bad-hash', 'bad-build']) {
    phase = mode;
    const rejectRoot = await prepare(mode, [3, null], ids[0]);
    const rejectRun = run(rejectRoot);
    await until(async () =>
      (await readFile(path.join(rejectRoot, 'logs/supervisor.log'), 'utf8').catch(() => '')).includes(
        mode === 'bad-hash' ? 'SHA-256 mismatch' : 'Release archive does not contain the promised runtime',
      ),
    );
    assert.equal(await readFile(path.join(rejectRoot, 'current'), 'utf8'), ids[0]);
    assert.equal((await readFile(path.join(rejectRoot, 'dummy-step'), 'utf8')).trim(), '1');
    await stop(rejectRoot, rejectRun);
  }
  phase = 'self-replace';
  await makeArchive(ids[0], replacementProbe);
  const selfRoot = await prepare('self-replace', [null]);
  const installed = path.join(selfRoot, 'remotekit_node.exe');
  await copyFile(updater, installed);
  const selfRun = run(selfRoot, installed);
  const selfResult = await selfRun.exited;
  assert.equal(selfResult.code, 0, selfResult.stderr);
  await until(() => exists(path.join(selfRoot, 'replacement-started')), 5000);
  assert.equal(await readFile(path.join(selfRoot, 'replacement-started'), 'utf8'), 'run');
  assert.deepEqual(await readFile(installed), await readFile(replacementProbe));
  assert.deepEqual(await readFile(installed + '.old'), await readFile(updater));
  assert.equal(await readFile(path.join(selfRoot, 'current'), 'utf8'), ids[0]);
  assert.equal(await exists(path.join(selfRoot, 'dummy-step')), false);
  const invalid = spawnSync(updater, ['run', '--root=' + path.join(temporary, 'invalid')], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(invalid.status, 1);
} finally {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((resolve) => {
          child.once('close', resolve);
          child.kill();
        }),
    ),
  );
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
