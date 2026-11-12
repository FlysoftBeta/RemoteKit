import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
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
  const context = {
    store,
    clock: systemClock,
    events: new EventEmitter(),
    tenants: new TenantRegistry(systemClock),
    closed: false,
    endpoint: {
      nodes: Object.assign(nodes, {
        get: () => ({ state: { state: 'ready', connectionEpoch: 'connection' } }),
      }),
      placement: { peek: () => ({ nodeId: 'node', sessionId: 'a'.repeat(32), placementEpoch: 1 }) },
      observation: () => ({ browserIncarnation: 'browser' }),
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
    operations: { handleEndpointAction: async () => {} },
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
    await assert.rejects(f.events.receive('node', current), /disk full/);
    assert.equal(f.store.clipboards.latest('user')?.text, 'device');
    assert.equal(f.acknowledgments.length, 1);
    f.store.db.exec('DROP TRIGGER fail_disposition');
    await f.events.receive('node', current);
    assert.equal(f.store.clipboards.latest('user')?.revision, '2');
    assert.equal(f.store.clipboards.latest('user')?.text, 'new native');
    await f.events.receive('node', { ...current, streamId: 'restored', seq: '1' });
    assert.equal(f.store.clipboards.latest('user')?.revision, '2');
  } finally {
    await f.close();
  }
});
test('failed download catalog commits never acknowledge and retired client actions never retarget a Viewer', async () => {
  const f = fixture();
  try {
    f.services.library.consumeDownload = async () => {
      throw new Error('catalog unavailable');
    };
    const download = f.event('1', {
      type: 'download.failed',
      body: { name: 'file', origin: '', error: { code: 'rejected', message: 'failed' } },
    });
    await assert.rejects(f.events.receive('node', download), /catalog unavailable/);
    assert.equal(f.acknowledgments.length, 0);
    f.services.library.consumeDownload = async () => {};
    await f.events.receive('node', download);
    let executed = false;
    f.services.operations.handleEndpointAction = async () => {
      executed = true;
    };
    const action = f.event('2', {
      type: 'client.action',
      body: {
        connectionId: 'old',
        authEpoch: 2,
        leaseId: 'old-lease',
        operationId: 'operation',
        operationGeneration: 'generation',
        action: { type: 'tab.create', windowId: 'window' },
      },
    });
    await f.events.receive('node', action);
    assert.equal(executed, false);
    assert.equal(f.store.coordination.receive(action), 'authorization-retired');
    assert.equal(f.acknowledgments[1].upTo, '2');
  } finally {
    await f.close();
  }
});
