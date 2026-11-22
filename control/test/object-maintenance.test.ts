import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ControlDatabase } from '../server/persistence/database';
import { ObjectIndex } from '../server/cluster/objects';
import type { NodeRegistry } from '../server/cluster/node-link';
import { createReadPool } from '../server/workers/read-pool';
import { tenantObjects } from '../server/persistence/object-references';

const scratch = resolve(import.meta.dirname, '../../develop/tmp');
const id = (n: number) => n.toString(16).padStart(64, '0');

function maintenanceFixture() {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  let now = 1_000_000;
  let free = 1e12;
  const node = Object.assign(new EventEmitter(), {
    nodeId: 'node',
    state: { state: 'ready', connectionEpoch: 'epoch' },
    diskDraining: false,
    limits: { diskReserveBytes: 1e9 },
    config: { peer: { address: 'node.test' } },
    metrics: { latest: () => ({ value: { disk: { total: 1e12, free } } }) },
    async request() {
      return {};
    },
  });
  const registry = Object.assign(new EventEmitter(), {
    handlers: new Map(),
    all: () => [node],
    get: () => node,
    isRemoved: () => false,
    options: { buildId: 'test' },
    objectKeys: { objectIdKey: Buffer.alloc(32).toString('base64') },
  }) as unknown as NodeRegistry;
  const index = new ObjectIndex(
    store,
    registry,
    null,
    () => true,
    () => false,
    () => now,
  );
  let passes = 0;
  const gc = index.gc.bind(index);
  index.gc = (at?: number) => {
    passes++;
    return gc(at);
  };
  return {
    index,
    registry,
    get passes() {
      return passes;
    },
    advance(ms: number) {
      now += ms;
    },
    setFree(bytes: number) {
      free = bytes;
    },
    async close() {
      await index.close();
      await store.close();
    },
  };
}

test('maintenance runs on change at most every five seconds, sweeps each minute, and ignores steady metrics', async () => {
  const f = maintenanceFixture();
  try {
    await f.index.scheduled();
    assert.equal(f.passes, 1, 'the first pass runs at once');
    await f.index.scheduled();
    assert.equal(f.passes, 1, 'nothing changed');
    f.index.invalidate();
    f.advance(4_999);
    await f.index.scheduled();
    assert.equal(f.passes, 1, 'a change waits for the minimum interval');
    f.advance(1);
    await f.index.scheduled();
    assert.equal(f.passes, 2);
    f.registry.emit('metrics', 'node');
    f.advance(5_000);
    await f.index.scheduled();
    assert.equal(f.passes, 3, 'the first metrics sample sets the disk band');
    for (let n = 0; n < 10; n++) f.registry.emit('metrics', 'node');
    f.advance(5_000);
    await f.index.scheduled();
    assert.equal(f.passes, 3, 'metrics within the same disk band change nothing');
    f.setFree(5e8);
    f.registry.emit('metrics', 'node');
    await f.index.scheduled();
    assert.equal(f.passes, 4, 'crossing the disk floor changes the band');
    f.advance(59_999);
    await f.index.scheduled();
    assert.equal(f.passes, 4);
    f.advance(1);
    await f.index.scheduled();
    assert.equal(f.passes, 5, 'the sweep runs without changes');
  } finally {
    await f.close();
  }
});

test('read workers answer from their own connection and report failures by code', async () => {
  const directory = mkdtempSync(join(scratch, 'read-pool-'));
  const store = new ControlDatabase(join(directory, 'control.db'), { buildId: 'test' });
  try {
    for (let n = 1; n <= 3; n++)
      store.db.prepare('INSERT INTO objects VALUES (?,?,?,?,?)').run(id(n), n, n, id(n), n);
    store.db.prepare('INSERT INTO object_claims VALUES (?,?,?)').run('tenant', id(2), Date.now());
    store.db.prepare('INSERT INTO object_derivations VALUES (?,?,?)').run(id(3), id(2), 'thumbnail');
    const input = { now: Date.now(), replicaNodes: [], target: 0, perTenant: true };
    const inline = await createReadPool(':memory:', store.db).run('objects.storage', input);
    const worker = await store.readers.run('objects.storage', input);
    assert.deepEqual(worker, inline);
    assert.deepEqual(worker.tenants, { tenant: { objects: 2, bytes: 5 } });
    assert.deepEqual(tenantObjects(store.db).get('tenant'), new Set([id(2), id(3)]));
    // The worker validates rows as strictly as the main connection.
    store.db.prepare("UPDATE objects SET size='broken' WHERE id=?").run(id(1));
    await assert.rejects(store.readers.run('objects.storage', input), { code: 'internal' });
    await store.readers.close();
    await assert.rejects(store.readers.run('objects.storage', input), { code: 'unavailable' });
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
