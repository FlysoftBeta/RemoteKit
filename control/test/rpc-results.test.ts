import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcResults, rpcId } from '../server/endpoint/rpc-results';

test('RPC duplicates share execution, retain failures and reject changed targets', async () => {
  const results = new RpcResults();
  const request = {
    method: 'view.navigate',
    opId: 'operation',
    replay: false,
    endpointIncarnation: 'endpoint',
    params: { browserIncarnation: 'browser', viewId: '1', url: 'https://example.test' },
  };
  let calls = 0;
  let release!: (value: object) => void;
  const original = results.execute(request, () => {
    calls++;
    return new Promise<object>((resolve) => {
      release = resolve;
    });
  });
  const duplicate = results.execute({ ...request, id: 'new-transport-id', replay: true }, () => {
    throw new Error('duplicate executed');
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ accepted: true });
  assert.deepEqual(await original, await duplicate);
  await assert.rejects(
    results.execute(
      { ...request, params: { ...request.params, browserIncarnation: 'replacement' } },
      () => undefined,
    ),
    { code: 'conflict' },
  );
  const failure = new Error('execution failed');
  const failed = { ...request, opId: 'failure' };
  await assert.rejects(
    results.execute(failed, () => {
      throw failure;
    }),
    failure,
  );
  await assert.rejects(
    results.execute({ ...failed, replay: true }, () => undefined),
    failure,
  );
});

test('RPC result eviction never executes replay-only requests', async () => {
  const results = new RpcResults();
  for (let index = 0; index <= 1024; index++)
    await results.execute({ method: 'query', opId: String(index), replay: false }, () => index);
  let executed = false;
  await assert.rejects(
    results.execute({ method: 'query', opId: '0', replay: true }, () => {
      executed = true;
    }),
    { code: 'outcome_unknown' },
  );
  assert.equal(executed, false);
  assert.equal(await results.execute({ method: 'query', opId: '1024', replay: true }, () => -1), 1024);
  assert.notEqual(rpcId('begin', 'identity'), rpcId('cancel', 'identity'));
  assert.equal(rpcId('begin', 'identity').length <= 64, true);
});
