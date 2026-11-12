import { RemoteKitError } from '../shared/errors';
import { AtRestKey } from '../server/auth/crypto';
import { LibraryRepository } from '../server/persistence/library';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../server/persistence/migrations';
import { ObjectIndex } from '../server/cluster/objects';
import type { NodeRegistry } from '../server/cluster/node-link';
import type { ControlDatabase } from '../server/persistence/database';
import { FileLibrary } from '../server/files/library';
import type { InternalFileRequest } from '../server/workspace/page-requests';
import type { LibrarySnapshot, LibrarySource, SelectionState } from '../shared/file-library';

const ASSETS = {
  photo: 'a'.repeat(64),
  original: 'b'.repeat(64),
  draft: 'c'.repeat(64),
  extra: 'd'.repeat(64),
  missing: 'e'.repeat(64),
};
const limits = { maxFileBytes: 5, maxBatchBytes: 8, maxFiles: 3 };
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

function fixture(assetType = 'image/jpeg') {
  const db = new Database(':memory:');
  db.defaultSafeIntegers(true);
  migrate(db, { backupDirectory: '', buildId: 'test', atRestKey: new AtRestKey(null) });
  for (const tenant of ['tenant', 'other'])
    db.prepare('INSERT INTO library_state VALUES (?,0,NULL)').run(tenant);
  const calls: { method: string; tenant: string; args: any }[] = [];
  const states = new Map<string, SelectionState>();
  const assets = new Map([
    [ASSETS.photo, 3],
    [ASSETS.original, 5],
    [ASSETS.draft, 4],
    [ASSETS.extra, 4],
  ]);
  const untypedAssets = new Set<string>();
  let losePrepare = false,
    locked = false,
    lockOnDescribe = false;
  const endpoint = {
    async request(method: string, tenant: string, args: any = {}): Promise<any> {
      calls.push({ method, tenant, args });
      if (method === 'service.asset.describe') {
        if (lockOnDescribe) locked = true;
        if (tenant !== 'tenant' || !assets.has(args.assetId))
          throw new RemoteKitError('not_found', 'asset_missing');
        return {
          assetId: args.assetId,
          size: assets.get(args.assetId),
          ...(untypedAssets.has(args.assetId) ? {} : { type: assetType }),
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
      return { accepted: true };
    },
  };
  const gateway = {
    describeAsset: (tenant: string, args: { assetId: string }) =>
      endpoint.request('service.asset.describe', tenant, args),
    prepareSelection: (tenant: string, args: unknown) =>
      endpoint.request('session.library.prepare', tenant, args),
    selectionStatus: (tenant: string, args: { selectionId: string }) =>
      endpoint.request('session.library.selectionStatus', tenant, args),
  };
  let requestSource: LibrarySource | null = { app: 'browser', channel: 'example.test' };
  const resolveSource = (tenant: string, requestId: string) =>
    tenant === 'tenant' && requestId === 'chooser' ? requestSource : null;
  let manager = new FileLibrary(
    new LibraryRepository(db),
    gateway,
    limits,
    {
      available: () => true,
      checkQuota: () => {},
      require: (tenant, id) => {
        if (tenant !== 'tenant' || !assets.has(id)) throw new RemoteKitError('not_found', 'Object missing');
      },
    },
    resolveSource,
  );
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
      origin: { kind: 'files', channel: 'upload', partitionId: null },
      ...more,
    });
  return {
    db,
    calls,
    states,
    untypedAssets,
    run,
    add,
    reopen: () => {
      manager = new FileLibrary(
        new LibraryRepository(db),
        gateway,
        limits,
        {
          available: () => true,
          checkQuota: () => {},
          require: (tenant, id) => {
            if (tenant !== 'tenant' || !assets.has(id))
              throw new RemoteKitError('not_found', 'Object missing');
          },
        },
        resolveSource,
      );
    },
    setSource: (source: LibrarySource | null) => {
      requestSource = source;
    },
    exists: (entryId: string) => manager.entryExists('tenant', entryId),
    hidden: () => manager.hiddenEntryIds('tenant'),
    organized: (entryId: string) => manager.organized('tenant', entryId),
    losePrepare: () => {
      losePrepare = true;
    },
    lockOnDescribe: () => {
      lockOnDescribe = true;
    },
    unlock: () => {
      locked = lockOnDescribe = false;
    },
  };
}

