import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelDocumentSource } from '../client/documents/channel-source';
import { RemoteKitError } from '../shared/errors';
import { documentFixture } from '../client/test-hooks-learning-fixtures';
import { FileChannel } from '../client/files/file-channel';
import { decodeIncoming } from '../client/rtc/protocol';

test('DataChannel document failures are localized once and retain native diagnosis', async () => {
  for (const [reason, expected] of [
    ['document_encrypted', '文档受密码保护，无法转换'],
    ['document_corrupt', '文档已损坏，无法转换'],
    ['document_unsupported', '不支持此文档格式'],
    ['document_too_complex', '文档过于复杂，超出处理限制'],
    ['future_reason', '无法处理此内容'],
    ['toString', '无法处理此内容'],
  ]) {
    for (const resource of [false, true]) {
      let calls = 0;
      const channel = {
        readyState: 'open',
        bufferedAmount: 0,
        send(raw: string) {
          calls++;
          const request = JSON.parse(raw);
          const reply = decodeIncoming(
            JSON.stringify({
              type: 'files.result',
              version: 1,
              requestId: request.requestId,
              ok: false,
              error: { code: 'rejected', message: 'Native conversion diagnosis', reason, retryAfterMs: 1 },
            }),
          );
          assert.notEqual(reply.type, 'decode-error');
          if (reply.type !== 'decode-error') queueMicrotask(() => files.handle(reply));
        },
      } as RTCDataChannel;
      const files = new FileChannel(() => channel);
      const source = new ChannelDocumentSource(
        {
          documentOpen: resource
            ? async () => ({ state: 'ready', ...documentFixture.info })
            : files.documentOpen.bind(files),
          documentResource: files.documentResource.bind(files),
        },
        'asset',
      );
      const signal = new AbortController().signal;
      if (resource) await source.open(signal);
      await assert.rejects(resource ? source.resource('html', signal) : source.open(signal), (error) => {
        assert.ok(error instanceof RemoteKitError);
        assert.equal(error.code, 'rejected');
        assert.equal(error.message, expected);
        assert.equal(error.detail, 'Native conversion diagnosis');
        assert.equal(error.reason, reason.startsWith('document_') ? reason : undefined);
        assert.equal(error.retryAfterMs, undefined);
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test('conversion polling preserves the final DataChannel reason after converting state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(raw: string) {
      const request = JSON.parse(raw);
      const reply = decodeIncoming(
        JSON.stringify({
          type: 'files.result',
          version: 1,
          requestId: request.requestId,
          ...(++calls === 1
            ? { ok: true, result: { state: 'converting' } }
            : { ok: false, error: { code: 'rejected', message: 'broken XML', reason: 'document_corrupt' } }),
        }),
      );
      if (reply.type !== 'decode-error') queueMicrotask(() => files.handle(reply));
    },
  } as RTCDataChannel;
  const files = new FileChannel(() => channel);
  const source = new ChannelDocumentSource(files, 'asset');
  const statuses: string[] = [];
  const opening = source.open(new AbortController().signal, { onStatus: (status) => statuses.push(status) });
  const failed = assert.rejects(opening, {
    code: 'rejected',
    message: '文档已损坏，无法转换',
    detail: 'broken XML',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(statuses, ['converting']);
  t.mock.timers.tick(1500);
  await failed;
  assert.equal(calls, 2);
});

test('document source opens the rendition and reconstructs chunked resources', async () => {
  const requested: number[] = [];
  const bytes = '文档资源'.repeat(12000);
  const data = new TextEncoder().encode(bytes);
  const source = new ChannelDocumentSource(
    {
      documentOpen: async () => ({ state: 'ready', ...documentFixture.info }),
      documentResource: async (_id, _content, offset) => {
        requested.push(offset);
        const chunk = data.slice(offset, offset + 16384);
        return {
          data: Buffer.from(chunk).toString('base64'),
          offset: offset + chunk.length,
          total: data.length,
          mime: 'text/html',
        };
      },
    },
    'asset',
  );
  const signal = new AbortController().signal;
  assert.equal((await source.open(signal)).documentId, documentFixture.info.documentId);
  const resource = await source.resource('html', signal);
  assert.equal(resource.mime, 'text/html');
  assert.equal(await resource.data.text(), bytes);
  assert.deepEqual(requested.slice(0, 3), [0, 16384, 32768]);
});

test('conversion polling retries at 1.5 seconds and stops on cancellation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const source = new ChannelDocumentSource(
    {
      documentOpen: async () =>
        ++attempts === 1 ? { state: 'converting' } : { state: 'ready', ...documentFixture.info },
      documentResource: async () => {
        throw new Error();
      },
    },
    'asset',
  );
  const statuses: string[] = [];
  const opening = source.open(new AbortController().signal, { onStatus: (status) => statuses.push(status) });
  await Promise.resolve();
  context.mock.timers.tick(1499);
  assert.equal(attempts, 1);
  assert.deepEqual(statuses, ['converting']);
  context.mock.timers.tick(1);
  await opening;
  assert.equal(attempts, 2);
  assert.deepEqual(statuses, ['converting', 'ready']);
  const controller = new AbortController();
  const cancelled = new ChannelDocumentSource(
    {
      documentOpen: async () => ({ state: 'converting' }),
      documentResource: async () => {
        throw new Error();
      },
    },
    'asset',
  ).open(controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(cancelled, { code: 'canceled' });
});

test('long conversions keep polling and typed final errors reach the caller', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let converting = true;
  const channel = {
    documentOpen: async () =>
      converting ? { state: 'converting' as const } : { state: 'ready' as const, ...documentFixture.info },
    documentResource: async () => {
      throw new Error();
    },
  };
  const opening = new ChannelDocumentSource(channel, 'asset').open(new AbortController().signal);
  await Promise.resolve();
  context.mock.timers.tick(300000);
  await new Promise((resolve) => setImmediate(resolve));
  converting = false;
  context.mock.timers.tick(1500);
  await opening;
  for (const code of ['invalid_request', 'rejected'] as const) {
    const source = new ChannelDocumentSource(
      {
        ...channel,
        documentOpen: async () => {
          throw new RemoteKitError(code, '转换失败');
        },
      },
      'asset',
    );
    await assert.rejects(
      source.open(new AbortController().signal),
      (error: unknown) => error instanceof RemoteKitError && error.code === code,
    );
  }
});

test('resource chunks reject non-advancing offsets and changing totals', async () => {
  for (const response of [
    { data: '', offset: 0, total: 10, mime: 'text/css' },
    { data: 'eA==', offset: 3, total: 10, mime: 'text/css' },
  ]) {
    const source = new ChannelDocumentSource(
      {
        documentOpen: async () => ({ state: 'ready', ...documentFixture.info }),
        documentResource: async () => response,
      },
      'asset',
    );
    const signal = new AbortController().signal;
    await source.open(signal);
    await assert.rejects(source.resource('css', signal), /数据无效/);
  }
});

test('document methods use the authenticated file channel and its library binding', async () => {
  const messages: any[] = [];
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(encoded: string) {
      const message = JSON.parse(encoded);
      messages.push(message);
      const result =
        message.method === 'document.open'
          ? { state: 'ready', ...documentFixture.info }
          : { data: 'eA==', offset: 1, total: 1, mime: 'text/css' };
      queueMicrotask(() =>
        files.handle({ type: 'files.result', version: 1, requestId: message.requestId, ok: true, result }),
      );
    },
  } as unknown as RTCDataChannel;
  const files = new FileChannel(
    () => channel,
    () => 7,
  );
  const source = new ChannelDocumentSource(files, 'asset-id');
  const signal = new AbortController().signal;
  await source.open(signal);
  await source.resource('resource-id', signal);
  assert.deepEqual(
    messages.map((message) => message.method),
    ['document.open', 'document.resource'],
  );
  assert.ok(messages.every((message) => message.authEpoch === 7 && message.params.requestId === 'library'));
  assert.deepEqual(messages[1].params, {
    requestId: 'library',
    documentId: documentFixture.info.documentId,
    contentId: 'resource-id',
    offset: 0,
  });
});

test('resource loading limits simultaneous file requests and cancels queued reads', async () => {
  const pending: (() => void)[] = [];
  let active = 0;
  let maximum = 0;
  const source = new ChannelDocumentSource(
    {
      documentOpen: async () => ({ state: 'ready', ...documentFixture.info }),
      documentResource: async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active--;
        return { data: 'eA==', offset: 1, total: 1, mime: 'text/css' };
      },
    },
    'asset',
  );
  const signal = new AbortController().signal;
  await source.open(signal);
  const reads = Array.from({ length: 4 }, (_, index) => source.resource(String(index), signal));
  const abort = new AbortController();
  const queued = source.resource('queued', abort.signal);
  abort.abort();
  await assert.rejects(queued, { code: 'canceled' });
  pending.forEach((resolve) => resolve());
  await Promise.all(reads);
  assert.equal(maximum, 4);
});
