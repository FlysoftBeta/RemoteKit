import assert from 'node:assert/strict';
import test from 'node:test';
import { LibraryStore, type LibraryRequest, type FilePort } from '../client/files/library-store';
import { projectBasket, projectLibrary, type LibraryChange } from '../client/files/library-operations';
import { RemoteKitError } from '../shared/errors';
import type { LibrarySnapshot } from '../shared/file-library';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const source = { app: 'files', channel: 'upload' };
function snapshot(): LibrarySnapshot {
  return {
    revision: 1,
    partitions: [{ id: 'group', name: 'Group' }],
    basket: ['a', 'b'],
    basketPartitionId: 'group',
    excludedSources: [],
    sources: [{ ...source, count: 2, excluded: false }],
    entries: ['a', 'b'].map((id) => ({
      id,
      kind: 'file',
      name: id,
      available: true,
      type: 'text/plain',
      size: 1,
      assetId: id.repeat(64),
      createdAt: 1,
      source,
      collected: true,
      partitionId: 'group',
    })),
  };
}
async function setup(t: test.TestContext, work: (method: string, params: any) => Promise<LibrarySnapshot>) {
  const store = new LibraryStore(
    (async (method, params) => work(method, params)) as LibraryRequest,
    {} as FilePort,
  );
  t.after(store.dispose);
  store.configure(true, true, 'viewer', []);
  await flush();
  return store;
}

test('file edits project immediately over snapshots and rollback to refreshed server state', async (t) => {
  let server = snapshot();
  const reply = deferred<LibrarySnapshot>();
  const store = await setup(t, async (method) => (method === 'library.get' ? server : reply.promise));
  const result = store.mutate('library.delete', { operationId: 'delete', ids: ['a'] });
  assert.deepEqual(
    store.getSnapshot().snapshot?.entries.map((entry) => entry.id),
    ['b'],
  );
  assert.deepEqual(store.getSnapshot().snapshot?.basket, ['b']);
  store.receive({ ...server, revision: 2 });
  assert.deepEqual(
    store.getSnapshot().snapshot?.entries.map((entry) => entry.id),
    ['b'],
  );
  await flush();
  server = { ...server, revision: 3, partitions: [{ id: 'group', name: 'Server edit' }] };
  const rejected = assert.rejects(result, { code: 'forbidden' });
  reply.reject(new RemoteKitError('forbidden', 'any text'));
  await rejected;
  assert.deepEqual(store.getSnapshot().snapshot, server);
  assert.equal(store.getSnapshot().error?.code, 'forbidden');
});

test('rapid basket edits stay visible and use consecutive server revisions', async (t) => {
  let server = snapshot();
  const first = deferred<LibrarySnapshot>();
  const calls: any[] = [];
  const store = await setup(t, async (method, params) => {
    if (method === 'library.get') return server;
    calls.push(structuredClone(params));
    if (calls.length === 1) return first.promise;
    server = { ...server, revision: 3, basket: params.ids };
    return server;
  });
  const reorder = store.mutate('library.basket', {
    operationId: 'order',
    ids: ['b', 'a'],
    expectedRevision: 1,
  });
  const remove = store.mutate('library.basket', { operationId: 'remove', ids: ['a'], expectedRevision: 1 });
  assert.deepEqual(store.getSnapshot().snapshot?.basket, ['a']);
  await flush();
  assert.equal(calls.length, 1);
  server = { ...server, revision: 2, basket: ['b', 'a'] };
  store.receive(server);
  first.resolve(server);
  await reorder;
  assert.deepEqual(store.getSnapshot().snapshot?.basket, ['a']);
  await remove;
  assert.equal(calls[1].expectedRevision, 2);
  store.receive({ ...server, revision: 4, basket: ['b'] });
  assert.deepEqual(store.getSnapshot().snapshot?.basket, ['b']);
});