test('library entries require upload media types while hash-only references do not', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.untypedAssets.add(ASSETS.original);
  const snapshot = await f.add(ASSETS.photo, 'library', { originalAssetId: ASSETS.original });
  assert.equal(snapshot.entries[0].type, 'image/jpeg');
  assert.equal(snapshot.entries[0].originalAssetId, ASSETS.original);
  f.untypedAssets.add(ASSETS.draft);
  await assert.rejects(f.add(ASSETS.draft), { code: 'outcome_unknown' });
});

test('file catalog validates scoped assets and ordered basket, prunes removed entries and preserves collected originals', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const start = await f.run('partition', { operationId: 'group', name: '  Receipts  ' });
  const partitionId = start.partitions[0].id;
  const direct = await f.add(ASSETS.photo, 'library', {
    originalAssetId: ASSETS.original,
    origin: { kind: 'files', channel: 'upload', partitionId },
  });
  const first = await f.add(ASSETS.draft);
  const second = await f.add(ASSETS.extra, 'basket', { afterId: first.basket[0] });
  assert.deepEqual(second.basket, [first.basket[0], second.entries[0].id]);
  f.reopen();
  const retry = await f.add(ASSETS.photo, 'library', {
    originalAssetId: ASSETS.original,
    origin: { kind: 'files', channel: 'upload', partitionId },
  });
  assert.deepEqual(retry, second);
  assert.equal(
    f.calls.filter((c) => c.method === 'service.asset.describe' && c.args.assetId === ASSETS.photo).length,
    1,
  );
  await assert.rejects(f.add(ASSETS.photo, 'basket'), { code: 'conflict' });
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
      {
        operationId: 'foreign',
        assetId: ASSETS.photo,
        name: 'photo.jpg',
        origin: { kind: 'files', channel: 'upload', partitionId: null },
        destination: 'library',
      },
      'other',
    ),
    { code: 'not_found' },
  );
  const collected = direct.entries[0].id;
  const removed = await f.run('basket', {
    operationId: 'clear',
    expectedRevision: second.revision,
    ids: [collected],
  });
  assert.deepEqual(
    removed.entries.map((e) => e.id),
    [collected],
  );
  assert.deepEqual(await f.add(ASSETS.draft), removed);
  const moved = await f.run('move', { operationId: 'move', ids: [collected], partitionId: null });
  assert.equal(moved.entries[0].partitionId, null);
  const renamed = await f.run('partition', { operationId: 'rename', id: partitionId, name: 'Invoices' });
  assert.deepEqual(renamed.partitions, [{ id: partitionId, name: 'Invoices' }]);
});

