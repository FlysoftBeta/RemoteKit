import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cleanupMarkdown,
  cleanupRun,
  createTrackedDirectory,
  trackCleanupProcess,
  trackNodeData,
} from './cleanup.mjs';

const evidence = fileURLToPath(new URL('../../../develop/tmp/e2e/', import.meta.url));
mkdirSync(evidence, { recursive: true });
function fixture() {
  return mkdtempSync(join(evidence, 'cleanup-unit-'));
}
function file(root, path, contents) {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents);
}

test('only newly created tracked directories are deleted; evidence and crash dumps survive', async () => {
  const run = fixture();
  const profile = join(run, 'viewer');
  file(run, 'pre-existing/Local State', 'old');
  assert.equal(createTrackedDirectory(run, join(run, 'pre-existing'), 'viewer-profile'), false);
  createTrackedDirectory(run, profile, 'viewer-profile');
  file(profile, 'Local State', '{}');
  file(profile, 'Default/Cache/block', '12345');
  file(profile, 'Default/IndexedDB/blob', '123');
  file(profile, 'Crashpad/reports/crash.dmp', 'dump');
  file(profile, 'debug.log', 'log');
  for (const name of ['control.db', 'shot.png', 'steps.jsonl', 'summary.md']) file(run, name, 'evidence');
  trackNodeData(run, join(run, 'node'));
  file(run, 'node/data/sessions/s1/session-1/profile-1/Cache/blob', '1234');
  file(run, 'node/data/objects/00/object.rko', 'object');
  const report = await cleanupRun(run);
  assert.equal(report.bytes, 27);
  assert.equal(report.directories.length, 2);
  assert(report.directories.every((directory) => directory.status === 'deleted'));
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(join(run, 'node/data')), false);
  assert.equal(readFileSync(join(run, 'pre-existing/Local State'), 'utf8'), 'old');
  assert.equal(readFileSync(join(run, 'preserved/viewer/Crashpad/reports/crash.dmp'), 'utf8'), 'dump');
  assert.equal(readFileSync(join(run, 'preserved/viewer/debug.log'), 'utf8'), 'log');
  for (const name of ['control.db', 'shot.png', 'steps.jsonl', 'summary.md'])
    assert(existsSync(join(run, name)));
  const viewer = report.directories[0];
  assert.deepEqual(viewer.defaultTop, [
    { path: 'Default/Cache', bytes: 5 },
    { path: 'Default/IndexedDB', bytes: 3 },
  ]);
  assert.equal(report.directories[1].profiles[0].bytes, 4);
  assert.deepEqual(await cleanupRun(run), report, 'repeated cleanup retains original measurements');
  const markdown = cleanupMarkdown([{ scenario: 'unit', browser: 'mock', cleanup: report }]);
  assert.match(markdown, /viewer-profile\/Default\/Cache \| 5/);
  assert.match(markdown, /session-data\/objects \| 6/);
});

test('outside paths and junctions to another directory are rejected', async () => {
  const run = fixture();
  const outside = fixture();
  assert.throws(() => createTrackedDirectory(run, outside, 'viewer-profile'), /below its run/);
  assert.throws(() => createTrackedDirectory(run, run, 'viewer-profile'), /below its run/);
  file(outside, 'untouched', 'keep');
  const profile = join(run, 'viewer');
  createTrackedDirectory(run, profile, 'viewer-profile');
  symlinkSync(outside, join(profile, 'external'), 'junction');
  assert.throws(
    () => createTrackedDirectory(run, join(profile, 'external/child'), 'viewer-profile'),
    /escapes through a link/,
  );
  await cleanupRun(run);
  assert.equal(readFileSync(join(outside, 'untouched'), 'utf8'), 'keep');
});

test('a locked path is reported after bounded retries with its original measured size', async () => {
  const run = fixture();
  const profile = join(run, 'viewer');
  createTrackedDirectory(run, profile, 'viewer-profile');
  file(profile, 'Local State', '{}');
  let attempts = 0;
  const report = await cleanupRun(run, {
    timeout: 15,
    retryDelay: 5,
    remove: async () => {
      attempts++;
      throw Object.assign(Error('locked by process'), { code: 'EBUSY' });
    },
  });
  assert(attempts > 1 && attempts < 20);
  assert.equal(report.bytes, 2);
  assert.equal(report.directories[0].status, 'retained');
  assert.match(report.directories[0].error, /locked by process/);
  assert(existsSync(profile));
  assert.match(
    cleanupMarkdown([{ scenario: 'locked', browser: 'mock', cleanup: report }]),
    /locked by process/,
  );
  await cleanupRun(run);
});

test('keep-profiles measures but retains profiles, Session data and crash dumps', async () => {
  const run = fixture();
  const profile = join(run, 'viewer');
  createTrackedDirectory(run, profile, 'viewer-profile');
  file(profile, 'Local State', '{}');
  file(profile, 'crash.dmp', 'dump');
  trackNodeData(run, join(run, 'node'));
  file(run, 'node/data/session.db', 'session');
  const report = await cleanupRun(run, { keepProfiles: true });
  assert.equal(report.bytes, 13);
  assert(report.directories.every((directory) => directory.status === 'kept'));
  assert(existsSync(join(profile, 'Local State')));
  assert(existsSync(join(profile, 'crash.dmp')));
  assert(existsSync(join(run, 'node/data/session.db')));
  assert.match(cleanupMarkdown([{ scenario: 'keep', browser: 'mock', cleanup: report }]), /--keep-profiles/);
  await cleanupRun(run);
});

test('cleanup waits for owners to exit and reports owners that outlive its deadline', async () => {
  const run = fixture();
  const profile = join(run, 'viewer');
  createTrackedDirectory(run, profile, 'viewer-profile');
  file(profile, 'Local State', '{}');
  const owner = Object.assign(new EventEmitter(), { pid: 987654 });
  trackCleanupProcess(run, owner);
  const retained = await cleanupRun(run, { timeout: 0, isAlive: () => true });
  assert.equal(retained.directories[0].status, 'retained');
  assert.deepEqual(retained.directories[0].pids, [987654]);
  assert(existsSync(profile));
  setTimeout(() => owner.emit('exit'), 5);
  let alive = true;
  owner.once('exit', () => {
    alive = false;
  });
  const removed = await cleanupRun(run, { timeout: 1000, retryDelay: 5, isAlive: () => alive });
  assert.equal(removed.directories[0].status, 'deleted');
  assert.equal(existsSync(profile), false);
});

test('nested stack roots share the scenario manifest', async (t) => {
  const run = fixture();
  const previous = process.env.E2E_RUN;
  process.env.E2E_RUN = run;
  t.after(() => {
    if (previous === undefined) delete process.env.E2E_RUN;
    else process.env.E2E_RUN = previous;
  });
  trackNodeData(join(run, 'stack'), join(run, 'stack/node'));
  file(run, 'stack/node/data/session.db', 'session');
  const report = await cleanupRun(run);
  assert.equal(report.bytes, 7);
  assert.equal(report.directories[0].path, join('stack', 'node', 'data'));
  assert.equal(existsSync(join(run, 'stack/node/data')), false);
});
