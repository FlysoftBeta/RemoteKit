import { RemoteKitError } from '../shared/errors';
import { LibraryRepository } from '../server/persistence/library';
import { testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSchema } from '../server/persistence/schema';
import { FileLibrary } from '../server/file-library';
import type { InternalFileRequest } from '../server/file-requests';
import type { LibrarySnapshot, SelectionState } from '../shared/file-library';

const limits = { maxFileBytes: 5, maxBatchBytes: 8, maxFiles: 3, sessionBytes: 100 };
const request: InternalFileRequest = {
  id: 'chooser',
  tabId: 'tab',
  windowId: 'window',
  origin: 'https://example.test',
  multiple: true,
  accept: ['.png'],
  state: 'pending',
  limits,
  binding: {
    browserIncarnation: 'browser',
    view: 'view',
    instance: 'instance',
    document: 'document',
    request: 'native',
  },
};

function fixture() {
  const db = new Database(':memory:');
  db.defaultSafeIntegers(true);
  createSchema(db);
  const calls: { method: string; tenant: string; args: any }[] = [];
  const states = new Map<string, SelectionState>();
  const assets = new Map([
    ['photo', 3],
    ['original', 5],
    ['draft', 4],
    ['extra', 4],
  ]);
  let losePrepare = false,
    locked = false,
    lockOnRetain = false;
  const endpoint = {
    async request(method: string, tenant: string, args: any = {}) {
      calls.push({ method, tenant, args });
      if (method === 'session.library.describe') {
        if (tenant !== 'tenant' || !assets.has(args.assetId))
          throw new RemoteKitError('not_found', 'asset_missing');
        return {
          assetId: args.assetId,
          hash: 'a'.repeat(64),
          size: assets.get(args.assetId),
          type: 'image/jpeg',
        };
      }
      if (method === 'session.library.prepare') {
        if (!states.has(args.selectionId)) states.set(args.selectionId, 'pending');
        if (losePrepare) {
          losePrepare = false;
          throw new RemoteKitError('outcome_unknown', 'response lost');
        }
      }
      if (method === 'session.library.selectionStatus')
        return { state: states.get(args.selectionId) ?? 'unknown' };
      if (method === 'session.library.retain' && lockOnRetain) locked = true;
      return { accepted: true };
    },
  };
  let manager = new FileLibrary(new LibraryRepository(db), testGateway(endpoint), limits);
  const run = <T = LibrarySnapshot>(
    method: string,
    params: unknown = {},
    tenant = 'tenant',
    chooser: InternalFileRequest | null = request,
  ) =>
    manager.request(
      tenant,
      'library.' + method,
      params,
      () => {
        if (locked) throw new RemoteKitError('locked', 'locked');
      },
      (id) => (tenant === 'tenant' && chooser?.id === id ? chooser : undefined),
    ) as Promise<T>;
  const add = (assetId: string, destination = 'basket', more: Record<string, unknown> = {}) =>
    run('import', {
      operationId: assetId,
      assetId,
      name: assetId + '.jpg',
      destination,
      groupId: null,
      ...more,
    });
  return {
    db,
    calls,
    states,
    run,
    add,
    reopen: () => {
      manager = new FileLibrary(new LibraryRepository(db), testGateway(endpoint), limits);
    },
    losePrepare: () => {
      losePrepare = true;
    },
    lockOnRetain: () => {
      lockOnRetain = true;
    },
    unlock: () => {
      locked = lockOnRetain = false;
    },
  };
}