test('prepared selection retries its immutable manifest and consumes only confirmed entry IDs after restart', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const partitionId = (await f.run('partition', { operationId: 'group', name: 'Receipts' })).partitions[0].id;
  const first = await f.add(ASSETS.draft);
  const latest = await f.add(ASSETS.extra);
  const [draft, extra] = latest.basket;
  await f.run('basketPartition', { operationId: 'basket-partition', partitionId });
  const params = { operationId: 'prepare', requestId: 'chooser', entryIds: [draft] };
  await assert.rejects(
    f.run('prepare', { ...params, entryIds: latest.basket }, 'tenant', { ...request, multiple: false }),
    { code: 'limit_exceeded' },
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
    files: [{ assetId: ASSETS.draft, name: ASSETS.draft + '.jpg', type: 'image/jpeg' }],
    limits: request.limits,
  });
  await assert.rejects(f.run('prepare', { ...params, entryIds: [extra] }), { code: 'conflict' });
  await assert.rejects(f.run('finish', prepared, 'other'), { code: 'not_found' });
  f.states.set(prepared.selectionId, 'unknown');
  type Finish = { state: SelectionState; snapshot: LibrarySnapshot };
  const unknown = await f.run<Finish>('finish', prepared, 'tenant', null);
  assert.equal(unknown.state, 'unknown');
  assert.deepEqual(unknown.snapshot.basket, latest.basket);
  const reorder = {
    operationId: 'reorder',
    expectedRevision: (await f.run('get')).revision,
    ids: [extra, draft],
  };
  const reordered = await f.run('basket', reorder);
  f.states.set(prepared.selectionId, 'selected');
  const reconciled = await f.run('get', {}, 'tenant', null);
  assert.deepEqual(reconciled.basket, [extra]);
  assert.deepEqual(
    reconciled.entries.find((e) => e.id === draft),
    { ...first.entries[0], collected: true, partitionId },
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
  const snapshot = await f.add(ASSETS.draft),
    entry = snapshot.entries[0];
  const prepared = await f.run<{ selectionId: string }>('prepare', {
    operationId: 'prepare',
    requestId: 'chooser',
    entryIds: [entry.id],
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
  f.lockOnDescribe();
  await assert.rejects(f.add(ASSETS.photo), { code: 'locked' });
  f.unlock();
  assert.deepEqual(await f.run('get'), reconciled);
  assert.equal((await f.add(ASSETS.photo)).entries.length, 1);
});

test('explicit deletion is atomic and keeps assets referenced by another entry or its original', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const first = (await f.add(ASSETS.photo, 'library', { originalAssetId: ASSETS.original })).entries[0];
  const duplicate = (await f.add(ASSETS.photo, 'library', { operationId: 'duplicate' })).entries[0];
  const derivative = (await f.add(ASSETS.extra, 'library', { originalAssetId: ASSETS.original })).entries[0];
  await f.run('basket', { operationId: 'basket', expectedRevision: 3, ids: [first.id, duplicate.id] });
  const prepared = await f.run<{ selectionId: string }>('prepare', {
    operationId: 'prepare',
    requestId: 'chooser',
    entryIds: [first.id],
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
  const remaining = await f.run('delete', { operationId: 'second', ids: [duplicate.id] });
  assert.deepEqual(remaining.basket, []);
  f.reopen();
  assert.deepEqual(await f.run('delete', removeFirst), remaining);
});

test('photo choice and scan failure remain blocked until confirmed in place', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const partitionId = (await f.run('partition', { operationId: 'group', name: 'Scans' })).partitions[0].id;
  await f.add(ASSETS.draft);
  const photo = { mode: 'scan', pending: 'choice', candidateAssetIds: [ASSETS.photo, ASSETS.extra] };
  const initial = await f.add(ASSETS.photo, 'basket', {
    origin: { kind: 'files', channel: 'camera', partitionId },
    originalAssetId: ASSETS.original,
    photo,
  });
  const [entry] = initial.entries;
  assert.deepEqual(entry.photo, photo);
  f.reopen();
  assert.deepEqual(await f.run('get'), initial);
  await assert.rejects(
    f.add(ASSETS.photo, 'basket', {
      origin: { kind: 'files', channel: 'camera', partitionId },
      originalAssetId: ASSETS.original,
      photo: { ...photo, mode: 'photo' },
    }),
    { code: 'conflict' },
  );
  const prepare = { operationId: 'prepare', requestId: 'chooser', entryIds: [entry.id] };
  await assert.rejects(f.run('prepare', prepare), { code: 'conflict' });
  const scanError = {
    mode: 'scan',
    pending: 'scan-error',
    processingFailure: { code: 'internal', message: '扫描未能完成', errorId: 'c-0123456789' },
  };
  const choice = {
    operationId: 'choose',
    entryId: entry.id,
    expectedRevision: initial.revision,
    assetId: ASSETS.extra,
    originalAssetId: ASSETS.original,
    photo: scanError,
  };
  const chosen = await f.run('replace', choice);
  assert.deepEqual(chosen.entries, [
    { ...entry, assetId: ASSETS.extra, size: 4, photo: scanError },
    initial.entries[1],
  ]);
  assert.deepEqual(chosen.basket, initial.basket);
  await assert.rejects(f.run('prepare', prepare), { code: 'conflict' });
  const confirm = {
    operationId: 'confirm',
    entryId: entry.id,
    expectedRevision: chosen.revision,
    assetId: ASSETS.original,
    originalAssetId: ASSETS.original,
    photo: { mode: 'scan' },
  };
  await assert.rejects(f.run('replace', { ...confirm, expectedRevision: initial.revision }), {
    code: 'conflict',
  });
  const confirmed = await f.run('replace', confirm);
  assert.deepEqual(confirmed.entries[0], {
    ...entry,
    assetId: ASSETS.original,
    size: 5,
    photo: confirm.photo,
  });
  f.reopen();
  const callsBeforeReplay = f.calls.length;
  assert.deepEqual(await f.run('replace', choice), confirmed);
  assert.equal(f.calls.length, callsBeforeReplay);
  await assert.rejects(f.run('replace', { ...choice, originalAssetId: ASSETS.draft }), { code: 'conflict' });
  f.losePrepare();
  await assert.rejects(f.run('prepare', prepare), { code: 'outcome_unknown' });
  const replacement = {
    operationId: 'replace',
    entryId: entry.id,
    expectedRevision: confirmed.revision,
    assetId: ASSETS.photo,
  };
  await assert.rejects(f.run('replace', replacement), { code: 'conflict' });
  const prepared = await f.run<{ selectionId: string }>('prepare', prepare);
  assert.deepEqual(f.calls.filter((c) => c.method === 'session.library.prepare').pop()?.args.files, [
    { assetId: ASSETS.original, name: entry.name, type: 'image/jpeg' },
  ]);
  f.states.set(prepared.selectionId, 'cancelled');
  await f.run('finish', prepared);
  const replaced = await f.run('replace', replacement);
  assert.deepEqual(replaced.entries[0], {
    kind: 'file',
    available: true,
    id: entry.id,
    assetId: ASSETS.photo,
    size: 3,
    type: entry.type,
    name: entry.name,
    createdAt: entry.createdAt,
    source: { app: 'files', channel: 'camera' },
    partitionId,
    collected: false,
  });
});

test('photo turns validate on import and replace and WebP replacement preserves entry identity and name stem', async (t) => {
  const f = fixture('image/webp');
  t.after(() => f.db.close());
  for (const quarterTurns of [0, -1, 4, 1.5, NaN, Infinity, '1', null, true]) {
    await assert.rejects(
      f.add(ASSETS.photo, 'basket', {
        photo: { mode: 'photo', quarterTurns },
      }),
      { code: 'invalid_request' },
    );
  }
  const initial = await f.add(ASSETS.photo, 'basket', {
    name: 'receipt.original.jpg',
    originalAssetId: ASSETS.original,
    photo: { mode: 'scan', quarterTurns: 1 },
  });
  assert.equal(initial.entries[0].type, 'image/webp');
  assert.equal(initial.entries[0].photo?.quarterTurns, 1);
  const replace = {
    operationId: 'rotate',
    entryId: initial.entries[0].id,
    expectedRevision: initial.revision,
    assetId: ASSETS.extra,
    originalAssetId: ASSETS.original,
  };
  for (const quarterTurns of [0, -1, 4, 1.5, NaN, Infinity, '1', null, true]) {
    await assert.rejects(f.run('replace', { ...replace, photo: { mode: 'scan', quarterTurns } }), {
      code: 'invalid_request',
    });
  }
  let next = await f.run('replace', { ...replace, photo: { mode: 'scan', quarterTurns: 2 } });
  assert.deepEqual(next.entries[0], {
    ...initial.entries[0],
    assetId: ASSETS.extra,
    size: 4,
    name: 'receipt.original.webp',
    photo: { mode: 'scan', quarterTurns: 2 },
  });
  assert.deepEqual(next.basket, initial.basket);
  next = await f.run('replace', {
    ...replace,
    operationId: 'rotate-three',
    expectedRevision: next.revision,
    photo: { mode: 'scan', quarterTurns: 3 },
  });
  assert.equal(next.entries[0].photo?.quarterTurns, 3);
  f.reopen();
  assert.deepEqual(await f.run('get'), next);
});

test('photo metadata validates candidate references and prunes them when an entry is removed', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  await assert.rejects(
    f.add(ASSETS.photo, 'basket', {
      photo: { mode: 'scan', processingFailure: { code: 'invalid-code', message: 'invalid' } },
    }),
    {
      code: 'invalid_request',
    },
  );
  await assert.rejects(
    f.add(ASSETS.photo, 'basket', {
      photo: { mode: 'photo', candidateAssetIds: [ASSETS.extra, ASSETS.extra] },
    }),
    { code: 'invalid_request' },
  );
  await assert.rejects(
    f.add(ASSETS.photo, 'basket', {
      photo: { mode: 'photo', candidateAssetIds: [ASSETS.draft, ASSETS.extra, ASSETS.original] },
    }),
    { code: 'limit_exceeded' },
  );
  await assert.rejects(
    f.add(ASSETS.photo, 'basket', { photo: { mode: 'photo', candidateAssetIds: [ASSETS.missing] } }),
    { code: 'not_found' },
  );
  await f.add(ASSETS.draft, 'library', { originalAssetId: ASSETS.original });
  const pending = await f.add(ASSETS.photo, 'basket', {
    photo: { mode: 'photo', pending: 'choice', candidateAssetIds: [ASSETS.original, ASSETS.extra] },
  });
  const pruned = await f.run('basket', { operationId: 'prune', expectedRevision: pending.revision, ids: [] });
  assert.deepEqual(
    pruned.entries.map((e) => e.assetId),
    [ASSETS.draft],
  );
});

