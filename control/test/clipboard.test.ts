import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/application';
import { ControlDatabase } from '../server/persistence/database';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { requestViewer } from './server-fixture';
import { clipboardLimits } from '../server/persistence/clipboards';
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
  const store = new ControlDatabase(':memory:', clock);
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
  const warn = t.mock.method(console, 'warn', () => {});
  const store = new ControlDatabase(':memory:');
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
          'Clipboard write exceeds limits',
          { textBytes: clipboardLimits.text + 2, htmlBytes: clipboardLimits.html },
        ],
        [
          'Clipboard write exceeds limits',
          { textBytes: clipboardLimits.text, htmlBytes: clipboardLimits.html + 4 },
        ],
      ],
    );
  } finally {
    store.db.close();
  }
});

function stack() {
  const store = new ControlDatabase(':memory:');
  for (const user of ['one', 'two', 'empty']) addUser(store, user);
  const gateway = testGateway({ request: async () => ({}) });
  const requests: { method: string; tenant: string; args: any }[] = [];
  const node = gateway.nodes.get('fixture')!;
  node.request = async (method, tenant, args) => {
    requests.push({ method, tenant, args });
    return {};
  };
  const control = createApplication(store, gateway);
  const emit = (tenant: string, fields: Partial<ClipboardChangedEvent> = {}) => {
    node.emit('clipboard.changed', {
      type: 'clipboard.changed',
      tenantId: tenant,
      sessionId: tenant,
      browserSequence: '1',
      text: 'private-copy',
      html: '<b>private-copy</b>',
      ...fields,
    });
  };
  return {
    store,
    gateway,
    control,
    requests,
    emit,
    async close() {
      await control.close();
      store.db.close();
    },
  };
}

test('session open and ensure seed the current clipboard and omit an absent clipboard', async () => {
  const h = stack();
  try {
    h.store.clipboards.record('one', { text: 'copy', html: '<p>copy</p>' });
    await h.gateway.ensureSession('one');
    await h.gateway.ensureSession('empty');
    for (const method of ['session.open', 'session.ensure']) {
      assert.deepEqual(
        h.requests.find((request) => request.method === method && request.tenant === 'one')?.args.clipboard,
        { revision: '1', text: 'copy', html: '<p>copy</p>' },
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          h.requests.find((request) => request.method === method && request.tenant === 'empty')!.args,
          'clipboard',
        ),
        false,
      );
    }
    h.store.clipboards.record('one', { text: 'new', html: '' });
    await h.gateway.ensureSession('one');
    assert.deepEqual(h.requests[h.requests.length - 1]?.args.clipboard, {
      revision: '2',
      text: 'new',
      html: '',
    });
    h.gateway.forget('one');
    await h.gateway.ensureSession('one');
    assert.equal(h.requests[h.requests.length - 2]?.args.clipboard.revision, '2');
  } finally {
    await h.close();
  }
});

test('clipboard events follow tenant mutation order, isolate revisions and never echo', async () => {
  const h = stack();
  let release!: () => void;
  try {
    for (const tenant of ['one', 'two']) h.gateway.placement.resolve(tenant);
    const blocked = h.control.tenants.serial(
      'one',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    h.emit('one', { browserSequence: '90', text: 'first' });
    h.emit('two', { text: 'other' });
    h.emit('one', { browserSequence: '2', text: 'last', html: '' });
    await h.control.tenants.serial('two', async () => {});
    assert.equal(h.store.clipboards.latest('one'), undefined);
    assert.equal(h.store.clipboards.latest('two')?.revision, '1');
    release();
    await blocked;
    await h.control.tenants.drain();
    assert.deepEqual(h.store.clipboards.latest('one'), { revision: '2', text: 'last', html: '' });
    h.emit('one', { sessionId: 'stale', text: 'stale' });
    h.emit('one', { text: '', html: '' });
    await h.control.tenants.drain();
    assert.deepEqual(h.store.clipboards.latest('one'), { revision: '3', text: '', html: '' });
    assert.deepEqual(h.requests, []);
  } finally {
    release?.();
    await h.close();
  }
});

test('oversize and failed clipboard events keep content out of logs and preserve the previous value', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const h = stack();
  try {
    h.gateway.placement.resolve('one');
    h.emit('one');
    await h.control.tenants.drain();
    const previous = h.store.clipboards.latest('one');
    h.emit('one', { oversize: true, textBytes: 5 * 1024 * 1024, htmlBytes: 0 });
    h.emit('one', { text: 'private'.repeat(clipboardLimits.text), html: '' });
    await h.control.tenants.drain();
    assert.deepEqual(h.store.clipboards.latest('one'), previous);
    t.mock.method(h.store.clipboards, 'record', () => {
      throw new Error('private-copy');
    });
    h.emit('one');
    await h.control.tenants.drain();
    const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
    assert.match(logged, /textBytes/);
    assert.match(logged, /Clipboard write failed/);
    assert.doesNotMatch(logged, /private|<b>/);
  } finally {
    await h.close();
  }
});

