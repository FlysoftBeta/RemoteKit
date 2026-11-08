import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApplication } from '../server/application';
import { createHttp } from '../server/http/server';
import { ControlDatabase } from '../server/persistence/database';
import { resolveNavigation } from '../server/navigation-url';
import type { LibraryEntry } from '../shared/file-library';
import type { ProductAction, ProductOperation } from '../shared/product';
import { FILE_LIMITS } from '../shared/product';
import { RemoteKitError } from '../shared/errors';
import { registerUser, requestViewer, TestClock, testGateway } from './server-fixture';

const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

class Endpoint {
  readonly calls: { method: string; tenant: string; args: any }[] = [];
  readonly views = new Map<string, any>();
  readonly pendingClose = new Set<string>();
  readonly rejectedClose = new Set<string>();
  info: any = {
    title: 'Document title',
    url: 'https://example.test/work/document',
    manifest: { name: 'Workspace App', startUrl: './home', themeColor: '#123456', display: 'browser' },
    icon: { png: png.toString('base64'), width: 192, height: 192 },
  };

  async request(method: string, tenant: string, args: any = {}) {
    this.calls.push({ method, tenant, args });
    if (method === 'session.snapshot')
      return { running: true, browserIncarnation: 'browser', views: [...this.views.values()] };
    if (method === 'view.appInfo') return this.info;
    if (method === 'view.ensure')
      this.views.set(args.viewId, {
        ...args,
        title: 'Initial page',
        instance: 'instance',
        document: 'initial',
        actual: 0,
        loading: false,
      });
    if (method === 'view.navigate') {
      const view = this.views.get(args.viewId);
      Object.assign(view, { url: args.url, loading: true });
    }
    if (method === 'view.configure') Object.assign(this.views.get(args.viewId) ?? {}, args);
    if (method === 'view.close') {
      if (this.rejectedClose.has(args.viewId)) throw new RemoteKitError('rejected', 'Close rejected');
      const view = this.views.get(args.viewId);
      if (this.pendingClose.has(args.viewId))
        return {
          pending: true,
          requestId: 'beforeunload',
          browserIncarnation: 'browser',
          instance: view.instance,
          document: view.document,
        };
      this.views.delete(args.viewId);
      return { closed: true };
    }
    if (method === 'view.close.reply') {
      if (args.accept) this.views.get(args.viewId).close_state = 'closed';
      return { accepted: true, browser: { ok: true } };
    }
    return { accepted: true, applied: true };
  }
}

async function fixture() {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', clock);
  const endpoint = new Endpoint();
  const control = createApplication(store, testGateway(endpoint), undefined, clock);
  const user = await registerUser(store, 'workspace-user', 'password123');
  await control.viewers.attachViewer(
    user.tenantId,
    'lease',
    () => {},
    { identity: 'test', valid: () => true },
    true,
  );
  const request = (method: string, params: any) =>
    requestViewer(control, user.tenantId, 'lease', method, params);
  const action = (value: ProductAction) => control.operations.productAction(user.tenantId, value, 'lease');
  const close = async () => {
    await control.close();
    store.db.close();
  };
  return { clock, store, endpoint, control, user, request, action, close };
}

