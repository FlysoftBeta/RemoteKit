import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ObjectIndex } from '../server/cluster/objects';
import type { NodeLink, NodeRegistry } from '../server/cluster/node-link';
import { ControlDatabase } from '../server/persistence/database';
import { RemoteKitError } from '../shared/errors';

const source = 'a'.repeat(64);
const document = 'b'.repeat(64);
const HOUR = 3600_000;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const store = new ControlDatabase(':memory:');
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