const uploadSource = { app: 'files', channel: 'upload' };
const requestOrigin = { kind: 'request', requestId: 'chooser' };
type Finish = { state: SelectionState; snapshot: LibrarySnapshot };

async function prepare(f: ReturnType<typeof fixture>, entryId: string, operationId = 'prepare') {
  return f.run<{ selectionId: string }>('prepare', {
    operationId,
    requestId: 'chooser',
    entryIds: [entryId],
  });
}

test('request imports infer browser and web app sources and replay without the retired request', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const first = await f.add(ASSETS.photo, 'basket', { origin: requestOrigin });
  assert.deepEqual(first.entries[0].source, { app: 'browser', channel: 'example.test' });
  assert.equal(first.entries[0].collected, false);
  f.setSource({ app: 'web:mail', channel: '' });
  const second = await f.add(ASSETS.extra, 'basket', { origin: requestOrigin });
  assert.deepEqual(second.sources, [
    { app: 'web:mail', channel: '', count: 1, excluded: false },
    { app: 'browser', channel: 'example.test', count: 1, excluded: false },
  ]);
  f.setSource(null);
  f.reopen();
  assert.deepEqual(await f.add(ASSETS.photo, 'basket', { origin: requestOrigin }), second);
  await assert.rejects(f.add(ASSETS.draft, 'basket', { origin: requestOrigin }), { code: 'conflict' });
  await assert.rejects(f.add(ASSETS.photo, 'basket', { origin: { ...requestOrigin, requestId: 'other' } }), {
    code: 'conflict',
  });
});

