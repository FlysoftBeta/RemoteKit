import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../server/store';
import { Control } from '../server/control';
import { createHttp } from '../server/http';
import type { Endpoint } from '../server/endpoint';
import { EndpointProcess } from '../server/endpoint';
import { fileURLToPath } from 'node:url';
class FakeEndpoint implements Endpoint {
  calls: { method: string; tenant: string; args: any }[] = [];
  views = new Map<string, Set<string>>();
  pending = false;
  details = new Map<string, Record<string, unknown>>();
  delayedClose = false;
  async request(method: string, tenant: string, args: any = {}) {
    this.calls.push({ method, tenant, args });
    const views = this.views.get(tenant) ?? new Set<string>();
    this.views.set(tenant, views);
    if (method === 'session.snapshot')
      return {
        running: true,
        browserIncarnation: 'browser-A',
        views: [...views].map((viewId) => ({
          viewId,
          instance: '1',
          document: '2',
          ...this.details.get(viewId),
        })),
      };
    if (method === 'view.ensure') views.add(args.viewId);
    if (method === 'view.close') {
      if (this.delayedClose && !args.force)
        return { accepted: true, browserIncarnation: 'browser-A', instance: '1', document: '2' };
      if (this.pending && !args.force)
        return {
          pending: true,
          requestId: 'request-1',
          browserIncarnation: 'browser-A',
          instance: '1',
          document: '2',
        };
      views.delete(args.viewId);
      return { closed: true };
    }
    if (method === 'view.close.reply') {
      if (args.accept) this.details.set(args.viewId, { close_state: 'closed' });
      return { accepted: true, browser: { ok: true } };
    }
    if (method === 'rtc.offer') return { sdp: 'v=0\r\na=candidate:contract-fixture' };
    return {};
  }
}
test('actual child stdio framing and process restart restore product views', async () => {
  const store = new Store(':memory:');
  const endpoint = new EndpointProcess(process.execPath, [
    fileURLToPath(new URL('./stdio-fixture.mjs', import.meta.url)),
  ]);
  const control = new Control(store, endpoint);
  const tenant = store.session().tenantId;
  endpoint.on('ready', () => void control.reconcileAll());
  const ready = once(endpoint, 'ready');
  endpoint.start();
  await ready;
  try {
    const created = await control.action(tenant, { type: 'tab.create', url: 'about:blank' });
    const restarted = once(endpoint, 'ready');
    await assert.rejects(endpoint.request('test.exit', tenant));
    await restarted;
    await control.serial(tenant, () => control.reconcile(tenant));
    const snapshot = await endpoint.request('session.snapshot', tenant);
    assert.deepEqual(snapshot.views, [{ viewId: created.tabs[0].webviewId }]);
  } finally {
    await endpoint.stop();
    store.db.close();
  }
});

