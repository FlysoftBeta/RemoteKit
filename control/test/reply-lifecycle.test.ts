import { registerUser } from './server-fixture';
import { accountsFor } from './server-fixture';
import { RemoteKitError } from '../shared/errors';
import { testGateway } from './server-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication, type DomainServices } from '../server/application';
import type { EndpointLink } from '../server/endpoint/link';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';

/** Fault injection models the serialized Endpoint: a reply never calls Start. */
class LifecycleEndpoint implements EndpointLink {
  readonly state = { state: 'ready' as const, incarnation: 'test', connectionEpoch: 'test' };
  running = true;
  browserIncarnation = 'browser-A';
  browserPid = 10;
  view: any;
  events: any[] = [];
  replies: any[] = [];
  offlineNextSnapshot = false;
  replaceBeforeReply = false;
  wrongKind = false;
  starts = 0;
  onAck?: () => void;
  replace() {
    this.browserIncarnation = 'browser-B'; /* PID and local counters can repeat. */
  }
  async request(method: string, _tenant: string, args: any = {}): Promise<any> {
    const identity = () => ({ browserIncarnation: this.browserIncarnation, instance: '1', document: '2' });
    if (method === 'session.ensure') {
      this.starts++;
      this.running = true;
      return { running: true, browserPid: this.browserPid, browserIncarnation: this.browserIncarnation };
    }
    if (method === 'session.sitePreferences' || method === 'session.mediaPolicy')
      return { accepted: true, applied: this.running };
    if (method === 'session.snapshot') {
      if (this.offlineNextSnapshot) {
        this.offlineNextSnapshot = false;
        this.running = false;
      }
      return {
        running: this.running,
        browserPid: this.running ? this.browserPid : 0,
        browserIncarnation: this.running ? this.browserIncarnation : null,
        views: this.running && this.view ? [{ ...this.view }] : [],
        events: this.events,
      };
    }
    if (method === 'view.ensure') {
      this.view = { ...args, instance: '1', document: '2', actual: 0 };
      return {};
    }
    if (method === 'view.configure') {
      Object.assign(this.view, args);
      return {};
    }
    if (method === 'view.close') {
      this.view.close_state = 'closing';
      this.view.pending_close = { requestId: '7' };
      return { ...identity(), pending: true, requestId: '7' };
    }
    if (method === 'view.page.reply' || method === 'view.close.reply') {
      if (this.replaceBeforeReply) {
        this.replaceBeforeReply = false;
        this.replace();
      }
      if (
        !this.running ||
        args.browserIncarnation !== this.browserIncarnation ||
        args.instance !== this.view.instance ||
        args.document !== this.view.document
      )
        throw new RemoteKitError('conflict', 'stale_page_request');
      if (method === 'view.close.reply' && (this.wrongKind || this.view.close_state !== 'closing'))
        return { accepted: true, browser: { ok: false } };
      this.replies.push(args);
      if (method === 'view.close.reply') {
        this.view.close_state = args.accept ? 'closing' : 'cancelled';
        delete this.view.pending_close;
      } else this.view.pageRequests.pending = [];
      return { accepted: true, browser: { ok: true } };
    }
    if (method === 'session.events.ack') {
      this.onAck?.();
      this.events = [];
      return { accepted: true };
    }
    return {};
  }
}
async function fixture() {
  const store = new ControlDatabase(':memory:'),
    endpoint = new LifecycleEndpoint(),
    control = createApplication(store, testGateway(endpoint));
  const { tenantId: tenant } = await registerUser(store, 'lifecycle-user', 'password123');
  await control.viewers.attachViewer(
    tenant,
    'lease',
    () => {},
    { identity: 'test-account', valid: () => true },
    true,
  );
  const created = await control.operations.productAction(
    tenant,
    { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: 'about:blank' },
    'lease',
  );
  const tab = created.state.workspace.tabs[0];
  return { store, endpoint, control, tenant, tab };
}

test('file requests bind Browser identity and stay separate from dialogs', async () => {
  const { store, endpoint, control, tenant } = await fixture();
  try {
    endpoint.view.pageRequests = {
      pending: [
        {
          request: '7',
          kind: 'file_chooser',
          origin: 'https://files.test',
          multiple: false,
          accept_types: ['.txt'],
          accept_types_omitted: true,
        },
      ],
    };
    await control.reconciler.tick();
    const request = control.viewers.productState(tenant).fileRequests[0];
    assert.ok(request);
    assert.equal(control.viewers.productState(tenant).pageDialogs.length, 0);
    assert.equal('binding' in request, false);
    assert.deepEqual(request.accept, ['.txt']);
    assert.equal(request.acceptTypesOmitted, true);
    endpoint.replace();
    await control.reconciler.tick();
    assert.notEqual(control.viewers.productState(tenant).fileRequests[0].id, request.id);
  } finally {
    await control.close();
    store.db.close();
  }
});

