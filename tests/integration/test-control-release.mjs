import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const [manager, releaseTool, updater, dummy] = process.argv.slice(2).map((value) => path.resolve(value));
assert(manager && releaseTool && updater && dummy, 'expected manager, release tool, updater, dummy Endpoint');
const scratch = path.join(repository, 'develop/tmp');
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(path.join(scratch, `control-release-${Date.now()}-`));
const root = path.join(temporary, 'host');
const nodeRoot = path.join(temporary, 'remote-node');
const tree = path.join(temporary, 'tree');
const key = path.join(temporary, 'release.key');
const python = 'C:\\src\\depot_tools\\python3.bat';
const children = new Set();
const releases = new Map();
const requests = [];
const notFound = new Set();
let latest = 1;
let phase = 'fixture';
let dropped = false;
let corrupt;
let serverFailure;
let success = false;
const dropPath = '/v1/control-full.000';
const dropBytes = 256 * 1024;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (file) => readFile(file, 'utf8').catch(() => '');
const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function run(executable, args, options = {}) {
  return execute(executable, args, {
    cwd: repository,
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}
async function until(predicate, description, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (serverFailure) throw serverFailure;
    if (await predicate()) return;
    await delay(100);
  }
  throw Error(
    `${phase}: deadline waiting for ${description}\n${await text(path.join(root, 'logs/manager.log'))}\n${await text(path.join(root, 'logs/control.log'))}\n${await text(path.join(nodeRoot, 'logs/supervisor.log'))}`,
  );
}
async function pythonScript(script, args = []) {
  return run(
    'cmd.exe',
    ['/d', '/s', '/c', `""${python}" "${script}" ${args.map((arg) => `"${arg}"`).join(' ')}"`],
    { windowsVerbatimArguments: true },
  );
}
async function processes(directory) {
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$prefix = '${directory.replaceAll("'", "''")}\\'; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } | Select-Object ProcessId, ParentProcessId, ExecutablePath) | ConvertTo-Json -Compress`,
  ]);
  return result.stdout.trim() ? [].concat(JSON.parse(result.stdout)) : [];
}
async function stop(directory) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const running = await processes(directory);
    if (running.length === 0) return;
    await Promise.all(
      running.map(({ ProcessId }) =>
        run('taskkill.exe', ['/PID', String(ProcessId), '/T', '/F']).catch(() => {}),
      ),
    );
  }
  throw Error(`process cleanup deadline: ${directory}`);
}
function start(executable, directory) {
  const child = spawn(executable, ['run', '--root=' + directory], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  child.on('error', (error) => {
    output += error.stack;
  });
  const exited = new Promise((resolve) =>
    child.once('close', (code) => {
      children.delete(child);
      resolve({ code, output });
    }),
  );
  return { child, exited };
}
const server = createServer((request, response) => {
  void (async () => {
    const requested = new URL(request.url, 'http://localhost').pathname;
    const assetPath = requested === '/latest/control.manifest' ? `/v${latest}/control.manifest` : requested;
    const record = { phase, path: assetPath, range: request.headers.range ?? null, status: 200 };
    requests.push(record);
    const match = /^\/v(\d+)\/([^/]+)$/.exec(assetPath);
    if (notFound.has(assetPath) || !match || !releases.has(Number(match[1]))) {
      record.status = 404;
      response.writeHead(404).end();
      return;
    }
    let bytes = await readFile(path.join(releases.get(Number(match[1])).directory, match[2]));
    if (assetPath === corrupt) {
      bytes = Buffer.from(bytes);
      bytes[100] ^= 1;
    }
    let offset = 0;
    if (request.headers.range) {
      assert.match(request.headers.range, /^bytes=\d+-$/);
      offset = Number(request.headers.range.slice(6, -1));
      assert(offset > 0 && offset < bytes.length);
      record.status = 206;
    }
    response.writeHead(record.status, {
      'Content-Length': bytes.length - offset,
      ...(offset ? { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    if (assetPath === dropPath && !dropped) {
      dropped = true;
      response.write(bytes.subarray(0, dropBytes));
      setTimeout(() => response.destroy(), 100);
      return;
    }
    response.end(bytes.subarray(offset));
  })().catch((error) => {
    serverFailure = error;
    response.destroy(error);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const prefix = `http://127.0.0.1:${server.address().port}/`;
let controlUrl;
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const filename = path.join(directory, entry.name);
        return entry.isDirectory() ? sourceFiles(filename) : [filename];
      }),
    )
  ).flat();
}
async function prepareControl(node) {
  const dist = path.join(repository, 'control/dist');
  const outputs = ['server.mjs', 'recover-credentials.mjs', 'client/index.html', 'runtime/manifest.json'];
  const outputStats = await Promise.all(outputs.map((file) => stat(path.join(dist, file)).catch(() => null)));
  const inputs = (
    await Promise.all(
      ['server', 'client', 'shared'].map((dir) => sourceFiles(path.join(repository, 'control', dir))),
    )
  ).flat();
  inputs.push(
    ...[
      'control/package.json',
      'control/package-lock.json',
      'control/tsconfig.json',
      'control/vite.config.ts',
      'tools/build-control-server.mjs',
    ].map((file) => path.join(repository, file)),
  );
  const inputStats = await Promise.all(inputs.map((file) => stat(file).catch(() => null)));
  if (
    outputStats.some((value) => !value) ||
    Math.max(...inputStats.filter(Boolean).map((value) => value.mtimeMs)) >
      Math.min(...outputStats.filter(Boolean).map((value) => value.mtimeMs))
  ) {
    console.log('Building stale Control distribution');
    await run(
      node,
      [
        path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js'),
        '--prefix',
        'control',
        'run',
        'build',
      ],
      {
        env: { ...process.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH },
      },
    );
  }
  const runtime = JSON.parse(await readFile(path.join(dist, 'runtime/manifest.json'), 'utf8'));
  assert.equal(runtime.nodeModuleAbi, (await run(node, ['-p', 'process.versions.modules'])).stdout.trim());
  for (const directory of ['bin', 'control/dist', 'licenses', 'node/bin', 'node/licenses'])
    await mkdir(path.join(tree, directory), { recursive: true });
  await Promise.all([
    cp(node, path.join(tree, 'bin/node.exe')),
    cp(manager, path.join(tree, 'bin/remotekit_control.exe')),
    cp(updater, path.join(tree, 'bin/remotekit_node.exe')),
    cp(updater, path.join(tree, 'node/bin/remotekit_node.exe')),
    cp(dummy, path.join(tree, 'node/bin/endpoint_service.exe')),
    ...['server.mjs', 'recover-credentials.mjs', 'client'].map((file) =>
      cp(path.join(dist, file), path.join(tree, 'control/dist', file), { recursive: true }),
    ),
    cp(path.join(dist, 'runtime/node_modules'), path.join(tree, 'control/node_modules'), { recursive: true }),
    cp(path.join(dist, 'runtime/manifest.json'), path.join(tree, 'control/runtime-manifest.json')),
    cp(path.join(path.dirname(node), 'LICENSE'), path.join(tree, 'licenses/Node-LICENSE')),
    writeFile(path.join(tree, 'control/random-padding.bin'), randomBytes(34 * 1024 * 1024)),
    writeFile(path.join(tree, 'node/licenses/fixture.txt'), 'Dummy Endpoint integration fixture\n'),
    writeFile(
      path.join(tree, 'recover-credentials.cmd'),
      '@echo off\r\nset "REMOTEKIT_CONTROL_CONFIG=%~dp0..\\..\\config\\control.json"\r\n"%~dp0bin\\node.exe" "%~dp0control\\dist\\recover-credentials.mjs" %*\r\n',
    ),
  ]);
}
async function pack(version, base, full = false) {
  await writeFile(path.join(tree, 'control/generation.json'), JSON.stringify({ generation: version }));
  await writeFile(path.join(tree, 'node/bin/generation.json'), JSON.stringify({ generation: version }));
  if (version === 8) {
    await writeFile(
      path.join(tree, 'bin/remotekit_control.exe'),
      Buffer.concat([await readFile(manager), Buffer.from('RemoteKit releaseflow overlay v8\n')]),
    );
  }
  const payload = path.join(temporary, `v${version}.tar`);
  const generated = JSON.parse(
    (await pythonScript(path.join(temporary, 'payload.py'), [tree, payload])).stdout,
  );
  const directory = path.join(temporary, `v${version}`);
  const previous = releases.get(base);
  await run(releaseTool, [
    'pack',
    '--key=' + key,
    '--payload=' + payload,
    '--build=' + generated.buildId,
    '--url-prefix=' + prefix + `v${version}/`,
    '--out=' + directory,
    '--level=1',
    '--patch-level=1',
    ...(previous
      ? [
          '--base=' + previous.payload,
          '--base-build=' + previous.id,
          '--base-manifest=' + prefix + `v${base}/control.manifest`,
        ]
      : []),
    ...(full ? ['--full'] : []),
  ]);
  const manifest = JSON.parse(
    (
      await run(releaseTool, [
        'inspect',
        '--key=' + key,
        '--manifest=' + path.join(directory, 'control.manifest'),
      ])
    ).stdout,
  );
  assert.equal(manifest.buildId, generated.buildId);
  assert(
    ![...releases.values()].some((release) => release.id === generated.buildId),
    'distinct generation buildId',
  );
  assert.equal(Boolean(manifest.patch), Boolean(previous));
  assert.equal(Boolean(manifest.full), !previous || full);
  releases.set(version, { directory, payload, id: generated.buildId, manifest });
  return releases.get(version);
}
async function installed(version) {
  const { id, manifest } = releases.get(version);
  await until(
    async () =>
      (await text(path.join(root, 'current'))).trim() === id &&
      (await text(path.join(root, 'logs/manager.log'))).includes('started Control ' + id),
    `Control v${version}`,
  );
  await until(async () => {
    try {
      return (await fetch(controlUrl, { signal: AbortSignal.timeout(1000) })).status === 200;
    } catch {
      return false;
    }
  }, 'Control HTTP 200');
  assert.deepEqual(await readdir(path.join(root, 'versions')), [id]);
  const versionRoot = path.join(root, 'versions', id);
  const nodeArchive = await readFile(path.join(versionRoot, 'release/node.tar.zst'));
  assert.deepEqual(JSON.parse(await text(path.join(versionRoot, 'release/node.json'))), {
    buildId: id,
    sha256: hash(nodeArchive),
    size: nodeArchive.length,
  });
  assert.deepEqual(JSON.parse(await text(path.join(versionRoot, 'payload.json'))), manifest.payload);
  assert.equal(hash(await readFile(path.join(versionRoot, 'payload.tar'))), manifest.payload.sha256);
  assert.equal(await exists(path.join(versionRoot, 'node')), false);
  assert.deepEqual(
    (await readdir(path.join(root, 'work'))).filter((name) => /^(payload-|stage-)/.test(name)),
    [],
  );
  const running = await processes(root);
  assert(
    running.some(
      (process) =>
        process.ExecutablePath.toLowerCase() === path.join(versionRoot, 'bin/node.exe').toLowerCase(),
    ),
    'active Control process uses installed version',
  );
}
async function nodeInstalled(version) {
  const { id } = releases.get(version);
  await until(
    async () =>
      (await text(path.join(nodeRoot, 'current'))).trim() === id &&
      (await text(path.join(nodeRoot, 'dummy-active'))).trim() === id,
    `remote node v${version}`,
  );
  assert.deepEqual(await readdir(path.join(nodeRoot, 'runtime')), [id]);
  assert.deepEqual(await readdir(path.join(nodeRoot, 'downloads')), []);
  assert((await text(path.join(nodeRoot, 'logs/supervisor.log'))).includes('activated runtime ' + id));
  assert((await text(path.join(nodeRoot, 'logs/endpoint.log'))).includes('dummy cluster ' + id));
}
function assertAssets(expected) {
  const actual = requests.filter(
    (request) => request.phase === phase && /control-(full|patch)\./.test(request.path),
  );
  assert.deepEqual(
    actual.map((request) => request.path),
    expected.flatMap(([version, kind]) =>
      (kind === 'patch'
        ? releases.get(version).manifest.patch.asset
        : releases.get(version).manifest.full
      ).slices.map((slice) => new URL(slice.url).pathname),
    ),
  );
  assert(actual.every((request) => request.status === 200 && request.range === null));
}
async function restart(version) {
  await stop(root);
  latest = version;
  return start(path.join(root, 'remotekit_control.exe'), root);
}
try {
  const resolver = path.join(temporary, 'resolve-node.py');
  await writeFile(
    resolver,
    `import sys\nsys.path.insert(0, ${JSON.stringify(path.join(repository, 'tools')).replaceAll('\\\\', '/')})\nfrom node_runtime import resolve_node\nprint(resolve_node())\n`,
  );
  const node =
    process.version === 'v24.20.0'
      ? process.execPath
      : (await pythonScript(resolver)).stdout.trim().split(/\r?\n/).at(-1);
  assert.equal((await run(node, ['--version'])).stdout.trim(), 'v24.20.0');
  await writeFile(
    path.join(temporary, 'payload.py'),
    `import json, sys\nfrom pathlib import Path\nsys.path.insert(0, ${JSON.stringify(path.join(repository, 'tools')).replaceAll('\\\\', '/')})\nfrom release_payload import build_id, write_payload\ntree = Path(sys.argv[1])\nidentity = build_id(tree, tree / 'node')\nfor root in (tree, tree / 'node'):\n    (root / 'build.json').write_text(json.dumps({'buildId': identity}) + '\\n', encoding='utf-8')\n(tree / 'manifest.json').write_text(json.dumps({'buildId': identity, 'fixture': 'control-release'}), encoding='utf-8')\nprint(json.dumps({'buildId': identity, **write_payload(tree, sys.argv[2])}))\n`,
  );
  await prepareControl(node);
  await run(releaseTool, ['keygen', '--out=' + key]);
  const first = await pack(1);
  assert(first.manifest.full.slices.length >= 2, 'fresh install spans multiple fixed 32 MiB slices');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  controlUrl = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));
  await run(manager, [
    'init',
    '--root=' + root,
    '--manifest=' + prefix + 'latest/control.manifest',
    '--key-file=' + key,
  ]);
  await writeFile(
    path.join(root, 'config/manager.json'),
    JSON.stringify({ manifest: prefix + 'latest/control.manifest', checkIntervalMinutes: 5 }),
  );
  await writeFile(
    path.join(root, 'config/control.json'),
    JSON.stringify({
      http: { listen: controlUrl.slice(7), origins: [controlUrl] },
      storage: { database: '../data/control.db', diagnostics: '../data/diagnostics' },
      cluster: { keyFile: 'cluster.key', controlUrl: controlUrl.replace('http:', 'ws:') + '/api/node' },
      nodes: { 'release-node': {} },
    }),
  );
  phase = 'fresh';
  console.log('Fresh install with interrupted slice');
  start(path.join(root, 'remotekit_control.exe'), root);
  await installed(1);
  const fresh = requests.filter((request) => request.phase === phase && /control-full\./.test(request.path));
  assert(dropped);
  assert.equal(fresh.length, first.manifest.full.slices.length + 1);
  assert.deepEqual(
    fresh.filter((request) => request.path === dropPath).map((request) => request.range),
    [null, `bytes=${dropBytes}-`],
  );
  assert.equal(fresh.filter((request) => request.status === 206).length, 1);
  assert((await text(path.join(root, 'logs/manager.log'))).includes('transfer interrupted'));
  assert((await text(path.join(root, 'logs/control.log'))).includes('RemoteKit Control ' + controlUrl));
  phase = 'remote-node';
  console.log('Remote node downloads v1 from real Control');
  await mkdir(nodeRoot);
  await cp(path.join(root, 'config/nodes/release-node/node.json'), path.join(nodeRoot, 'node.json'));
  await cp(updater, path.join(nodeRoot, 'remotekit_node.exe'));
  await writeFile(path.join(nodeRoot, 'dummy-cluster'), 'cluster handshake');
  start(path.join(nodeRoot, 'remotekit_node.exe'), nodeRoot);
  await nodeInstalled(1);
  assertAssets([]);
  phase = 'patch';
  console.log('Patch v1 to v2 and remote build_mismatch update');
  await pack(2, 1);
  await restart(2);
  await installed(2);
  await nodeInstalled(2);
  assertAssets([[2, 'patch']]);
  assert((await text(path.join(nodeRoot, 'logs/endpoint.log'))).includes('build_mismatch'));
  assert((await text(path.join(nodeRoot, 'logs/supervisor.log'))).includes('endpoint exit 3'));
  phase = 'missed-deltas';
  console.log('Missed releases chain v2 to v3 to v4');
  await stop(root);
  await pack(3, 2);
  await pack(4, 3);
  latest = 4;
  start(path.join(root, 'remotekit_control.exe'), root);
  await installed(4);
  await nodeInstalled(4);
  assertAssets([
    [3, 'patch'],
    [4, 'patch'],
  ]);
  assert.equal(
    requests.filter((request) => request.phase === phase && request.path === '/v3/control.manifest').length,
    1,
  );
  phase = 'broken-chain';
  console.log('Missing v5 manifest falls back to v6 full');
  await stop(root);
  await pack(5, 4);
  await pack(6, 5, true);
  notFound.add('/v5/control.manifest');
  latest = 6;
  start(path.join(root, 'remotekit_control.exe'), root);
  await installed(6);
  await nodeInstalled(6);
  assertAssets([[6, 'full']]);
  assert.equal(
    requests.filter(
      (request) =>
        request.phase === phase && request.path === '/v5/control.manifest' && request.status === 404,
    ).length,
    1,
  );
  phase = 'corrupt-patch';
  console.log('Corrupted patch authentication falls back to full');
  await pack(7, 6, true);
  corrupt = '/v7/control-patch.000';
  await restart(7);
  await installed(7);
  await nodeInstalled(7);
  assertAssets([
    [7, 'patch'],
    [7, 'full'],
  ]);
  assert(
    (await text(path.join(root, 'logs/manager.log'))).includes(
      'release key does not match or data corrupted',
    ),
  );
  corrupt = undefined;
  phase = 'self-update';
  console.log('Manager v8 self-replacement and successor');
  await pack(8, 7);
  const predecessor = await restart(8);
  await until(
    async () => (await text(path.join(root, 'current'))).trim() === releases.get(8).id,
    'v8 activation',
  );
  await until(() => predecessor.child.exitCode !== null, 'predecessor exit', 15000);
  const exit = await predecessor.exited;
  assert.equal(exit.code, 0, exit.output);
  await installed(8);
  await nodeInstalled(8);
  assertAssets([[8, 'patch']]);
  assert.deepEqual(
    await readFile(path.join(root, 'remotekit_control.exe')),
    await readFile(path.join(root, 'versions', releases.get(8).id, 'bin/remotekit_control.exe')),
  );
  await until(
    async () => !(await exists(path.join(root, 'remotekit_control.exe.old'))),
    'successor removes .old',
  );
  const successor = (await processes(root)).find(
    (process) =>
      process.ExecutablePath.toLowerCase() === path.join(root, 'remotekit_control.exe').toLowerCase(),
  );
  assert(successor && successor.ProcessId !== predecessor.child.pid, 'successor manager is running');
  assert((await text(path.join(root, 'logs/manager.log'))).includes('installed updated supervisor'));
  phase = 'wrong-key';
  console.log('Wrong key rejects manifest and installs nothing');
  const wrongRoot = path.join(temporary, 'wrong-key');
  const wrongKey = path.join(temporary, 'wrong.key');
  await run(releaseTool, ['keygen', '--out=' + wrongKey]);
  await run(manager, [
    'init',
    '--root=' + wrongRoot,
    '--manifest=' + prefix + 'latest/control.manifest',
    '--key-file=' + wrongKey,
  ]);
  start(path.join(wrongRoot, 'remotekit_control.exe'), wrongRoot);
  await until(
    async () =>
      (await text(path.join(wrongRoot, 'logs/manager.log'))).includes(
        'release key does not match or data corrupted',
      ),
    'wrong-key rejection',
  );
  assert.equal(await exists(path.join(wrongRoot, 'current')), false);
  assert.deepEqual(await readdir(path.join(wrongRoot, 'versions')).catch(() => []), []);
  assertAssets([]);
  assert.equal(
    requests.filter((request) => request.phase === phase && request.path === '/v8/control.manifest').length,
    1,
  );
  for (const directory of [root, wrongRoot]) {
    const log = await text(path.join(directory, 'logs/manager.log'));
    assert(!log.includes((await text(key)).trim()));
    assert(!log.includes((await text(wrongKey)).trim()));
  }
  success = true;
} finally {
  if (!success) await writeFile(path.join(temporary, 'requests.json'), JSON.stringify(requests, null, 2));
  await stop(temporary);
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once('close', resolve);
          child.kill();
        }),
    ),
  );
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (success) await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  else console.error(`Failure evidence: ${temporary}`);
}
