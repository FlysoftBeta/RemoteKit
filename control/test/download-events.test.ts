import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AtRestKey } from '../server/auth/crypto';
import type { DownloadEvent } from '../server/endpoint/types';
import { FileLibrary } from '../server/files/library';
import { log } from '../server/log';
import { LibraryRepository } from '../server/persistence/library';
import { migrate } from '../server/persistence/migrations';
import { SessionEvents } from '../server/workspace/session-events';
import { CoordinationRepository } from '../server/persistence/coordination';
import { EventEmitter } from 'node:events';
import { RemoteKitError } from '../shared/errors';
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
  for (const tenant of ['tenant', 'other'])
    db.prepare('INSERT INTO library_state VALUES (?,0,NULL)').run(tenant);
  const repository = new LibraryRepository(db);
  const manager = () =>
    new FileLibrary(
      repository,
      {} as never,
      { maxFileBytes: 256 * 1024 * 1024, maxBatchBytes: 512 * 1024 * 1024, maxFiles: 64 },
      { available: () => true, require: () => ({}) as never, checkQuota: () => {} },
      () => null,
    );
  let library = manager();
  const acknowledgements: { streamId: string; upTo: string }[] = [];
  const runtime = { backgroundTasks: new Map() };
  const coordination = new CoordinationRepository(db, new AtRestKey(null));
  const nodes = Object.assign(new EventEmitter(), {
    get: () => ({ state: { state: 'ready', connectionEpoch: 'connection' } }),
  });
  const consumer = new SessionEvents(
    {
      store: { coordination, transaction: (fn: () => unknown) => db.transaction(fn)() },
      tenants: { get: () => runtime },
      endpoint: {
        nodes,
        sessionFault: () => undefined,
        faultSession: (_tenant: string, error: unknown) => {
          throw error;
        },
        placement: { peek: () => ({ nodeId: 'node', sessionId: 'session', placementEpoch: 1 }) },
        acknowledge: async (ack: { streamId: string; upTo: string }) => {
          assert.ok(db.prepare('SELECT 1 FROM file_library_operations WHERE tenant=?').get('tenant'));
          acknowledgements.push({ streamId: ack.streamId, upTo: ack.upTo });
        },
      },
    } as never,
    {
      get library() {
        return library;
      },
      viewers: { push: () => {} },
    } as never,
  );
  let sequence = 0;
  const sourceSequences = new Map<string, string>();
  return {
    db,
    runtime,
    repository,
    acknowledgements,
    consume: async (events: DownloadEvent[]) => {
      for (const event of events) {
        let seq = sourceSequences.get(event.eventId);
        if (!seq) sourceSequences.set(event.eventId, (seq = String(++sequence)));
        const { type, eventId, ...body } = event;
        await consumer.receive('node', {
          event: 'session.event',
          tenantId: 'tenant',
          sessionId: 'session',
          placementEpoch: 1,
          connectionEpoch: 'connection',
          streamId: 'stream',
          seq,
          eventId,
          browserIncarnation: 'browser',
          type,
          body,
        } as never);
      }
    },
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
      available: true,
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
  assert.deepEqual(f.acknowledgements, [
    { streamId: 'stream', upTo: '1' },
    { streamId: 'stream', upTo: '1' },
  ]);
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

test('excluded sources omit entries and full catalogs retain the download until space is available', async (t) => {
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
  await assert.rejects(
    f.consume([{ ...imported, eventId: 'full' }]),
    (error: RemoteKitError) => error.code === 'limit_exceeded',
  );
  assert.equal(f.repository.snapshot('tenant').entries.length, 4096);
  assert.equal(f.acknowledgements[f.acknowledgements.length - 1]?.upTo, '2');
  full.entries = [];
  f.repository.save('tenant', full);
  f.reopen();
  await f.consume([{ ...imported, eventId: 'full' }]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 1);
  assert.equal(f.runtime.backgroundTasks.get('full').state, 'complete');
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
  assert.deepEqual(f.acknowledgements, [{ streamId: 'stream', upTo: '1' }]);
  const save = f.repository.save.bind(f.repository);
  f.repository.save = () => {
    throw new Error('disk full');
  };
  await assert.rejects(f.consume([imported]), /disk full/);
  assert.deepEqual(f.acknowledgements, [{ streamId: 'stream', upTo: '1' }]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 0);
  f.repository.save = save;
  await f.consume([imported]);
  assert.equal(f.repository.snapshot('tenant').entries.length, 1);
});