test('source exclusion hides aggregate entries, supports undo, and permits explicit library uploads', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const partitionId = (await f.run('partition', { operationId: 'partition', name: 'Saved' })).partitions[0]
    .id;
  const first = (await f.add(ASSETS.photo, 'library')).entries[0];
  const second = (
    await f.add(ASSETS.extra, 'library', {
      origin: { kind: 'files', channel: 'upload', partitionId },
    })
  ).entries[0];
  const excluded = await f.run('source', { operationId: 'exclude', source: uploadSource, excluded: true });
  assert.deepEqual(excluded.sources, [{ ...uploadSource, count: 2, excluded: true }]);
  assert.deepEqual(f.hidden(), new Set([first.id, second.id]));
  assert.equal(f.exists(first.id), true);
  assert.equal(f.exists('missing'), false);
  assert.equal(f.organized(second.id), true);
  assert.equal(f.organized(first.id), false);
  const direct = await f.add(ASSETS.draft, 'library');
  assert.equal(direct.entries[0].collected, true);
  assert.ok(f.hidden().has(direct.entries[0].id));
  const restored = await f.run('source', { operationId: 'include', source: uploadSource, excluded: false });
  assert.deepEqual(restored.excludedSources, []);
  assert.deepEqual(f.hidden(), new Set());
  f.reopen();
  assert.deepEqual(
    await f.run('source', { operationId: 'exclude', source: uploadSource, excluded: true }),
    restored,
  );
});

