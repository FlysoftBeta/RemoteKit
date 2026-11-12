import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonical, counter, validateDesired, type SessionDesired } from '../server/endpoint/coordination';

function desired(): SessionDesired {
  return JSON.parse(
    readFileSync(new URL('../../protocol/coordination.fixture.json', import.meta.url), 'utf8'),
  );
}

test('coordination counters reject precision loss and canonicalization preserves view order', () => {
  for (const value of ['0', '1', '18446744073709551615']) assert.equal(counter(value), true);
  for (const value of [1, '01', '-1', '18446744073709551616', '1.0']) assert.equal(counter(value), false);
  assert.equal(counter('0', true), false);
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});
test('desired rejects conflicting run and commit, duplicate views and invalid occlusion', () => {
  validateDesired(desired());
  const runningCommit = desired();
  runningCommit.commit = 'commit';
  assert.throws(() => validateDesired(runningCommit), { code: 'invalid_request' });
  const duplicate = desired();
  duplicate.views.push(duplicate.views[0]);
  assert.throws(() => validateDesired(duplicate), { code: 'invalid_request' });
  const occluded = desired();
  occluded.views[0].occludedBottom = 901;
  assert.throws(() => validateDesired(occluded), { code: 'invalid_request' });
});

import { ControlDatabase } from '../server/persistence/database';
import type { SessionEvent } from '../server/endpoint/coordination';

test('desired revisions survive reconnects and only advance for changed content', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    const { revision, ...document } = desired();
    assert.equal(store.coordination.revision(document), '1');
    assert.equal(store.coordination.revision({ ...document, connectionEpoch: 'reconnected' }), '1');
    assert.equal(store.coordination.revision({ ...document, quality: { effectiveDpr: 2 } }), '2');
    assert.equal(
      store.coordination.revision({ ...document, placementEpoch: document.placementEpoch + 1 }),
      '3',
    );
  } finally {
    store.db.close();
  }
});
test('inbox preserves source identity across restored streams and commits cursors with effects', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    const event: SessionEvent = {
      event: 'session.event',
      tenantId: 'tenant',
      sessionId: 'a'.repeat(32),
      placementEpoch: 1,
      connectionEpoch: 'connection',
      streamId: 'source-stream',
      seq: '1',
      eventId: 'closed-source',
      browserIncarnation: 'browser',
      type: 'view.closed',
      body: { viewId: '1', reason: 'script' },
    };
    assert.equal(store.coordination.receive(event), null);
    assert.throws(() =>
      store.transaction(() => {
        store.coordination.settle(event, 'removed');
        store.coordination.advance(event);
        throw new Error('disk failure');
      }),
    );
    assert.equal(store.coordination.cursor(event), '0');
    assert.equal(store.coordination.receive(event), null);
    store.transaction(() => {
      store.coordination.settle(event, 'removed');
      store.coordination.advance(event);
    });
    const restored = { ...event, streamId: 'restored-stream' };
    assert.equal(store.coordination.receive(restored), 'removed');
    store.transaction(() => store.coordination.advance(restored));
    assert.equal(store.coordination.cursor(restored), '1');
    assert.throws(
      () => store.coordination.receive({ ...restored, body: { viewId: '2', reason: 'script' } }),
      { code: 'conflict' },
    );
    assert.throws(() => store.coordination.advance({ ...restored, seq: '3' }), { code: 'conflict' });
    const row = store.db.prepare('SELECT payload FROM session_event_inbox').get() as { payload: string };
    assert.doesNotMatch(row.payload, /viewId|reason|script/);
  } finally {
    store.db.close();
  }
});

import { coordinationLimits, validateSessionEvent } from '../server/endpoint/coordination';
import { SessionFaults } from '../server/endpoint/session-faults';

test('clipboard UTF-8 fields accept the contract boundary and reject one byte past', () => {
  for (const [field, bound] of [
    ['text', coordinationLimits.textBytes],
    ['html', coordinationLimits.htmlBytes],
  ] as const) {
    const value = desired();
    value.clipboard.value[field] = 'x'.repeat(bound);
    validateDesired(value);
    value.clipboard.value[field] += 'x';
    assert.throws(() => validateDesired(value));
    const event = {
      event: 'session.event',
      tenantId: 'tenant',
      sessionId: 'a'.repeat(32),
      placementEpoch: 1,
      connectionEpoch: 'connection',
      seq: '1',
      streamId: 'stream',
      eventId: 'event',
      browserIncarnation: null,
      type: 'clipboard.changed',
      body: {
        baseRevision: '0',
        browserSequence: '1',
        excludeFromHistory: false,
        text: '',
        html: '',
        [field]: 'x'.repeat(bound),
      },
    };
    validateSessionEvent(event);
    event.body[field] += 'x';
    assert.throws(() => validateSessionEvent(event));
  }
});

