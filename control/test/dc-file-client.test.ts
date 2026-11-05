import test from 'node:test';
import assert from 'node:assert/strict';
import { FileChannel } from '../client/files/file-channel';

test('library asset transfer resumes from the Endpoint offset and uses the library binding only', async () => {
  const data = new Uint8Array(40000).map((_, index) => index % 251);
  const file = new File([data], '照片.jpg', { type: 'image/jpeg' });
  const signal = new AbortController().signal;
  const asset = { assetId: 'sealed', hash: 'hash', size: data.byteLength, type: file.type };
  const messages: { method: string; params: any; authEpoch: number }[] = [];
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(text: string) {
      const message = JSON.parse(text);
      messages.push(message);
      const offset = message.params.offset;
      const part = data.subarray(offset, offset + 16384);
      const result =
        message.method === 'asset.begin'
          ? { uploadId: 'draft', offset: 16384 }
          : message.method === 'asset.chunk'
            ? { offset: offset + Buffer.from(message.params.data, 'base64').byteLength }
            : message.method === 'asset.seal'
              ? asset
              : message.method === 'asset.read'
                ? {
                    offset: offset + part.length,
                    total: data.length,
                    data: Buffer.from(part).toString('base64'),
                  }
                : { state: 'unknown', selectionId: 'selection' };
      queueMicrotask(() =>
        client.handle({ type: 'files.result', version: 1, requestId: message.requestId, ok: true, result }),
      );
    },
  } as unknown as RTCDataChannel;
  const client = new FileChannel(
    () => channel,
    () => 9,
  );
  assert.deepEqual(await client.uploadAsset(file, 'operation', signal), asset);
  const chunks = messages.filter((message) => message.method === 'asset.chunk');
  assert.deepEqual(
    chunks.map((message) => message.params.offset),
    [16384, 32768],
  );
  assert.deepEqual(
    Buffer.concat(chunks.map((message) => Buffer.from(message.params.data, 'base64'))),
    Buffer.from(data.subarray(16384)),
  );
  assert.deepEqual(new Uint8Array(await (await client.readPhoto(asset, signal)).arrayBuffer()), data);
  assert.ok(messages.every((message) => message.params.requestId === 'library' && message.authEpoch === 9));
  assert.deepEqual(await client.commitSelection('chooser', 'selection'), {
    state: 'unknown',
    selectionId: 'selection',
  });
  assert.deepEqual(messages[messages.length - 1]?.params, { requestId: 'chooser', selectionId: 'selection' });
});

test('library asset uploads fill four ordered chunk slots and seal only after every valid ACK', async () => {
  const sent: any[] = [];
  let notify!: () => void;
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(text: string) {
      sent.push(JSON.parse(text));
      notify?.();
    },
  } as unknown as RTCDataChannel;
  const client = new FileChannel(() => channel);
  function ack(message: any, result: unknown) {
    client.handle({ type: 'files.result', version: 1, requestId: message.requestId, ok: true, result });
  }
  async function waitFor(count: number) {
    while (sent.length < count)
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
  }
  const file = new File([new Uint8Array(6 * 16384)], 'original.png', { type: 'image/png' });
  const run = client.uploadAsset(file, 'capture', new AbortController().signal);
  ack(sent[0], { uploadId: 'draft', offset: 0 });
  await waitFor(5);
  assert.deepEqual(
    sent.slice(1).map((message) => message.params.offset),
    [0, 16384, 32768, 49152],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 5);
  ack(sent[1], { offset: 16384 });
  await waitFor(6);
  assert.equal(sent[5].params.offset, 65536);
  ack(sent[2], { offset: 32768 });
  await waitFor(7);
  assert.equal(sent[6].params.offset, 81920);
  for (const index of [6, 4, 5]) ack(sent[index], { offset: index * 16384 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 7, 'seal needs all valid offsets, even when ACKs finish out of order');
  ack(sent[3], { offset: 49152 });
  await waitFor(8);
  assert.equal(sent[7].method, 'asset.seal');
  ack(sent[7], { assetId: 'sealed' });
  assert.equal((await run).assetId, 'sealed');
});