test('file catalog validates scoped assets and ordered basket, reconciles removed drafts and preserves archived originals', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const start = await f.run('group', { operationId: 'group', name: '  Receipts  ' });
  const groupId = start.groups[0].id;
  const direct = await f.add('photo', 'library', { originalAssetId: 'original', groupId });
  const first = await f.add('draft');
  const second = await f.add('extra', 'basket', { afterId: first.basket[0] });
  assert.deepEqual(second.basket, [first.basket[0], second.entries[0].id]);
  f.reopen();
  const retry = await f.add('photo', 'library', { originalAssetId: 'original', groupId });
  assert.deepEqual(retry, second);
  assert.equal(
    f.calls.filter((c) => c.method === 'session.library.describe' && c.args.assetId === 'photo').length,
    1,
  );
  await assert.rejects(f.add('photo', 'basket'), { code: 'conflict' });
  await assert.rejects(
    f.run('basket', {
      operationId: 'dup',
      expectedRevision: second.revision,
      ids: [first.basket[0], first.basket[0]],
    }),
    { code: 'invalid_request' },
  );
  await assert.rejects(
    f.run('basket', { operationId: 'foreign', expectedRevision: 0, ids: first.basket }, 'other'),
    { code: 'not_found' },
  );
  await assert.rejects(
    f.run(
      'import',
      { operationId: 'foreign', assetId: 'photo', name: 'photo.jpg', groupId: null, destination: 'library' },
      'other',
    ),
    { code: 'not_found' },
  );
  const archived = direct.entries[0].id;
  const removed = await f.run('basket', {
    operationId: 'clear',
    expectedRevision: second.revision,
    ids: [archived],
  });
  assert.deepEqual(
    removed.entries.map((e) => e.id),
    [archived],
  );
  assert.deepEqual(f.calls.filter((c) => c.method === 'session.library.references').pop()?.args, {
    revision: removed.revision,
    assetIds: ['original', 'photo'],
  });
  assert.deepEqual(await f.add('draft'), removed);
  const moved = await f.run('move', { operationId: 'move', ids: [archived], groupId: null });
  assert.equal(moved.entries[0].groupId, null);
  const renamed = await f.run('group', { operationId: 'rename', id: groupId, name: 'Invoices' });
  assert.deepEqual(renamed.groups, [{ id: groupId, name: 'Invoices' }]);
});

test('prepared selection retries its immutable manifest and consumes only confirmed entry IDs after restart', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const groupId = (await f.run('group', { operationId: 'group', name: 'Receipts' })).groups[0].id;
  const first = await f.add('draft');
  const latest = await f.add('extra');
  const [draft, extra] = latest.basket;
  const params = { operationId: 'prepare', requestId: 'chooser', entryIds: [draft], groupId };
  await assert.rejects(
    f.run('prepare', { ...params, entryIds: latest.basket }, 'tenant', { ...request, multiple: false }),
    { code: 'invalid_request' },
  );
  await assert.rejects(
    f.run('prepare', { ...params, entryIds: latest.basket }, 'tenant', {
      ...request,
      limits: { ...limits, maxBatchBytes: 7 },
    }),
    { code: 'limit_exceeded' },
  );
  f.losePrepare();
  await assert.rejects(f.run('prepare', params), { code: 'outcome_unknown' });
  f.reopen();
  const prepared = await f.run<{ selectionId: string }>('prepare', params);
  const calls = f.calls.filter((c) => c.method === 'session.library.prepare');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.deepEqual(calls[0].args, {
    selectionId: prepared.selectionId,
    requestId: 'chooser',
    binding: request.binding,
    files: [{ assetId: 'draft', name: 'draft.jpg', type: 'image/jpeg' }],
  });
  await assert.rejects(f.run('prepare', { ...params, entryIds: [extra] }), { code: 'conflict' });
  await assert.rejects(f.run('finish', prepared, 'other'), { code: 'not_found' });
  f.states.set(prepared.selectionId, 'unknown');
  type Finish = { state: SelectionState; snapshot: LibrarySnapshot };
  const unknown = await f.run<Finish>('finish', prepared, 'tenant', null);
  assert.equal(unknown.state, 'unknown');
  assert.deepEqual(unknown.snapshot.basket, latest.basket);
  const reorder = { operationId: 'reorder', expectedRevision: latest.revision, ids: [extra, draft] };
  const reordered = await f.run('basket', reorder);
  f.states.set(prepared.selectionId, 'selected');
  const reconciled = await f.run('get', {}, 'tenant', null);
  assert.deepEqual(reconciled.basket, [extra]);
  assert.deepEqual(
    reconciled.entries.find((e) => e.id === draft),
    { ...first.entries[0], archived: true, groupId },
  );
  await assert.rejects(
    f.run('basket', {
      operationId: 'stale',
      expectedRevision: reordered.revision,
      ids: [draft, extra],
    }),
    { code: 'conflict' },
  );
  f.reopen();
  assert.deepEqual(await f.run('basket', reorder), reconciled);
  assert.deepEqual(await f.run('finish', prepared), { state: 'selected', snapshot: reconciled });
  const readded = await f.run('basket', {
    operationId: 'readd',
    expectedRevision: reconciled.revision,
    ids: [draft, extra],
  });
  assert.deepEqual(await f.run('finish', prepared), { state: 'selected', snapshot: readded });
});