test('workspace WS routes preserve bounded local state and split settings while restricting product actions', async () => {
  const f = await fixture();
  try {
    const opened = await f.action({ type: 'window.open', appId: 'files', placement: { mode: 'space' } });
    const windowId = opened.state.workspace.windows[0].id;
    await f.request('window.state', { windowId, state: { view: 'recent', search: 'photo' } });
    assert.deepEqual(f.store.workspaces.workspace(f.user.tenantId).windows[0].state, {
      view: 'recent',
      search: 'photo',
    });
    await f.request('action', { type: 'window.state', windowId, state: { partitionId: 'photos' } });
    assert.deepEqual(f.store.workspaces.workspace(f.user.tenantId).windows[0].state, {
      partitionId: 'photos',
    });
    for (const state of [[], null, { text: '界'.repeat(1500) }])
      await assert.rejects(f.request('window.state', { windowId, state }), { code: 'invalid_request' });
    await f.request('action', {
      type: 'settings.update',
      settings: { workspace: { showStats: true }, browser: { searchEngine: 'bing' } },
    });
    const settings = f.store.workspaces.workspace(f.user.tenantId).settings;
    assert.equal(settings.workspace.showStats, true);
    assert.equal(settings.browser.searchEngine, 'bing');
    assert.equal(settings.browser.memorySaverEnabled, true);
    await assert.rejects(
      f.request('action', { type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
      { code: 'invalid_request' },
    );
    assert.equal(
      f.endpoint.calls.some((call) => call.method === 'view.ensure'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('app inspection binds expiring icon tokens to tenants and installed icons require matching authenticated URLs', async () => {
  const f = await fixture();
  let server: ReturnType<typeof createHttp> | undefined;
  try {
    await f.action({
      type: 'window.open',
      appId: 'browser',
      url: 'https://example.test/work/document',
      placement: { mode: 'space' },
    });
    const tab = f.store.workspaces.workspace(f.user.tenantId).tabs[0];
    const info = await f.request('app.inspect', { tabId: tab.id });
    assert.deepEqual(
      { ...info, iconToken: undefined },
      {
        name: 'Workspace App',
        startUrl: 'https://example.test/work/home',
        scope: 'https://example.test/work/',
        display: 'browser',
        themeColor: '#123456',
        iconToken: undefined,
        iconDataUrl: `data:image/png;base64,${png.toString('base64')}`,
      },
    );
    assert.ok(info.iconToken);
    const call = f.endpoint.calls.find((call) => call.method === 'view.appInfo')!;
    assert.equal(call.tenant, f.user.tenantId);
    assert.equal(call.args.viewId, tab.webviewId);
    const other = await registerUser(f.store, 'other-user', 'password123');
    assert.throws(() => f.control.workspace.appIcon(other.tenantId, info.iconToken), { code: 'not_found' });
    const installed = await f.action({ type: 'app.install', ...info });
    const app = installed.state.workspace.apps[0];
    assert.ok(app.iconHash);
    assert.equal(app.iconUrl, `/api/apps/${app.id}/icon?h=${app.iconHash}`);
    assert.equal('icon' in app, false);
    server = createHttp(f.control, { origins: [], clientDir: '.' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const get = (path: string, token?: string, method = 'GET') =>
      fetch(origin + path, { method, headers: token ? { Cookie: `rk_session=${token}` } : {} });
    assert.equal((await get(app.iconUrl!)).status, 401);
    assert.equal((await get(app.iconUrl!, other.token)).status, 404);
    assert.equal((await get(`/api/apps/${app.id}/icon?h=wrong`, f.user.token)).status, 404);
    const response = await get(app.iconUrl!, f.user.token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(response.headers.get('vary'), 'Cookie');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const head = await get(app.iconUrl!, f.user.token, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(png.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    f.clock.advance(600000);
    assert.throws(() => f.control.workspace.appIcon(f.user.tenantId, info.iconToken), { code: 'not_found' });
    assert.deepEqual(f.store.workspaces.items.appIcon(f.user.tenantId, app.id)?.png, png);
  } finally {
    await server?.shutdown();
    await f.close();
  }
});

test('committed main-frame navigation records normalized pages, latest titles and launcher chain boundaries', async () => {
  const f = await fixture();
  try {
    await f.action({
      type: 'window.open',
      appId: 'browser',
      placement: { mode: 'space' },
      url: 'https://initial.test/',
    });
    const tab = f.store.workspaces.workspace(f.user.tenantId).tabs[0];
    const view = f.endpoint.views.get(tab.webviewId)!;
    await f.control.reconciler.tick();
    f.control.workspace.clearUsage(f.user.tenantId, 'all');
    const navigate = async (
      url: string,
      options: { documentCommitted?: boolean; error?: boolean; source?: 'launcher' } = {},
    ) => {
      f.clock.advance(1000);
      const previousUrl = view.url;
      const operation: ProductOperation = {
        operationId: randomUUID(),
        operationGeneration: f.store.operations.operationGeneration(f.user.tenantId),
        action: { type: 'tab.navigate', tabId: tab.id, url, source: options.source },
      };
      await f.control.operations.submitOperation(f.user.tenantId, operation, 'lease');
      const terminal = {
        ...operation,
        state: 'committed',
        url: options.documentCommitted === false ? previousUrl : url,
        documentCommitted: options.documentCommitted !== false,
        isErrorPage: options.error === true,
      };
      Object.assign(view, {
        url: options.documentCommitted === false ? previousUrl : url,
        loading: false,
        title: `Title ${url}`,
        isErrorPage: options.error === true,
        ...(options.documentCommitted === false ? {} : { document: operation.operationId }),
        navigationOperations: [terminal],
      });
      await f.control.reconciler.tick();
      assert.equal(f.control.operations.operationStatus(f.user.tenantId, operation).status, 'committed');
    };
    await navigate('https://pages.test/first#fragment');
    await navigate('https://pages.test/second', { source: 'launcher' });
    let pages = f.store.workspaces.items
      .usage(f.user.tenantId, f.clock.wallMs())
      .filter((event) => event.item.startsWith('page:'));
    assert.deepEqual(
      pages.map((event) => event.item),
      ['page:https://pages.test/first', 'page:https://pages.test/second'],
    );
    assert.notEqual(pages[0].chain, pages[1].chain);
    view.title = 'Settled title';
    await f.control.reconciler.tick();
    pages = f.store.workspaces.items
      .usage(f.user.tenantId, f.clock.wallMs())
      .filter((event) => event.item.startsWith('page:'));
    assert.equal(pages.length, 2);
    assert.equal(pages[1].title, 'Settled title');
    for (const engine of ['google', 'bing', 'duckduckgo', 'baidu'] as const)
      await navigate(resolveNavigation('two words', engine));
    await navigate('about:blank');
    await navigate('https://errors.test/', { error: true });
    await navigate('https://iframe.test/', { documentCommitted: false });
    assert.equal(
      f.store.workspaces.items
        .usage(f.user.tenantId, f.clock.wallMs())
        .filter((event) => event.item.startsWith('page:')).length,
      2,
    );
  } finally {
    await f.close();
  }
});

test('launcher groups obey caps, favorite and organized priority, source exclusion and App presentation', async () => {
  const f = await fixture();
  try {
    await f.action({ type: 'window.open', appId: 'files', placement: { mode: 'space' } });
    const state = f.store.workspaces.workspace(f.user.tenantId);
    const windowId = state.windows[0].id;
    state.apps = Array.from({ length: 15 }, (_, index) => ({
      id: `app-${index}`,
      name: `Installed ${index}`,
      startUrl: `https://app${index}.test/`,
      scope: `https://app${index}.test/`,
      display: 'standalone',
      createdAt: 1,
      updatedAt: 1,
      themeColor: '#123456',
      iconUrl: `/api/apps/app-${index}/icon?h=hash`,
      iconHash: 'hash',
    }));
    state.favorites = [
      { id: 'favorite', title: 'Favorite page', url: 'https://app0.test/favorite', createdAt: 1 },
    ];
    f.store.workspaces.saveWorkspace(state);
    const library = f.store.library.snapshot(f.user.tenantId);
    library.partitions = [{ id: 'partition', name: 'Organized' }];
    library.excludedSources = [{ app: 'files', channel: 'camera' }];
    library.entries = Array.from({ length: 30 }, (_, index): LibraryEntry => ({
      id: `file-${index}`,
      name: `File ${index}`,
      assetId: `asset-${index}`,
      type: 'text/plain',
      size: 1,
      createdAt: 1,
      source: { app: 'files', channel: index === 0 ? 'camera' : 'upload' },
      partitionId: index >= 20 ? 'partition' : null,
      collected: true,
    }));
    library.entries.push({
      ...library.entries[20],
      id: 'excluded-organized',
      source: { app: 'files', channel: 'camera' },
    });
    library.entries.push({
      id: 'unused',
      name: 'Unused searchable file',
      assetId: 'unused-asset',
      type: 'text/plain',
      size: 1,
      createdAt: 1,
      source: { app: 'files', channel: 'upload' },
      partitionId: null,
      collected: true,
    });
    f.store.library.save(f.user.tenantId, library);
    const record = (item: string, visits: number, title?: string) => {
      for (let index = 0; index < visits; index++)
        f.store.workspaces.items.recordUsage(
          f.user.tenantId,
          { item, windowId, title, source: 'launcher' },
          f.clock.wallMs(),
        );
    };
    for (const app of state.apps) record('app:web:' + app.id, 40);
    for (let index = 0; index < 30; index++) record(`page:https://pages.test/${index}`, 2, `Page ${index}`);
    record('page:https://once.test/sign-in', 1, 'Sign in once');
    record('page:https://pages.test/1', 1, 'Just a moment...');
    for (const entry of library.entries.filter((entry) => entry.id !== 'unused'))
      record('file:' + entry.id, entry.id === 'file-0' ? 100 : 1);
    const { items } = await f.request('launcher.get', {});
    const group = (name: string) => items.filter((item: any) => item.group === name);
    assert.equal(group('frequent').length, 12);
    assert.equal(group('apps').length, 18);
    assert.deepEqual(
      group('apps')
        .slice(0, 3)
        .map((item: any) => item.appId),
      ['browser', 'files', 'settings'],
    );
    assert.equal(group('pages').length, 16);
    assert.equal(group('pages')[0].favorite, true);
    assert.equal(group('pages')[0].themeColor, '#123456');
    assert.equal(group('pages')[0].iconUrl, '/api/apps/app-0/icon?h=hash');
    assert.equal(group('files').length, 12);
    assert.ok(
      group('files')
        .slice(0, 10)
        .every((item: any) => item.organized),
    );
    assert.equal(
      items.some((item: any) => item.entryId === 'file-0'),
      false,
    );
    assert.equal(
      items.some((item: any) => item.entryId === 'excluded-organized'),
      false,
    );
    const frequent = new Set(group('frequent').map((item: any) => item.key));
    assert.ok([...group('pages'), ...group('files')].every((item: any) => !frequent.has(item.key)));
    const search = await f.request('launcher.get', { query: 'favorite' });
    assert.deepEqual(
      search.items.map((item: any) => item.url),
      ['https://app0.test/favorite'],
    );
    assert.equal(
      items.some((item: any) => item.url === 'https://once.test/sign-in'),
      false,
    );
    assert.equal(items.find((item: any) => item.url === 'https://pages.test/1')?.title, 'Page 1');
    const once = await f.request('launcher.get', { query: 'sign in once' });
    assert.deepEqual(
      once.items.map((item: any) => item.url),
      ['https://once.test/sign-in'],
    );
    const unused = await f.request('launcher.get', { query: 'unused searchable' });
    assert.deepEqual(
      unused.items.map((item: any) => item.entryId),
      ['unused'],
    );
    assert.equal(
      items.some((item: any) => item.entryId === 'unused'),
      false,
    );
    await assert.rejects(f.request('usage.record', { item: 'file:missing', windowId }), {
      code: 'not_found',
    });
    await assert.rejects(f.request('usage.record', { item: 'page:https://pages.test/', windowId }), {
      code: 'invalid_request',
    });
    assert.deepEqual(await f.request('usage.record', { item: 'file:file-1', windowId }), { recorded: true });
    await f.request('usage.clear', { scope: 'pages' });
    let events = f.store.workspaces.items.usage(f.user.tenantId, f.clock.wallMs());
    assert.equal(
      events.some((event) => event.item.startsWith('page:')),
      false,
    );
    assert.equal(
      events.some((event) => event.item.startsWith('file:')),
      true,
    );
    await f.request('usage.clear', { scope: 'all' });
    events = f.store.workspaces.items.usage(f.user.tenantId, f.clock.wallMs());
    assert.deepEqual(events, []);
  } finally {
    await f.close();
  }
});

test('a committed passive primary document records usage while subresources remain loading', async () => {
  const f = await fixture();
  try {
    await f.action({
      type: 'window.open',
      appId: 'browser',
      url: 'https://initial.test/',
      placement: { mode: 'space' },
    });
    const tab = f.store.workspaces.workspace(f.user.tenantId).tabs[0];
    const view = f.endpoint.views.get(tab.webviewId)!;
    await f.control.reconciler.tick();
    f.control.workspace.clearUsage(f.user.tenantId, 'all');
    f.clock.advance(1000);
    Object.assign(view, {
      document: 'passive-commit',
      url: 'https://passive.test/document#fragment',
      title: 'Committed page',
      loading: true,
    });
    await f.control.reconciler.tick();
    let events = f.store.workspaces.items.usage(f.user.tenantId, f.clock.wallMs());
    assert.deepEqual(
      events.map((event) => [event.item, event.title]),
      [['page:https://passive.test/document', 'Committed page']],
    );
    assert.equal(f.store.workspaces.workspace(f.user.tenantId).tabs[0].loading, true);
    await f.control.reconciler.tick();
    assert.equal(f.store.workspaces.items.usage(f.user.tenantId, f.clock.wallMs()).length, 1);
    f.clock.advance(1000);
    view.url = 'https://passive.test/document?page=2';
    view.title = 'Second route';
    await f.control.reconciler.tick();
    events = f.store.workspaces.items.usage(f.user.tenantId, f.clock.wallMs());
    assert.deepEqual(
      events.map((event) => event.item),
      ['page:https://passive.test/document', 'page:https://passive.test/document?page=2'],
    );
  } finally {
    await f.close();
  }
});

for (const target of ['space', 'app'] as const) {
  test(`definite ${target} close rejection clears persisted intent and never resumes a rejected operation`, async () => {
    const f = await fixture();
    try {
      let appId = 'browser';
      if (target === 'app') {
        const installed = await f.action({
          type: 'app.install',
          name: 'App',
          startUrl: 'https://app.test/',
          scope: 'https://app.test/',
          display: 'standalone',
        });
        appId = 'web:' + installed.state.workspace.apps[0].id;
      }
      await f.action({
        type: 'window.open',
        appId,
        url: 'https://first.test/',
        placement: { mode: 'space' },
      });
      let state = f.store.workspaces.workspace(f.user.tenantId);
      await f.action({
        type: 'window.open',
        appId,
        url: 'https://second.test/',
        placement: { mode: 'split', besideWindowId: state.windows[0].id, side: 'right' },
      });
      state = f.store.workspaces.workspace(f.user.tenantId);
      const second = state.tabs[1];
      f.endpoint.rejectedClose.add(second.webviewId);
      const operation: ProductOperation = {
        operationId: randomUUID(),
        operationGeneration: f.store.operations.operationGeneration(f.user.tenantId),
        action:
          target === 'space'
            ? { type: 'space.close', spaceId: state.spaces[0].id }
            : { type: 'app.uninstall', appId },
      };
      const receipt = await f.control.operations.submitOperation(f.user.tenantId, operation, 'lease');
      assert.equal(receipt.status, 'rejected');
      state = f.store.workspaces.workspace(f.user.tenantId);
      assert.deepEqual(
        state.windows.map((window) => window.id),
        [second.windowId],
      );
      assert.equal(state.pendingWindowCloseId, null);
      assert.equal(state.pendingWindowCloseIds, undefined);
      assert.equal(state.pendingAppUninstallId, undefined);
      assert.equal(state.pendingClose, null);
      if (target === 'app') assert.equal(state.apps.length, 1);
      const closedCalls = f.endpoint.calls.filter((call) => call.method === 'view.close').length;
      f.endpoint.rejectedClose.clear();
      for (let tick = 0; tick < 2; tick++) await f.control.reconciler.tick();
      assert.equal(f.endpoint.calls.filter((call) => call.method === 'view.close').length, closedCalls);
      state = f.store.workspaces.workspace(f.user.tenantId);
      assert.deepEqual(
        state.windows.map((window) => window.id),
        [second.windowId],
      );
      if (target === 'app') assert.equal(state.apps.length, 1);
      assert.equal(f.control.operations.operationStatus(f.user.tenantId, operation).status, 'rejected');
    } finally {
      await f.close();
    }
  });
}

test('file request source resolves the owning browser hostname or installed web App', async () => {
  const f = await fixture();
  try {
    await f.action({
      type: 'window.open',
      appId: 'browser',
      url: 'https://source.test/page',
      placement: { mode: 'space' },
    });
    const state = f.store.workspaces.workspace(f.user.tenantId);
    const tab = state.tabs[0];
    f.control.tenants.get(f.user.tenantId).pageRequests.files = [
      {
        id: 'request',
        tabId: tab.id,
        windowId: tab.windowId,
        origin: 'https://source.test',
        multiple: false,
        accept: [],
        state: 'pending',
        limits: FILE_LIMITS,
        binding: {
          browserIncarnation: 'browser',
          view: tab.webviewId,
          instance: 'instance',
          document: 'initial',
          request: 'native-request',
        },
      },
    ];
    assert.deepEqual(f.control.workspace.fileSourceForRequest(f.user.tenantId, 'request'), {
      app: 'browser',
      channel: 'source.test',
    });
    assert.equal(f.control.workspace.fileSourceForRequest(f.user.tenantId, 'unknown'), null);
    state.windows[0].appId = 'web:installed';
    f.store.workspaces.saveWorkspace(state);
    assert.deepEqual(f.control.workspace.fileSourceForRequest(f.user.tenantId, 'request'), {
      app: 'web:installed',
      channel: '',
    });
  } finally {
    await f.close();
  }
});

test('web App popups split beside their opener, overflow into a space and route other new tabs to the browser', async () => {
  const f = await fixture();
  try {
    const installed = await f.action({
      type: 'app.install',
      name: 'App',
      startUrl: 'https://app.test/',
      scope: 'https://app.test/',
      display: 'standalone',
    });
    const appId = 'web:' + installed.state.workspace.apps[0].id;
    await f.action({ type: 'window.open', appId, placement: { mode: 'space' } });
    const original = f.store.workspaces.workspace(f.user.tenantId);
    const opener = original.tabs[0];
    const popup = async (id: string, disposition: number, openerViewId = opener.webviewId) => {
      const state = f.store.workspaces.workspace(f.user.tenantId);
      await f.control.popups.observePopups(state, {
        pendingPopups: [
          {
            provisionalId: id,
            openerViewId,
            disposition,
            userGesture: true,
            status: 'pending',
            url: `https://popup.test/${id}`,
          },
        ],
      });
      const result = f.store.workspaces.workspace(f.user.tenantId);
      const tab = result.tabs.find((item) => item.popup?.provisionalId === id)!;
      assert.ok(tab);
      assert.notEqual(tab.webviewId, openerViewId);
      assert.equal(tab.popup!.status, 'pending');
      return { state: result, tab, window: result.windows.find((window) => window.id === tab.windowId)! };
    };
    const first = await popup('web-popup-one', 5);
    assert.equal(first.window.appId, appId);
    assert.deepEqual(first.state.spaces[0].windowIds, [opener.windowId, first.window.id]);
    const second = await popup('web-popup-two', 5);
    assert.equal(second.state.spaces[0].windowIds.length, 3);
    const overflow = await popup('web-popup-overflow', 5);
    assert.equal(overflow.window.appId, appId);
    assert.equal(overflow.state.spaces.length, 2);
    assert.deepEqual(overflow.state.spaces[1].windowIds, [overflow.window.id]);
    const foreground = await popup('foreground', 3);
    assert.equal(foreground.window.appId, 'browser');
    const browserSpace = foreground.state.spaces.find((space) =>
      space.windowIds.includes(foreground.window.id),
    )!;
    assert.equal(foreground.state.activeSpaceId, browserSpace.id);
    for (const [id, disposition] of [
      ['background', 4],
      ['new-window', 6],
    ] as const) {
      const routed = await popup(id, disposition);
      assert.equal(routed.window.id, foreground.window.id);
      assert.equal(routed.window.activeTabId, routed.tab.id);
      assert.equal(routed.state.activeSpaceId, browserSpace.id);
    }
    const browserPopup = await popup('browser-popup', 5, foreground.tab.webviewId);
    assert.equal(browserPopup.window.appId, 'browser');
    assert.notEqual(browserPopup.window.id, foreground.window.id);
    assert.deepEqual(
      browserPopup.state.spaces.find((space) => space.windowIds.includes(browserPopup.window.id))!.windowIds,
      [browserPopup.window.id],
    );
    for (const window of browserPopup.state.windows.filter((window) => window.appId === appId))
      assert.equal(browserPopup.state.tabs.filter((tab) => tab.windowId === window.id).length, 1);
    assert.equal(
      f.endpoint.calls.some(
        (call) => call.method === 'view.ensure' && call.args.url.startsWith('https://popup.test/'),
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test('space close and App uninstall stop at beforeunload, preserve cancelled targets and continue sequentially on retry', async () => {
  const f = await fixture();
  try {
    await f.action({
      type: 'window.open',
      appId: 'browser',
      url: 'https://first.test/',
      placement: { mode: 'space' },
    });
    let state = f.store.workspaces.workspace(f.user.tenantId);
    const firstWindow = state.windows[0];
    await f.action({
      type: 'window.open',
      appId: 'browser',
      url: 'https://second.test/',
      placement: { mode: 'split', besideWindowId: firstWindow.id, side: 'right' },
    });
    state = f.store.workspaces.workspace(f.user.tenantId);
    const secondTab = state.tabs.find((tab) => tab.windowId !== firstWindow.id)!;
    f.endpoint.pendingClose.add(secondTab.webviewId);
    const submit = async (action: ProductAction) => {
      const operation = {
        operationId: randomUUID(),
        operationGeneration: f.store.operations.operationGeneration(f.user.tenantId),
        action,
      };
      await f.control.operations.submitOperation(f.user.tenantId, operation, 'lease');
      return operation;
    };
    const closeSpace = await submit({ type: 'space.close', spaceId: state.spaces[0].id });
    state = f.store.workspaces.workspace(f.user.tenantId);
    assert.equal(state.windows.length, 1);
    assert.equal(state.pendingClose?.id, secondTab.id);
    assert.deepEqual(state.spaces[0].weights, [1]);
    assert.equal(f.control.operations.operationStatus(f.user.tenantId, closeSpace).status, 'applying');
    await submit({
      type: 'tab.close',
      tabId: secondTab.id,
      cancel: true,
      requestId: state.pendingClose!.requestId,
    });
    state = f.store.workspaces.workspace(f.user.tenantId);
    assert.equal(state.pendingClose, null);
    assert.equal(state.pendingWindowCloseId, null);
    assert.equal(state.windows.length, 1);
    assert.equal(f.control.operations.operationStatus(f.user.tenantId, closeSpace).status, 'rejected');
    f.endpoint.pendingClose.clear();
    await f.action({ type: 'space.close', spaceId: state.spaces[0].id });
    const installed = await f.action({
      type: 'app.install',
      name: 'App',
      startUrl: 'https://app.test/',
      scope: 'https://app.test/',
      display: 'standalone',
    });
    const appId = 'web:' + installed.state.workspace.apps[0].id;
    for (let index = 0; index < 2; index++)
      await f.action({ type: 'window.open', appId, placement: { mode: 'space' } });
    state = f.store.workspaces.workspace(f.user.tenantId);
    const last = state.tabs[state.tabs.length - 1];
    f.endpoint.pendingClose.add(last.webviewId);
    const uninstall = await submit({ type: 'app.uninstall', appId });
    state = f.store.workspaces.workspace(f.user.tenantId);
    assert.equal(state.windows.length, 1);
    assert.equal(state.apps.length, 1);
    assert.equal(state.pendingAppUninstallId, state.apps[0].id);
    assert.equal(state.pendingClose?.id, last.id);
    await submit({
      type: 'tab.close',
      tabId: last.id,
      cancel: true,
      requestId: state.pendingClose!.requestId,
    });
    state = f.store.workspaces.workspace(f.user.tenantId);
    assert.equal(state.apps.length, 1);
    assert.equal(state.pendingAppUninstallId, undefined);
    assert.equal(state.pendingWindowCloseIds, undefined);
    assert.equal(f.control.operations.operationStatus(f.user.tenantId, uninstall).status, 'rejected');
    f.endpoint.pendingClose.clear();
    await submit({ type: 'app.uninstall', appId });
    state = f.store.workspaces.workspace(f.user.tenantId);
    assert.deepEqual(state.apps, []);
    assert.deepEqual(state.windows, []);
    assert.deepEqual(state.tabs, []);
    assert.deepEqual(state.spaces, []);
    assert.equal(state.activeSpaceId, null);
  } finally {
    await f.close();
  }
});

test('page previews share normalized usage keys, reject invalid images, and serve only authenticated tenant images', async () => {
  const f = await fixture();
  let server: ReturnType<typeof createHttp> | undefined;
  try {
    const image = 'data:image/jpeg;base64,' + jpeg.toString('base64');
    await f.action({
      type: 'favorite.add',
      url: 'https://preview.test/page#favorite',
      title: 'Preview page',
    });
    assert.deepEqual(await f.request('page.preview', { url: 'https://preview.test/page#capture', image }), {
      saved: true,
    });
    assert.deepEqual(
      [...f.store.workspaces.items.previewHashes(f.user.tenantId).keys()],
      ['page:https://preview.test/page'],
    );
    const result = await f.request('launcher.get', { query: 'Preview page' });
    const item = result.items.find((item: any) => item.kind === 'page');
    assert.match(item.previewUrl, /^\/api\/previews\/[0-9a-f]{64}$/);
    for (const url of [
      'about:blank',
      'chrome-error://chromewebdata/',
      'https://www.google.com/search?q=hello',
      'https://duckduckgo.com/?q=hello',
    ])
      assert.deepEqual(await f.request('page.preview', { url, image }), { saved: false });
    for (const invalid of [
      '',
      'data:image/png;base64,' + png.toString('base64'),
      'data:image/jpeg;base64,!!!!',
      'data:image/jpeg;base64,' + Buffer.alloc(24 * 1024 + 1, 0xff).toString('base64'),
      'data:image/jpeg;base64,' + Buffer.alloc(512 * 1024, 0xff).toString('base64'),
    ])
      await assert.rejects(f.request('page.preview', { url: 'https://preview.test/', image: invalid }), {
        code: 'invalid_request',
      });
    const exact = Buffer.alloc(24 * 1024, 0xff);
    exact[1] = 0xd8;
    assert.deepEqual(
      await f.request('page.preview', {
        url: 'https://preview.test/exact',
        image: 'data:image/jpeg;base64,' + exact.toString('base64'),
      }),
      { saved: true },
    );
    server = createHttp(f.control, { origins: [], clientDir: '.' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const get = (token?: string) =>
      fetch(origin + item.previewUrl, { headers: token ? { Cookie: `rk_session=${token}` } : {} });
    assert.equal((await get()).status, 401);
    const other = await registerUser(f.store, 'preview-other', 'password123');
    assert.equal((await get(other.token)).status, 404);
    const response = await get(f.user.token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(response.headers.get('vary'), 'Cookie');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
    for (const scope of ['pages', 'all']) {
      await f.request('usage.clear', { scope });
      assert.equal((await get(f.user.token)).status, 404);
      assert.equal(
        (await f.request('launcher.get', { query: 'Preview page' })).items.find(
          (item: any) => item.kind === 'page',
        ).previewUrl,
        undefined,
      );
      await f.request('page.preview', { url: 'https://preview.test/page', image });
    }
  } finally {
    await server?.shutdown();
    await f.close();
  }
});
