import { publishAndObserve } from './coordination-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/application';
import { log } from '../server/log';
import { ControlDatabase } from '../server/persistence/database';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { requestViewer } from './server-fixture';
import { clipboardLimits, clipboardDocumentBytes } from '../server/persistence/clipboards';
import limits from '../../protocol/limits.json';
import type { ClipboardChangedEvent } from '../server/endpoint/types';
import { diagnosticEndpointSnapshot } from '../server/diagnostics/projection';
import { decodeFrame, encodeJson } from '../server/cluster/frames';
import { TestClock, testGateway } from './server-fixture';

function addUser(store: ControlDatabase, id: string) {
  store.accounts.insertUser({
    id,
    username: id,
    tenant: id,
    salt: '',
    password_hash: '',
    is_admin: 0,
  });
  const workspace = emptyWorkspace(id);
  workspace.settings.workspace.clipboardSync = true;
  store.workspaces.writeWorkspace(workspace);
}

test('clipboard repository stores the latest value, empty writes, timestamps and per-user revisions', () => {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', { clock, buildId: 'test' });
  try {
    for (const user of ['one', 'two']) addUser(store, user);
    assert.equal(store.clipboards.latest('one'), undefined);
    const first = { revision: '1', text: 'plain', html: '<b>plain</b>' };
    assert.deepEqual(store.clipboards.record('one', first), first);
    assert.deepEqual(store.clipboards.latest('one'), first);
    store.clipboards.record('two', { text: 'other', html: '' });
    clock.advance(25);
    assert.deepEqual(store.clipboards.record('one', { text: '', html: '' }), {
      revision: '2',
      text: '',
      html: '',
    });
    assert.equal(
      (store.db.prepare('SELECT updated_at FROM clipboards WHERE user_id=?').get('one') as any).updated_at,
      BigInt(clock.wallMs()),
    );
    store.db.prepare('UPDATE clipboards SET revision=? WHERE user_id=?').run(9007199254740992n, 'one');
    assert.equal(store.clipboards.record('one', { text: '', html: '' })?.revision, '9007199254740993');
    store.clipboards.clear('one');
    store.clipboards.clear('one');
    assert.equal(store.clipboards.latest('one'), undefined);
    assert.equal(store.clipboards.latest('two')?.revision, '1');
    assert.equal(store.clipboards.record('one', { text: '', html: '' })?.revision, '1');
    store.accounts.deleteUser('one');
    assert.equal(store.clipboards.latest('one'), undefined);
    assert.throws(() => store.clipboards.record('missing', { text: '', html: '' }), /FOREIGN KEY/);
  } finally {
    store.db.close();
  }
});

test('clipboard limits count UTF-8 bytes and rejected writes log only sizes', (t) => {
  const warn = t.mock.method(log, 'warn', () => {});
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    addUser(store, 'one');
    const value = {
      text: 'é'.repeat(clipboardLimits.text / 2),
      html: '😀'.repeat(clipboardLimits.html / 4),
    };
    store.clipboards.record('one', value);
    assert.equal(store.clipboards.record('one', { ...value, text: value.text + 'é' }), undefined);
    assert.equal(store.clipboards.record('one', { ...value, html: value.html + '😀' }), undefined);
    assert.deepEqual(store.clipboards.latest('one'), { revision: '1', ...value });
    assert.deepEqual(
      warn.mock.calls.map((call) => call.arguments),
      [
        [
          'clipboard.write_exceeds_limits',
          {
            textBytes: clipboardLimits.text + 2,
            htmlBytes: clipboardLimits.html,
            encodedBytes: clipboardDocumentBytes({ ...value, text: value.text + 'é' }),
          },
        ],
        [
          'clipboard.write_exceeds_limits',
          {
            textBytes: clipboardLimits.text,
            htmlBytes: clipboardLimits.html + 4,
            encodedBytes: clipboardDocumentBytes({ ...value, html: value.html + '😀' }),
          },
        ],
      ],
    );
  } finally {
    store.db.close();
  }
});

test('clipboard admission counts encoded bytes without changing the persisted value', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    addUser(store, 'one');
    const value = { text: '\u0000'.repeat(600000), html: '' };
    value.html = 'x'.repeat(
      limits.documentBytes - limits.managementEnvelopeBytes - clipboardDocumentBytes(value),
    );
    assert.equal(store.clipboards.record('one', value)?.revision, '1');
    assert.equal(store.clipboards.record('one', { ...value, html: value.html + 'x' }), undefined);
    assert.deepEqual(store.clipboards.latest('one'), { ...value, revision: '1' });
    assert.equal(
      store.clipboards.record('one', { text: '\u0000'.repeat(clipboardLimits.text), html: '' }),
      undefined,
    );
  } finally {
    store.db.close();
  }
});