test('pending selections pin removed entries, cancelled selections release them, and lock blocks late imports', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const snapshot = await f.add('draft'),
    entry = snapshot.entries[0];
  const prepared = await f.run<{ selectionId: string }>('prepare', {
    operationId: 'prepare',
    requestId: 'chooser',
    entryIds: [entry.id],
    groupId: null,
  });
  const removed = await f.run('basket', {
    operationId: 'remove',
    expectedRevision: snapshot.revision,
    ids: [],
  });
  assert.deepEqual(removed.entries, [entry]);
  f.states.set(prepared.selectionId, 'cancelled');
  const reconciled = await f.run('get', {}, 'tenant', null);
  assert.deepEqual(reconciled.entries, []);
  assert.deepEqual(f.calls.filter((c) => c.method === 'session.library.references').pop()?.args.assetIds, []);
  f.lockOnRetain();
  await assert.rejects(f.add('photo'), { code: 'locked' });
  f.unlock();
  assert.deepEqual(await f.run('get'), reconciled);
  assert.equal((await f.add('photo')).entries.length, 1);
});

test('explicit deletion is atomic and keeps assets referenced by another entry or its original', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const first = (await f.add('photo', 'library', { originalAssetId: 'original' })).entries[0];
  const duplicate = (await f.add('photo', 'library', { operationId: 'duplicate' })).entries[0];
  const derivative = (await f.add('extra', 'library', { originalAssetId: 'original' })).entries[0];
  await f.run('basket', { operationId: 'basket', expectedRevision: 3, ids: [first.id, duplicate.id] });
  const prepared = await f.run<{ selectionId: string }>('prepare', {
    operationId: 'prepare',
    requestId: 'chooser',
    entryIds: [first.id],
    groupId: null,
  });
  const deletion = { operationId: 'delete', ids: [first.id, duplicate.id] };
  await assert.rejects(f.run('delete', deletion), { code: 'conflict' });
  assert.deepEqual((await f.run('get')).basket, [first.id, duplicate.id]);
  f.states.set(prepared.selectionId, 'cancelled');
  await f.run('get');
  const removeFirst = { operationId: 'first', ids: [first.id] };
  const removed = await f.run('delete', removeFirst);
  assert.deepEqual(removed.basket, [duplicate.id]);
  assert.deepEqual(removed.entries, [derivative, duplicate]);
  assert.deepEqual(f.calls.filter((c) => c.method === 'session.library.references').pop()?.args.assetIds, [
    'extra',
    'original',
    'photo',
  ]);
  const remaining = await f.run('delete', { operationId: 'second', ids: [duplicate.id] });
  assert.deepEqual(remaining.basket, []);
  assert.deepEqual(f.calls.filter((c) => c.method === 'session.library.references').pop()?.args.assetIds, [
    'extra',
    'original',
  ]);
  f.reopen();
  assert.deepEqual(await f.run('delete', removeFirst), remaining);
});

