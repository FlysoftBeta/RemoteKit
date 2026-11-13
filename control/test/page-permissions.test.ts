import { applyDesiredViews, publishAndObserve } from './coordination-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication } from '../server/application';
import { registerUser, testGateway } from './server-fixture';
import type { EndpointLink } from '../server/endpoint/link';
import { projectPageRequest, validatePageReply } from '../server/workspace/page-requests';
import { recordedAction } from '../shared/recorded-action';
import { sitePayload, validProtocolHandler, validSiteOrigin } from '../server/workspace/site-policy';
import { applyCommand } from '../server/workspace/commands';
import { diagnosticEndpointSnapshot } from '../server/diagnostics/projection';
import { SITE_PERMISSIONS, type PageDialogReply, type ProductAction } from '../shared/product';
import { RemoteKitError } from '../shared/errors';

const origin = 'https://example.test';
class PromptEndpoint implements EndpointLink {
  readonly state = { state: 'ready' as const, incarnation: 'test', connectionEpoch: 'test' };
  view: any;
  calls: { method: string; args: any }[] = [];
  onRequest?: (method: string, args: any) => void | Promise<void>;
  observe() {
    return {
      running: true,
      browserPid: 10,
      browserIncarnation: 'browser-A',
      views: this.view ? [this.view] : [],
    };
  }
  async request(method: string, _tenant: string, args: any = {}): Promise<any> {
    await this.onRequest?.(method, args);
    this.calls.push({ method, args });
    if (method === 'session.desired') {
      const views = new Map(this.view ? [[this.view.viewId, this.view]] : []);
      applyDesiredViews(views, args);
      const previous = this.view;
      this.view = [...views.values()][0];
      if (!previous && this.view) this.view.document = '2';
    }
    if (method === 'view.page.reply') {
      this.view.pageRequests.pending = [];
      return { accepted: true, browser: { ok: true } };
    }
    return { accepted: true, applied: true };
  }
}
async function fixture() {
  const store = new ControlDatabase(':memory:', { buildId: 'test' }),
    endpoint = new PromptEndpoint(),
    control = createApplication(store, testGateway(endpoint));
  const { tenantId: tenant } = await registerUser(store, 'prompt-user', 'password123');
  await control.viewers.attachViewer(
    tenant,
    'lease',
    () => {},
    { identity: 'test-account', valid: () => true },
    true,
  );
  await control.operations.productAction(
    tenant,
    { type: 'window.open', appId: 'browser', placement: { mode: 'space' }, url: origin },
    'lease',
  );
  await publishAndObserve(control.endpoint, tenant);
  const show = async (request: Record<string, unknown>) => {
    endpoint.view.pageRequests = { pending: [{ request: randomUUID(), origin, ...request }] };
    await control.reconciler.tick();
    endpoint.calls = [];
    return control.viewers.productState(tenant).pageDialogs[0];
  };
  const close = async () => {
    await control.close();
    store.db.close();
  };
  return { store, endpoint, control, tenant, show, close };
}

