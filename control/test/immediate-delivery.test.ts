import assert from 'node:assert/strict';
import test from 'node:test';
import { FileChannel } from '../client/files/file-channel';
import { LibraryStore, type FilePort, type LibraryRequest } from '../client/files/library-store';
import type { Incoming } from '../client/rtc/protocol';
import { decodeIncoming } from '../client/rtc/protocol';
import type { LibrarySnapshot } from '../shared/file-library';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const snapshot = (revision: number): LibrarySnapshot => ({
  revision,
  entries: [],
  basket: [],
  partitions: [],
  sources: [],
  excludedSources: [],
  basketPartitionId: null,
});

test('a pushed selection result is emitted by the page channel', () => {
  const channel = new FileChannel(
    () => null,
    () => 1,
    'page',
  );
  const seen: unknown[] = [];
  channel.selectionResults.subscribe((event) => seen.push(event));
  const handled = channel.handle({
    type: 'files.selection',
    version: 1,
    selectionId: 'selection',
    state: 'selected',
    authEpoch: 1,
  } as Incoming);
  assert.equal(handled, true);
  assert.deepEqual(seen, [{ selectionId: 'selection', state: 'selected' }]);
});

test('a pushed selection result confirms its checkout at once, without waiting for the backstop', async () => {
  let finishes = 0;
  let state = 'validating';
  const request = (async (method: string) => {
    if (method === 'library.prepare') return { selectionId: 'selection' };
    if (method === 'library.finish') {
      finishes++;
      return { state, snapshot: snapshot(finishes) };
    }
    return snapshot(0);
  }) as LibraryRequest;
  const port = {
    commitSelection: async (_requestId: string, selectionId: string) => ({
      state: 'validating',
      selectionId,
    }),
  } as unknown as FilePort;
  const store = new LibraryStore(request, port);
  store.pushing = () => true;
  try {
    store.configure(true, true, 'viewer', ['request']);
    await flush();
    await store.select('request', ['entry']);
    assert.equal(store.getSnapshot().checkouts.request.state, 'validating');
    const before = finishes;
    state = 'selected';
    store.selectionResolved('other');
    await flush();
    assert.equal(finishes, before);
    store.selectionResolved('selection');
    await flush();
    assert.equal(finishes, before + 1);
    assert.equal(store.getSnapshot().checkouts.request.state, 'selected');
  } finally {
    store.dispose();
  }
});

test('the incoming message validator accepts only final pushed selection states', () => {
  const base = { type: 'files.selection', version: 1, selectionId: 's', authEpoch: 1 };
  assert.equal(decodeIncoming({ ...base, state: 'cancelled' }).type, 'files.selection');
  assert.equal(decodeIncoming({ ...base, state: 'pending' }).type, 'decode-error');
});