test('photo choice and scan failure remain blocked until confirmed in place', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const references = () =>
    f.calls.filter((c) => c.method === 'session.library.references').pop()?.args.assetIds;
  const groupId = (await f.run('group', { operationId: 'group', name: 'Scans' })).groups[0].id;
  await f.add('draft');
  const photo = { mode: 'scan', pending: 'choice', candidateAssetIds: ['photo', 'extra'] };
  const initial = await f.add('photo', 'basket', { groupId, originalAssetId: 'original', photo });
  const [entry] = initial.entries;
  assert.deepEqual(entry.photo, photo);
  assert.deepEqual(f.calls.filter((c) => c.method === 'session.library.retain').pop()?.args.assetIds, [
    'photo',
    'original',
    'extra',
  ]);
  f.reopen();
  assert.deepEqual(await f.run('get'), initial);
  assert.deepEqual(references(), ['draft', 'extra', 'original', 'photo']);
  await assert.rejects(
    f.add('photo', 'basket', { groupId, originalAssetId: 'original', photo: { ...photo, mode: 'photo' } }),
    { code: 'conflict' },
  );
  const prepare = { operationId: 'prepare', requestId: 'chooser', entryIds: [entry.id], groupId };
  await assert.rejects(f.run('prepare', prepare), { code: 'conflict' });
  const scanError = { mode: 'scan', pending: 'scan-error', warning: '扫描失败' };
  const choice = {
    operationId: 'choose',
    entryId: entry.id,
    expectedRevision: initial.revision,
    assetId: 'extra',
    originalAssetId: 'original',
    photo: scanError,
  };
  const chosen = await f.run('replace', choice);
  assert.deepEqual(chosen.entries, [
    { ...entry, assetId: 'extra', size: 4, photo: scanError },
    initial.entries[1],
  ]);
  assert.deepEqual(chosen.basket, initial.basket);
  assert.deepEqual(references(), ['draft', 'extra', 'original']);
  await assert.rejects(f.run('prepare', prepare), { code: 'conflict' });
  const confirm = {
    operationId: 'confirm',
    entryId: entry.id,
    expectedRevision: chosen.revision,
    assetId: 'original',
    originalAssetId: 'original',
    photo: { mode: 'scan' },
  };
  await assert.rejects(f.run('replace', { ...confirm, expectedRevision: initial.revision }), {
    code: 'conflict',
  });
  const confirmed = await f.run('replace', confirm);
  assert.deepEqual(confirmed.entries[0], { ...entry, assetId: 'original', size: 5, photo: confirm.photo });
  assert.deepEqual(references(), ['draft', 'original']);
  f.reopen();
  const callsBeforeReplay = f.calls.length;
  assert.deepEqual(await f.run('replace', choice), confirmed);
  assert.equal(f.calls.length, callsBeforeReplay);
  await assert.rejects(f.run('replace', { ...choice, originalAssetId: 'draft' }), { code: 'conflict' });
  f.losePrepare();
  await assert.rejects(f.run('prepare', prepare), { code: 'outcome_unknown' });
  const replacement = {
    operationId: 'replace',
    entryId: entry.id,
    expectedRevision: confirmed.revision,
    assetId: 'photo',
  };
  await assert.rejects(f.run('replace', replacement), { code: 'conflict' });
  const prepared = await f.run<{ selectionId: string }>('prepare', prepare);
  assert.deepEqual(f.calls.filter((c) => c.method === 'session.library.prepare').pop()?.args.files, [
    { assetId: 'original', name: entry.name, type: 'image/jpeg' },
  ]);
  f.states.set(prepared.selectionId, 'cancelled');
  await f.run('finish', prepared);
  const replaced = await f.run('replace', replacement);
  assert.deepEqual(replaced.entries[0], {
    id: entry.id,
    assetId: 'photo',
    size: 3,
    type: entry.type,
    name: entry.name,
    createdAt: entry.createdAt,
    groupId,
    archived: false,
  });
  assert.deepEqual(references(), ['draft', 'photo']);
});

test('photo metadata validates candidate references and prunes them when an entry is removed', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  await assert.rejects(f.add('photo', 'basket', { photo: { mode: 'scan', warning: 'x'.repeat(257) } }), {
    code: 'invalid_request',
  });
  await assert.rejects(
    f.add('photo', 'basket', { photo: { mode: 'photo', candidateAssetIds: ['extra', 'extra'] } }),
    { code: 'invalid_request' },
  );
  await assert.rejects(
    f.add('photo', 'basket', { photo: { mode: 'photo', candidateAssetIds: ['draft', 'extra', 'original'] } }),
    { code: 'invalid_request' },
  );
  await assert.rejects(
    f.add('photo', 'basket', { photo: { mode: 'photo', candidateAssetIds: ['missing'] } }),
    { code: 'not_found' },
  );
  await f.add('draft', 'library', { originalAssetId: 'original' });
  const pending = await f.add('photo', 'basket', {
    photo: { mode: 'photo', pending: 'choice', candidateAssetIds: ['original', 'extra'] },
  });
  const pruned = await f.run('basket', { operationId: 'prune', expectedRevision: pending.revision, ids: [] });
  assert.deepEqual(
    pruned.entries.map((e) => e.assetId),
    ['draft'],
  );
  assert.deepEqual(f.calls.filter((c) => c.method === 'session.library.references').pop()?.args.assetIds, [
    'draft',
    'original',
  ]);
});
