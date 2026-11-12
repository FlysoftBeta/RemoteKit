import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlDatabase } from '../server/persistence/database';
import { FileLibrary } from '../server/files/library';
import { FILE_LIMITS } from '../shared/product';
import type { SnippetOrigin } from '../shared/file-library';
import { filesInView } from '../client/files/files-app-state';
import { snippetOriginLabel, snippetSearchText } from '../client/files/snippet-view';

const page: SnippetOrigin = {
  kind: 'page',
  app: 'browser',
  url: 'https://example.test/path',
  title: 'A page',
};

test('copying a snippet leaves unrelated library rows and object references untouched', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    const snapshot = store.library.recordSnippet('tenant', 'first', page, 1)!;
    const firstId = snapshot.entries[0].id;
    store.db.exec(`CREATE TEMP TABLE library_writes (table_name TEXT, id TEXT);
      CREATE TEMP TRIGGER entry_update AFTER UPDATE ON library_entries BEGIN INSERT INTO library_writes VALUES ('entry',new.id); END;
      CREATE TEMP TRIGGER partition_update AFTER DELETE ON library_partitions BEGIN INSERT INTO library_writes VALUES ('partition',old.id); END;
      CREATE TEMP TRIGGER basket_update AFTER DELETE ON library_basket BEGIN INSERT INTO library_writes VALUES ('basket',old.entry_id); END;
      CREATE TEMP TRIGGER reference_update AFTER INSERT ON object_gc BEGIN INSERT INTO library_writes VALUES ('object',new.id); END;`);
    store.library.recordSnippet('tenant', 'second', { kind: 'device' }, 2);
    assert.deepEqual(store.db.prepare('SELECT * FROM library_writes').all(), []);
    assert.equal(store.library.snapshot('tenant').entries[1].id, firstId);
  } finally {
    store.db.close();
  }
});

test('snippets keep text in Control, deduplicate per tenant and refresh origin and copy time', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    const text = '\n   hello   world \nfull text 😀';
    const first = store.library.recordSnippet('one', text, page, 10)!;
    const entry = first.entries[0];
    assert.equal(entry.kind, 'snippet');
    assert.equal(entry.size, Buffer.byteLength(text));
    assert.equal(entry.assetId, undefined);
    assert.equal(entry.kind === 'snippet' && entry.preview, 'hello world');
    assert.equal(JSON.stringify(first).includes('full text'), false);
    assert.deepEqual(store.library.snippet('one', entry.id), { text, html: '' });
    store.library.recordSnippet('one', 'newer', page, 11);
    store.library.change('one', 'organize', 'organize', (snapshot) => {
      snapshot.partitions.push({ id: 'partition', name: 'Saved' });
      snapshot.entries.find((item) => item.id === entry.id)!.partitionId = 'partition';
    });
    const repeated = store.library.recordSnippet('one', text, { kind: 'device' }, 12)!;
    assert.equal(repeated.entries.length, 2);
    assert.equal(repeated.entries[0].id, entry.id);
    assert.equal(repeated.entries[0].createdAt, 12);
    assert.equal(repeated.entries[0].partitionId, 'partition');
    assert.deepEqual(repeated.entries[0].kind === 'snippet' && repeated.entries[0].origin, {
      kind: 'device',
    });
    assert.throws(() => store.library.snippet('two', entry.id), { code: 'not_found' });
    const other = store.library.recordSnippet('two', text, page, 10)!;
    assert.notEqual(other.entries[0].id, entry.id);
  } finally {
    store.db.close();
  }
});