test('create-and-move projects the real group id and waits for the create reply', async (t) => {
  let server = snapshot();
  const reply = deferred<LibrarySnapshot>();
  const calls: { method: string; params: any }[] = [];
  const store = await setup(t, async (method, params) => {
    if (method === 'library.get') return server;
    calls.push({ method, params: structuredClone(params) });
    if (method === 'library.partition') return reply.promise;
    server = {
      ...server,
      revision: 3,
      entries: server.entries.map((entry) =>
        entry.id === 'a' ? { ...entry, partitionId: params.partitionId } : entry,
      ),
    };
    return server;
  });
  const result = store.createPartition('New group', ['a']);
  const id = store.getSnapshot().snapshot!.partitions.find((item) => item.name === 'New group')!.id;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(store.getSnapshot().snapshot?.entries[0].partitionId, id);
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, {
    operationId: calls[0].params.operationId,
    id,
    name: 'New group',
    create: true,
  });
  server = { ...server, revision: 2, partitions: [...server.partitions, { id, name: 'New group' }] };
  store.receive(server);
  assert.equal(store.getSnapshot().snapshot?.partitions.length, 2);
  assert.equal(store.getSnapshot().snapshot?.entries[0].partitionId, id);
  await flush();
  assert.equal(calls.length, 1);
  reply.resolve(server);
  await result;
  assert.equal(calls[1].params.partitionId, id);
});

for (const action of ['move', 'rename', 'delete', 'destination'] as const) {
  test(`a new group's ${action} projects immediately and waits for its creation acknowledgment`, async (t) => {
    const id = '12345678-1234-4234-8234-123456789abc';
    let server = snapshot();
    const created = deferred<LibrarySnapshot>();
    const calls: { method: string; params: any }[] = [];
    const store = await setup(t, async (method, params) => {
      if (method === 'library.get') return server;
      calls.push({ method, params: structuredClone(params) });
      if (method === 'library.partition' && params.create) return created.promise;
      server = projectLibrary(server, [{ change: { method, params } as LibraryChange }])!;
      server = { ...server, revision: server.revision + 1 };
      return server;
    });
    const create = store.mutate('library.partition', {
      operationId: 'create',
      id,
      name: 'Group',
      create: true,
    });
    const dependent =
      action === 'move'
        ? store.mutate('library.move', { operationId: 'move', ids: ['a'], partitionId: id })
        : action === 'rename'
          ? store.mutate('library.partition', { operationId: 'rename', id, name: 'Renamed', create: false })
          : action === 'delete'
            ? store.mutate('library.partitionDelete', { operationId: 'delete', id })
            : store.mutate('library.basketPartition', { operationId: 'destination', partitionId: id });
    const projected = store.getSnapshot().snapshot!;
    if (action === 'move') assert.equal(projected.entries[0].partitionId, id);
    if (action === 'rename')
      assert.equal(projected.partitions.find((item) => item.id === id)?.name, 'Renamed');
    if (action === 'delete')
      assert.equal(
        projected.partitions.some((item) => item.id === id),
        false,
      );
    if (action === 'destination') assert.equal(projected.basketPartitionId, id);
    await flush();
    assert.equal(calls.length, 1);
    server = { ...server, revision: 2, partitions: [...server.partitions, { id, name: 'Group' }] };
    store.receive(server);
    await flush();
    assert.equal(calls.length, 1);
    created.resolve(server);
    await Promise.all([create, dependent]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params.id ?? calls[1].params.partitionId, id);
    assert.deepEqual(store.getSnapshot().snapshot, server);
  });
}

test('a failed group creation rolls back its dependent edits without sending them', async (t) => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const server = snapshot();
  const reply = deferred<LibrarySnapshot>();
  const calls: string[] = [];
  const store = await setup(t, async (method) => {
    if (method === 'library.get') return server;
    calls.push(method);
    return reply.promise;
  });
  const create = store.mutate('library.partition', {
    operationId: 'create',
    id,
    name: 'Group',
    create: true,
  });
  const move = store.mutate('library.move', { operationId: 'move', ids: ['a'], partitionId: id });
  assert.equal(store.getSnapshot().snapshot?.entries[0].partitionId, id);
  await flush();
  const outcomes = Promise.allSettled([create, move]);
  reply.reject(new RemoteKitError('conflict', 'any text'));
  assert.deepEqual(
    (await outcomes).map((result) => result.status),
    ['rejected', 'rejected'],
  );
  assert.deepEqual(calls, ['library.partition']);
  assert.deepEqual(store.getSnapshot().snapshot, server);
  assert.equal(store.getSnapshot().error?.code, 'conflict');
});

