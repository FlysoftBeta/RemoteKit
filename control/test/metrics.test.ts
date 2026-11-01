import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';
import { Control } from '../server/control';
import { createHttp } from '../server/http';

test('metrics writes keep concurrent large tenant records intact and recover after failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'remotekit-metrics-'));
  const metricsDir = join(directory, 'metrics');
  const store = new Store(':memory:');
  const control = new Control(store, { request: async () => ({}) });
  const server = createHttp(control, { origins: ['http://test.local'], clientDir: directory, metricsDir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const sessions = Array.from({ length: 4 }, () => store.session());
  const post = (index: number, metrics: unknown) => fetch(`http://127.0.0.1:${address.port}/api/metrics`, {
    method: 'POST', headers: { origin: 'http://test.local', 'content-type': 'application/json', cookie: `rk_session=${sessions[index].token}` }, body: JSON.stringify(metrics),
  });
  try {
    // A real filesystem error must reach this request without poisoning the queue.
    await writeFile(metricsDir, 'not a directory');
    const failed = await post(0, { report: 'failed' });
    assert.equal(failed.status, 502); assert.ok((await failed.json()).error.message);
    await rm(metricsDir);
    const reports = sessions.map((_, index) => ({ report: index, payload: `${index}:中文:"quoted"\\path\n`.repeat(27000) }));
    for (const report of reports) {
      const bytes = Buffer.byteLength(JSON.stringify(report));
      assert.ok(bytes > 512 * 1024 && bytes < 1024 * 1024);
    }
    const responses = await Promise.all(reports.map((report, index) => post(index, report)));
    for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { stored: true }); }
    // Success is returned after the entire record is on disk, not just queued.
    const content = await readFile(join(metricsDir, 'client-metrics.jsonl'), 'utf8');
    assert.ok(content.endsWith('\n'));
    const records = content.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 4);
    assert.equal(new Set(records.map(record => record.metrics.report)).size, 4);
    for (const record of records) {
      const index = record.metrics.report;
      assert.deepEqual(record.metrics, reports[index]);
      assert.equal(record.tenantId, sessions[index].tenantId);
      assert.ok(Number.isFinite(Date.parse(record.receivedAt)));
    }
    t.diagnostic(`Validated ${Buffer.byteLength(content)} bytes: four intact >512KiB records with tenant ownership after failed write recovery.`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.db.close(); await rm(directory, { recursive: true, force: true });
  }
});
