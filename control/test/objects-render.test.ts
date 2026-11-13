import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ObjectIndex } from '../server/cluster/objects';
import limits from '../../protocol/limits.json';
import { encodeJson } from '../server/cluster/frames';
import type { NodeLink, NodeRegistry } from '../server/cluster/node-link';
import { ControlDatabase } from '../server/persistence/database';
import { RemoteKitError } from '../shared/errors';

const source = 'a'.repeat(64);
const document = 'b'.repeat(64);
const HOUR = 3600_000;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('worst-case escaped object locate reply fits half the management budget', () => {
  const sources = Object.fromEntries(
    Array.from({ length: limits.objectLocateIds }, (_, i) => [
      i.toString(16).padStart(64, '0'),
      Array.from({ length: limits.objectLocateSources }, () => ({
        nodeId: '\x01'.repeat(limits.objectSourceNodeIdBytes),
        address: '\x01'.repeat(limits.objectSourceAddressBytes),
      })),
    ]),
  );
  const reply = {
    id: '\x01'.repeat(limits.identityBytes),
    opId: '\x01'.repeat(limits.identityBytes),
    ok: true,
    result: { sources },
  };
  const bytes = Buffer.byteLength(JSON.stringify(reply));
  assert.equal(
    bytes,
    52 +
      12 * limits.identityBytes +
      limits.objectLocateIds *
        (69 +
          limits.objectLocateSources *
            (27 + 6 * (limits.objectSourceNodeIdBytes + limits.objectSourceAddressBytes))),
  );
  assert.ok(bytes < limits.managementBytes / 2);
  assert.equal(encodeJson(reply).length, bytes + 1);
});

test('object locate bounds IDs, source count and source strings and picks the least pressure', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < limits.objectLocateSources; i++) {
      const node = {
        ...f.nodes[0],
        nodeId: `replica-${i}`,
        metrics: { latest: () => ({ pressure: i + 2 }) },
      };
      f.nodes.push(node);
      f.store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(source, node.nodeId);
    }
    f.store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(source, 'beta');
    const locate = (ids: string[]) =>
      f.index.locate(f.nodes[0] as unknown as NodeLink, { tenantId: 'first', ids });
    const result = locate(Array(limits.objectLocateIds).fill(source));
    assert.equal(result.sources[source].length, limits.objectLocateSources);
    assert.deepEqual(
      result.sources[source].map((node) => node.nodeId),
      ['alpha', 'beta', ...Array.from({ length: limits.objectLocateSources - 2 }, (_, i) => `replica-${i}`)],
    );
    assert.throws(() => locate(Array(limits.objectLocateIds + 1).fill(source)), { code: 'invalid_request' });
    const first = f.nodes[0];
    f.store.db.prepare('DELETE FROM object_replicas WHERE node_id=?').run(first.nodeId);
    first.nodeId = 'n'.repeat(limits.objectSourceNodeIdBytes);
    first.config.peer.address = 'a'.repeat(limits.objectSourceAddressBytes);
    f.store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(source, first.nodeId);
    assert.equal(locate([source]).sources[source][0].nodeId, first.nodeId);
    first.config.peer.address += 'a';
    assert.throws(() => locate([source]), { code: 'limit_exceeded' });
    first.config.peer.address = 'a'.repeat(limits.objectSourceAddressBytes);
    f.store.db.prepare('DELETE FROM object_replicas WHERE node_id=?').run(first.nodeId);
    first.nodeId += 'n';
    f.store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(source, first.nodeId);
    assert.throws(() => locate([source]), { code: 'limit_exceeded' });
  } finally {
    await f.close();
  }
});

function putFixture() {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const offsets = new Map<string, number>();
  const chunks: number[] = [];
  let begins = 0;
  let ends = 0;
  const id = 'c'.repeat(64);
  const node = Object.assign(new EventEmitter(), {
    nodeId: 'node',
    state: { state: 'ready', connectionEpoch: 'epoch' },
    diskDraining: false,
    metrics: { latest: () => ({ value: { disk: { total: 1e12, free: 1e12 } } }) },
    async request(method: string, tenant: string, fields: { putId: string }) {
      if (method === 'object.put.begin') {
        begins++;
        offsets.set(fields.putId, 0);
      } else if (method === 'object.put.end') {
        ends++;
        const size = offsets.get(fields.putId)!;
        index.committed(node as unknown as NodeLink, {
          tenantId: 'tenant',
          putId: fields.putId,
          objectId: id,
          size,
          storedSize: size,
          storedSha256: id,
        });
        return { objectId: id, size };
      }
      return {};
    },
    async sendBinary(header: { putId: string; offset: number }, data: Uint8Array) {
      assert.equal(header.offset, offsets.get(header.putId));
      assert.ok(data.byteLength <= limits.objectChunkBytes);
      offsets.set(header.putId, header.offset + data.byteLength);
      chunks.push(data.byteLength);
    },
  });
  const registry = Object.assign(new EventEmitter(), {
    handlers: new Map(),
    all: () => [node],
    get: () => node,
    isRemoved: () => false,
    objectKeys: { objectIdKey: Buffer.alloc(32).toString('base64') },
  }) as unknown as NodeRegistry;
  const index = new ObjectIndex(
    store,
    registry,
    null,
    () => true,
    () => false,
  );
  return {
    index,
    chunks,
    get begins() {
      return begins;
    },
    get ends() {
      return ends;
    },
    async close() {
      await index.close();
      store.db.close();
    },
  };
}

