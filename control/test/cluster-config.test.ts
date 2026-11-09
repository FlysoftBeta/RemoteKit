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

test('packaged defaults resolve deployment storage and each local node runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-packaged-config-'));
  const buildId = 'b'.repeat(64);
  const version = join(directory, 'versions', buildId);
  const configPath = join(directory, 'config', 'control.json');
  await mkdir(version, { recursive: true });
  await writeFile(join(version, 'build.json'), JSON.stringify({ buildId }));
  const load = () => runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, [], join(version, 'control'));
  try {
    const config = load();
    assert.deepEqual(config.origins, ['http://127.0.0.1:3001', 'http://localhost:3001']);
    assert.equal(config.dbPath, join(directory, 'data/control.db'));
    assert.equal(config.diagnosticDir, join(directory, 'data/diagnostics'));
    assert.equal(config.cluster.keyFile, join(directory, 'config/cluster.key'));
    assert.deepEqual(config.nodes.local.local, {
      root: join(directory, 'data/node'),
      executable: join(directory, 'data/node/runtime', buildId, 'bin/endpoint_service.exe'),
      versionDir: version,
    });
    await writeFile(configPath, JSON.stringify({ nodes: { other: { local: { root: '../custom-node' } } } }));
    assert.equal(
      load().nodes.other.local!.executable,
      join(directory, 'custom-node/runtime', buildId, 'bin/endpoint_service.exe'),
    );
    await writeFile(
      configPath,
      JSON.stringify({ nodes: { other: { local: { root: '../custom-node', executable: 'override.exe' } } } }),
    );
    assert.throws(load, { code: 'invalid_request' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('config creates defaults and key, resolves paths, hashes effective overrides and exports frozen values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-config-'));
  const configPath = join(directory, 'control.json');
  const load = () => runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath, PORT: '1234' }, []);
  try {
    const initial = load();
    assert.equal(initial.port, 3001);
    assert.equal(initial.nodes.local.config.maxSessions, null);
    assert.deepEqual(initial.nodes.local.config.peer, {
      listen: '0.0.0.0:3101',
      address: '127.0.0.1:3101',
    });
    assert.deepEqual(initial.nodes.local.config.rtc, { ports: null, address: null });
    assert.equal(initial.nodes.local.config.diskReserveBytes, null);
    assert.equal(initial.nodes.local.config.sessionMemoryBytes, null);
    assert.equal(initial.quotas.tenantObjectBytes, null);
    assert.equal(Buffer.from(initial.cluster.key, 'base64').length, 32);
    assert.equal(
      initial.nodes.local.local!.executable,
      resolve(directory, '../../build/endpoint/endpoint/endpoint_service.exe'),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        http: { listen: '0.0.0.0:0', origins: ['https://viewer.test'] },
        storage: { database: 'db/control.db', diagnostics: 'archives' },
        cluster: { controlUrl: 'ws://192.168.1.10:3001/api/node' },
        nodeDefaults: { fps: 30, dataPath: 'tenant-data', browser: 'browser.exe' },
        nodes: {
          alpha: {
            fps: 60,
            peer: { address: 'alpha.test:3101' },
            rtc: { ports: '40000-40019', address: 'viewer-facing.example' },
          },
          beta: { controlUrl: 'wss://control.example/api/node', peer: { address: 'beta.test:3101' } },
          local: { local: { executable: '../bin/endpoint.exe', root: 'root' } },
        },
      }),
    );
    const config = load();
    assert.equal(config.port, 0);
    assert.equal(config.host, '0.0.0.0');
    assert.deepEqual(config.nodes.alpha.config.rtc, {
      ports: '40000-40019',
      address: 'viewer-facing.example',
    });
    assert.equal(config.nodes.local.local!.executable, resolve(directory, '../bin/endpoint.exe'));
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
            peer: { listen: '0.0.0.0:3101', address: '127.0.0.1:3101' },
            rtc: { ports: null, address: null },
          }),
        )
        .digest('hex'),
    );
    for (const value of [
      config,
      config.nodes,
      config.nodes.local,
      config.nodes.local.config,
      config.nodes.local.local,
      config.origins,
      config.cluster,
    ])
      assert.ok(Object.isFrozen(value));
    const nodeFile = (nodeId: string) =>
      readFile(join(directory, 'nodes', nodeId, 'node.json'), 'utf8').then(JSON.parse);
    assert.deepEqual(await nodeFile('alpha'), {
      nodeId: 'alpha',
      control: 'ws://192.168.1.10:3001/api/node',
      key: initial.cluster.key,
    });
    assert.deepEqual(await nodeFile('beta'), {
      nodeId: 'beta',
      control: 'wss://control.example/api/node',
      key: initial.cluster.key,
    });
    await assert.rejects(nodeFile('local'));
    assert.equal(load().cluster.key, initial.cluster.key);
    await writeFile(configPath, JSON.stringify({ nodes: {} }));
    assert.deepEqual(Object.keys(load().nodes), []);
    await assert.rejects(nodeFile('alpha'));
    await writeFile(join(directory, 'cluster.key'), 'invalid');
    assert.throws(load, { code: 'invalid_request' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('config accepts null or explicit quotas and node limits, including zero byte floors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-optional-limits-'));
  const configPath = join(directory, 'control.json');
  try {
    for (const limits of [
      { maxSessions: null, diskReserveBytes: null, sessionMemoryBytes: null, tenantObjectBytes: null },
      { maxSessions: 4, diskReserveBytes: 1000, sessionMemoryBytes: 2000, tenantObjectBytes: 3000 },
      { maxSessions: 1, diskReserveBytes: 0, sessionMemoryBytes: 0, tenantObjectBytes: 1 },
    ]) {
      const { tenantObjectBytes, ...nodeLimits } = limits;
      await writeFile(
        configPath,
        JSON.stringify({
          nodeDefaults: { maxSessions: 10, diskReserveBytes: 100, sessionMemoryBytes: 100 },
          quotas: { tenantObjectBytes },
          nodes: { local: { ...nodeLimits, local: { executable: 'endpoint.exe', root: 'node' } } },
        }),
      );
      const config = runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, []);
      for (const key of ['maxSessions', 'diskReserveBytes', 'sessionMemoryBytes'] as const)
        assert.equal(config.nodes.local.config[key], nodeLimits[key]);
      assert.equal(config.quotas.tenantObjectBytes, tenantObjectBytes);
    }
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
      { cluster: { controlUrl: 'ws://test/api/node' }, nodes: { alpha: {}, beta: {} } },
      { nodes: { remote: {} } },
      { nodeDefaults: { rtc: { ports: '3000' } } },
      { nodeDefaults: { rtc: { ports: '900-1000' } } },
      { nodeDefaults: { rtc: { ports: '5000-4000' } } },
      { nodeDefaults: { rtc: { address: 'viewer.test' } } },
      { nodeDefaults: { rtc: { ports: '40000-40001', address: 'bad host' } } },
      { nodes: { local: { local: { executable: 'e.exe', root: 'r' }, controlUrl: 'ws://t/api/node' } } },
      { quotas: { tenantObjectBytes: -1 } },
      { quotas: { tenantObjectBytes: 0 } },
      { quotas: { tenantObjectBytes: 1.5 } },
      { nodeDefaults: { maxSessions: 0 } },
      { nodeDefaults: { maxSessions: '3' } },
      { quotas: { tenantObjectBytes: '1000' } },
      { nodeDefaults: { peer: { listen: 'invalid' } } },
      { nodeDefaults: { peer: { address: 'host:65536' } } },
      { nodeDefaults: { peer: { advertise: 'host:3101' } } },
      { nodeDefaults: { diskReserveBytes: -1 } },
      { nodeDefaults: { sessionMemoryBytes: -1 } },
      { nodes: { Bad_ID: {} } },
      { extra: true },
      { http: null },
      { http: { port: 3001 } },
      { http: { listen: '3001' } },
      { http: { listen: 'host:65536' } },
      { http: { origins: 'http://test' } },
      { http: { tls: { key: 'key' } } },
      { database: 'control.db' },
      { storage: { database: null } },
      { storage: { diagnostics: false } },
      { cluster: { keyFile: null } },
      { cluster: { advertiseUrl: 'ws://test/api/node' } },
      { cluster: { controlUrl: 'http://test/api/node' } },
      { cluster: { controlUrl: 'ws://test/api/endpoint' } },
      { nodeDefaults: { local: {} } },
      { nodeDefaults: null },
      { nodes: { local: { launch: { executable: 'endpoint', root: 'root' } } } },
      { nodes: { local: { local: { executable: 'endpoint' } } } },
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
    await writeFile(
      configPath,
      JSON.stringify({ nodes: { local: { local: { executable: 'endpoint.exe', root: 'node' } } } }),
    );
    runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, []);
    for (const value of invalid) {
      const input =
        value && typeof value === 'object' && !Array.isArray(value)
          ? { nodes: { local: { local: { executable: 'endpoint.exe', root: 'node' } } }, ...value }
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
