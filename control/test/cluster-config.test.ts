import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, lstatSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeConfig, parseConfig, mediaDefaults, canonicalJson } from '../server/config';
import { convertV1 } from '../server/config-v1';
import { publicKey } from '../server/cluster/noise';
import { readBuildId } from '../server/cluster/build-id';
import { loadRelease } from '../server/cluster/release';
import { NodeRegistry } from '../server/cluster/node-link';
import { ControlDatabase } from '../server/persistence/database';
import { Placement } from '../server/cluster/placement';
import { fakeMetrics } from './fake-node';
import { testNode } from './node-fixture';
import { log } from '../server/log';
const local = { local: { root: '../data/node', executable: 'endpoint.exe' } };
const peer = { listen: '0.0.0.0:3101', address: 'gpu.test:3101' };
const remote = { remote: { control: 'wss://control.test:3001/api/node' }, peer };
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'rk-config-'));
  const configPath = join(directory, 'config', 'control.json');
  mkdirSync(join(directory, 'config'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = (value: unknown) => writeFileSync(configPath, JSON.stringify(value));
  const load = () => runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, [], join(directory, 'control'));
  const parse = () => parseConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, [], join(directory, 'control'));
  return { directory, configPath, save, load, parse };
}
test('defaults and identity bootstrap are stable and paths resolve against config directory', async (t) => {
  const h = await fixture(t);
  const config = h.load();
  assert.equal(config.dbPath, join(h.directory, 'data/control.db'));
  assert.equal(config.nodes.local.local!.root, join(h.directory, 'data/node'));
  assert.deepEqual(config.nodes.local.config.peer, { listen: '127.0.0.1:3101', address: '127.0.0.1:3101' });
  const bootstrap = JSON.parse(readFileSync(config.nodes.local.bootstrapFile, 'utf8'));
  assert.deepEqual(Object.keys(bootstrap).sort(), ['controlPublicKey', 'nodeId', 'privateKey']);
  assert.equal(bootstrap.controlPublicKey, config.identity.publicKey);
  assert.equal(
    publicKey(Buffer.from(bootstrap.privateKey, 'base64')).toString('base64'),
    config.nodes.local.publicKey,
  );
  assert.deepEqual(h.load().identity, config.identity);
  assert.equal(h.load().nodes.local.publicKey, config.nodes.local.publicKey);
  assert.ok(!existsSync(join(h.directory, 'config/cluster.key')));
  h.save({ nodes: { gpu: remote } });
  const next = h.load();
  assert.ok(existsSync(config.nodes.local.bootstrapFile));
  assert.ok(!existsSync(join(h.directory, 'config/nodes/local')));
  assert.ok(lstatSync(config.nodes.local.local!.root).isDirectory());
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(next.nodes.gpu.bootstrapFile, 'utf8'))).sort(), [
    'control',
    'controlPublicKey',
    'nodeId',
    'privateKey',
  ]);
  const before = next.nodes.gpu.publicKey;
  rmSync(next.nodes.gpu.bootstrapFile);
  assert.notEqual(h.load().nodes.gpu.publicKey, before);
  h.save({ nodes: {} });
  h.load();
  assert.ok(!existsSync(next.nodes.gpu.bootstrapFile));
});
test('removing a local node retains only its bootstrap and refuses its identity', async (t) => {
  const h = await fixture(t);
  h.save({ nodes: { local } });
  const first = h.load();
  const bootstrap = readFileSync(first.nodes.local.bootstrapFile, 'utf8');
  h.save({ nodes: {} });
  const removed = h.load();
  assert.equal(removed.nodes.local, undefined);
  assert.equal(readFileSync(first.nodes.local.bootstrapFile, 'utf8'), bootstrap);
  assert.deepEqual(readdirSync(join(h.directory, 'config/nodes')), []);
  h.save({ nodes: { local } });
  assert.equal(h.load().nodes.local.publicKey, first.nodes.local.publicKey);
});
test('packaged and dev default files share every default except local.executable', async (t) => {
  const dev = await fixture(t);
  const packaged = await fixture(t);
  writeFileSync(join(packaged.directory, 'build.json'), JSON.stringify({ buildId: 'a'.repeat(64) }));
  dev.load();
  packaged.load();
  const first = JSON.parse(readFileSync(dev.configPath, 'utf8'));
  const second = JSON.parse(readFileSync(packaged.configPath, 'utf8'));
  assert.ok(first.nodes.local.local.executable);
  delete first.nodes.local.local.executable;
  assert.deepEqual(first, second);
});
test('parsing including recovery never provisions or converts files', async (t) => {
  const h = await fixture(t);
  h.parse();
  assert.deepEqual(requireFiles(h.directory), ['config']);
  const old = { cluster: { controlUrl: 'ws://host:3001/api/node' }, nodes: { gpu: { peer } } };
  h.save(old);
  h.parse();
  assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')), old);
  assert.ok(!existsSync(h.configPath + '.v1'));
  assert.ok(!existsSync(join(h.directory, 'config/control.key')));
});
function requireFiles(directory: string) {
  return readdirSync(directory).sort();
}
test('media and limits do not change restart hash; peer and RTC do', async (t) => {
  const h = await fixture(t);
  h.save({ nodes: { local }, media: { fps: 30 } });
  const first = h.parse().nodes.local;
  h.save({
    nodes: {
      local: {
        ...local,
        media: { encoder: 'nvenc' },
        limits: { maxSessions: 4, diskReserveBytes: 0, sessionMemoryBytes: 1 },
      },
    },
    media: { fps: 24 },
  });
  const next = h.parse().nodes.local;
  assert.equal(next.config.media.encoder, 'nvenc');
  assert.equal(next.config.media.fps, 24);
  assert.deepEqual(Object.keys(next.config).sort(), ['media', 'nodeId', 'peer', 'rtc']);
  assert.equal(first.configHash, next.configHash);
  assert.equal(
    first.configHash,
    createHash('sha256')
      .update(canonicalJson({ peer: first.config.peer, rtc: first.config.rtc }))
      .digest('hex'),
  );
  h.save({ nodes: { local: { ...local, peer: { listen: '127.0.0.1:3102' } } } });
  assert.notEqual(h.parse().nodes.local.configHash, first.configHash);
  h.save({ nodes: { local: { ...local, rtc: { ports: '40000-40001' } } } });
  assert.notEqual(h.parse().nodes.local.configHash, first.configHash);
});
test('node network, media, limits, bootstrap and unknown keys are strictly validated', async (t) => {
  const h = await fixture(t);
  for (const nodes of [
    { a: local, b: remote },
    {
      a: { ...local, peer: { listen: '127.0.0.1:3101', address: 'a:3101' } },
      b: { ...local, local: { ...local.local, root: 'other' }, peer },
    },
    { a: { ...local, remote: remote.remote } },
    { a: {} },
    { a: { remote: { control: 'https://host/api/node' } } },
    { a: { ...local, peer: { listen: 'bad' } } },
    { a: { ...local, peer: { listen: '127.0.0.1:0' } } },
    { a: { ...local, rtc: { address: 'viewer.test' } } },
    { a: { ...local, rtc: { ports: '5000-4000' } } },
    { a: { ...local, rtc: { ports: '40000-40001', address: 'bad host' } } },
    ...[0, -1, '2', 1.5].map((sessionMemoryBytes) => ({ a: { ...local, limits: { sessionMemoryBytes } } })),
    { a: { ...local, limits: { maxSessions: 0 } } },
    { a: { ...local, media: { fps: 0 } } },
    { a: { ...local, media: { encoder: 'nvenc', qsvLowPower: 'on' } } },
    { a: { ...local, media: { unknown: 1 } } },
    { a: { ...local, extra: true } },
  ]) {
    h.save({ nodes });
    assert.throws(h.parse, JSON.stringify(nodes));
  }
  h.save({
    nodes: {
      a: { ...local, peer: { listen: '127.0.0.1:3101', address: 'a:3101' } },
      b: { ...local, local: { ...local.local, root: 'b' }, peer },
    },
  });
  assert.throws(h.parse, /a.*b.*3101/);
  for (const [field, value] of Object.entries(mediaDefaults)) {
    if (typeof value !== 'number') continue;
    h.save({ nodes: { local }, media: { [field]: '1' } });
    assert.throws(h.parse);
  }
});