test('finish uses current exclusions and basket partition and settles exactly once after restart', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = { app: 'browser', channel: 'example.test' };
  const partitionId = (await f.run('partition', { operationId: 'partition', name: 'Sent' })).partitions[0].id;
  const initial = await f.add(ASSETS.photo, 'basket', { origin: requestOrigin });
  const entryId = initial.entries[0].id;
  const selection = await prepare(f, entryId);
  await f.run('source', { operationId: 'exclude', source, excluded: true });
  await f.run('basketPartition', { operationId: 'destination', partitionId });
  f.states.set(selection.selectionId, 'selected');
  f.reopen();
  const result = await f.run<Finish>('finish', selection);
  assert.deepEqual(result.snapshot.basket, []);
  assert.deepEqual(result.snapshot.entries, [{ ...initial.entries[0], partitionId }]);
  assert.deepEqual(f.hidden(), new Set([entryId]));
  await f.run('source', { operationId: 'include', source, excluded: false });
  await f.run('basketPartition', { operationId: 'clear-destination', partitionId: null });
  const latest = await f.run('get');
  assert.deepEqual(await f.run('finish', selection), { state: 'selected', snapshot: latest });
  assert.equal(latest.entries[0].collected, false);
  const moved = await f.run('move', { operationId: 'unorganize', ids: [entryId], partitionId: null });
  assert.deepEqual(moved.entries, []);
});

test('excluded consumed entries lose collection and vanish when their last reference ends', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const initial = await f.add(ASSETS.photo, 'library');
  const entryId = initial.entries[0].id;
  await f.run('basket', { operationId: 'basket', expectedRevision: initial.revision, ids: [entryId] });
  const selection = await prepare(f, entryId);
  await f.run('source', { operationId: 'exclude', source: uploadSource, excluded: true });
  f.states.set(selection.selectionId, 'selected');
  const result = await f.run<Finish>('finish', selection);
  assert.deepEqual(result.snapshot.entries, []);
  assert.deepEqual(result.snapshot.sources, []);
  assert.equal(f.exists(entryId), false);
});

test('purge clears source references, retains partition and basket references, and prunes the rest', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const partitionId = (await f.run('partition', { operationId: 'partition', name: 'Kept' })).partitions[0].id;
  const discarded = (await f.add(ASSETS.photo, 'library')).entries[0];
  const organized = (
    await f.add(ASSETS.extra, 'library', {
      origin: { kind: 'files', channel: 'upload', partitionId },
    })
  ).entries[0];
  const basket = (await f.add(ASSETS.draft)).entries[0];
  const purged = await f.run('sourcePurge', { operationId: 'purge', source: uploadSource });
  assert.deepEqual(purged.sources, []);
  assert.deepEqual(
    purged.entries,
    [basket, organized].map((entry) => ({ ...entry, source: null, collected: false })),
  );
  assert.equal(f.exists(discarded.id), false);
  assert.equal(f.organized(organized.id), true);
  const removed = await f.run('basket', { operationId: 'clear', expectedRevision: purged.revision, ids: [] });
  assert.deepEqual(
    removed.entries.map((entry) => entry.id),
    [organized.id],
  );
  const deleted = await f.run('partitionDelete', { operationId: 'delete-partition', id: partitionId });
  assert.deepEqual(deleted.entries, []);
  f.reopen();
  assert.deepEqual(await f.run('sourcePurge', { operationId: 'purge', source: uploadSource }), deleted);
});

