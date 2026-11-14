import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { Noise, encode, decode, socketTransport, publicKey } from './test-cluster-noise-interop.mjs';

const [harness, dummy, updater, replacementProbe] = process.argv.slice(2);
const require = createRequire(new URL('../../control/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const repository = fileURLToPath(new URL('../../', import.meta.url));
const scratch = path.join(repository, 'develop/tmp');
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(path.join(scratch, 'node-updater-'));
const controlPrivateKey = Buffer.alloc(32, 7);
const nodePrivateKey = Buffer.alloc(32, 6);
const ids = ['a'.repeat(64), 'b'.repeat(64)];
const archives = new Map();
const children = new Set();
let failed;
let phase = 'update';
let outcome = 'pending';
let bInterrupted = false;
const offsets = [];
const hellos = [];
let equalReplacementRoot;
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
    const connectionPhase = phase;
    assert.equal(request.url, '/api/node');
    assert.equal(request.headers.authorization, undefined);
    const transport = socketTransport(socket);
    if (connectionPhase === 'equal-changed')
      await copyFile(
        replacementProbe,
        path.join(equalReplacementRoot, 'runtime', ids[0], 'bin/remotekit_node.exe'),
      );
    let release;
    const noise = new Noise(false, controlPrivateKey);
    const hello = JSON.parse(noise.read(await transport.next(5000)));
    const reply = ((hello, remoteKey) => {
      assert.deepEqual(remoteKey, publicKey(nodePrivateKey));
      assert.equal(hello.type, 'node.hello');
      assert.equal(hello.role, 'updater');
      assert.equal(hello.nodeId, 'test-node');
      assert.equal(hello.incarnation, undefined);
      hellos.push({ phase: connectionPhase, buildId: hello.buildId });
      release = archives.get(hello.buildId === 'dev' ? ids[0] : ids[1]);
      if (connectionPhase.startsWith('equal')) release = archives.get(ids[0]);
      if (connectionPhase === 'bad-hash')
        release = { ...release, descriptor: { ...release.descriptor, sha256: '0'.repeat(64) } };
      if (connectionPhase === 'bad-build')
        release = {
          ...archives.get(ids[0]),
          descriptor: { ...archives.get(ids[0]).descriptor, buildId: ids[1] },
        };
      return connectionPhase === 'no-release'
        ? { type: 'node.reject', code: 'no_release', message: 'fixture', buildId: ids[0] }
        : { type: 'node.release', release: release.descriptor };
    })(hello, noise.remoteStatic);
    const replyText = JSON.stringify(reply);
    const duplicate = connectionPhase === 'duplicate-release';
    const rawReply = duplicate
      ? replyText.replace('"release":{', `"release":{"buildId":"${release.descriptor.buildId}",`)
      : replyText;
    transport.send(noise.write(Buffer.from(rawReply)));
    const state = noise.split();
    if (duplicate) {
      socket.on('message', () => {
        failed = Error('updater sent a package request after a duplicate-key release');
      });
      return;
    }
    if (connectionPhase === 'no-release') {
      socket.close();
      return;
    }
    if (connectionPhase.startsWith('equal')) return;
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
async function prepare(name, sequence, current, supervisor = updater) {
  const root = path.join(temporary, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'node.json'),
    JSON.stringify({
      version: 1,
      control: `ws://127.0.0.1:${server.address().port}/api/node`,
      privateKey: nodePrivateKey.toString('base64'),
      controlPublicKey: publicKey(controlPrivateKey).toString('base64'),
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
    await copyFile(dummy, path.join(bin, 'remotekit_snapshot.exe'));
    await copyFile(supervisor, path.join(bin, 'remotekit_node.exe'));
    await writeFile(path.join(bin, '..', 'build.json'), JSON.stringify({ buildId: current }));
    await writeFile(path.join(root, 'current'), current);
  }
  return root;
}
async function lockFile(filename, sharing) {
  const child = spawn(harness, [`--lock-${sharing}`, filename], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    output += bytes;
  });
  const exited = new Promise((resolve) =>
    child.once('close', (code) => {
      children.delete(child);
      resolve({ code, output });
    }),
  );
  await until(() => {
    assert.equal(child.exitCode, null, output);
    return output.includes('locked');
  });
  return async () => {
    child.stdin.end();
    const result = await exited;
    assert.equal(result.code, 0, result.output);
  };
}
function run(root, installed) {
  const child = spawn(installed ?? harness, installed ? ['run', '--root=' + root] : [root], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
async function events(root) {
  return (await readFile(path.join(root, 'logs/supervisor.log'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}
async function expectSteps(root, count, running) {
  await until(async () => {
    assert.equal(running.child.exitCode, null, `supervisor exited during ${phase}`);
    return Number(await readFile(path.join(root, 'dummy-step'), 'utf8').catch(() => '0')) === count;
  });
}
async function expectReplacement(root, running, original) {
  const result = await running.exited;
  assert.equal(result.code, 0, result.stderr);
  await until(() => exists(path.join(root, 'replacement-started')), 5000);
  assert.equal(await readFile(path.join(root, 'replacement-started'), 'utf8'), 'run');
  assert.deepEqual(await readFile(path.join(root, 'remotekit_node.exe')), await readFile(replacementProbe));
  assert.deepEqual(await readFile(path.join(root, 'remotekit_node.exe.old')), await readFile(original));
  assert.equal(await readFile(path.join(root, 'current'), 'utf8'), ids[0]);
}
async function testCurrentState(state, scenario) {
  phase = scenario;
  const stateRoot = await prepare(scenario, [null], ids[0]);
  const currentFile = path.join(stateRoot, 'current');
  const buildFile = path.join(stateRoot, 'runtime', ids[0], 'build.json');
  const nodeExecutable = path.join(stateRoot, 'runtime', ids[0], 'bin/remotekit_node.exe');
  const obsolete = path.join(stateRoot, 'runtime', 'c'.repeat(64));
  const download = path.join(stateRoot, 'downloads/retained.partial');
  await mkdir(obsolete, { recursive: true });
  await mkdir(path.dirname(download));
  await writeFile(path.join(obsolete, 'retain'), 'obsolete');
  await writeFile(download, 'download');
  if (state === 'invalid-current') await writeFile(currentFile, '../invalid');
  if (state === 'missing-build') await rm(buildFile);
  if (state === 'missing-executable') await rm(nodeExecutable);
  if (state === 'invalid-build') await writeFile(buildFile, '{');
  if (state === 'mismatched-build') await writeFile(buildFile, JSON.stringify({ buildId: ids[1] }));
  if (state === 'oversized-build') await writeFile(buildFile, 'x'.repeat(65537));
  const blockedFile =
    state === 'unreadable-current' ? currentFile : state === 'unreadable-build' ? buildFile : undefined;
  const unlock = blockedFile ? await lockFile(blockedFile, 'exclusive') : undefined;
  const stateRun = run(stateRoot);
  if (unlock) {
    await until(async () =>
      (await events(stateRoot)).some(
        (record) => record.ev === 'supervisor.current_failed' && record.err.code === 'unavailable',
      ),
    );
    assert.equal(await exists(path.join(stateRoot, 'dummy-step')), false);
    assert.equal(await readFile(path.join(obsolete, 'retain'), 'utf8'), 'obsolete');
    assert.equal(await readFile(download, 'utf8'), 'download');
    assert.equal(hellos.filter((hello) => hello.phase === scenario).length, 0);
    assert(!(await events(stateRoot)).some((record) => record.ev === 'current.invalid'));
    await unlock();
  }
  await expectSteps(stateRoot, 1, stateRun);
  assert.equal(await readFile(currentFile, 'utf8'), ids[0]);
  assert.deepEqual(JSON.parse(await readFile(buildFile, 'utf8')), { buildId: ids[0] });
  assert.deepEqual(await readFile(nodeExecutable), await readFile(updater));
  assert.deepEqual(await readdir(path.join(stateRoot, 'runtime')), [ids[0]]);
  assert.deepEqual(await readdir(path.join(stateRoot, 'downloads')), []);
  if (blockedFile) {
    assert.equal(hellos.filter((hello) => hello.phase === scenario).length, 0);
  } else {
    assert.deepEqual(
      hellos.filter((hello) => hello.phase === scenario),
      [{ phase: scenario, buildId: 'dev' }],
    );
    const warnings = (await events(stateRoot)).filter((record) => record.ev === 'current.invalid');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].lvl, 'warn');
    assert.equal(typeof warnings[0].message, 'string');
    assert(warnings[0].message.length > 0);
    assert(!(await events(stateRoot)).some((record) => record.ev === 'supervisor.current_failed'));
  }
  await stop(stateRoot, stateRun);
  assert.deepEqual(
    hellos.filter((hello) => hello.phase === scenario),
    blockedFile ? [] : [{ phase: scenario, buildId: 'dev' }],
    await readFile(path.join(stateRoot, 'logs/supervisor.log'), 'utf8'),
  );
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
  assert.deepEqual(hellos[0], { phase: 'update', buildId: 'dev' });
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
  assert(!log.includes(controlPrivateKey.toString('base64')));
  assert(!log.includes(nodePrivateKey.toString('base64')));
  assert((await readFile(path.join(root, 'logs/endpoint.log'), 'utf8')).includes('dummy endpoint step 4'));
  for (const state of [
    'invalid-current',
    'missing-build',
    'missing-executable',
    'invalid-build',
    'mismatched-build',
    'oversized-build',
    'unreadable-current',
    'unreadable-build',
  ]) {
    const repetitions = state === 'missing-executable' ? 5 : 1;
    for (let repetition = 1; repetition <= repetitions; ++repetition) {
      await testCurrentState(state, `${state}-${repetition}`);
    }
  }
  phase = 'equal-unchanged';
  const equalRoot = await prepare(phase, [3, null], ids[0], harness);
  const equalExecutable = path.join(equalRoot, 'remotekit_node.exe');
  await copyFile(harness, equalExecutable);
  const downloadsBeforeEqual = offsets.length;
  const equalRun = run(equalRoot, equalExecutable);
  await expectSteps(equalRoot, 2, equalRun);
  assert.equal(offsets.length, downloadsBeforeEqual);
  assert.deepEqual(
    hellos.filter((hello) => hello.phase === phase),
    [{ phase, buildId: ids[0] }],
  );
  assert.deepEqual(await readFile(equalExecutable), await readFile(harness));
  assert.equal(await exists(equalExecutable + '.old'), false);
  assert.equal(await exists(equalExecutable + '.new'), false);
  assert(
    !(await events(equalRoot)).some(
      (record) => record.ev === 'runtime.activated' || record.ev === 'supervisor.update_failed',
    ),
  );
  await stop(equalRoot, equalRun);

  phase = 'equal-startup-replacement';
  const startupRoot = await prepare(phase, [null], ids[0], replacementProbe);
  const startupExecutable = path.join(startupRoot, 'remotekit_node.exe');
  await copyFile(harness, startupExecutable);
  await expectReplacement(startupRoot, run(startupRoot, startupExecutable), harness);
  assert.equal(await exists(path.join(startupRoot, 'dummy-step')), false);
  assert.equal(hellos.filter((hello) => hello.phase === phase).length, 0);

  phase = 'equal-retry';
  const replacementRetryRoot = await prepare(phase, [null], ids[0], replacementProbe);
  const replacementRetryExecutable = path.join(replacementRetryRoot, 'remotekit_node.exe');
  await copyFile(harness, replacementRetryExecutable);
  const unlockReplacement = await lockFile(replacementRetryExecutable + '.new', 'exclusive');
  const replacementRetryRun = run(replacementRetryRoot, replacementRetryExecutable);
  await expectSteps(replacementRetryRoot, 1, replacementRetryRun);
  assert.deepEqual(await readFile(replacementRetryExecutable), await readFile(harness));
  assert.equal(await exists(replacementRetryExecutable + '.old'), false);
  await unlockReplacement();
  await expectReplacement(replacementRetryRoot, replacementRetryRun, harness);
  assert.equal((await readFile(path.join(replacementRetryRoot, 'dummy-step'), 'utf8')).trim(), '1');
  assert.equal(hellos.filter((hello) => hello.phase === phase).length, 0);

  phase = 'equal-changed';
  equalReplacementRoot = await prepare(phase, [3, null], ids[0], harness);
  const changedExecutable = path.join(equalReplacementRoot, 'remotekit_node.exe');
  await copyFile(harness, changedExecutable);
  await expectReplacement(equalReplacementRoot, run(equalReplacementRoot, changedExecutable), harness);
  assert.equal((await readFile(path.join(equalReplacementRoot, 'dummy-step'), 'utf8')).trim(), '1');
  assert.equal(offsets.length, downloadsBeforeEqual);
  assert.deepEqual(
    hellos.filter((hello) => hello.phase === phase),
    [{ phase, buildId: ids[0] }],
  );

  phase = 'cleanup-failure';
  const cleanupRoot = await prepare(phase, [3, null], ids[0]);
  const unlockCleanup = await lockFile(path.join(cleanupRoot, 'runtime', ids[0], 'build.json'), 'readable');
  const cleanupRun = run(cleanupRoot);
  await expectSteps(cleanupRoot, 2, cleanupRun);
  assert.equal(await readFile(path.join(cleanupRoot, 'current'), 'utf8'), ids[1]);
  assert(await exists(path.join(cleanupRoot, 'runtime', ids[0])));
  assert.equal(
    (await events(cleanupRoot)).filter((record) => record.ev === 'runtime.cleanup_failed').length,
    1,
  );
  assert(!(await events(cleanupRoot)).some((record) => record.ev === 'supervisor.update_failed'));
  await stop(cleanupRoot, cleanupRun);
  await rm(path.join(cleanupRoot, 'test-stop'));
  const cleanupLockedRestart = run(cleanupRoot);
  await expectSteps(cleanupRoot, 3, cleanupLockedRestart);
  assert.equal(
    (await events(cleanupRoot)).filter((record) => record.ev === 'runtime.cleanup_failed').length,
    2,
  );
  await stop(cleanupRoot, cleanupLockedRestart);
  await unlockCleanup();
  await rm(path.join(cleanupRoot, 'test-stop'));
  const cleanupRestart = run(cleanupRoot);
  await expectSteps(cleanupRoot, 4, cleanupRestart);
  assert.deepEqual(await readdir(path.join(cleanupRoot, 'runtime')), [ids[1]]);
  assert.deepEqual(await readdir(path.join(cleanupRoot, 'downloads')), []);
  await stop(cleanupRoot, cleanupRestart);

  phase = 'no-release';
  const retryRoot = await prepare(phase, [3, null], ids[0]);
  const retryRun = run(retryRoot);
  await until(async () =>
    (await events(retryRoot)).some(
      (record) =>
        record.ev === 'supervisor.update_failed' && record.err.message === 'Control has no node release',
    ),
  );
  await delay(250);
  assert.equal((await readFile(path.join(retryRoot, 'dummy-step'), 'utf8')).trim(), '1');
  await stop(retryRoot, retryRun);
  phase = 'duplicate-release';
  const duplicateRoot = await prepare(phase, [3, null], ids[0]);
  const installedBeforeDuplicate = new Map();
  for (const filename of [
    'current',
    `runtime/${ids[0]}/build.json`,
    ...['endpoint_service.exe', 'remotekit_node.exe', 'remotekit_snapshot.exe'].map(
      (name) => `runtime/${ids[0]}/bin/${name}`,
    ),
  ]) {
    installedBeforeDuplicate.set(filename, await readFile(path.join(duplicateRoot, filename)));
  }
  const downloadsBeforeDuplicate = offsets.length;
  const duplicateRun = run(duplicateRoot);
  await until(async () =>
    (await events(duplicateRoot)).some((record) => record.ev === 'supervisor.update_failed'),
  );
  // A malformed reply from Control breaks our own protocol, so it is internal and carries an error id.
  const duplicateFailure = (await events(duplicateRoot)).find(
    (record) => record.ev === 'supervisor.update_failed',
  ).err;
  assert.equal(duplicateFailure.code, 'internal');
  assert.equal(typeof duplicateFailure.errorId, 'string');
  await delay(31000);
  assert.equal(duplicateRun.child.exitCode, null);
  assert.deepEqual(
    hellos.filter((hello) => hello.phase === phase),
    [{ phase, buildId: ids[0] }],
  );
  assert.equal(offsets.length, downloadsBeforeDuplicate);
  assert.equal((await readFile(path.join(duplicateRoot, 'dummy-step'), 'utf8')).trim(), '1');
  for (const [filename, bytes] of installedBeforeDuplicate) {
    assert.deepEqual(await readFile(path.join(duplicateRoot, filename)), bytes);
  }
  assert.deepEqual(await readdir(path.join(duplicateRoot, 'runtime')), [ids[0]]);
  assert.equal(await exists(path.join(duplicateRoot, 'downloads')), false);
  const duplicateEvents = await events(duplicateRoot);
  assert.equal(duplicateEvents.filter((record) => record.ev === 'supervisor.update_failed').length, 1);
  assert(!duplicateEvents.some((record) => record.ev === 'runtime.activated'));
  await stop(duplicateRoot, duplicateRun);
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
  await expectReplacement(selfRoot, selfRun, updater);
  assert.equal(await exists(path.join(selfRoot, 'dummy-step')), false);
  const invalid = spawnSync(updater, ['run', '--root=' + path.join(temporary, 'invalid')], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(invalid.status, 1);
  outcome = 'passed';
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
  if (outcome === 'passed')
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  else console.error(`Failure evidence: ${temporary}`);
}