test('Viewer writes and snippet copies reject encoded overflow as a field limit', async (t) => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  addUser(store, 'one');
  const control = createApplication(store, testGateway({ request: async () => ({}) }));
  t.mock.method(control.viewers, 'assertProductViewer', () => {});
  const authority = { tenantId: 'one', leaseId: 'lease', epoch: 1 };
  try {
    store.clipboards.record('one', { text: 'retained', html: '' });
    const text = '\u0000'.repeat(clipboardLimits.text);
    await assert.rejects(control.clipboard.set(authority, { text }), {
      code: 'limit_exceeded',
      capacity: 'field',
    });
    const snippet = store.library.recordSnippet('one', text, { kind: 'device' }, 1)!.entries[0];
    await assert.rejects(control.clipboard.copySnippet(authority, snippet.id), {
      code: 'limit_exceeded',
      capacity: 'field',
    });
    assert.deepEqual(store.clipboards.latest('one'), { revision: '1', text: 'retained', html: '' });
  } finally {
    await control.close();
    store.db.close();
  }
});

test('clipboard delivery precedes desired and repeats only after a revision or connection change', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  addUser(store, 'one');
  addUser(store, 'empty');
  const requests: { method: string; args: any }[] = [];
  let connectionEpoch = 'first';
  const gateway = testGateway({
    get state() {
      return { state: 'ready' as const, incarnation: 'fixture', connectionEpoch };
    },
    request: async (method, _tenant, args) => {
      requests.push({ method, args });
      return {};
    },
  });
  const control = createApplication(store, gateway);
  try {
    store.clipboards.record('one', { text: 'copy', html: '<p>copy</p>' });
    await publishAndObserve(gateway, 'one');
    assert.deepEqual(
      requests.map((request) => request.method),
      ['session.clipboard', 'session.desired'],
    );
    assert.deepEqual(requests[0].args.value, { text: 'copy', html: '<p>copy</p>' });
    assert.deepEqual(requests[1].args.clipboard, { revision: '1' });
    await publishAndObserve(gateway, 'one');
    assert.equal(requests.length, 2);
    connectionEpoch = 'reconnected';
    await publishAndObserve(gateway, 'one');
    assert.deepEqual(
      requests.slice(2).map((request) => request.method),
      ['session.clipboard', 'session.desired'],
    );
    await publishAndObserve(gateway, 'empty');
    assert.deepEqual(requests[requests.length - 1]?.args.clipboard, {
      revision: '0',
    });
    store.clipboards.record('one', { text: 'new', html: '' });
    await publishAndObserve(gateway, 'one');
    assert.deepEqual(requests[requests.length - 1]?.args.clipboard, {
      revision: '2',
    });
    assert.deepEqual(requests[requests.length - 2]?.args.value, { text: 'new', html: '' });
  } finally {
    await control.close();
    store.db.close();
  }
});

test('diagnostics exclude clipboard and HTML subtrees even when values resemble diagnostic counters', () => {
  const projected = diagnosticEndpointSnapshot(
    {
      clipboard: { text: 'private', html: '<p>private</p>' },
      stats: {
        clipboard: { sequence: '42', revision: 7, width: 100 },
        html: { sequence: '43', width: 101 },
        clipboard_sequence: 44,
        sequence: '9',
      },
      outputDiagnostics: { ok: true, output: { clipboard: { sequence: '45' }, html: { width: 102 } } },
    },
    new Set(),
  );
  const json = JSON.stringify(projected);
  assert.doesNotMatch(json, /clipboard|html|private|42|43|44|45|100|101|102/);
  assert.match(json, /"sequence":"9"/);
});

test('clipboard frames enforce the transport bound including JSON escaping', () => {
  const clipboard = {
    text: 'a'.repeat(clipboardLimits.text),
    html: 'b'.repeat(clipboardLimits.html),
  };
  const message = { method: 'session.clipboard', revision: '1', value: clipboard };
  assert.deepEqual(decodeFrame(encodeJson(message)), { kind: 'json', message });
  assert.throws(
    () =>
      encodeJson({
        method: 'session.clipboard',
        value: { text: '\\0'.repeat(clipboardLimits.text), html: '\\0'.repeat(clipboardLimits.html) },
      }),
    { code: 'limit_exceeded' },
  );
  assert.throws(() => encodeJson({ method: 'other', clipboard }));
});