test('offline empty snapshot and replacement missing view preserve product tab and cancel old close intent', async () => {
  const { store, endpoint, control, tenant, tab } = await fixture();
  try {
    const pending = await control.operations.productAction(
      tenant,
      { type: 'window.close', windowId: tab.windowId },
      'lease',
    );
    assert.ok(pending.state.workspace.pendingClose);
    endpoint.offlineNextSnapshot = true;
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(tenant).tabs.length, 1);
    assert.equal(store.workspaces.workspace(tenant).pendingClose, null);
    assert.equal(store.workspaces.workspace(tenant).pendingWindowCloseId, null);
    endpoint.replace();
    endpoint.view = undefined;
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(tenant).tabs.length, 1);
  } finally {
    await control.close();
    store.db.close();
  }
});

test('reply execution rejects Browser replacement after snapshot even when PID and local IDs repeat', async () => {
  const { store, endpoint, control, tenant } = await fixture();
  try {
    endpoint.view.pageRequests = { pending: [{ request: '7', kind: 'confirm' }] };
    await control.reconciler.tick();
    const dialog = control.viewers.productState(tenant).pageDialogs[0],
      starts = endpoint.starts;
    endpoint.replaceBeforeReply = true;
    await assert.rejects(
      control.operations.productAction(
        tenant,
        { type: 'page.reply', dialogId: dialog.id, reply: { kind: 'dialog', accept: true } },
        'lease',
      ),
      { code: 'conflict' },
    );
    assert.equal(endpoint.replies.length, 0);
    assert.equal(endpoint.starts, starts);
    assert.equal(endpoint.view.pageRequests.pending.length, 1);
    await control.reconciler.tick();
    assert.notEqual(control.viewers.productState(tenant).pageDialogs[0].id, dialog.id);
  } finally {
    await control.close();
    store.db.close();
  }
});

test('close replies bind full identity, reject stale UI tokens and require explicit closed evidence', async () => {
  const { store, endpoint, control, tenant, tab } = await fixture();
  try {
    const close = () =>
      control.operations.productAction(tenant, { type: 'tab.close', tabId: tab.id }, 'lease');
    const reply = (requestId: string, accept: boolean) =>
      control.operations.productAction(
        tenant,
        { type: 'tab.close', tabId: tab.id, requestId, ...(accept ? { confirm: true } : { cancel: true }) },
        'lease',
      );
    let state = (await close()).state.workspace;
    const oldToken = state.pendingClose!.requestId!;
    assert.notEqual(oldToken, '7');
    endpoint.replaceBeforeReply = true;
    await assert.rejects(reply(oldToken, true), { code: 'conflict' });
    assert.equal(endpoint.replies.length, 0);
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(tenant).pendingClose, null);
    state = (await close()).state.workspace;
    const token = state.pendingClose!.requestId!;
    assert.notEqual(token, oldToken);
    await assert.rejects(reply(oldToken, true), { code: 'conflict' });
    endpoint.wrongKind = true;
    await assert.rejects(reply(token, true), { code: 'conflict' });
    assert.equal(store.workspaces.workspace(tenant).pendingClose!.awaiting, false);
    endpoint.wrongKind = false;
    await reply(token, false);
    assert.equal(store.workspaces.workspace(tenant).pendingClose, null);
    state = (await close()).state.workspace;
    await reply(state.pendingClose!.requestId!, true);
    assert.equal(store.workspaces.workspace(tenant).tabs.length, 1);
    endpoint.view = undefined;
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(tenant).tabs.length, 1);
    endpoint.events = [{ eventId: 'closed-1', type: 'view.closed', viewId: tab.webviewId }];
    await control.reconciler.tick();
    assert.equal(store.workspaces.workspace(tenant).tabs.length, 0);
    assert.deepEqual(endpoint.replies[0], {
      viewId: tab.webviewId,
      browserIncarnation: 'browser-B',
      instance: '1',
      document: '2',
      requestId: '7',
      accept: false,
    });
  } finally {
    await control.close();
    store.db.close();
  }
});
