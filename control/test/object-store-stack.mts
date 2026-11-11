import type { LibrarySnapshot } from '../shared/file-library';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createApplication } from '../server/application';
import { canonicalJson, nodeDefaults } from '../server/config';
import { NodeRegistry } from '../server/cluster/node-link';
import { Placement } from '../server/cluster/placement';
import { EndpointGateway } from '../server/endpoint/gateway';
import { ControlDatabase } from '../server/persistence/database';

const run = resolve(process.argv[2] ?? `develop/tmp/object-store/stack-${Date.now()}`);
await mkdir(run, { recursive: true });
const listener = createServer();
await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((done) => listener.close(() => done()));
const config = {
  ...nodeDefaults,
  nodeId: 'storage',
  maxSessions: 8,
  dataPath: join(run, 'data'),
  browser: process.argv[3] ?? 'C:/src/chromium/src/out/rel/remotekit_browser.exe',
  diskReserveBytes: 1024 * 1024,
  sessionMemoryBytes: 1024 * 1024,
  peer: { listen: `127.0.0.1:${port}`, address: `127.0.0.1:${port}` },
};
const store = new ControlDatabase(join(run, 'control.db'), { buildId: 'test' });
const nodes = new NodeRegistry({
  key: randomBytes(32).toString('base64'),
  buildId: 'dev',
  nodes: {
    storage: {
      config,
      configHash: createHash('sha256').update(canonicalJson(config)).digest('hex'),
      local: {
        executable: resolve('build/endpoint/endpoint/endpoint_service.exe'),
        root: join(run, 'node'),
      },
    },
  },
});
const endpoint = new EndpointGateway(nodes, new Placement(store, nodes));
const control = createApplication(store, endpoint);
const node = nodes.get('storage')!;
const located: { tenantId: string; ids: string[] }[] = [];
const locate = nodes.handlers.get('object.locate')!;
nodes.handlers.set('object.locate', (source, message) => {
  located.push({ tenantId: message.tenantId, ids: message.ids });
  return locate(source, message);
});
const until = async (probe: () => boolean) => {
  const deadline = Date.now() + 45000;
  while (!probe()) {
    assert.ok(Date.now() < deadline, 'Endpoint readiness timed out');
    await new Promise((done) => setTimeout(done, 100));
  }
};
const library = (tenant: string, method: string, params: object) =>
  control.library.request(
    tenant,
    'library.' + method,
    params,
    () => {},
    () => undefined,
  ) as Promise<LibrarySnapshot>;
let completed = false;
try {
  nodes.start();
  await until(() => node.state.state === 'ready' && !!node.metrics.latest());
  const chunks = async function* () {
    yield Buffer.from('One class attachment shared by two tenants.\n');
  };
  const first = await control.objects.put('first', chunks(), { maxBytes: 1024 });
  const second = await control.objects.put('second', chunks(), { maxBytes: 1024 });
  assert.deepEqual(second, first);
  assert.equal(control.objects.usage().objects, 1);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM object_claims').get() as { n: bigint }).n, 2n);
  const entries = new Map<string, string>();
  for (const tenant of ['first', 'second']) {
    const snapshot = await library(tenant, 'import', {
      operationId: randomUUID(),
      assetId: first.id,
      name: 'class.txt',
      destination: 'library',
      origin: { kind: 'files', channel: 'upload', partitionId: null },
    });
    entries.set(tenant, snapshot.entries[0].id);
    assert.equal(control.objects.bytes(tenant), first.size);
    assert.ok(located.some((request) => request.tenantId === tenant && request.ids.includes(first.id)));
  }
  const objects = await readdir(join(config.dataPath, 'objects', first.id.slice(0, 2)));
  assert.deepEqual(objects, [first.id + '.rko']);
  assert.equal(
    (await readFile(join(config.dataPath, 'objects', first.id.slice(0, 2), first.id + '.rko')))
      .subarray(0, 4)
      .toString(),
    'RKO2',
  );
  await endpoint.snapshot('stranger');
  await assert.rejects(node.request('session.library.describe', 'stranger', { assetId: first.id }), {
    code: 'forbidden',
  });
  store.db.exec('UPDATE object_claims SET claimed_at=0');
  await control.objects.gc();
  await library('first', 'delete', { operationId: randomUUID(), ids: [entries.get('first')] });
  await control.objects.gc();
  assert.equal(control.objects.usage().objects, 1);
  await library('second', 'delete', { operationId: randomUUID(), ids: [entries.get('second')] });
  const now = Date.now();
  await control.objects.gc(now);
  assert.equal(control.objects.usage().objects, 1);
  await control.objects.gc(now + 2 * 60 * 60 * 1000 + 1);
  assert.equal(control.objects.usage().objects, 0);

  await endpoint.ensureSession('first');
  await endpoint.hibernate('first');
  const firstPlacement = endpoint.placement.peek('first')!;
  const secondPlacement = endpoint.placement.peek('second')!;
  const firstDirectory = join(config.dataPath, 'sessions', firstPlacement.sessionId);
  const secondDirectory = join(config.dataPath, 'sessions', secondPlacement.sessionId);
  // A shared payload in two actual Session directories proves checkpoint block deduplication.
  const shared = Buffer.alloc(1024 * 1024, 17);
  await writeFile(join(firstDirectory, 'shared-checkpoint-block'), shared);
  await writeFile(join(secondDirectory, 'shared-checkpoint-block'), shared);
  await endpoint.snapshot('first');
  await endpoint.hibernate('first');
  await endpoint.hibernate('second');
  const sharedReferences = store.db
    .prepare(
      `SELECT id FROM checkpoint_objects WHERE tenant IN ('first','second') GROUP BY id HAVING count(DISTINCT tenant)=2`,
    )
    .all();
  assert.ok(sharedReferences.length > 0, 'Checkpoint blocks must be shared');
  const restored = endpoint.placement.peek('first')!;
  await rename(firstDirectory, firstDirectory + '.held');
  await endpoint.snapshot('first');
  assert.deepEqual(await readFile(join(firstDirectory, 'shared-checkpoint-block')), shared);
  assert.ok(
    located.some((request) => request.tenantId === 'first' && request.ids.includes(restored.checkpoint!)),
  );
  await endpoint.ensureSession('first');
  await endpoint.hibernate('first');
  await writeFile(
    join(run, 'result.json'),
    JSON.stringify(
      { objectId: first.id, sharedCheckpointObjects: sharedReferences.length, located, complete: true },
      null,
      2,
    ),
  );
  completed = true;
} finally {
  if (node.state.state === 'ready') await node.request('shutdown', '').catch(() => {});
  nodes.stop();
  await control.close();
  store.db.close();
}
assert.ok(completed);
console.log('Shared objects, tenant authorization, grace GC and checkpoint restore verified.');
