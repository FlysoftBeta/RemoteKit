import { log } from '../server/log';
import { AtRestKey } from '../server/auth/crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { FileLibrary } from '../server/files/library';
import { LibraryRepository } from '../server/persistence/library';
import { migrate } from '../server/persistence/schema';
import { PageRequests } from '../server/workspace/page-requests';
import type { DownloadEvent } from '../server/endpoint/types';
import type { ProductWorkspace } from '../shared/product';

const imported: DownloadEvent = {
  type: 'download.imported',
  eventId: 'download-incarnation-guid',
  assetId: 'a'.repeat(64),
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: '123',
  origin: 'https://example.com:8443',
};
function fixture() {
  const db = new Database(':memory:');
  migrate(db, { backupDirectory: '', buildId: 'test', atRestKey: new AtRestKey(null) });
  const repository = new LibraryRepository(db);
  const manager = () =>
    new FileLibrary(
      repository,
      {} as never,
      { maxFileBytes: 256 * 1024 * 1024, maxBatchBytes: 512 * 1024 * 1024, maxFiles: 64 },
      { require: () => ({}) as never, checkQuota: () => {} },
      () => null,
    );
  let library = manager();
  const acknowledgements: string[][] = [];
  const consumer = new PageRequests(
    {
      endpoint: {
        ackEvents: async (_tenant: string, { eventIds }: { eventIds: string[] }) => {
          assert.ok(db.prepare('SELECT 1 FROM file_library_operations WHERE tenant=?').get('tenant'));
          acknowledgements.push(eventIds);
          return { accepted: true };
        },
      },
    } as never,
    {
      get library() {
        return library;
      },
      operations: { saveWorkspace: () => {} },
    } as never,
  );
  const state = { tenantId: 'tenant', tabs: [] } as unknown as ProductWorkspace;
  return {
    db,
    repository,
    acknowledgements,
    consume: (events: DownloadEvent[]) => consumer.consumeClosedEvents(state, { events }),
    exclude: (channel: string) =>
      library.request(
        'tenant',
        'library.source',
        {
          operationId: 'exclude',
          source: { app: 'download', channel },
          excluded: true,
        },
        () => {},
        () => undefined,
      ),
    reopen: () => {
      library = manager();
    },
  };
}

test('download entries use a separate collected source, host with port, and no partition or basket', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const before = Date.now();
  await f.consume([imported]);
  const snapshot = f.repository.snapshot('tenant');
  assert.equal(snapshot.entries.length, 1);
  const entry = snapshot.entries[0];
  assert.deepEqual(
    { ...entry, id: '', createdAt: 0 },
    {
      id: '',
      kind: 'file',
      createdAt: 0,
      assetId: imported.assetId,
      name: 'report.pdf',
      type: 'application/pdf',
      size: 123,
      source: { app: 'download', channel: 'example.com:8443' },
      partitionId: null,
      collected: true,
    },
  );
  assert.ok(entry.createdAt >= before && entry.createdAt <= Date.now());
  assert.deepEqual(snapshot.basket, []);
  f.reopen();
  await f.consume([imported]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 1);
  assert.deepEqual(f.acknowledgements, [[imported.eventId], [imported.eventId]]);
});

test('download sources can be excluded through the library source API', async (t) => {
  for (const channel of ['', 'example.com:8443', 'example.com:443']) {
    const f = fixture();
    t.after(() => f.db.close());
    await f.exclude(channel);
    assert.deepEqual(f.repository.snapshot('tenant').excludedSources, [{ app: 'download', channel }]);
  }
});

test('download source origin handles default ports, empty origins and opaque origins', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  for (const [origin, channel] of [
    ['https://example.com:443', 'example.com'],
    ['', ''],
    ['null', ''],
    ['http://example.com:443', 'example.com:443'],
  ]) {
    const event = { ...imported, eventId: 'event-' + origin, origin };
    await f.consume([event]);
    assert.deepEqual(f.repository.snapshot('tenant').entries[0].source, { app: 'download', channel });
  }
});

test('excluded download sources and full catalogs durably omit entries, including replay', async (t) => {
  const warn = t.mock.method(log, 'warn', () => {});
  const f = fixture();
  t.after(() => f.db.close());
  const snapshot = f.repository.snapshot('tenant');
  snapshot.excludedSources = [{ app: 'download', channel: 'example.com:8443' }];
  f.repository.save('tenant', snapshot);
  await f.consume([imported]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 0);
  snapshot.excludedSources = [];
  f.repository.save('tenant', snapshot);
  await f.consume([imported]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 0);
  await f.consume([{ ...imported, eventId: 'seed' }]);
  const full = f.repository.snapshot('tenant');
  full.entries = Array.from({ length: 4096 }, (_, index) => ({ ...full.entries[0], id: String(index) }));
  f.repository.save('tenant', full);
  await f.consume([{ ...imported, eventId: 'full' }]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 4096);
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [
      [
        'library.download_omitted_catalog_full',
        { tenant: 'tenant', assetId: imported.assetId, name: imported.name },
      ],
    ],
  );
  full.entries = [];
  f.repository.save('tenant', full);
  f.reopen();
  await f.consume([{ ...imported, eventId: 'full' }]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 0);
});

test('failed downloads only log and acknowledge; a failed catalog commit never acknowledges', async (t) => {
  const warn = t.mock.method(log, 'warn', () => {});
  const f = fixture();
  t.after(() => f.db.close());
  const failed: DownloadEvent = {
    type: 'download.failed',
    eventId: 'failed',
    name: 'report.pdf',
    origin: '',
    error: { code: 'limit_exceeded', message: 'Storage quota exceeded', reason: 'storage_quota_exceeded' },
  };
  await f.consume([failed]);
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [
      [
        'library.download_failed',
        { tenant: 'tenant', name: failed.name, origin: failed.origin, error: failed.error },
      ],
    ],
  );
  assert.equal(f.repository.snapshot('tenant').entries.length, 0);
  assert.deepEqual(f.acknowledgements, [['failed']]);
  const save = f.repository.save.bind(f.repository);
  f.repository.save = () => {
    throw new Error('disk full');
  };
  await assert.rejects(f.consume([imported]), /disk full/);
  assert.deepEqual(f.acknowledgements, [['failed']]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 0);
  f.repository.save = save;
  await f.consume([imported]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 1);
});