test('new page requests project only validated fields and clip display strings', () => {
  const project = (request: any) => projectPageRequest({ request: '1', origin, ...request });
  assert.deepEqual(
    project({ kind: 'permission', embedding_origin: origin, permissions: [...SITE_PERMISSIONS] }),
    { kind: 'permission', origin, embeddingOrigin: origin, permissions: [...SITE_PERMISSIONS] },
  );
  assert.deepEqual(project({ kind: 'protocol_handler', protocol: 'mailto', url: origin + '/?%s' }), {
    kind: 'protocol_handler',
    origin,
    protocol: 'mailto',
    url: origin + '/?%s',
  });
  assert.deepEqual(project({ kind: 'repost' }), { kind: 'repost', origin });
  const auth = project({
    kind: 'http_auth',
    realm: 'r'.repeat(3000),
    scheme: 'digest',
    proxy: false,
    url: origin + '/' + 'a'.repeat(3000),
    username: 'secret-user',
    password: 'secret-password',
  });
  assert.equal(auth?.kind, 'http_auth');
  assert.equal(auth.realm.length, 2048);
  assert.equal(auth.url.length, 2048);
  assert.ok(!JSON.stringify(auth).includes('secret'));
  assert.ok(
    project({
      kind: 'http_auth',
      origin: 'proxy.test:8080',
      realm: '',
      scheme: 'negotiate',
      proxy: true,
      url: origin,
    }),
  );
  for (const malformed of [
    null,
    {},
    { kind: 'permission', embedding_origin: origin, permissions: [] },
    { kind: 'permission', embedding_origin: origin, permissions: ['camera'] },
    { kind: 'permission', embedding_origin: origin, permissions: ['notifications'] },
    { kind: 'permission', embedding_origin: origin, permissions: ['geolocation', 'notifications'] },
    { kind: 'permission', embedding_origin: 5, permissions: ['geolocation'] },
    { kind: 'permission', embedding_origin: origin, permissions: ['geolocation', 'geolocation'] },
    { kind: 'permission', origin: origin + '/', embedding_origin: origin, permissions: ['geolocation'] },
    { kind: 'http_auth', realm: '', scheme: 'Basic', proxy: false, url: origin },
    { kind: 'http_auth', realm: 0, scheme: 'basic', proxy: false, url: origin },
    { kind: 'http_auth', realm: '', scheme: 'basic', proxy: 'false', url: origin },
    { kind: 'http_auth', realm: '', scheme: 'basic', proxy: false, url: 'invalid' },
    { kind: 'repost', origin: 'file:///a' },
    { kind: 'protocol_handler', protocol: 'https', url: origin + '/%s' },
    { kind: 'protocol_handler', protocol: 'mailto', url: 'https://other.test/%s' },
  ])
    assert.equal(projectPageRequest(malformed && { request: '1', origin, ...malformed }), undefined);
});

test('page replies strictly validate their discriminated shape', () => {
  const valid: PageDialogReply[] = [
    { kind: 'dialog', accept: true, text: '文字' },
    ...(['allow', 'allow_once', 'block', 'dismiss'] as const).map((decision) => ({
      kind: 'permission' as const,
      decision,
    })),
    { kind: 'http_auth', accept: true, username: '', password: '密码' },
    { kind: 'http_auth', accept: false },
    { kind: 'repost', accept: true },
    { kind: 'protocol_handler', accept: false, remember: false },
  ];
  for (const reply of valid) assert.doesNotThrow(() => validatePageReply(reply));
  for (const reply of [
    null,
    {},
    { kind: 'permission', accept: true },
    { kind: 'permission', decision: 'allow', accept: true },
    { kind: 'http_auth', accept: true, username: 'u' },
    { kind: 'http_auth', accept: false, password: 'p' },
    { kind: 'http_auth', accept: true, username: 'u', password: '密'.repeat(400) },
    { kind: 'http_auth', accept: true, username: 'u'.repeat(1025), password: '' },
    { kind: 'repost', accept: 1 },
    { kind: 'protocol_handler', accept: true, remember: false },
    { kind: 'dialog', accept: true, extra: 1 },
  ])
    assert.throws(() => validatePageReply(reply), { code: 'invalid_request' });
});