test('photo burst admits a 44 KiB sample, rejects oversized analysis data and discards revoked sessions', async () => {
  const sent: any[] = [];
  let epoch = 1;
  const expected = {
    selectedFrameId: '1',
    keepFrameIds: ['1'],
    candidates: [{ frameId: '1', score: 1 }],
    uncertain: false,
    stop: true,
    reason: 'quality',
  };
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(text: string) {
      const message = JSON.parse(text);
      sent.push(message);
      const result = message.method === 'photo.burst.begin' ? { burstId: 'burst' } : expected;
      queueMicrotask(() =>
        client.handle({ type: 'files.result', version: 1, requestId: message.requestId, ok: true, result }),
      );
    },
  } as unknown as RTCDataChannel;
  const client = new FileChannel(
    () => channel,
    () => epoch,
  );
  const signal = new AbortController().signal;
  const { burstId } = await client.beginPhotoBurst(signal);
  const jpeg = new Blob([new Uint8Array(44 * 1024)], { type: 'image/jpeg' });
  assert.deepEqual(await client.samplePhotoBurst(burstId, '1', jpeg, ['1'], signal), expected);
  assert.ok(JSON.stringify(sent[1]).length > 24576 && JSON.stringify(sent[1]).length <= 61440);
  assert.equal(sent[1].params.requestId, 'library');
  assert.equal(Buffer.from(sent[1].params.data, 'base64').length, jpeg.size);
  await assert.rejects(
    client.samplePhotoBurst(
      burstId,
      '2',
      new Blob([jpeg, 'extra'], { type: 'image/jpeg' }),
      ['1', '2'],
      signal,
    ),
    /大小或格式/,
  );
  assert.deepEqual(await client.endPhotoBurst(burstId, ['1'], signal), expected);
  await assert.rejects(client.samplePhotoBurst(burstId, '2', jpeg, ['2'], signal), /会话已结束/);
  await client.beginPhotoBurst(signal);
  epoch++;
  await assert.rejects(client.samplePhotoBurst(burstId, '2', jpeg, ['2'], signal), /连接中断/);
  await assert.rejects(client.cancelPhotoBurst(burstId), /连接中断/);
  assert.deepEqual(
    sent.map((message) => message.method),
    ['photo.burst.begin', 'photo.burst.sample', 'photo.burst.end', 'photo.burst.begin'],
  );
});

test('original preview permits PNGs through 64 MiB while thumbnails remain limited to 64 KiB', async () => {
  const sent: string[] = [];
  const original = { assetId: 'original', hash: 'hash', type: 'image/png', size: 64 * 1024 * 1024 };
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(text: string) {
      const message = JSON.parse(text);
      sent.push(message.method);
      const result =
        message.method === 'asset.describe'
          ? original
          : message.method === 'photo.thumbnail'
            ? { ...original, type: 'image/jpeg', size: 65537 }
            : { data: '', offset: 0, total: original.size };
      queueMicrotask(() =>
        client.handle({ type: 'files.result', version: 1, requestId: message.requestId, ok: true, result }),
      );
    },
  } as unknown as RTCDataChannel;
  const client = new FileChannel(() => channel);
  const signal = new AbortController().signal;
  assert.deepEqual(await client.describeAsset('original', signal), original);
  await assert.rejects(client.describeAsset('different', signal), /文件信息无效/);
  await assert.rejects(client.readPhoto(original, signal), /照片预览数据无效/);
  await assert.rejects(client.readPhoto({ ...original, size: original.size + 1 }, signal), /大小超出限制/);
  await assert.rejects(client.photoThumbnail('original', signal), /缩略图数据无效/);
  assert.deepEqual(sent, ['asset.describe', 'asset.describe', 'asset.read', 'photo.thumbnail']);
});

test('chooser cancellation uses the authenticated selection command without an upload batch', async () => {
  const messages: any[] = [];
  let state = 'cancelled';
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(text: string) {
      const message = JSON.parse(text);
      messages.push(message);
      queueMicrotask(() =>
        client.handle({
          type: 'files.result',
          version: 1,
          requestId: message.requestId,
          ok: true,
          result: { state },
        }),
      );
    },
  } as unknown as RTCDataChannel;
  const client = new FileChannel(
    () => channel,
    () => 7,
  );
  for (const outcome of ['cancelled', 'validating', 'selected', 'unknown']) {
    state = outcome;
    assert.deepEqual(await client.cancelSelection('chooser'), { state: outcome });
  }
  assert.equal(messages[0].method, 'selection.cancel');
  assert.deepEqual(messages[0].params, { requestId: 'chooser' });
  assert.equal(messages[0].authEpoch, 7);
});