test('library projections preserve retained files, source counts, exclusions and group settings', () => {
  const apply = (change: LibraryChange, input = snapshot()) => projectLibrary(input, [{ change }])!;
  assert.equal(
    apply({
      method: 'library.partition',
      params: { operationId: 'rename', id: 'group', name: 'Renamed', create: false },
    }).partitions[0].name,
    'Renamed',
  );
  const deleted = apply({
    method: 'library.partitionDelete',
    params: { operationId: 'group-delete', id: 'group' },
  });
  assert.deepEqual(deleted.partitions, []);
  assert.equal(deleted.entries[0].partitionId, null);
  assert.equal(deleted.basketPartitionId, null);
  const excluded = apply({
    method: 'library.source',
    params: { operationId: 'exclude', source, excluded: true },
  });
  assert.equal(excluded.sources[0].excluded, true);
  assert.deepEqual(excluded.excludedSources, [source]);
  const purged = apply({ method: 'library.sourcePurge', params: { operationId: 'purge', source } });
  assert.equal(purged.entries.length, 2);
  assert.equal(purged.entries[0].source, null);
  assert.deepEqual(purged.sources, []);
  const orphan = snapshot();
  orphan.entries[0] = { ...orphan.entries[0], source: null, collected: false };
  orphan.basket = ['b'];
  assert.deepEqual(
    apply(
      { method: 'library.move', params: { operationId: 'move', ids: ['a'], partitionId: null } },
      orphan,
    ).entries.map((entry) => entry.id),
    ['b'],
  );
  const moved = apply({
    method: 'library.move',
    params: { operationId: 'move-in', ids: ['a'], partitionId: 'other' },
  });
  assert.equal(moved.entries[0].partitionId, 'other');
  assert.equal(
    apply({ method: 'library.basketPartition', params: { operationId: 'destination', partitionId: null } })
      .basketPartitionId,
    null,
  );
});

test('a failed basket addition is not repeated by a later edit and external additions are retained', async (t) => {
  let server = { ...snapshot(), basket: ['b'] };
  const reply = deferred<LibrarySnapshot>();
  const requests: string[][] = [];
  const store = await setup(t, async (method, params) => {
    if (method === 'library.get') return server;
    requests.push(params.ids);
    if (requests.length === 1) return reply.promise;
    return { ...server, revision: 3, basket: params.ids };
  });
  const add = store.mutate('library.basket', { operationId: 'add', ids: ['b', 'a'], expectedRevision: 1 });
  const reorder = store.mutate('library.basket', {
    operationId: 'order',
    ids: ['a', 'b'],
    expectedRevision: 1,
  });
  await flush();
  const rejected = assert.rejects(add, { code: 'forbidden' });
  reply.reject(new RemoteKitError('forbidden', 'any text'));
  await rejected;
  await reorder;
  assert.deepEqual(requests, [['b', 'a'], ['b']]);
  assert.deepEqual(store.getSnapshot().snapshot?.basket, ['b']);
  assert.deepEqual(projectBasket(['b', 'external'], ['a', 'b'], ['b', 'a']), ['b', 'external']);
});

test('file recovery removes the failed projection while the existing retry unit waits', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const server = snapshot();
  const reply = deferred<LibrarySnapshot>();
  let attempts = 0;
  const store = await setup(t, async (method) => {
    if (method === 'library.get') return server;
    if (++attempts === 1) throw new RemoteKitError('unavailable', 'any text');
    return reply.promise;
  });
  const result = store.mutate('library.move', { operationId: 'move', ids: ['a'], partitionId: null });
  assert.equal(store.getSnapshot().snapshot?.entries[0].partitionId, null);
  await flush();
  assert.equal(store.getSnapshot().snapshot?.entries[0].partitionId, 'group');
  assert.equal(store.getSnapshot().error?.code, 'unavailable');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(attempts, 2);
  assert.equal(store.getSnapshot().snapshot?.entries[0].partitionId, null);
  reply.resolve({
    ...server,
    revision: 2,
    entries: server.entries.map((entry) => (entry.id === 'a' ? { ...entry, partitionId: null } : entry)),
  });
  await result;
  assert.equal(store.getSnapshot().error, undefined);
});