test('permission persistence and awaited application precede guarded reply; transient choices do not persist', async () => {
  const f = await fixture();
  try {
    for (const decision of ['allow', 'block', 'allow_once', 'dismiss'] as const) {
      const dialog = await f.show({
        kind: 'permission',
        embedding_origin: origin,
        permissions: ['geolocation', 'clipboard_read'],
      });
      assert.equal(dialog.kind, 'permission');
      const order: string[] = [];
      let applied = false;
      f.endpoint.onRequest = async (method, args) => {
        if (method === 'session.desired') {
          assert.equal(
            f.store.workspaces.workspace(f.tenant).sites[origin].permissions?.geolocation,
            decision,
          );
          assert.equal(args.sitePreferences.sites[origin].permissions.clipboard_read, decision);
          order.push('apply');
          await new Promise<void>((resolve) => setImmediate(resolve));
          applied = true;
        }
        if (method === 'view.page.reply') {
          if (decision === 'allow' || decision === 'block') assert.ok(applied);
          order.push('reply');
          assert.equal(args.decision, decision);
          assert.equal('accept' in args, false);
          assert.equal(args.browserIncarnation, 'browser-A');
          assert.equal(args.instance, '1');
          assert.equal(args.document, '2');
        }
      };
      await f.control.operations.productAction(
        f.tenant,
        { type: 'page.reply', dialogId: dialog.id, reply: { kind: 'permission', decision } },
        'lease',
      );
      if (decision === 'allow' || decision === 'block')
        assert.ok(order.indexOf('apply') >= 0 && order.lastIndexOf('reply') > order.indexOf('apply'));
      else assert.deepEqual(order, ['reply']);
    }
  } finally {
    await f.close();
  }
});

test('protocol handler accept moves ownership, block persists, dismiss does not persist', async () => {
  const f = await fixture();
  try {
    const workspace = f.store.workspaces.workspace(f.tenant);
    workspace.sites['https://other.test'] = {
      protocolHandlers: [{ protocol: 'mailto', url: 'https://other.test/%s', allowed: true }],
    };
    f.store.workspaces.saveWorkspace(workspace);
    for (const [accept, remember] of [
      [true, true],
      [false, true],
      [false, false],
    ]) {
      const dialog = await f.show({ kind: 'protocol_handler', protocol: 'mailto', url: origin + '/?%s' });
      const order: string[] = [];
      f.endpoint.onRequest = (method, args) => {
        if (method === 'session.desired') {
          const sites = f.store.workspaces.workspace(f.tenant).sites;
          assert.equal(sites[origin].protocolHandlers?.[0].allowed, accept);
          assert.equal(sites['https://other.test'], undefined);
          order.push('apply');
        }
        if (method === 'view.page.reply') {
          assert.equal(args.accept, accept);
          assert.equal('remember' in args, false);
          order.push('reply');
        }
      };
      await f.control.operations.productAction(
        f.tenant,
        { type: 'page.reply', dialogId: dialog.id, reply: { kind: 'protocol_handler', accept, remember } },
        'lease',
      );
      if (remember)
        assert.ok(order.indexOf('apply') >= 0 && order.lastIndexOf('reply') > order.indexOf('apply'));
      else assert.deepEqual(order, ['reply']);
    }
  } finally {
    await f.close();
  }
});

test('auth forwards credentials transiently, strips operation records and diagnostics, and rejects mismatched replies', async () => {
  const f = await fixture();
  try {
    const dialog = await f.show({
      kind: 'http_auth',
      realm: '登录',
      scheme: 'basic',
      proxy: false,
      url: origin + '/',
    });
    await assert.rejects(
      f.control.operations.productAction(
        f.tenant,
        { type: 'page.reply', dialogId: dialog.id, reply: { kind: 'repost', accept: false } },
        'lease',
      ),
      { code: 'conflict' },
    );
    const action: ProductAction = {
      type: 'page.reply',
      dialogId: dialog.id,
      reply: { kind: 'http_auth', accept: true, username: 'secret-user', password: 'secret-password' },
    };
    const operationId = randomUUID();
    const receipt = await f.control.operations.submitOperation(
      f.tenant,
      { operationId, operationGeneration: f.store.operations.operationGeneration(f.tenant), action },
      'lease',
    );
    assert.equal(receipt.status, 'committed');
    assert.deepEqual(JSON.parse(f.store.operations.operation(f.tenant, operationId)!.payload), {
      type: 'page.reply',
      dialogId: dialog.id,
      reply: { kind: 'http_auth', accept: true },
    });
    const sent = f.endpoint.calls.find((call) => call.method === 'view.page.reply')!.args;
    assert.equal(sent.username, 'secret-user');
    assert.equal(sent.password, 'secret-password');
    assert.ok(!JSON.stringify(f.control.viewers.productState(f.tenant)).includes('secret'));
    assert.ok(
      !JSON.stringify(
        diagnosticEndpointSnapshot(
          { stats: { username: 'secret-user', password: 'secret-password' } },
          new Set(),
        ),
      ).includes('secret'),
    );
    assert.ok(
      !JSON.stringify(
        recordedAction({
          ...action,
          reply: { kind: 'repost', accept: true, username: 'secret-user', password: 'secret-password' },
        } as any),
      ).includes('secret'),
    );
    const repost = await f.show({ kind: 'repost' });
    await f.control.operations.productAction(
      f.tenant,
      { type: 'page.reply', dialogId: repost.id, reply: { kind: 'repost', accept: true } },
      'lease',
    );
    assert.equal(f.endpoint.calls.find((call) => call.method === 'view.page.reply')!.args.accept, true);
  } finally {
    await f.close();
  }
});