test('pending selections reject purge, partition deletion, and deletion atomically', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const partitionId = (await f.run('partition', { operationId: 'partition', name: 'Kept' })).partitions[0].id;
  const initial = await f.add(ASSETS.photo, 'library', {
    origin: { kind: 'files', channel: 'upload', partitionId },
  });
  const entryId = initial.entries[0].id;
  const selection = await prepare(f, entryId);
  const mutations = [
    ['sourcePurge', { operationId: 'purge', source: uploadSource }],
    ['partitionDelete', { operationId: 'delete-partition', id: partitionId }],
    ['delete', { operationId: 'delete', ids: [entryId] }],
  ] as const;
  for (const [method, params] of mutations) {
    await assert.rejects(f.run(method, params), { code: 'conflict' });
    assert.deepEqual(await f.run('get'), initial);
  }
  f.states.set(selection.selectionId, 'cancelled');
  await f.run('finish', selection);
  await f.run('sourcePurge', mutations[0][1]);
  const deleted = await f.run('partitionDelete', mutations[1][1]);
  assert.deepEqual(deleted.entries, []);
});

test('partition deletion keeps source and basket references and clears basket destination', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const partitionId = (await f.run('partition', { operationId: 'partition', name: 'Kept' })).partitions[0].id;
  const origin = { kind: 'files', channel: 'upload', partitionId };
  const collected = (await f.add(ASSETS.photo, 'library', { origin })).entries[0];
  const basket = (await f.add(ASSETS.extra, 'basket', { origin })).entries[0];
  await f.run('basketPartition', { operationId: 'destination', partitionId });
  const deleted = await f.run('partitionDelete', { operationId: 'delete-partition', id: partitionId });
  assert.equal(deleted.basketPartitionId, null);
  assert.deepEqual(deleted.partitions, []);
  assert.deepEqual(
    deleted.entries,
    [basket, collected].map((entry) => ({ ...entry, partitionId: null })),
  );
});

test('new mutations freeze payloads and reject mismatched operation IDs before state validation', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const partitionId = (await f.run('partition', { operationId: 'partition', name: 'Saved' })).partitions[0]
    .id;
  const mutations = [
    ['partition', { operationId: 'rename', id: partitionId, name: 'Sent' }, { name: 'Other' }],
    [
      'move',
      { operationId: 'move', ids: [(await f.add(ASSETS.photo, 'library')).entries[0].id], partitionId },
      { partitionId: null },
    ],
    ['source', { operationId: 'exclude', source: uploadSource, excluded: true }, { excluded: false }],
    ['basketPartition', { operationId: 'destination', partitionId }, { partitionId: null }],
    [
      'sourcePurge',
      { operationId: 'purge', source: uploadSource },
      { source: { app: 'files', channel: 'camera' } },
    ],
    ['partitionDelete', { operationId: 'delete-partition', id: partitionId }, { id: 'missing' }],
  ] as const;
  for (const [method, params, changed] of mutations) {
    const result = await f.run(method, params);
    f.reopen();
    assert.deepEqual(await f.run(method, params), result);
    await assert.rejects(f.run(method, { ...params, ...changed }), { code: 'conflict' });
  }
  await assert.rejects(f.run('basketPartition', { operationId: 'missing', partitionId: 'missing' }), {
    code: 'not_found',
  });
  await assert.rejects(
    f.run('source', {
      operationId: 'bad-source',
      source: { app: 'files', channel: 'other' },
      excluded: true,
    }),
    { code: 'invalid_request' },
  );
  await assert.rejects(
    f.run('import', {
      operationId: 'bad-origin',
      assetId: ASSETS.photo,
      name: 'file.jpg',
      destination: 'library',
      origin: { kind: 'files', channel: 'other', partitionId: null },
    }),
    { code: 'invalid_request' },
  );
});

