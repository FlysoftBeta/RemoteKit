import assert from 'node:assert/strict';
import test from 'node:test';
import { FileChannel, SelectionCommitFailure } from '../client/files/file-channel';
import type { Incoming } from '../client/rtc/protocol';
const flush = () => new Promise<void>((done) => setImmediate(done));
function fixture(role: 'objects' | 'page' = 'objects') {
  const sent: { requestId: string; method: string; params: { offset: number } }[] = [];
  const rtc = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as unknown as RTCDataChannel;
  const channel = new FileChannel(
    () => rtc,
    () => 1,
    role,
  );
  const reply = (requestId: string, result: unknown) =>
    channel.handle({
      type: 'files.result',
      version: 1,
      requestId,
      authEpoch: 1,
      ok: true,
      result,
    } as Incoming);
  return { sent, rtc, channel, reply };
}

test('asset reads maintain four in-flight offsets, assemble in order and report completed bytes', async (t) => {
  const f = fixture();
  t.after(() => f.channel.disconnect());
  const size = 5 * 16384 + 7;
  const progress: number[] = [];
  const pending = f.channel.readAsset(
    { assetId: 'image', size, type: 'image/jpeg' },
    new AbortController().signal,
    (bytes) => progress.push(bytes),
  );
  await flush();
  assert.deepEqual(
    f.sent.map((message) => message.params.offset),
    [0, 16384, 32768, 49152],
  );
  const complete = (offset: number) => {
    const message = f.sent.find((message) => message.params.offset === offset)!;
    const length = Math.min(16384, size - offset);
    f.reply(message.requestId, {
      data: btoa(String.fromCharCode(offset / 16384).repeat(length)),
      offset: offset + length,
      total: size,
    });
  };
  complete(32768);
  await flush();
  assert.equal(f.sent.length, 5);
  complete(65536);
  await flush();
  assert.equal(f.sent.length, 6);
  for (const offset of [81920, 49152, 16384, 0]) complete(offset);
  const bytes = new Uint8Array(await (await pending).arrayBuffer());
  assert.equal(bytes.length, size);
  for (let offset = 0; offset < size; offset++) assert.equal(bytes[offset], Math.floor(offset / 16384));
  assert.equal(progress[progress.length - 1], size);
  assert.ok(progress.every((bytes, index) => !index || bytes > progress[index - 1]));
});

test('native commit distinguishes explicit rejection from a lost sent response', async (t) => {
  const f = fixture('page');
  t.after(() => f.channel.disconnect());
  const rejected = f.channel.commitSelection('request', 'selection');
  const check = assert.rejects(
    rejected,
    (error) =>
      error instanceof SelectionCommitFailure &&
      error.disposition === 'retry' &&
      error.code === 'not_found' &&
      error.detail === 'asset_unreadable',
  );
  await flush();
  f.channel.handle({
    type: 'files.result',
    version: 1,
    requestId: f.sent[0].requestId,
    authEpoch: 1,
    ok: false,
    error: { code: 'not_found', message: 'unreadable', detail: 'asset_unreadable' },
  } as Incoming);
  await check;
  const unknown = assert.rejects(
    f.channel.commitSelection('request', 'selection'),
    (error) =>
      error instanceof SelectionCommitFailure &&
      error.disposition === 'query' &&
      error.code === 'outcome_unknown',
  );
  await flush();
  f.channel.disconnect();
  await unknown;
  (f.rtc as unknown as { readyState: string }).readyState = 'closed';
  await assert.rejects(
    f.channel.commitSelection('request', 'selection'),
    (error) => error instanceof SelectionCommitFailure && error.disposition === 'retry',
  );
});