test('retention keeps newest 200 unorganized snippets and all organized snippets; deletion removes text', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    const first = store.library.recordSnippet('tenant', 'organized', page, 1)!.entries[0];
    store.library.change('tenant', 'move', 'move', (snapshot) => {
      snapshot.entries[0].partitionId = 'saved';
    });
    let removed = '';
    for (let index = 0; index < 205; index++) {
      const next = store.library.recordSnippet('tenant', String(index), page, index + 2)!;
      if (index === 0) removed = next.entries[0].id;
    }
    const snapshot = store.library.snapshot('tenant');
    assert.equal(snapshot.entries.length, 201);
    assert(snapshot.entries.some((entry) => entry.id === first.id));
    assert.throws(() => store.library.snippet('tenant', removed), { code: 'not_found' });
    assert.deepEqual(store.library.snippet('tenant', first.id), { text: 'organized', html: '' });
    store.library.deleteTenant('tenant');
    assert.equal(
      (store.db.prepare('SELECT count(*) AS count FROM library_snippets').get() as { count: bigint }).count,
      0n,
    );
  } finally {
    store.db.close();
  }
});

test('snippet fetch, exclusion, source purge and file-selection barriers use library methods', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const library = new FileLibrary(store.library, {} as any, FILE_LIMITS, {} as any, () => null);
  const call = (method: string, params: unknown) =>
    library.request(
      'tenant',
      method,
      params,
      () => {},
      () => undefined,
    );
  try {
    await library.recordSnippet('tenant', 'first', page, 1);
    await library.recordSnippet('tenant', 'second', page, 2);
    const [second, first] = store.library.snapshot('tenant').entries;
    assert.deepEqual(await call('library.snippet', { id: first.id }), { text: 'first', html: '' });
    await call('library.partition', { operationId: 'partition', name: 'Saved' });
    const partitionId = store.library.snapshot('tenant').partitions[0].id;
    await call('library.move', { operationId: 'move', ids: [first.id], partitionId });
    await call('library.source', {
      operationId: 'exclude',
      source: { app: 'clipboard', channel: '' },
      excluded: true,
    });
    await library.recordSnippet('tenant', 'excluded', page, 3);
    assert.equal(store.library.snapshot('tenant').entries.length, 2);
    await assert.rejects(
      call('library.basket', {
        operationId: 'basket',
        ids: [first.id],
        expectedRevision: store.library.snapshot('tenant').revision,
      }),
      { code: 'invalid_request' },
    );
    await call('library.sourcePurge', { operationId: 'purge', source: { app: 'clipboard', channel: '' } });
    assert.throws(() => store.library.snippet('tenant', second.id), { code: 'not_found' });
    assert.equal(store.library.snapshot('tenant').entries.length, 1);
    assert.equal(store.library.snapshot('tenant').entries[0].source, null);
    assert.deepEqual(await call('library.snippet', { id: first.id }), { text: 'first', html: '' });
    await call('library.delete', { operationId: 'delete', ids: [first.id] });
    await assert.rejects(call('library.snippet', { id: first.id }), { code: 'not_found' });
  } finally {
    store.db.close();
  }
});

test('empty and oversized text are omitted, previews are bounded and origins never form categories', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    assert.equal(store.library.recordSnippet('tenant', '', page, 1), undefined);
    assert.equal(store.library.recordSnippet('tenant', '😀'.repeat(262145), page, 1), undefined);
    const snapshot = store.library.recordSnippet('tenant', '😀'.repeat(210), page, 2)!;
    const entry = snapshot.entries[0];
    assert(entry.kind === 'snippet');
    assert.equal(Array.from(entry.preview).length, 200);
    assert.deepEqual(snapshot.sources, [{ app: 'clipboard', channel: '', count: 1, excluded: false }]);
    assert.equal(filesInView(snapshot, 'all').length, 0);
    assert.equal(filesInView(snapshot, 'recent').length, 0);
    assert.equal(filesInView(snapshot, 'clipboard').length, 1);
    assert.equal(filesInView(snapshot, 'all', Date.now(), true).length, 1);
    assert.equal(snippetOriginLabel(page), 'example.test');
    assert.equal(snippetOriginLabel({ kind: 'device' }), '本机');
    assert.match(snippetSearchText(entry, []), /example.test\/path.*A page/);
  } finally {
    store.db.close();
  }
});
