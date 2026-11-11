import assert from 'node:assert/strict';
import test from 'node:test';
import {
  array,
  boolean,
  decodeJson,
  encodeJson,
  integer,
  literal,
  nullable,
  number,
  object,
  record,
  string,
  union,
} from '../server/persistence/codec';
import { receipt, settings } from '../server/persistence/documents';
import { defaultSettings } from '../server/persistence/workspaces';
import { operationPayload } from '../server/persistence/operations';
import { ControlDatabase } from '../server/persistence/database';

test('stored codecs reject missing, unknown, and mistyped fields on both reads and writes', () => {
  const codec = object(
    {
      name: string(),
      count: integer(),
      flags: record(boolean()),
      values: array(union(number(), literal('unknown')), { max: 2 }),
      parent: nullable(string()),
    },
    { enabled: boolean() },
  );
  const value = {
    name: 'row',
    count: 2,
    flags: { visible: true },
    values: [1, 'unknown'] as (number | 'unknown')[],
    parent: null,
  };
  assert.deepEqual(
    decodeJson(encodeJson(value, codec, 'table.column key'), codec, 'table.column key'),
    value,
  );
  for (const invalid of [
    { ...value, extra: true },
    { ...value, count: 1.5 },
    { ...value, name: undefined },
    { ...value, values: [1, 2, 3] },
    { ...value, flags: { visible: 'yes' } },
  ]) {
    assert.throws(() => encodeJson(invalid as typeof value, codec, 'table.column key'), {
      reason: 'corrupt_record',
    });
    assert.throws(
      () => decodeJson(JSON.stringify(invalid), codec, 'table.column key'),
      (error: any) =>
        error.reason === 'corrupt_record' &&
        error.detail.startsWith('table.column key: $') &&
        error.detail.includes('expected'),
    );
  }
  assert.throws(() => decodeJson('{', codec, 'table.column key'), {
    reason: 'corrupt_record',
    detail: 'table.column key: $ expected valid JSON',
  });
  const incomplete = defaultSettings();
  delete (incomplete.workspace as Partial<typeof incomplete.workspace>).autoKeyboard;
  assert.throws(() => decodeJson(JSON.stringify(incomplete), settings, 'user_settings.data tenant'), {
    reason: 'corrupt_record',
  });
});

test('receipt errors preserve valid error IDs and reject malformed IDs', () => {
  const value = {
    operationId: 'operation',
    operationGeneration: 'generation',
    status: 'failed' as const,
    error: { code: 'internal' as const, message: 'Failed', errorId: 'c-0123456789' },
  };
  assert.deepEqual(
    decodeJson(
      encodeJson(value, receipt, 'operation_receipts.receipt tenant/operation'),
      receipt,
      'operation_receipts.receipt tenant/operation',
    ),
    value,
  );
  assert.throws(
    () =>
      encodeJson(
        { ...value, error: { ...value.error, errorId: 'bad' } },
        receipt,
        'operation_receipts.receipt tenant/operation',
      ),
    { reason: 'corrupt_record' },
  );
});

test('recorded action encoding preserves canonical receipt payloads and rejects unknown fields', () => {
  const value = {
    type: 'window.state' as const,
    windowId: 'window',
    state: { z: 1, A: 2, a: 3, nested: { b: 1, B: 2 } },
  };
  assert.equal(
    operationPayload(value, 'operation_receipts.payload tenant/operation'),
    '{"state":{"A":2,"a":3,"nested":{"B":2,"b":1},"z":1},"type":"window.state","windowId":"window"}',
  );
  assert.throws(
    () =>
      operationPayload(
        { ...value, extra: true } as typeof value,
        'operation_receipts.payload tenant/operation',
      ),
    { reason: 'corrupt_record' },
  );
});

test('session import progress writers validate documents before changing the stored row', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    store.db.exec(
      "INSERT INTO session_imports(id,tenant,key_id,sites,state,cookies,origins,rejected_items,received_at) VALUES ('import','tenant','device','[]','pending',0,0,0,1)",
    );
    store.sessionImports.saveStorageJob('import', { importId: 'job' });
    assert.deepEqual(store.sessionImports.get('import')!.storageJob, { importId: 'job' });
    const counts = { cookies: { applied: 1, rejected: 0 }, localStorage: { applied: 2, rejected: 1 } };
    store.sessionImports.saveApplyCounts('import', 1, counts);
    const record = store.sessionImports.get('import')!;
    assert.deepEqual(record.applyCounts, counts);
    assert.equal(record.chunkIndex, 1);
    assert.equal(record.storageJob, undefined);
    const before = store.db.prepare('SELECT * FROM session_imports').get();
    assert.throws(
      () =>
        store.sessionImports.saveApplyCounts('import', 2, {
          ...counts,
          cookies: { applied: NaN, rejected: 0 },
        }),
      { reason: 'corrupt_record' },
    );
    assert.throws(
      () =>
        store.sessionImports.saveStorageJob('import', { importId: 'job', extra: true } as {
          importId: string;
        }),
      { reason: 'corrupt_record' },
    );
    assert.deepEqual(store.db.prepare('SELECT * FROM session_imports').get(), before);
  } finally {
    store.db.close();
  }
});
