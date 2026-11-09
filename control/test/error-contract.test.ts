import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteKitError, httpStatus, parseWireError, toRemoteKitError, wireError } from '../shared/errors';
import { errorHandling, retryDelay } from '../shared/error-policy';
import { endpointError } from '../server/endpoint/gateway';
import { formatError } from '../client/util/format-error';
import { mailError } from '../server/session-import/mail-error';
import { HttpClient } from '../server/learning/providers/http';

test('wire errors validate every code and restrict retry hints without leaking diagnosis', () => {
  for (const code of Object.keys(httpStatus) as (keyof typeof httpStatus)[]) {
    const error = parseWireError({
      code,
      message: '用户提示',
      reason: 'private',
      detail: 'private',
      retryAfterMs: 42,
    })!;
    assert.equal(error.code, code);
    assert.equal(error.message, '用户提示');
    assert.equal(error.retryAfterMs, ['busy', 'rate_limited', 'unavailable'].includes(code) ? 42 : undefined);
    assert.equal(error.detail, undefined);
    assert.equal(error.reason, undefined);
    assert.equal('detail' in wireError(error), false);
  }
  for (const value of [
    null,
    {},
    { code: 'toString', message: '' },
    { code: 'busy' },
    { code: 'foreign', message: '' },
  ])
    assert.equal(parseWireError(value), undefined);
  for (const retryAfterMs of [-1, 86_400_001, 1.5, Infinity, NaN, '20'])
    assert.equal(parseWireError({ code: 'busy', message: '', retryAfterMs })!.retryAfterMs, undefined);
  assert.equal(
    parseWireError({ code: 'busy', message: '', retryAfterMs: 86_400_000 })!.retryAfterMs,
    86_400_000,
  );
  assert.equal(httpStatus.canceled, 409);
  assert.equal(toRemoteKitError({ code: 'busy', message: 'untrusted' }).code, 'internal');
});

test('handling permits automatic retry only for saturation, rate windows and outages', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  assert.equal(retryDelay({ code: 'busy' }, 0), 250);
  assert.equal(retryDelay({ code: 'busy' }, 20), 5000);
  assert.equal(retryDelay({ code: 'unavailable' }, 0), 1000);
  assert.equal(retryDelay({ code: 'unavailable' }, 20), 300_000);
  assert.equal(retryDelay({ code: 'rate_limited' }, 0), 30_000);
  assert.equal(retryDelay({ code: 'rate_limited', retryAfterMs: 1234 }, 9), 1234);
  assert.equal(errorHandling('outcome_unknown'), 'reconcile');
  assert.equal(errorHandling('conflict'), 'refresh');
  assert.equal(errorHandling('not_found'), 'drop');
  assert.equal(errorHandling('locked'), 'unlock');
  assert.equal(errorHandling('unauthenticated'), 'sign-in');
  assert.equal(errorHandling('canceled'), 'canceled');
  for (const code of Object.keys(httpStatus) as (keyof typeof httpStatus)[])
    if (!['busy', 'rate_limited', 'unavailable'].includes(code))
      assert.equal(retryDelay({ code, retryAfterMs: 1 }, 0), undefined);
});

test('native conversion preserves handling and hints while keeping English diagnosis private', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const error = endpointError({ code: 'busy', message: 'queue full', retryAfterMs: 25 });
  assert.equal(error.code, 'busy');
  assert.equal(error.retryAfterMs, 25);
  assert.equal(error.detail, 'queue full');
  assert.match(error.message, /[\u4e00-\u9fff]/);
  assert.equal(endpointError(error), error);
  assert.equal(log.mock.callCount(), 1);
  assert.equal(endpointError({ message: 'missing code' }).code, 'outcome_unknown');
  assert.equal(
    endpointError({ code: 'rejected', message: 'encrypted', reason: 'document_encrypted' }).message,
    '文档受密码保护，无法转换',
  );
  assert.equal(formatError(new RemoteKitError('rejected', '具体原因')), '具体原因');
  assert.ok(!formatError(new RemoteKitError('invalid_request', '')).includes('重试'));
  assert.equal(formatError(new RemoteKitError('canceled', 'canceled by caller')), '');
});