test('diagnostic loopback environment is injected into only the requested endpoint child', async () => {
  const before = process.env.REMOTEKIT_RTC_LOOPBACK_TEST;
  for (const enabled of [true, false]) {
    const endpoint = new EndpointProcess(
      process.execPath,
      [fileURLToPath(new URL('./stdio-fixture.mjs', import.meta.url))],
      enabled,
    );
    const ready = once(endpoint, 'ready');
    endpoint.start();
    await ready;
    try {
      assert.equal(
        (await endpoint.request('test.loopbackEnv', 'test')).loopback,
        enabled ? '1' : (before ?? null),
      );
      assert.equal(process.env.REMOTEKIT_RTC_LOOPBACK_TEST, before);
    } finally {
      await endpoint.stop();
    }
  }
});
test('periodic observation recovers missing views without redundant configuration, tracks redirect and late beforeunload', async () => {
  const store = new Store(':memory:');
  const endpoint = new FakeEndpoint();
  const control = new Control(store, endpoint);
  const tenant = store.session().tenantId;
  const created = await control.action(tenant, { type: 'tab.create', url: 'https://initial.test/' });
  const tab = created.tabs[0];
  endpoint.calls = [];
  await control.tick();
  assert.equal(
    endpoint.calls.filter((call) => call.method === 'view.ensure' || call.method === 'view.configure').length,
    0,
  );
  await control.action(tenant, { type: 'tab.navigate', id: tab.id, url: 'https://intent.test/' });
  endpoint.details.set(tab.webviewId!, { url: 'https://initial.test/', loading: true });
  await control.tick();
  assert.equal(control.state(tenant).tabs[0].url, 'https://intent.test/');
  endpoint.details.set(tab.webviewId!, {
    url: 'https://redirected.test/',
    title: 'Committed title',
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
  await control.tick();
  assert.equal(control.state(tenant).tabs[0].url, 'https://redirected.test/');
  assert.equal(control.state(tenant).tabs[0].title, 'Committed title');
  assert.equal(control.state(tenant).tabs[0].canGoBack, true);
  await control.action(tenant, { type: 'tab.command', id: tab.id, command: 'back' });
  assert.equal(endpoint.calls.find((call) => call.method === 'view.command')?.args.command, 'back');
  await assert.rejects(control.action(tenant, { type: 'tab.command', id: tab.id, command: 'arbitrary' }));
  endpoint.views.get(tenant)!.clear();
  endpoint.calls = [];
  await control.tick();
  assert.equal(
    endpoint.calls.find((call) => call.method === 'view.ensure')?.args.url,
    'https://redirected.test/',
  );
  endpoint.delayedClose = true;
  await control.action(tenant, { type: 'tab.close', id: tab.id });
  assert.equal(control.state(tenant).pendingClose?.awaiting, true);
  endpoint.details.set(tab.webviewId!, { close_state: 'closing', pending_close: { requestId: 'late-1' } });
  await control.tick();
  assert.equal(control.state(tenant).pendingClose?.nativeRequestId, 'late-1');
  assert.equal(control.state(tenant).pendingClose?.awaiting, false);
  await control.action(tenant, {
    type: 'tab.close',
    id: tab.id,
    requestId: control.state(tenant).pendingClose!.requestId,
    cancel: true,
  });
  assert.equal(control.state(tenant).tabs.length, 1);
  store.db.close();
});
test('device mode changes configure before normal reload; size-only changes preserve the page', async () => {
  const store = new Store(':memory:'),
    endpoint = new FakeEndpoint(),
    control = new Control(store, endpoint),
    tenant = store.session().tenantId;
  await control.action(tenant, { type: 'tab.create', url: 'about:blank' });
  endpoint.calls = [];
  await control.action(tenant, {
    type: 'device.set',
    device: { mode: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2 },
  });
  const configured = endpoint.calls.findIndex((call) => call.method === 'view.configure'),
    reloaded = endpoint.calls.findIndex(
      (call) => call.method === 'view.command' && call.args.command === 'reload',
    );
  assert.ok(configured >= 0 && reloaded > configured);
  endpoint.calls = [];
  await control.action(tenant, {
    type: 'device.set',
    device: { mode: 'tablet', width: 768, height: 1024, deviceScaleFactor: 2 },
  });
  assert.equal(endpoint.calls.filter((call) => call.method === 'view.command').length, 0);
  store.db.close();
});
test('stable mappings, restart reconciliation, orphan cleanup and close cancellation', async () => {
  const store = new Store(':memory:');
  const endpoint = new FakeEndpoint();
  const control = new Control(store, endpoint);
  const { tenantId } = store.session();
  const created = await control.action(tenantId, { type: 'tab.create', url: 'example.com' });
  const tab = created.tabs[0];
  assert.match(tab.webviewId!, /^[1-9][0-9]*$/);
  endpoint.views.set(tenantId, new Set(['999']));
  await control.reconcileAll();
  assert.deepEqual([...endpoint.views.get(tenantId)!], [tab.webviewId]);
  assert.equal(control.state(tenantId).tabs[0].webviewId, tab.webviewId);
  endpoint.pending = true;
  let result = await control.action(tenantId, { type: 'tab.close', id: tab.id });
  assert.equal(result.tabs.length, 1);
  assert.equal(result.pendingClose?.nativeRequestId, 'request-1');
  result = await control.action(tenantId, {
    type: 'tab.close',
    id: tab.id,
    requestId: result.pendingClose!.requestId,
    cancel: true,
  });
  assert.equal(result.tabs.length, 1);
  assert.equal(result.pendingClose, null);
  await control.action(tenantId, { type: 'tab.close', id: tab.id });
  await control.action(tenantId, {
    type: 'tab.close',
    id: tab.id,
    requestId: control.state(tenantId).pendingClose!.requestId,
    confirm: true,
  });
  assert.equal((await control.getState(tenantId)).tabs.length, 0);
  store.db.close();
});
test('HTTP cookie isolation, origin checks and offer/ICE tenant binding', async () => {
  const store = new Store(':memory:');
  const endpoint = new FakeEndpoint();
  const control = new Control(store, endpoint);
  const server = createHttp(control, {
    diagnostics: true,
    origins: ['http://test.local'],
    clientDir: '.',
    metricsDir: '.',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  const base = `http://127.0.0.1:${address.port}`;
  const session = async () => {
    const res = await fetch(base + '/api/state');
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], state: (await res.json()) as any };
  };
  const a = await session(),
    b = await session();
  assert.notEqual(a.state.tenantId, b.state.tenantId);
  assert.match(a.cookie, /rk_session=/);
  const post = (cookie: string, path: string, body: unknown, origin = 'http://test.local') =>
    fetch(base + path, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await post(a.cookie, '/api/actions', { type: 'tab.create', url: 'about:blank' }, 'http://evil.local'))
        .status,
      403,
    );
    assert.equal(
      (
        await post(a.cookie, '/api/actions', {
          type: 'tab.create',
          url: 'about:blank',
          tenantId: b.state.tenantId,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post(a.cookie, '/api/actions', { type: 'tab.create', url: 'about:blank' })).status,
      200,
    );
    assert.equal(control.state(b.state.tenantId).tabs.length, 0);
    const answer = (await (
      await post(a.cookie, '/api/rtc/offer', { type: 'offer', sdp: 'v=0\r\n' })
    ).json()) as any;
    assert.equal(answer.type, 'answer');
    assert.equal(endpoint.calls.find((call) => call.method === 'rtc.offer')?.tenant, a.state.tenantId);
    assert.equal(
      (await post(b.cookie, '/api/rtc/ice', { connectionId: answer.connectionId, candidate: {} })).status,
      403,
    );
    assert.equal(
      (await post(a.cookie, '/api/rtc/ice', { connectionId: answer.connectionId, candidate: {} })).status,
      400,
    );
    assert.equal(
      (
        await post(a.cookie, '/api/rtc/ice', {
          connectionId: answer.connectionId,
          candidate: {
            candidate: 'candidate:1 1 udp 1 127.0.0.1 9999 typ host',
            sdpMid: '0',
            sdpMLineIndex: 0,
          },
        })
      ).status,
      200,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.db.close();
  }
});