test('Session faults back off on attaches and reset after healthy running', () => {
  let now = 0;
  const faults = new SessionFaults(() => now);
  const target = { tenantId: 'tenant', sessionId: 'a'.repeat(32), placementEpoch: 1 };
  const first = faults.fault(target, 'bad');
  assert.match(first.errorId!, /^c-/);
  assert.equal(faults.fault(target, 'again'), first);
  assert.equal(faults.attach(target), false);
  now = 60_000;
  assert.equal(faults.attach(target), true);
  faults.fault(target, 'again');
  now += 60_000;
  assert.equal(faults.attach(target), false);
  now += 60_000;
  assert.equal(faults.attach(target), true);
  faults.observe(target, true);
  now += 600_000;
  faults.fault(target, 'again');
  now += 60_000;
  assert.equal(faults.attach(target), true);
  assert.equal(faults.get({ ...target, placementEpoch: 2 }), undefined);
});

test('management disconnect interrupts the Session fault healthy-running reset window', () => {
  let now = 0;
  const faults = new SessionFaults(() => now);
  const target = { tenantId: 'tenant', sessionId: 'a'.repeat(32), placementEpoch: 1 };
  faults.fault(target, 'first');
  now = 60_000;
  assert.equal(faults.attach(target), true);
  faults.observe(target, true);
  now += 500_000;
  faults.disconnected();
  now += 100_000;
  faults.observe(target, true);
  faults.fault(target, 'second');
  now += 60_000;
  assert.equal(faults.attach(target), false);
  now += 60_000;
  assert.equal(faults.attach(target), true);
});

import { encodeJson } from '../server/cluster/frames';
import { observedSession } from './coordination-fixture';
import { validateSessionObserved } from '../server/endpoint/coordination';

test('encoded management, event and observation bounds are inclusive', () => {
  const management = { padding: '' };
  management.padding = 'x'.repeat(
    coordinationLimits.managementBytes - Buffer.byteLength(JSON.stringify(management)),
  );
  encodeJson(management);
  management.padding += 'x';
  assert.throws(() => encodeJson(management));
  const body = { viewId: '1', reason: 'script', padding: '' };
  body.padding = 'x'.repeat(coordinationLimits.eventBytes - Buffer.byteLength(JSON.stringify(body)));
  const event = {
    event: 'session.event',
    tenantId: 'tenant',
    sessionId: 'a'.repeat(32),
    placementEpoch: 1,
    connectionEpoch: 'connection',
    seq: '1',
    streamId: 'stream',
    eventId: 'event',
    browserIncarnation: null,
    type: 'view.closed',
    body,
  };
  encodeJson(event);
  validateSessionEvent(event);
  body.padding += 'x';
  assert.throws(() => validateSessionEvent(event));
  const observation = observedSession(desired(), 'connection', 'endpoint');
  observation.stats.padding = '';
  observation.stats.padding = 'x'.repeat(
    coordinationLimits.observationBytes - Buffer.byteLength(JSON.stringify(observation)),
  );
  encodeJson(observation);
  validateSessionObserved(observation);
  observation.stats.padding += 'x';
  assert.throws(() => validateSessionObserved(observation));
});

import { mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { emptyWorkspace } from '../server/persistence/workspaces';
import type { OperationReceipt } from '../shared/product';

test('persisted coordination, operation, workspace, library and clipboard counters survive Control restart', () => {
  const directory = mkdtempSync(resolve('../develop/tmp/arch3-counter-'));
  const path = join(directory, 'control.db');
  let store = new ControlDatabase(path, { buildId: 'test' });
  const document = desired();
  const tenant = document.tenantId;
  store.accounts.insertUser({
    id: 'user',
    username: 'user',
    tenant,
    salt: '',
    password_hash: '',
    is_admin: 0,
  });
  const workspace = emptyWorkspace(tenant);
  store.workspaces.writeWorkspace(workspace);
  workspace.settings.workspace.clipboardSync = true;
  store.workspaces.saveWorkspace(workspace);
  const workspaceRevision = workspace.revision;
  const desiredRevision = store.coordination.revision(document);
  const generation = store.operations.operationGeneration(tenant);
  const first: OperationReceipt = {
    operationId: 'first',
    operationGeneration: generation,
    status: 'committed',
  };
  store.operations.reserveOperation(tenant, { type: 'window.close', windowId: 'window' }, first);
  store.library.save(tenant, {
    revision: 12,
    entries: [],
    basket: [],
    partitions: [],
    sources: [],
    excludedSources: [],
    basketPartitionId: null,
  });
  const libraryRevision = store.library.snapshot(tenant).revision;
  store.clipboards.record('user', { text: 'first', html: '' });
  store.reclaim.close();
  store.db.close();
  store = new ControlDatabase(path, { buildId: 'test' });
  try {
    assert.equal(
      store.coordination.revision({ ...document, connectionEpoch: 'new-connection' }),
      desiredRevision,
    );
    assert.ok(BigInt(store.coordination.revision({ ...document, run: 'stopped' })) > BigInt(desiredRevision));
    assert.equal(store.operations.operationGeneration(tenant), generation);
    const second: OperationReceipt = {
      operationId: 'second',
      operationGeneration: generation,
      status: 'committed',
    };
    store.operations.reserveOperation(tenant, { type: 'window.close', windowId: 'window' }, second);
    assert.ok(BigInt(second.operationSequence!) > BigInt(first.operationSequence!));
    const current = store.workspaces.workspace(tenant);
    assert.equal(current.revision, workspaceRevision);
    current.settings.workspace.clipboardSync = false;
    store.workspaces.saveWorkspace(current);
    assert.ok(current.revision > workspaceRevision);
    assert.equal(store.library.snapshot(tenant).revision, libraryRevision);
    store.library.availabilityChanged(tenant);
    assert.equal(store.library.snapshot(tenant).revision, libraryRevision + 1);
    assert.equal(store.clipboards.record('user', { text: 'second', html: '' })!.revision, '2');
  } finally {
    store.reclaim.close();
    store.db.close();
  }
});

import { validateNodeDesired } from '../server/endpoint/coordination';

test('desired collection counts accept each contract boundary and reject one more', () => {
  for (const field of ['views', 'sites', 'fileRequests'] as const) {
    const value = desired();
    const count = coordinationLimits[field];
    const set = (size: number) => {
      if (field === 'views')
        value.views = Array.from({ length: size }, (_, index) => ({
          ...desired().views[0],
          viewId: String(index + 1),
        }));
      if (field === 'sites')
        value.sitePreferences.sites = Object.fromEntries(
          Array.from({ length: size }, (_, index) => [`https://site${index}.test`, { tabletUa: true }]),
        );
      if (field === 'fileRequests')
        value.authorization.files.requests = Array.from({ length: size }, (_, index) => ({
          id: `request${index}`,
          binding: { browserIncarnation: 'browser', view: '1', instance: '1', document: '1', request: '1' },
        }));
    };
    set(count);
    validateDesired(value);
    set(count + 1);
    assert.throws(() => validateDesired(value));
  }
  const node = {
    method: 'node.desired' as const,
    connectionEpoch: 'connection',
    revision: '1',
    sessions: Array.from({ length: coordinationLimits.sessions }, (_, index) => ({
      tenantId: `tenant${index}`,
      sessionId: index.toString(16).padStart(32, '0'),
      placementEpoch: 1,
      dataState: 'dirty' as const,
    })),
  };
  validateNodeDesired(node);
  node.sessions.push({ tenantId: 'extra', sessionId: 'f'.repeat(32), placementEpoch: 1, dataState: 'dirty' });
  assert.throws(() => validateNodeDesired(node));
});

test('configuration and whole desired JSON bounds include the exact encoded boundary', () => {
  const value = desired();
  value.views[0].url = '';
  const { clipboard, ...configuration } = value;
  value.views[0].url = 'x'.repeat(
    coordinationLimits.configurationBytes - Buffer.byteLength(JSON.stringify(configuration)),
  );
  validateDesired(value);
  value.views[0].url += 'x';
  assert.throws(() => validateDesired(value));
  value.views[0].url = value.views[0].url.slice(1);
  value.clipboard.value.text = 'x'.repeat(coordinationLimits.textBytes);
  value.clipboard.value.html = 'x'.repeat(coordinationLimits.htmlBytes);
  const excess = Buffer.byteLength(JSON.stringify(value)) - coordinationLimits.documentBytes;
  value.clipboard.value.html = value.clipboard.value.html.slice(excess);
  assert.equal(Buffer.byteLength(JSON.stringify(value)), coordinationLimits.documentBytes);
  validateDesired(value);
  value.clipboard.value.html += 'x';
  assert.throws(() => validateDesired(value));
});
