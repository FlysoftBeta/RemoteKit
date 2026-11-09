import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeIncoming } from '../client/rtc/protocol';
import { httpStatus, RemoteKitError } from '../shared/errors';
import { formatError } from '../client/util/format-error';

const failures = [
  { type: 'error' },
  {
    type: 'input.result',
    clientSequence: '1',
    ok: false,
  },
  { type: 'focus', focusRequestId: '1', layoutEpoch: '2', ok: false },
  { type: 'files.result', version: 1, requestId: '1', ok: false },
];

test('DataChannel failures require a known error code and string message', () => {
  for (const message of failures) {
    for (const code of Object.keys(httpStatus)) {
      const error = { code, message: 'public detail' };
      const packet = { ...message, error, authEpoch: 4 };
      assert.deepEqual(decodeIncoming(packet), packet);
    }
    for (const error of [
      undefined,
      'busy',
      { code: 'unknown', message: 'detail' },
      { code: 'toString', message: 'detail' },
      { code: 'busy' },
      { code: 'busy', message: 7 },
    ]) {
      assert.equal(decodeIncoming({ ...message, error }).type, 'decode-error');
    }
  }
  assert.equal(decodeIncoming({ type: 'error', message: 'legacy' }).type, 'decode-error');
  assert.equal(httpStatus.busy, 503);
  assert.equal(formatError(new RemoteKitError('busy', 'public detail')), 'public detail');
});

test('product receipts require structured errors', () => {
  const packet = {
    type: 'product.result',
    version: 1,
    operationId: '1',
    operationGeneration: '2',
    result: {
      operationId: '1',
      operationGeneration: '2',
      status: 'failed',
      error: { code: 'forbidden', message: '无权执行' },
    },
  };
  assert.deepEqual(decodeIncoming(packet), packet);
});