test('object GC follows live entry assets, originals, candidates, and pending selections through purge', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const nodes = {
    handlers: new Map(),
    on() {},
    all: () => [],
    isRemoved: () => false,
  } as unknown as NodeRegistry;
  const store = {
    db: f.db,
    atRestKey: new AtRestKey(null),
    transaction: <T>(work: () => T) => f.db.transaction(work)(),
  } as ControlDatabase;
  const objects = new ObjectIndex(
    store,
    nodes,
    1024,
    () => false,
    () => false,
  );
  for (const assetId of [ASSETS.photo, ASSETS.original, ASSETS.extra, ASSETS.draft])
    f.db.prepare('INSERT INTO objects VALUES (?,?,?,?,?)').run(assetId, 3, 3, assetId, 0);
  const partitionId = (await f.run('partition', { operationId: 'partition', name: 'Saved' })).partitions[0]
    .id;
  const saved = await f.add(ASSETS.photo, 'library', {
    originalAssetId: ASSETS.original,
    origin: { kind: 'files', channel: 'upload', partitionId },
    photo: { mode: 'photo', candidateAssetIds: [ASSETS.extra] },
  });
  const basket = await f.add(ASSETS.draft);
  const selection = await prepare(f, basket.entries[0].id);
  await f.run('basket', { operationId: 'remove', expectedRevision: basket.revision, ids: [] });
  const indexed = () =>
    (f.db.prepare('SELECT id FROM objects ORDER BY id').all() as { id: string }[]).map((row) => row.id);
  const allAssets = indexed();
  await objects.gc();
  assert.deepEqual(indexed(), allAssets);
  f.states.set(selection.selectionId, 'cancelled');
  await f.run('finish', selection);
  await objects.gc();
  await objects.gc(Date.now() + 2 * 60 * 60 * 1000 + 1);
  assert.deepEqual(indexed(), [ASSETS.photo, ASSETS.original, ASSETS.extra].sort());
  await f.run('sourcePurge', { operationId: 'purge', source: uploadSource });
  await objects.gc();
  assert.equal(f.exists(saved.entries[0].id), true);
  assert.deepEqual(indexed(), [ASSETS.photo, ASSETS.original, ASSETS.extra].sort());
  await f.run('partitionDelete', { operationId: 'delete-partition', id: partitionId });
  await objects.gc();
  await objects.gc(Date.now() + 2 * 60 * 60 * 1000 + 1);
  assert.deepEqual(indexed(), []);
});

test('purged basket entries finish with only their partition reference', async (t) => {
  for (const organize of [false, true]) {
    const f = fixture();
    t.after(() => f.db.close());
    const initial = await f.add(ASSETS.photo);
    const entryId = initial.entries[0].id;
    await f.run('sourcePurge', { operationId: 'purge', source: uploadSource });
    let partitionId: string | null = null;
    if (organize) {
      partitionId = (await f.run('partition', { operationId: 'partition', name: 'Sent' })).partitions[0].id;
      await f.run('basketPartition', { operationId: 'destination', partitionId });
    }
    const selection = await prepare(f, entryId);
    f.states.set(selection.selectionId, 'selected');
    const { snapshot } = await f.run<Finish>('finish', selection);
    assert.deepEqual(snapshot.basket, []);
    assert.deepEqual(
      snapshot.entries,
      organize ? [{ ...initial.entries[0], source: null, collected: false, partitionId }] : [],
    );
  }
});

test('excluded request sources permit temporary basket imports and reject direct collection', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = { app: 'browser', channel: 'example.test' };
  await f.run('source', { operationId: 'exclude', source, excluded: true });
  await assert.rejects(f.add(ASSETS.photo, 'library', { origin: requestOrigin }), { code: 'conflict' });
  const basket = await f.add(ASSETS.photo, 'basket', { origin: requestOrigin });
  assert.equal(basket.entries[0].collected, false);
  const selection = await prepare(f, basket.entries[0].id);
  f.states.set(selection.selectionId, 'selected');
  const { snapshot } = await f.run<Finish>('finish', selection);
  assert.deepEqual(snapshot.entries, []);
});