for (const [nodeId, node] of [
  ['local', local],
  ['gpu', remote],
] as const) {
  for (const change of [
    'control_key',
    'node_id',
    'unparseable',
    'unknown_key',
    'private_key',
    'missing_key',
    'invalid_control_key',
    'missing_file',
  ] as const) {
    test(`${nodeId} bootstrap regenerates for ${change}`, async (t) => {
      const h = await fixture(t);
      h.save({ nodes: { [nodeId]: node } });
      const first = h.load();
      const file = first.nodes[nodeId].bootstrapFile;
      const bootstrap = JSON.parse(readFileSync(file, 'utf8'));
      const warnings: unknown[][] = [];
      t.mock.method(log, 'warn', (...args: unknown[]) => {
        warnings.push(args);
      });
      let reason: string;
      if (change === 'control_key') {
        writeFileSync(join(h.directory, 'config/control.key'), Buffer.alloc(32, 7).toString('base64'));
        reason = 'control_public_key_changed';
      } else if (change === 'missing_file') {
        rmSync(file);
        reason = 'missing_bootstrap';
      } else if (change === 'unparseable') {
        writeFileSync(file, '{');
        reason = 'invalid_bootstrap';
      } else {
        if (change === 'node_id') bootstrap.nodeId = 'other-node';
        if (change === 'unknown_key') bootstrap.key = 'old';
        if (change === 'private_key') bootstrap.privateKey = 'invalid';
        if (change === 'missing_key') delete bootstrap.privateKey;
        if (change === 'invalid_control_key') bootstrap.controlPublicKey = 'invalid';
        writeFileSync(file, JSON.stringify(bootstrap));
        reason = change === 'node_id' ? 'node_id_changed' : 'invalid_bootstrap';
      }
      const regenerated = h.load();
      const replacement = JSON.parse(readFileSync(file, 'utf8'));
      assert.notEqual(regenerated.nodes[nodeId].publicKey, first.nodes[nodeId].publicKey);
      assert.equal(replacement.nodeId, nodeId);
      assert.equal(replacement.controlPublicKey, regenerated.identity.publicKey);
      assert.equal(
        publicKey(Buffer.from(replacement.privateKey, 'base64')).toString('base64'),
        regenerated.nodes[nodeId].publicKey,
      );
      assert.deepEqual(warnings, [['config.identity_regenerated', { nodeId, reason }]]);
      assert.equal(h.load().nodes[nodeId].publicKey, regenerated.nodes[nodeId].publicKey);
      assert.equal(warnings.length, 1);
    });
  }
}

