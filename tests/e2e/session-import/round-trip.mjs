import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStack, until } from '../kit/stack.mjs';

const [endpoint, browser, output, portArg = '33961'] = process.argv.slice(2);
assert(endpoint && browser && output);
const run = resolve(output);
const port = Number(portArg);
const origin = `http://127.0.0.1:${port}`;
await mkdir(run, { recursive: true });
const stack = await startStack({
  scenario: 'session-import',
  run,
  port,
  endpoint,
  browser,
  seed: false,
  fixtures: false,
  dev: false,
});
const control = stack.control;
try {
  await until(async () => {
    const state = await control.call('inspect');
    return state.nodes[0]?.state === 'ready' && state.nodes[0].metrics;
  }, 'node ready');
  const response = await fetch(origin + '/api/auth/setup', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'import-test', password: randomUUID() }),
  });
  assert.equal(response.status, 200, await response.text());
  const tenant = (await control.call('inspect')).users[0].tenant;
  const params = {
    importId: randomUUID() + ':0',
    cookies: [
      {
        name: 'recoverable',
        value: 'cookie',
        domain: '127.0.0.1',
        path: '/',
        hostOnly: true,
        secure: false,
        httpOnly: false,
        sameSite: 'lax',
        expires: null,
      },
    ],
    localStorage: [{ origin, items: [['recoverable', 'storage']] }],
  };
  await assert.rejects(control.call('storageImport', { tenant, params, loseReply: true }), /outcome_unknown/);
  const recovered = await control.call('storageImport', { tenant, params });
  assert.equal(recovered.importId, params.importId);
  assert(!Object.hasOwn(recovered, 'job'));
  const done = await until(async () => {
    const state = await control.call('storageImportStatus', {
      tenant,
      params: { importId: params.importId },
    });
    return state.state === 'done' && state;
  }, 'import complete');
  assert.deepEqual(done.cookies, { applied: 1, rejected: 0 });
  assert.deepEqual(done.localStorage, { applied: 1, rejected: 0 });
  assert.deepEqual(await control.call('storageImport', { tenant, params }), done);
  assert.deepEqual(
    await control.call('storageImportStatus', { tenant, params: { importId: params.importId } }),
    done,
  );
  await assert.rejects(
    control.call('storageImport', {
      tenant,
      params: { ...params, localStorage: [{ origin, items: [['recoverable', 'different']] }] },
    }),
    /conflict/,
  );
  await writeFile(
    join(run, 'result.json'),
    JSON.stringify({ forcedLostReply: true, recovered: done }, null, 2),
  );
  console.log('Session import recovered the forced lost begin reply and retained its result.');
} finally {
  await stack.stop();
}
