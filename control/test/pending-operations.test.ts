import assert from 'node:assert/strict';
import test from 'node:test';
import { literal, object, string, union } from '../server/persistence/codec';
import { ControlDatabase } from '../server/persistence/database';

test('a union rules out choices by their literal tags and still reports every choice', () => {
  const shape = union(
    object({ type: literal('a'), value: string() }),
    object({ type: literal('b', 'c'), count: string() }),
  );
  assert.deepEqual(shape.read({ type: 'c', count: '1' }, '$'), { type: 'c', count: '1' });
  assert.throws(() => shape.read({ type: 'z', value: 'x' }, '$'), {
    message: '$.type expected a; $.type expected b|c',
  });
  // A matching tag decodes the choice in full, so its own error is reported.
  assert.throws(() => shape.read({ type: 'a', value: 1 }, '$'), {
    message: '$.value expected string; $.type expected b|c',
  });
});

test('pending operations skip settled receipts but still decode every other row strictly', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    const insert = store.db.prepare('INSERT INTO operation_receipts VALUES (?,?,?,?)');
    const payload = JSON.stringify({ type: 'window.focus', windowId: 'w' });
    const receipt = (id: string, status: string, extra = {}) =>
      JSON.stringify({ operationId: id, operationGeneration: '1', status, ...extra });
    insert.run('t', 'done', payload, receipt('done', 'committed'));
    insert.run(
      't',
      'failed',
      payload,
      receipt('failed', 'failed', { error: { code: 'internal', message: 'x' } }),
    );
    insert.run('t', 'open', payload, receipt('open', 'applying'));
    insert.run('other', 'elsewhere', payload, receipt('elsewhere', 'accepted'));
    assert.deepEqual(
      store.operations.pendingOperations('t').map(({ receipt }) => [receipt.operationId, receipt.status]),
      [['open', 'applying']],
    );
    // Rows whose status cannot be read in SQL are decoded and fail as corrupt records.
    for (const corrupt of ['not json', JSON.stringify({ operationId: 'x', operationGeneration: '1' })]) {
      store.db.prepare("DELETE FROM operation_receipts WHERE id='bad'").run();
      insert.run('t', 'bad', payload, corrupt);
      assert.throws(() => store.operations.pendingOperations('t'), { reason: 'corrupt_record' });
    }
  } finally {
    store.close();
  }
});