test('object puts accept the byte limit, reject one over, and split chunks at the shared size', async () => {
  const f = putFixture();
  const chunk = Buffer.alloc(limits.objectChunkBytes);
  async function* bytes(count: number) {
    while (count > 0) {
      const size = Math.min(count, chunk.length);
      yield chunk.subarray(0, size);
      count -= size;
    }
  }
  try {
    const result = await f.index.put('tenant', bytes(limits.objectPutBytes), {
      maxBytes: limits.objectPutBytes + 1,
    });
    assert.equal(result.size, limits.objectPutBytes);
    assert.equal(f.ends, 1);
    await assert.rejects(
      f.index.put('tenant', bytes(limits.objectPutBytes + 1), { maxBytes: limits.objectPutBytes + 1 }),
      { code: 'limit_exceeded' },
    );
    assert.equal(f.ends, 1);
  } finally {
    await f.close();
  }
  const split = putFixture();
  try {
    async function* oversizedChunk() {
      yield Buffer.alloc(limits.objectChunkBytes + 1);
    }
    await split.index.put('tenant', oversizedChunk(), { maxBytes: limits.objectPutBytes });
    assert.deepEqual(split.chunks, [limits.objectChunkBytes, 1]);
  } finally {
    await split.close();
  }
});

test('object puts admit the per-node count and reject the next put', async () => {
  const f = putFixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* bytes() {
    await blocked;
    yield Buffer.from('x');
  }
  const controllers = Array.from({ length: limits.objectPutsPerNode }, () => new AbortController());
  const pending = controllers.map((controller) =>
    f.index.put('tenant', bytes(), { maxBytes: 1, signal: controller.signal }).then(
      () => assert.fail('canceled put completed'),
      (error) => assert.equal(error.code, 'canceled'),
    ),
  );
  try {
    await settle();
    assert.equal(f.begins, limits.objectPutsPerNode);
    await assert.rejects(f.index.put('tenant', bytes(), { maxBytes: 1 }), { code: 'busy' });
  } finally {
    controllers.forEach((controller) => controller.abort());
    release();
    await Promise.all(pending);
    await f.close();
  }
});

function fixture() {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  let now = Date.now();
  let work: (node: NodeLink) => Promise<unknown> = async () => {
    throw new RemoteKitError('rejected', 'corrupt document');
  };
  const requests: string[] = [];
  const nodes = ['alpha', 'beta'].map((nodeId) => {
    const node = {
      nodeId,
      state: { state: 'ready', connectionEpoch: nodeId },
      diskDraining: false,
      config: { peer: { address: nodeId } },
      metrics: { latest: () => ({ pressure: nodeId === 'alpha' ? 0 : 1 }) },
      async request(method: string) {
        if (method !== 'object.render') return {};
        requests.push(nodeId);
        return work(node as unknown as NodeLink);
      },
    };
    return node;
  });
  const registry = Object.assign(new EventEmitter(), {
    handlers: new Map(),
    all: () => nodes,
    get: (id: string) => nodes.find((node) => node.nodeId === id),
    isRemoved: () => false,
    options: { buildId: 'build-a' },
  }) as unknown as NodeRegistry;
  const makeIndex = () =>
    new ObjectIndex(
      store,
      registry,
      1024 * 1024,
      () => true,
      () => false,
      () => now,
    );
  let index = makeIndex();
  store.db.prepare('INSERT INTO objects VALUES (?,?,?,?,?)').run(source, 10, 50, source, now);
  for (const tenant of ['first', 'second']) {
    store.db.prepare('INSERT INTO object_claims VALUES (?,?,?)').run(tenant, source, now);
    store.db
      .prepare(
        `INSERT INTO learning_downloads (tenant,key,published_at,saved_at,object_id,state,document) VALUES (?,?,?,?,?,'saved',1)`,
      )
      .run(tenant, 'attachment', now, now, source);
  }
  store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(source, 'alpha');
  return {
    store,
    registry,
    nodes,
    requests,
    get index() {
      return index;
    },
    setWork(value: typeof work) {
      work = value;
    },
    advance(hours: number) {
      now += hours * HOUR;
    },
    failure() {
      return store.db.prepare('SELECT * FROM object_render_failures WHERE source_id=?').get(source) as
        | {
            state: string;
            reason: string;
            failed_at: bigint;
            retry_at: bigint | null;
            attempts: bigint;
            node_id: string | null;
          }
        | undefined;
    },
    async reopen() {
      await index.close();
      index = makeIndex();
    },
    commit(node: NodeLink) {
      index.committed(node, {
        objectId: document,
        size: 20,
        storedSize: 60,
        storedSha256: document,
        derivedFrom: source,
        kind: 'document',
      });
      return { documentId: document };
    },
    async close() {
      await index.close();
      store.db.close();
    },
  };
}