test('site actions apply without reload, preserve tablet UA and prune empty origins', async () => {
  const f = await fixture();
  try {
    await f.control.operations.productAction(
      f.tenant,
      { type: 'site.permission', origin, permission: 'local_fonts', setting: 'allow' },
      'lease',
    );
    assert.deepEqual(f.store.workspaces.workspace(f.tenant).sites[origin], {
      permissions: { local_fonts: 'allow' },
    });
    assert.ok(f.endpoint.calls.some((call) => call.method === 'session.desired'));
    assert.ok(!f.endpoint.calls.some((call) => call.method === 'view.command'));
    const workspace = f.store.workspaces.workspace(f.tenant);
    workspace.sites[origin] = {
      ...workspace.sites[origin],
      tabletUa: true,
      protocolHandlers: [{ protocol: 'web+notes', url: origin + '/%s', allowed: false }],
    };
    f.store.workspaces.saveWorkspace(workspace);
    await f.control.operations.productAction(
      f.tenant,
      { type: 'site.protocolHandler.remove', origin, protocol: 'web+notes' },
      'lease',
    );
    assert.equal(f.store.workspaces.workspace(f.tenant).sites[origin].protocolHandlers, undefined);
    await f.control.operations.productAction(f.tenant, { type: 'site.permissions.reset', origin }, 'lease');
    assert.deepEqual(f.store.workspaces.workspace(f.tenant).sites[origin], {
      tabletUa: true,
    });
    await f.control.operations.productAction(
      f.tenant,
      {
        type: 'site.permission',
        origin: 'https://empty.test',
        permission: 'local_fonts',
        setting: 'block',
      },
      'lease',
    );
    await f.control.operations.productAction(
      f.tenant,
      { type: 'site.permission', origin: 'https://empty.test', permission: 'local_fonts', setting: 'ask' },
      'lease',
    );
    assert.equal(f.store.workspaces.workspace(f.tenant).sites['https://empty.test'], undefined);
    const ctx = { ids: [], viewId: '' };
    for (const action of [
      { type: 'site.permission', origin, permission: 'camera', setting: 'allow' },
      { type: 'site.permission', origin, permission: 'notifications', setting: 'allow' },
      { type: 'site.permission', origin, permission: 'local_fonts', setting: 'default' },
      { type: 'site.permission', origin: origin + '/', permission: 'local_fonts', setting: 'allow' },
      { type: 'site.protocolHandler.remove', origin, protocol: 'https' },
      { type: 'site.permissions.reset', origin, extra: true },
    ])
      assert.throws(() => applyCommand(workspace, action as ProductAction, ctx), { code: 'invalid_request' });
    assert.deepEqual(
      sitePayload({
        ...workspace,
        sites: {
          [origin]: {
            tabletUa: true,
            permissions: { geolocation: 'allow' },
            protocolHandlers: [{ protocol: 'mailto', url: origin + '/%s', allowed: false }],
          },
          'https://empty.test': { tabletUa: false, permissions: {}, protocolHandlers: [] },
        },
      }),
      {
        [origin]: {
          tabletUa: true,
          permissions: { geolocation: 'allow' },
          protocolHandlers: [{ protocol: 'mailto', url: origin + '/%s', allowed: false }],
        },
      },
    );
  } finally {
    await f.close();
  }
});

