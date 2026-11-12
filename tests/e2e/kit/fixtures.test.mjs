import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixtures.mjs';

const evidence = fileURLToPath(new URL('../../../develop/tmp/e2e/', import.meta.url));
mkdirSync(evidence, { recursive: true });

async function fixture(t, kind, context = {}) {
  const run = mkdtempSync(join(evidence, 'fixture-unit-'));
  const server = await startFixture(kind, 0, { run, ...context });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { run, origin: 'http://127.0.0.1:' + server.address().port };
}

test('workspace fixtures expose the app and keep events isolated per run', async (t) => {
  const first = await fixture(t, 'workspace');
  const second = await fixture(t, 'workspace');
  const manifest = await (await fetch(first.origin + '/manifest.json')).json();
  assert.equal(manifest.name, 'Workspace Notes');
  const page = await (await fetch(first.origin + '/fs/')).text();
  assert.match(page, /navigator\.storage\.getDirectory/);
  const event = { type: 'note', path: '/notes/test', value: 'fixture value' };
  await fetch(first.origin + '/event', { method: 'POST', body: JSON.stringify(event) });
  assert.deepEqual(await (await fetch(first.origin + '/events')).json(), [event]);
  assert.deepEqual(await (await fetch(second.origin + '/events')).json(), []);
  assert.deepEqual(JSON.parse(await readFile(join(first.run, 'fixture-events.jsonl'), 'utf8')), event);
});

test('gesture fixtures retain telemetry and obtain snapshots from their Control', async (t) => {
  const calls = [];
  const server = await fixture(t, 'gestures', {
    call: async (method) => {
      calls.push(method);
      return [{ tenant: 'fixture-tenant' }];
    },
  });
  const telemetry = { id: 'tap', child: false, events: [{ type: 'pointerdown' }] };
  await fetch(server.origin + '/telemetry', { method: 'POST', body: JSON.stringify(telemetry) });
  const inspected = await (await fetch(server.origin + '/inspect')).json();
  assert.deepEqual(inspected.telemetry, { 'tap:root': telemetry });
  assert.deepEqual(inspected.users, [{ tenant: 'fixture-tenant' }]);
  assert.deepEqual(calls, ['snapshots']);
  assert.deepEqual(JSON.parse(await readFile(join(server.run, 'telemetry.jsonl'), 'utf8')), telemetry);
});
