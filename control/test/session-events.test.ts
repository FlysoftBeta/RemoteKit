import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { RemoteKitError } from '../shared/errors';
import { ControlDatabase } from '../server/persistence/database';
import { TenantRegistry } from '../server/tenants/tenant-registry';
import { systemClock } from '../server/util/clock';
import { SessionEvents } from '../server/workspace/session-events';
import { ClipboardService } from '../server/clipboard';
import { emptyWorkspace } from '../server/persistence/workspaces';
import type { DomainContext, DomainServices } from '../server/application';
import type { EventsAck, SessionEvent } from '../server/endpoint/coordination';

function fixture() {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  store.accounts.insertUser({
    id: 'user',
    username: 'user',
    tenant: 'tenant',
    salt: '',
    password_hash: '',
    is_admin: 0,
  });
  store.workspaces.writeWorkspace(emptyWorkspace('tenant'));
  const nodes = new EventEmitter();
  const acknowledgments: EventsAck[] = [];
  const faults = new Map<string, unknown>();
  let connectionEpoch = 'connection';
  const context = {
    store,
    clock: systemClock,
    events: new EventEmitter(),
    tenants: new TenantRegistry(systemClock),
    closed: false,
    endpoint: {
      sessionFault: (tenant: string) => faults.get(tenant),
      faultSession: (tenant: string, error: unknown) => faults.set(tenant, error),
      nodes: Object.assign(nodes, {
        get: () => ({ state: { state: 'ready', connectionEpoch } }),
      }),
      placement: { peek: () => ({ nodeId: 'node', sessionId: 'a'.repeat(32), placementEpoch: 1 }) },
      observation: () => ({
        browserIncarnation: 'browser',
        authorization: { connectionId: null, epoch: 0, unlocked: false },
      }),
      acknowledge: async (ack: EventsAck) => {
        acknowledgments.push(ack);
      },
    },
  } as unknown as DomainContext;
  const services = {
    viewers: { push: () => {} },
    pageRequests: {
      removeProductTab: (workspace: any, tab: any) => {
        workspace.tabs = workspace.tabs.filter((value: any) => value !== tab);
        for (const window of workspace.windows) if (window.activeTabId === tab.id) window.activeTabId = null;
      },
    },
    library: { consumeDownload: async () => {} },
    learning: {
      signIn: {
        consume: (_tenant: string, _browser: string, _event: unknown, complete: Function) => {
          complete('canceled');
          return true;
        },
      },
    },
  } as unknown as DomainServices;
  services.clipboard = new ClipboardService(context, services);
  const events = new SessionEvents(context, services);
  const event = (seq: string, fields: Partial<SessionEvent> = {}): SessionEvent =>
    ({
      event: 'session.event',
      tenantId: 'tenant',
      sessionId: 'a'.repeat(32),
      placementEpoch: 1,
      connectionEpoch: 'connection',
      streamId: 'stream',
      seq,
      eventId: 'event-' + seq,
      browserIncarnation: 'browser',
      type: 'view.closed',
      body: { viewId: '1', reason: 'script' },
      ...fields,
    }) as SessionEvent;
  return {
    store,
    context,
    services,
    events,
    event,
    acknowledgments,
    reconnect: () => {
      connectionEpoch = 'reconnected';
      faults.clear();
    },
    async close() {
      await events.close();
      await context.tenants.close();
      store.db.close();
    },
  };
}