test('site payload includes only deliverable permissions and ignores unknown permission keys', () => {
  assert.deepEqual(SITE_PERMISSIONS, [
    'geolocation',
    'clipboard_read',
    'local_fonts',
    'window_management',
    'midi_sysex',
    'idle_detection',
  ]);
  const workspace = {
    sites: {
      [origin]: { permissions: { geolocation: 'allow', notifications: 'block' } },
      'https://unknown.test': { permissions: { notifications: 'allow' } },
    },
  } as unknown as Parameters<typeof sitePayload>[0];
  assert.deepEqual(sitePayload(workspace), { [origin]: { permissions: { geolocation: 'allow' } } });
});

test('failed preference application keeps the saved decision and never forwards the reply', async () => {
  const f = await fixture();
  try {
    const dialog = await f.show({
      kind: 'permission',
      embedding_origin: origin,
      permissions: ['local_fonts'],
    });
    f.endpoint.onRequest = (method) => {
      if (method === 'session.desired') throw new RemoteKitError('unavailable', '应用失败');
    };
    await assert.rejects(
      f.control.operations.productAction(
        f.tenant,
        { type: 'page.reply', dialogId: dialog.id, reply: { kind: 'permission', decision: 'block' } },
        'lease',
      ),
    );
    assert.equal(f.store.workspaces.workspace(f.tenant).sites[origin].permissions?.local_fonts, 'block');
    assert.ok(!f.endpoint.calls.some((call) => call.method === 'view.page.reply'));
  } finally {
    await f.close();
  }
});

test('authentication errors cannot copy credentials into receipts or state', async () => {
  const f = await fixture();
  try {
    const dialog = await f.show({ kind: 'http_auth', realm: '', scheme: 'basic', proxy: false, url: origin });
    f.endpoint.onRequest = (method) => {
      if (method === 'view.page.reply') throw new RemoteKitError('rejected', 'secret-user secret-password');
    };
    const operationId = randomUUID();
    const receipt = await f.control.operations.submitOperation(
      f.tenant,
      {
        operationId,
        operationGeneration: f.store.operations.operationGeneration(f.tenant),
        action: {
          type: 'page.reply',
          dialogId: dialog.id,
          reply: { kind: 'http_auth', accept: true, username: 'secret-user', password: 'secret-password' },
        },
      },
      'lease',
    );
    assert.equal(receipt.status, 'failed');
    assert.ok(!JSON.stringify(f.store.operations.operation(f.tenant, operationId)).includes('secret'));
    assert.ok(!JSON.stringify(f.control.viewers.productState(f.tenant)).includes('secret'));
  } finally {
    await f.close();
  }
});

test('origin, protocol URL and display host rules', () => {
  assert.ok(validSiteOrigin(origin));
  assert.ok(!validSiteOrigin(origin + '/'));
  for (const site of ['http://localhost', 'http://127.0.0.1:8080', origin])
    assert.ok(validProtocolHandler(site, 'web+notes', site + '/?%s'));
  for (const [site, protocol, url] of [
    [origin, 'web+Notes', origin + '/%s'],
    [origin, 'mailto', 'http://example.test/%s'],
    ['http://example.test', 'mailto', 'http://example.test/%s'],
    [origin, 'mailto', origin + '/missing'],
  ])
    assert.ok(!validProtocolHandler(site, protocol, url));
});