test('POST transport loss is unknown and never retried, reads honor HTTP handling', async () => {
  let calls = 0;
  const client = new HttpClient({
    retryBaseMs: 0,
    fetch: async () => {
      calls++;
      throw new TypeError('socket reset');
    },
  });
  await assert.rejects(client.json('https://fixture.test/', { method: 'POST' }), { code: 'outcome_unknown' });
  assert.equal(calls, 1);
  await assert.rejects(client.json('https://fixture.test/'), { code: 'unavailable' });
  assert.equal(calls, 5);
  for (const [status, code] of [
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [418, 'internal'],
  ] as const) {
    const http = new HttpClient({
      maxRetries: 0,
      fetch: async () => new Response('', { status, headers: { 'Retry-After': '2' } }),
    });
    await assert.rejects(
      http.response('https://fixture.test/'),
      (error) =>
        error instanceof RemoteKitError &&
        error.code === code &&
        (status !== 429 || error.retryAfterMs === 2000),
    );
  }
});

test('mail authentication is permanent while typed transport evidence retains delivery certainty', () => {
  assert.equal(mailError({ code: 'EAUTH' }, true).code, 'unauthenticated');
  assert.equal(mailError({ authenticationFailed: true }, false).code, 'unauthenticated');
  assert.equal(mailError({ responseCode: 550 }, true).code, 'forbidden');
  assert.equal(mailError({ code: 'ECONNRESET' }, false).code, 'unavailable');
  assert.equal(mailError({ code: 'ECONNRESET' }, true).code, 'outcome_unknown');
  assert.equal(mailError(new Error('defect'), false).code, 'internal');
});

test('Viewer HTTP distinguishes encoding defects, read cancellation and uncertain POST delivery', async (t) => {
  const { request } = await import('../client/control/http-request');
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('aborted', 'AbortError');
  });
  await assert.rejects(request('/fixture'), { code: 'canceled' });
  await assert.rejects(request('/fixture', {}), { code: 'outcome_unknown' });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(request('/fixture', cyclic), { code: 'internal' });
  assert.equal(fetch.mock.callCount(), 2);
  fetch.mock.mockImplementation(async () => {
    throw new TypeError('network reset');
  });
  await assert.rejects(request('/fixture'), { code: 'unavailable' });
  await assert.rejects(request('/fixture', {}), { code: 'outcome_unknown' });
});

test('a NodeLink write deadline closes the unwritten queue and encoding defects stay internal', async (t) => {
  const { Carrier, NodeRegistry } = await import('../server/cluster/node-link');
  const { CipherState } = await import('../server/cluster/noise');
  const { nodeDefaults } = await import('../server/config');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class QueuedCarrier extends Carrier {
    readonly bufferedAmount = 0;
    closed = false;
    sends = 0;
    rejectWrite?: (error: Error) => void;
    send() {
      this.sends++;
      return new Promise<void>((_, reject) => {
        this.rejectWrite = reject;
      });
    }
    close() {
      this.closed = true;
      this.rejectWrite?.(new Error('queue canceled'));
    }
  }
  const registry = new NodeRegistry({
    key: Buffer.alloc(32, 1).toString('base64'),
    buildId: 'dev',
    nodes: { local: { config: { ...nodeDefaults, nodeId: 'local' }, configHash: 'local' } },
  });
  t.after(() => registry.stop());
  const carrier = new QueuedCarrier();
  const link = registry.get('local')!;
  link.attach(
    {
      carrier,
      epoch: 'epoch',
      transport: {
        send: new CipherState(Buffer.alloc(32, 1)),
        receive: new CipherState(Buffer.alloc(32, 2)),
      },
    },
    'incarnation',
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(link.request('fixture', 'tenant', cyclic), { code: 'internal' });
  assert.equal(carrier.sends, 0);
  const pending = assert.rejects(link.request('fixture', 'tenant', {}, 10), { code: 'unavailable' });
  t.mock.timers.tick(10);
  await pending;
  assert.equal(carrier.closed, true);
  assert.equal(link.state.state, 'offline');
});

test('provider cancellation before dispatch is canceled and an aborted POST after dispatch is unknown', async () => {
  let calls = 0;
  const aborted = new AbortController();
  aborted.abort();
  const client = new HttpClient({
    fetch: async () => {
      calls++;
      throw new DOMException('aborted', 'AbortError');
    },
  });
  await assert.rejects(client.response('https://fixture.test/', { method: 'POST', signal: aborted.signal }), {
    code: 'canceled',
  });
  assert.equal(calls, 0);
  const during = new AbortController();
  const sending = new HttpClient({
    fetch: async () => {
      calls++;
      during.abort();
      throw new DOMException('aborted', 'AbortError');
    },
  });
  await assert.rejects(sending.response('https://fixture.test/', { method: 'POST', signal: during.signal }), {
    code: 'outcome_unknown',
  });
  assert.equal(calls, 1);
});