test('queued clipboard events cannot recreate a reset or deleted session clipboard', async () => {
  const h = stack();
  try {
    h.gateway.placement.resolve('one');
    await h.control.tenants.serial('one', async () => {
      h.emit('one');
      h.gateway.placement.forgetTenant('one');
      h.store.clipboards.clear('one');
    });
    await h.control.tenants.drain();
    assert.equal(h.store.clipboards.latest('one'), undefined);
  } finally {
    await h.close();
  }
});

test('page origins, concealed copies and device writes share recording without device echoes', async () => {
  const h = stack();
  const pushes: { tenant: string; message: any; excluded?: string }[] = [];
  h.control.events.on('clipboard', (tenant, message, excluded) => pushes.push({ tenant, message, excluded }));
  try {
    h.gateway.placement.resolve('one');
    const workspace = h.store.workspaces.workspace('one');
    workspace.windows.push({ id: 'window', appId: 'web:example', activeTabId: 'tab', lastActiveAt: 0 });
    workspace.spaces.push({
      id: 'space',
      windowIds: ['window'],
      weights: [1],
      focusedWindowId: 'window',
      lastActiveAt: 0,
    });
    workspace.activeSpaceId = 'space';
    workspace.tabs.push({
      id: 'tab',
      windowId: 'window',
      webviewId: '42',
      title: 'Fixture',
      url: 'https://example.test/path',
    });
    h.store.workspaces.saveWorkspace(workspace);
    h.emit('one', { text: 'page text', html: '', viewId: '42' });
    await h.control.tenants.drain();
    const page = h.store.library.snapshot('one').entries[0];
    assert.equal(page.kind, 'snippet');
    assert.deepEqual(page.kind === 'snippet' && page.origin, {
      kind: 'page',
      app: 'web:example',
      url: 'https://example.test/path',
      title: 'Fixture',
    });
    assert.equal(pushes[0].message.text, 'page text');
    assert.equal(pushes[0].excluded, undefined);
    h.emit('one', { text: 'concealed', html: '', excludeFromHistory: true });
    await h.control.tenants.drain();
    assert.equal(h.store.clipboards.latest('one')?.text, 'concealed');
    assert.equal(h.store.library.snapshot('one').entries.length, 1);
    h.control.tenants.get('one').viewer = {
      id: 'lease',
      authentication: { valid: () => true, identity: 'token' },
      security: { locked: false, epoch: 1 },
      revoke: () => {},
    } as any;
    const result = await requestViewer(h.control, 'one', 'lease', 'clipboard.set', { text: 'device text' });
    assert.equal(result.revision, '3');
    assert.equal(pushes[pushes.length - 1]?.excluded, undefined);
    const device = h.store.library.snapshot('one').entries[0];
    assert.deepEqual(device.kind === 'snippet' && device.origin, { kind: 'device' });
    assert.equal(h.requests[h.requests.length - 1]?.method, 'clipboard.write');
    assert.deepEqual(h.requests[h.requests.length - 1]?.args, {
      revision: '3',
      text: 'device text',
      html: '',
    });
    const copied = await requestViewer(h.control, 'one', 'lease', 'library.copySnippet', { id: page.id });
    assert.equal(copied.text, 'page text');
    assert.equal(h.store.library.snapshot('one').entries[0].id, page.id);
    assert.equal(h.store.clipboards.latest('one')?.revision, '4');
    const state = h.store.workspaces.workspace('one');
    state.settings.workspace.clipboardSync = false;
    h.store.workspaces.saveWorkspace(state);
    await requestViewer(h.control, 'one', 'lease', 'clipboard.set', { text: 'off' });
    assert.deepEqual(await requestViewer(h.control, 'one', 'lease', 'clipboard.get', {}), {
      revision: '5',
      text: 'off',
    });
    const count = pushes.length;
    h.emit('one', { text: 'remote while off', html: '' });
    await h.control.tenants.drain();
    assert.equal(pushes.length, count + 1);
    assert.equal(h.store.library.snapshot('one').entries[0].kind, 'snippet');
    assert.equal(h.store.clipboards.latest('one')?.text, 'remote while off');
  } finally {
    await h.close();
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

test('clipboard frames carry maximum payloads and escaped seeds while other JSON retains its limit', () => {
  const clipboard = {
    revision: '1',
    text: 'a'.repeat(clipboardLimits.text),
    html: 'b'.repeat(clipboardLimits.html),
  };
  for (const method of ['session.open', 'session.ensure']) {
    const message = { method, clipboard };
    assert.deepEqual(decodeFrame(encodeJson(message)), { kind: 'json', message });
  }
  const message = {
    method: 'session.open',
    clipboard: {
      revision: '1',
      text: '\0'.repeat(clipboardLimits.text),
      html: '\0'.repeat(clipboardLimits.html),
    },
  };
  assert.deepEqual(decodeFrame(encodeJson(message)), { kind: 'json', message });
  const live = { method: 'clipboard.write', ...message.clipboard };
  assert.deepEqual(decodeFrame(encodeJson(live)), { kind: 'json', message: live });
  assert.throws(() => encodeJson({ method: 'other', clipboard }));
  assert.throws(() => encodeJson({ type: 'clipboard.changed', text: 'a'.repeat(4 * 1024 * 1024) }));
});
