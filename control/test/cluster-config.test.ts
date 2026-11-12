import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeConfig, parseConfig, defaultConfig } from '../server/config';
import {
  configDocument,
  controlKey,
  nodeBootstrap,
  decodeConfigFile,
  encodeConfigFile,
} from '../server/config-formats';
import { configMigrations } from '../server/config-migrations';
import { publicKey } from '../server/cluster/noise';
import { readBuildId } from '../server/cluster/build-id';
import { loadRelease } from '../server/cluster/release';
import { NodeRegistry } from '../server/cluster/node-link';
import { ControlDatabase } from '../server/persistence/database';
import { Placement } from '../server/cluster/placement';
import { fakeMetrics } from './fake-node';
import { testNode } from './node-fixture';

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
test('new configuration and identity files are versioned and stable', async (t) => {
  const h = await fixture(t);
  h.parse();
  assert.deepEqual(readdirSync(h.directory), ['config']);
  const first = h.load();
  assert.equal(first.dbPath, join(h.directory, 'data/control.db'));
  assert.equal(first.nodes.local.local!.root, join(h.directory, 'data/node'));
  assert.deepEqual(h.load().identity, first.identity);
  assert.equal(h.load().nodes.local.publicKey, first.nodes.local.publicKey);
  const key = decodeConfigFile(
    readFileSync(join(h.directory, 'config/control.key'), 'utf8'),
    controlKey,
    'key',
  );
  assert.equal(key.version, 1);
  const bootstrap = decodeConfigFile(
    readFileSync(first.nodes.local.bootstrapFile, 'utf8'),
    nodeBootstrap,
    'node',
  );
  assert.equal(bootstrap.version, 1);
  assert.equal(
    publicKey(Buffer.from(bootstrap.privateKey, 'base64')).toString('base64'),
    first.nodes.local.publicKey,
  );
  assert.deepEqual(
    Object.values(configMigrations).map((steps) => steps.length),
    [0, 0, 0, 0],
  );
});
test('configuration codecs accept writer output and reject missing, unknown and mistyped fields', () => {
  const samples = [
    [configDocument, defaultConfig('dev'), 'control'],
    [controlKey, { version: 1, privateKey: Buffer.alloc(32).toString('base64') }, 'key'],
    [
      nodeBootstrap,
      {
        version: 1,
        nodeId: 'gpu',
        privateKey: Buffer.alloc(32).toString('base64'),
        controlPublicKey: Buffer.alloc(32).toString('base64'),
      },
      'node',
    ],
  ] as const;
  for (const [codec, value, store] of samples) {
    const encoded = encodeConfigFile<unknown>(value, codec, store);
    assert.deepEqual(
      decodeConfigFile(encoded, codec as import('../server/persistence/codec').Codec<unknown>, store),
      value,
    );
    for (const bad of [
      { ...value, version: undefined },
      { ...value, unknown: true },
      { ...value, version: '1' },
    ]) {
      assert.throws(
        () =>
          decodeConfigFile(
            JSON.stringify(bad),
            codec as import('../server/persistence/codec').Codec<unknown>,
            store,
          ),
        (error: any) => error.reason === 'corrupt_state' && /^c-[0-9a-f]{10}$/.test(error.errorId),
      );
      assert.throws(() => encodeConfigFile<unknown>(bad, codec, store), { reason: 'corrupt_state' });
    }
  }
});
test('all required config sections and fields stay required', async (t) => {
  const h = await fixture(t);
  for (const section of ['http', 'storage', 'media', 'quotas', 'nodes'] as const) {
    const value = defaultConfig('dev') as Record<string, unknown>;
    delete value[section];
    h.save(value);
    assert.throws(h.parse, { reason: 'corrupt_state' });
  }
  const value = defaultConfig('dev');
  delete (value.nodes.local.limits as Partial<typeof value.nodes.local.limits>).maxSessions;
  h.save(value);
  assert.throws(h.parse, { reason: 'corrupt_state' });
});
test('invalid bootstraps fail without changing their bytes or rotating identity', async (t) => {
  const h = await fixture(t);
  const config = h.load();
  const file = config.nodes.local.bootstrapFile;
  const original = JSON.parse(readFileSync(file, 'utf8'));
  for (const value of [
    { ...original, privateKey: undefined },
    { ...original, unknown: true },
    { ...original, nodeId: 7 },
    { ...original, nodeId: 'different' },
    { ...original, privateKey: 'invalid' },
  ]) {
    const bytes = JSON.stringify(value);
    writeFileSync(file, bytes);
    assert.throws(h.load, { reason: 'corrupt_state' });
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
});
test('node tuning inherits only declared optional per-node overrides', async (t) => {
  const h = await fixture(t);
  const value = defaultConfig('dev');
  value.media = { ...value.media, fps: 30 };
  h.save(value);
  const first = h.parse().nodes.local;
  h.save({ ...value, nodes: { local: { ...value.nodes.local, media: { encoder: 'nvenc' } } } });
  const next = h.parse().nodes.local;
  assert.equal(next.config.media.encoder, 'nvenc');
  assert.equal(next.config.media.fps, 30);
  assert.equal(next.configHash, first.configHash);
  const invalid = {
    ...value,
    nodes: { local: { ...value.nodes.local, rtc: { ports: '5000-4000', address: null } } },
  };
  h.save(invalid);
  assert.throws(h.parse, { reason: 'corrupt_state' });
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