test('study conversion is in flight once across tenant nodes and committed derivations are shared', async () => {
  const f = fixture();
  let finish!: () => void;
  f.setWork(async (node) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return f.commit(node);
  });
  try {
    f.index.render(source);
    f.index.render(source);
    assert.throws(
      () =>
        f.index.derivation(f.nodes[1] as unknown as NodeLink, {
          tenantId: 'second',
          params: { id: source, kind: 'document' },
        }),
      { code: 'busy' },
    );
    assert.deepEqual(f.requests, ['alpha']);
    finish();
    await settle();
    assert.deepEqual(
      f.index.derivation(f.nodes[1] as unknown as NodeLink, {
        tenantId: 'second',
        params: { id: source, kind: 'document' },
      }),
      { id: document },
    );
    f.index.render(source);
    assert.deepEqual(f.requests, ['alpha']);
    assert.equal(f.failure(), undefined);
  } finally {
    finish?.();
    await f.close();
  }
});

test('deterministic failures persist across Control restart and never retry for another tenant', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  try {
    f.index.render(source);
    await settle();
    assert.equal(f.failure()?.state, 'failed');
    assert.equal(f.failure()?.reason, 'rejected');
    assert.equal(f.failure()?.retry_at, null);
    await f.reopen();
    f.advance(24 * 30);
    f.index.render(source);
    assert.throws(
      () =>
        f.index.derivation(f.nodes[1] as unknown as NodeLink, {
          tenantId: 'second',
          params: { id: source, kind: 'document' },
        }),
      { code: 'rejected', message: 'corrupt document' },
    );
    assert.deepEqual(f.requests, ['alpha']);
    f.registry.options.buildId = 'build-b';
    f.index.render(source);
    await settle();
    assert.deepEqual(f.requests, ['alpha', 'alpha'], 'a new build retries a deterministic failure');
    f.store.db.exec('DELETE FROM object_claims; UPDATE objects SET created_at=0');
    await f.index.gc(Date.now() + 365 * 24 * HOUR);
    assert.equal(f.failure(), undefined);
  } finally {
    await f.close();
  }
});

test('transient failures retry after persistent exponential backoff with minute-scale saturation delays capped at one hour', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  f.setWork(async () => {
    throw new RemoteKitError('busy', 'document queue full');
  });
  try {
    f.index.render(source);
    await settle();
    await f.reopen();
    for (const hours of [1, 2, 4, 8, 16, 32, 60].map((minutes) => minutes / 60)) {
      const row = f.failure()!;
      assert.equal(Number(row.retry_at! - row.failed_at), hours * HOUR);
      const count = f.requests.length;
      f.advance(hours - 0.001);
      f.index.render(source);
      assert.equal(f.requests.length, count);
      f.advance(0.001);
      f.index.render(source);
      await settle();
      assert.equal(f.requests.length, count + 1);
    }
    f.setWork(async (node) => f.commit(node));
    f.advance(24);
    f.index.render(source);
    await settle();
    assert.equal(f.failure(), undefined);
    assert.equal(f.index.derived(source, 'document'), document);
  } finally {
    await f.close();
  }
});

test('unknown outcomes cannot start a competing conversion on another node', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  f.setWork(async () => {
    throw new RemoteKitError('outcome_unknown', 'Node request timed out');
  });
  try {
    f.index.render(source);
    await settle();
    assert.equal(f.failure()?.node_id, 'alpha');
    await f.reopen();
    f.nodes[0].state.state = 'offline';
    f.advance(1);
    f.index.render(source);
    assert.deepEqual(f.requests, ['alpha']);
    f.nodes[0].state.state = 'ready';
    f.setWork(async (node) => f.commit(node));
    f.advance(2);
    f.index.render(source);
    await settle();
    assert.deepEqual(f.requests, ['alpha', 'alpha']);
    assert.equal(f.failure(), undefined);
  } finally {
    await f.close();
  }
});