test('a changed remote control URL updates the bootstrap without rotating its identity', async (t) => {
  const h = await fixture(t);
  h.save({ nodes: { gpu: remote } });
  const first = h.load();
  const file = first.nodes.gpu.bootstrapFile;
  const bootstrap = JSON.parse(readFileSync(file, 'utf8'));
  const warnings: unknown[][] = [];
  const updates: unknown[][] = [];
  t.mock.method(log, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  t.mock.method(log, 'info', (...args: unknown[]) => {
    updates.push(args);
  });
  const control = 'wss://new-control.test:3443/api/node';
  h.save({ nodes: { gpu: { ...remote, remote: { control } } } });
  const next = h.load();
  assert.equal(next.nodes.gpu.publicKey, first.nodes.gpu.publicKey);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...bootstrap, control });
  assert.deepEqual(warnings, []);
  assert.deepEqual(updates, [['config.bootstrap_updated', { nodeId: 'gpu' }]]);
  h.load();
  assert.equal(updates.length, 1);
});

test('v1 conversion preserves realistic network, tuning, policy and session import', async (t) => {
  const h = await fixture(t);
  const old = {
    http: { listen: '0.0.0.0:3001' },
    storage: { database: '../data/control.db' },
    cluster: { keyFile: 'cluster.key', controlUrl: 'ws://control.lan:3001/api/node' },
    nodeDefaults: {
      fps: 30,
      bitrate: 12000000,
      maxSessions: 12,
      sessionMemoryBytes: 1048576,
      diskReserveBytes: 4096,
      dataPath: 'data',
      peer: { listen: '0.0.0.0:3101' },
    },
    nodes: {
      local: { local: local.local, peer: { listen: '127.0.0.1:3102' }, browser: 'custom.exe' },
      gpu: {
        peer: { address: 'gpu.lan:3101' },
        encoder: 'nvenc',
        maxSessions: 8,
        controlUrl: 'wss://public.test/api/node',
      },
    },
    quotas: { tenantObjectBytes: 4096 },
    sessionImport: {
      mailbox: 'operator@example.test',
      appMailbox: 'app@example.test',
      imap: { host: 'imap.example.test', user: 'operator', password: 'secret' },
      smtp: { host: 'smtp.example.test', port: 465, user: 'operator', password: 'secret' },
    },
  };
  const conversion = convertV1(old);
  assert.equal(conversion.config.media.fps, 30);
  assert.equal(conversion.config.nodes.gpu.media.encoder, 'nvenc');
  assert.equal(conversion.config.nodes.gpu.limits.maxSessions, 8);
  assert.equal(conversion.config.nodes.gpu.remote.control, 'wss://public.test/api/node');
  assert.match(conversion.warnings[0], /custom.exe/);
  assert.ok(!('browser' in conversion.config.nodes.local));
  h.save(old);
  writeFileSync(join(h.directory, 'config/cluster.key'), 'old PSK');
  const result = h.load();
  assert.deepEqual(JSON.parse(readFileSync(h.configPath + '.v1', 'utf8')), old);
  assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')), conversion.config);
  assert.ok(existsSync(result.nodes.local.bootstrapFile));
  assert.ok(existsSync(result.nodes.gpu.bootstrapFile));
  assert.ok(!existsSync(join(h.directory, 'config/cluster.key')));
  assert.equal(h.load().nodes.gpu.publicKey, result.nodes.gpu.publicKey);
});
test('build identity and release validate descriptor, archive size and hash at startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-build-'));
  const controlRoot = join(directory, 'control');
  try {
    assert.equal(readBuildId(controlRoot), 'dev');
    assert.equal(loadRelease(controlRoot, 'dev'), undefined);
    await writeFile(join(directory, 'build.json'), '{}');
    assert.throws(() => readBuildId(controlRoot), { code: 'invalid_request' });
    const buildId = 'a'.repeat(64);
    await writeFile(join(directory, 'build.json'), JSON.stringify({ buildId }));
    assert.equal(readBuildId(controlRoot), buildId);
    await mkdir(join(directory, 'release'));
    const archive = Buffer.from('release archive');
    const descriptor = {
      buildId,
      size: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex'),
    };
    await writeFile(join(directory, 'release/node.tar.zst'), archive);
    await writeFile(join(directory, 'release/node.json'), JSON.stringify(descriptor));
    assert.deepEqual(loadRelease(controlRoot, buildId)!.descriptor, descriptor);
    assert.throws(() => loadRelease(controlRoot, 'dev'), { code: 'invalid_request' });
    await writeFile(join(directory, 'release/node.tar.zst'), Buffer.alloc(archive.length));
    assert.throws(() => loadRelease(controlRoot, buildId), { code: 'invalid_request' });
    await writeFile(join(directory, 'release/node.tar.zst'), Buffer.alloc(1));
    assert.throws(() => loadRelease(controlRoot, buildId), { code: 'invalid_request' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('face templates, placements and profile keys survive a Control restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-placement-'));
  const path = join(directory, 'control.db');
  let store = new ControlDatabase(path, { buildId: 'test' });
  const template = Array(128).fill(1 / Math.sqrt(128));
  const face = store.security.faceVault.seal('user', template, 'model');
  store.db.close();
  try {
    store = new ControlDatabase(path, { buildId: 'test' });
    assert.deepEqual(store.security.faceVault.open('user', face, 'model'), template);
    const nodes = new NodeRegistry({
      nodes: { alpha: testNode('alpha') },
      privateKey: Buffer.alloc(32).toString('base64'),
      buildId: 'dev',
    });
    nodes.get('alpha')!.state = { state: 'ready', incarnation: 'process', connectionEpoch: 'epoch' };
    nodes.get('alpha')!.metrics.record(fakeMetrics());
    let placement = new Placement(store, nodes);
    const assigned = placement.resolve('tenant');
    const profileKey = placement.keys(assigned).profileKey;
    store.db.close();
    store = new ControlDatabase(path, { buildId: 'test' });
    placement = new Placement(store, nodes);
    assert.deepEqual(placement.resolve('tenant'), assigned);
    assert.equal(placement.keys(placement.resolve('tenant')).profileKey, profileKey);
    assert.deepEqual(store.security.faceVault.open('user', face, 'model'), template);
    nodes.stop();
  } finally {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