test('closed tabs commit before cumulative ack and restored source events do not remove a replacement tab', async () => {
  const f = fixture();
  try {
    const workspace = f.store.workspaces.workspace('tenant');
    workspace.windows.push({ id: 'window', appId: 'browser', activeTabId: 'tab', lastActiveAt: 0 });
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
      webviewId: '1',
      windowId: 'window',
      url: 'https://example.test',
      title: 'test',
      idleKeepAlive: false,
    });
    f.store.workspaces.saveWorkspace(workspace);
    f.context.endpoint.acknowledge = async (ack) => {
      assert.equal(f.store.workspaces.workspace('tenant').tabs.length, 0);
      assert.equal(f.store.coordination.cursor(f.event('1')), '1');
      f.acknowledgments.push(ack);
    };
    await f.events.receive('node', f.event('1'));
    assert.equal(f.acknowledgments[0].upTo, '1');
    const restored = { ...f.event('1'), streamId: 'restored' };
    await f.events.receive('node', restored);
    assert.equal(f.acknowledgments[1].streamId, 'restored');
    await f.events.receive('node', f.event('3'));
    assert.equal(f.acknowledgments.length, 2);
  } finally {
    await f.close();
  }
});
test('clipboard disposition and concurrent snippets commit atomically before acknowledgment', async () => {
  const f = fixture();
  try {
    f.store.clipboards.record('user', { text: 'device', html: '' });
    const excluded = f.store.library.snapshot('tenant');
    excluded.excludedSources = [{ app: 'clipboard', channel: '' }];
    f.store.library.save('tenant', excluded);
    const native = f.event('1', {
      type: 'clipboard.changed',
      body: {
        browserSequence: '9',
        baseRevision: '0',
        excludeFromHistory: true,
        text: 'native',
        html: '<b>native</b>',
      },
    });
    await f.events.receive('node', native);
    assert.equal(f.store.clipboards.latest('user')?.text, 'device');
    assert.equal(f.store.library.snapshot('tenant').entries[0].kind, 'snippet');
    assert.equal(
      f.store.library.snippet('tenant', f.store.library.snapshot('tenant').entries[0].id).html,
      '<b>native</b>',
    );
    assert.equal(f.store.coordination.receive(native), 'concurrent-snippet');
    assert.equal(f.acknowledgments[0].upTo, '1');
    const current = f.event('2', {
      type: 'clipboard.changed',
      body: {
        browserSequence: '10',
        baseRevision: '1',
        excludeFromHistory: true,
        text: 'new native',
        html: '',
      },
    });
    f.store.db.exec(
      "CREATE TRIGGER fail_disposition BEFORE UPDATE ON session_event_inbox BEGIN SELECT RAISE(ABORT,'disk full'); END",
    );
    await assert.rejects(f.events.receive('node', current), { code: 'internal' });
    assert.equal(f.store.clipboards.latest('user')?.text, 'device');
    assert.equal(f.acknowledgments.length, 1);
    f.store.db.exec('DROP TRIGGER fail_disposition');
    f.reconnect();
    const redelivered = { ...current, connectionEpoch: 'reconnected' };
    await f.events.receive('node', redelivered);
    assert.equal(f.store.clipboards.latest('user')?.revision, '2');
    assert.equal(f.store.clipboards.latest('user')?.text, 'new native');
    await f.events.receive('node', { ...redelivered, streamId: 'restored', seq: '1' });
    assert.equal(f.store.clipboards.latest('user')?.revision, '2');
  } finally {
    await f.close();
  }
});
test('HTML-only concurrent native clipboard copies survive as snippets and account removal clears dedupe evidence', async () => {
  const f = fixture();
  try {
    f.store.clipboards.record('user', { text: 'device', html: '' });
    const native = f.event('1', {
      type: 'clipboard.changed',
      body: {
        browserSequence: '1',
        baseRevision: '0',
        excludeFromHistory: true,
        text: '',
        html: '<img src="data:image/png;base64,AA==">',
      },
    });
    await f.events.receive('node', native);
    const entry = f.store.library.snapshot('tenant').entries[0];
    assert.equal(f.store.library.snippet('tenant', entry.id).html, '<img src="data:image/png;base64,AA==">');
    assert.equal(f.store.clipboards.latest('user')?.text, 'device');
    f.store.transaction(() => f.store.coordination.deleteTenant('tenant'));
    assert.equal(f.store.coordination.cursor(native), '0');
    assert.equal(f.store.coordination.receive(native), null);
  } finally {
    await f.close();
  }
});

test('catalog rejection is durable and does not block the next Session event', async () => {
  const f = fixture();
  try {
    f.services.library.consumeDownload = async () => {
      throw new RemoteKitError('limit_exceeded', 'catalog full', { capacity: 'catalog' });
    };
    const download = f.event('1', {
      type: 'download.failed',
      body: { name: 'file', origin: '', error: { code: 'rejected', message: 'failed' } },
    });
    await f.events.receive('node', download);
    assert.equal(f.acknowledgments[0].upTo, '1');
    assert.equal(f.store.coordination.receive(download), 'download_pending');
    assert.equal(
      f.context.tenants.get('tenant').backgroundTasks.get(download.eventId)?.error?.code,
      'limit_exceeded',
    );
    await f.events.receive('node', f.event('2'));
    assert.equal(f.acknowledgments[1].upTo, '2');
    assert.equal(f.context.endpoint.sessionFault('tenant'), undefined);
    f.services.library.consumeDownload = async () => {};
    await f.events.reconcileDownloads();
    assert.equal(f.store.coordination.receive(download), 'download_pending');
    f.store.db
      .prepare(
        'INSERT INTO library_state VALUES (?,1,NULL) ON CONFLICT(tenant) DO UPDATE SET revision=revision+1',
      )
      .run('tenant');
    await f.events.reconcileDownloads();
    assert.equal(f.store.coordination.receive(download), 'recorded');
  } finally {
    await f.close();
  }
});

test('uncertain download ingestion retains its event identity and projects unknown until reconciliation', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const f = fixture();
  t.after(() => f.close());
  const imported = new Set<string>();
  let calls = 0;
  f.services.library.consumeDownload = async (_tenant, event) => {
    calls++;
    if (imported.has(event.eventId!)) return;
    imported.add(event.eventId!);
    throw new RemoteKitError('outcome_unknown', 'reply lost', { errorId: 'e-0123456789' });
  };
  const event = f.event('1', {
    type: 'download.imported',
    body: { name: 'file', origin: '', assetId: 'b'.repeat(64), size: '1', mimeType: 'text/plain' },
  });
  await f.events.receive('node', event);
  assert.equal(f.context.tenants.get('tenant').backgroundTasks.get(event.eventId)?.state, 'unknown');
  assert.equal(f.store.coordination.cursor(event), '1');
  assert.equal(f.store.coordination.receive(event), 'download_pending');
  t.mock.timers.tick(1000);
  await f.events.reconcileDownloads();
  assert.equal(calls, 2);
  assert.equal(imported.size, 1);
  assert.equal(f.context.tenants.get('tenant').backgroundTasks.get(event.eventId)?.state, 'complete');
  assert.equal(f.store.coordination.receive(event), 'recorded');
});
