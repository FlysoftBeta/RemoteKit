import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalJson, nodeDefaults, runtimeConfig } from '../server/config';
import { readBuildId } from '../server/cluster/build-id';
import { loadRelease } from '../server/cluster/release';
import { fakeMetrics } from './fake-node';
import { ControlDatabase } from '../server/persistence/database';
import { Placement } from '../server/cluster/placement';
import { NodeRegistry } from '../server/cluster/node-link';

test('config creates defaults and key, resolves paths, hashes effective overrides and exports frozen values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-config-'));
  const configPath = join(directory, 'control.json');
  const load = () => runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath, PORT: '1234' }, []);
  try {
    const initial = load();
    assert.equal(initial.port, 3001);
    assert.deepEqual(initial.nodes.local.config.peer, {
      listen: '0.0.0.0:3101',
      advertise: '127.0.0.1:3101',
    });
    assert.equal(initial.nodes.local.config.diskReserveBytes, 10 * 1024 ** 3);
    assert.equal(initial.nodes.local.config.sessionMemoryBytes, 2 * 1024 ** 3);
    assert.equal(initial.quotas.tenantObjectBytes, 4 * 1024 ** 3);
    assert.equal(Buffer.from(initial.cluster.key, 'base64').length, 32);
    assert.equal(
      initial.nodes.local.launch!.executable,
      resolve(directory, '../../build/endpoint/endpoint/endpoint_service.exe'),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        http: { port: 0, origins: ['https://viewer.test'] },
        database: 'db/control.db',
        diagnostics: 'archives',
        cluster: { advertiseUrl: 'ws://192.168.1.10:3001/api/node' },
        nodeDefaults: { fps: 30, dataPath: 'tenant-data', browser: 'browser.exe' },
        nodes: {
          alpha: { fps: 60, peer: { advertise: 'alpha.test:3101' } },
          local: { launch: { executable: '../bin/endpoint.exe', root: 'root' } },
        },
      }),
    );
    const config = load();
    assert.equal(config.port, 0);
    assert.equal(config.dbPath, join(directory, 'db/control.db'));
    assert.equal(config.diagnosticDir, join(directory, 'archives'));
    assert.equal(config.nodes.alpha.config.fps, 60);
    assert.equal(config.nodes.local.config.fps, 30);
    assert.equal(config.nodes.local.config.browser, 'browser.exe');
    assert.equal(config.nodes.local.config.dataPath, 'tenant-data');
    assert.equal(
      config.nodes.local.configHash,
      createHash('sha256')
        .update(
          canonicalJson({
            ...nodeDefaults,
            fps: 30,
            dataPath: 'tenant-data',
            browser: 'browser.exe',
            nodeId: 'local',
            peer: { listen: '0.0.0.0:3101', advertise: '127.0.0.1:3101' },
          }),
        )
        .digest('hex'),
    );
    for (const value of [
      config,
      config.nodes,
      config.nodes.local,
      config.nodes.local.config,
      config.nodes.local.launch,
      config.origins,
      config.cluster,
    ])
      assert.ok(Object.isFrozen(value));
    const bootstrap = JSON.parse(await readFile(join(directory, 'node.json'), 'utf8'));
    assert.deepEqual(bootstrap, { control: 'ws://192.168.1.10:3001/api/node', key: initial.cluster.key });
    assert.equal(load().cluster.key, initial.cluster.key);
    await writeFile(configPath, JSON.stringify({ nodes: {} }));
    assert.deepEqual(Object.keys(load().nodes), []);
    await writeFile(join(directory, 'cluster.key'), 'invalid');
    assert.throws(load, { code: 'invalid_request' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('config rejects unknown fields, wrong types, invalid ranges and invalid combinations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-invalid-config-'));
  const configPath = join(directory, 'control.json');
  try {
    const invalid: unknown[] = [
      null,
      [],
      { nodes: { alpha: {}, beta: {} } },
      { quotas: { tenantObjectBytes: -1 } },
      { quotas: { tenantObjectBytes: '1000' } },
      { nodeDefaults: { peer: { listen: 'invalid' } } },
      { nodeDefaults: { peer: { advertise: 'host:65536' } } },
      { nodeDefaults: { diskReserveBytes: -1 } },
      { nodeDefaults: { sessionMemoryBytes: 0 } },
      { nodes: { Bad_ID: {} } },
      { extra: true },
      { http: null },
      { http: { port: '3001' } },
      { http: { port: -1 } },
      { http: { host: null } },
      { http: { origins: 'http://test' } },
      { http: { tls: { key: 'key' } } },
      { database: null },
      { diagnostics: false },
      { cluster: { keyFile: null } },
      { cluster: { advertiseUrl: 'http://test/api/node' } },
      { cluster: { advertiseUrl: 'ws://test/api/endpoint' } },
      { nodeDefaults: { launch: {} } },
      { nodeDefaults: null },
      { nodes: { local: { launch: { executable: 'endpoint' } } } },
      { nodes: { local: { ignored: true } } },
    ];
    for (const [field, value] of Object.entries({
      fps: 0,
      bitrate: 50000001,
      maxBitrate: 100000,
      asyncDepth: 9,
      gop: 65536,
      targetUsage: 8,
      bufferMs: 49,
      idleIdrMs: 4294967296,
      maxEncodeWidth: 15,
      maxEncodeHeight: 4097,
      maxSessions: 65,
      encoder: 'software',
      rateControl: 'quality',
      qsvLowPower: 'yes',
      browser: false,
      dataPath: null,
    }))
      invalid.push({ nodeDefaults: { [field]: value } });
    invalid.push({ nodeDefaults: { encoder: 'nvenc', qsvLowPower: 'on' } });
    for (const value of invalid) {
      const input =
        value && typeof value === 'object' && !Array.isArray(value)
          ? { nodes: { local: {} }, ...value }
          : value;
      await writeFile(configPath, JSON.stringify(input));
      assert.throws(
        () => runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, []),
        { code: 'invalid_request' },
        JSON.stringify(input),
      );
    }
    await writeFile(configPath, '{');
    assert.throws(() => runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, []), {
      code: 'invalid_request',
    });
    assert.throws(() => runtimeConfig({}, ['--unexpected']), { code: 'invalid_request' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  let store = new ControlDatabase(path);
  const template = Array(128).fill(1 / Math.sqrt(128));
  const face = store.security.faceVault.seal('user', template, 'model');
  store.db.close();
  try {
    store = new ControlDatabase(path);
    assert.deepEqual(store.security.faceVault.open('user', face, 'model'), template);
    const nodes = new NodeRegistry({
      nodes: { alpha: { config: { ...nodeDefaults, nodeId: 'alpha' }, configHash: 'hash' } },
      key: Buffer.alloc(32).toString('base64'),
      buildId: 'dev',
    });
    nodes.get('alpha')!.state = { state: 'ready', incarnation: 'process', connectionEpoch: 'epoch' };
    nodes.get('alpha')!.metrics.record(fakeMetrics());
    let placement = new Placement(store, nodes);
    const assigned = placement.resolve('tenant');
    const profileKey = placement.keys(assigned).profileKey;
    store.db.close();
    store = new ControlDatabase(path);
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
