import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { makeNodeRelease } from './kit/node-release.mjs';
import { trackCleanupProcess, trackNodeData } from './kit/cleanup.mjs';
import { stageControlRelease, startStack, until } from './kit/stack.mjs';
/** Real Control + standalone updater + real Endpoint, initial install then build-mismatch update.
 * args: Endpoint exe, Browser exe, new evidence directory, [port]
 */
import assert from 'node:assert/strict';

const [endpointArg, browserArg, output, portArg = '33851'] = process.argv.slice(2);
assert([endpointArg, browserArg, output].every(Boolean));
const endpoint = resolve(endpointArg),
  browser = resolve(browserArg),
  run = resolve(output),
  port = Number(portArg);
await mkdir(run, { recursive: true });
const nodeRoot = join(run, 'node');
await mkdir(nodeRoot);
trackNodeData(run, nodeRoot);
const installed = join(nodeRoot, 'remotekit_node.exe');
await copyFile(join(dirname(endpoint), 'remotekit_node.exe'), installed);
const releases = [];
const servers = [];
for (const generation of ['first', 'second']) {
  const runtime = join(run, generation);
  servers.push(await stageControlRelease(runtime));
  releases.push(await makeNodeRelease(runtime, endpoint, generation, browser));
}
assert.notEqual(releases[0].buildId, releases[1].buildId);
const launchControl = async (index) =>
  startStack({
    scenario: 'node-updater',
    run,
    control: 'release',
    release: resolve(servers[index], '../../..'),
    seed: false,
    fixtures: false,
    ports: { control: port, viewer: port + 3, fixture: port + 2, peer: port + 1 },
    nodes: { 'updater-test': { remote: { control: `ws://127.0.0.1:${port}/api/node` } } },
  });
let stack, control, updater;
try {
  stack = await launchControl(0);
  control = stack.control;
  await until(
    () =>
      fetch(`http://127.0.0.1:${port}/api/auth/setup`).then(
        (r) => r.ok,
        () => false,
      ),
    'first Control listening',
  );
  await copyFile(join(run, 'nodes/updater-test/node.json'), join(nodeRoot, 'node.json'));
  updater = spawn(installed, ['run', '--root=' + nodeRoot], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackCleanupProcess(run, updater);
  for (const stream of ['stdout', 'stderr'])
    updater[stream].on('data', (bytes) => void appendFile(join(run, 'updater.' + stream + '.log'), bytes));
  const verify = async (index) => {
    const release = releases[index];
    await until(
      () => control.events.find((event) => event.event === 'node.ready' && event.buildId === release.buildId),
      'node.ready ' + index,
      90000,
    );
    await until(async () => {
      const snapshot = await control.call('inspect');
      return snapshot.nodes.some((node) => node.buildId === release.buildId && node.metrics);
    }, 'Endpoint metrics ' + index);
    assert.equal((await readFile(join(nodeRoot, 'current'), 'utf8')).trim(), release.buildId);
    assert.deepEqual(
      JSON.parse(await readFile(join(nodeRoot, 'runtime', release.buildId, 'build.json'), 'utf8')),
      { buildId: release.buildId },
    );
    const bytes = await readFile(join(nodeRoot, 'runtime', release.buildId, 'bin/endpoint_service.exe'));
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    assert.equal(hash(bytes), hash(await readFile(endpoint)));
    await writeFile(
      join(run, 'ready-' + index + '.json'),
      JSON.stringify({ release, events: control.events, snapshot: await control.call('inspect') }, null, 2),
    );
    console.log('node.ready release ' + index);
  };
  await verify(0);
  await stack.stop();
  stack = await launchControl(1);
  control = stack.control;
  await verify(1);
  const supervisor = await readFile(join(nodeRoot, 'logs/supervisor.log'), 'utf8');
  const records = supervisor
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert(
    records.some((record) => record.ev === 'endpoint.exited' && record.exitCode === 3),
    supervisor,
  );
  for (const release of releases)
    assert(
      records.some((record) => record.ev === 'runtime.activated' && record.buildId === release.buildId),
      supervisor,
    );
  assert.deepEqual(await readdir(join(nodeRoot, 'runtime')), [releases[1].buildId]);
  await writeFile(
    join(run, 'pass.json'),
    JSON.stringify({ releases, exit3: true, current: releases[1].buildId }, null, 2),
  );
  console.log('pass');
} catch (error) {
  process.exitCode = 1;
  await writeFile(
    join(run, 'failure.json'),
    JSON.stringify({ error: error.stack, snapshot: await control?.call('inspect').catch(String) }, null, 2),
  );
  console.error(error);
} finally {
  // Only this test's updater and child are terminated; Control closes its Noise carrier first.
  await stack?.stop();
  if (updater && updater.exitCode === null) {
    const stopped = new Promise((done) => updater.once('exit', done));
    const killer = spawn('taskkill', ['/PID', String(updater.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise((done) => killer.once('exit', done));
    await stopped;
  }
}
