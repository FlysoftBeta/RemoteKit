import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand } from '../server/workspace/commands';
import { removeWindow } from '../server/workspace/model';
import { Popups } from '../server/workspace/popups';
import type { ProductAction, ProductWorkspace } from '../shared/product';

function empty(): ProductWorkspace {
  return {
    tenantId: 'tenant',
    revision: 0,
    tabs: [],
    windows: [],
    spaces: [],
    activeSpaceId: null,
    apps: [],
    favorites: [],
    sites: {},
    settings: {
      workspace: {
        qualityPreference: 'auto',
        uiScale: 1,
        topDeadZone: 'off',
        showStats: false,
        autoFullscreen: false,
        autoKeyboard: false,
        avSync: false,
        audioChannels: { left: true, right: true },
      },
      browser: { searchEngine: 'google', memorySaverEnabled: true },
    },
  };
}
let sequence = 0;
function command(workspace: ProductWorkspace, action: ProductAction) {
  const prefix = String(++sequence);
  return applyCommand(workspace, action, {
    ids: [prefix + 'w', prefix + 's', prefix + 't'],
    viewId: prefix,
    now: sequence * 1000,
  });
}
function open(workspace: ProductWorkspace, appId = 'browser') {
  return command(workspace, { type: 'window.open', appId, placement: { mode: 'space' } }).workspace;
}

test('tab.create query always searches with the current engine and rejects URL/query ambiguity', () => {
  for (const [engine, prefix] of [
    ['google', 'https://www.google.com/search?q='],
    ['bing', 'https://www.bing.com/search?q='],
    ['duckduckgo', 'https://duckduckgo.com/?q='],
    ['baidu', 'https://www.baidu.com/s?wd='],
  ] as const) {
    const workspace = open(empty());
    workspace.settings.browser.searchEngine = engine;
    const windowId = workspace.windows[0].id;
    for (const query of ['example.com', 'https://example.com/path', '中文 & 😀']) {
      const next = command(workspace, { type: 'tab.create', windowId, query }).workspace;
      assert.equal(next.tabs[next.tabs.length - 1].url, prefix + encodeURIComponent(query));
      assert.equal(next.tabs[next.tabs.length - 1].kind, 'remote');
    }
    const exactQuery = 'a'.repeat(8192 - prefix.length);
    for (const query of ['a'.repeat(8193), exactQuery + 'a', '中'.repeat(1000)])
      assert.throws(() => command(workspace, { type: 'tab.create', windowId, query }), {
        code: 'limit_exceeded',
      });
    const exact = command(workspace, { type: 'tab.create', windowId, query: exactQuery }).workspace;
    assert.equal(exact.tabs[exact.tabs.length - 1].url.length, 8192);
    for (const query of ['', ' ', '\ud800', 42, null])
      assert.throws(() => command(workspace, { type: 'tab.create', windowId, query } as ProductAction), {
        code: 'invalid_request',
      });
    assert.throws(
      () => command(workspace, { type: 'tab.create', windowId, url: 'https://example.com', query: 'text' }),
      { code: 'invalid_request' },
    );
  }
});

test('spaces place windows, retain proportions when reordering, and remove empty spaces', () => {
  let workspace = open(open(empty()));
  const [first, second] = workspace.windows;
  workspace = command(workspace, {
    type: 'window.place',
    windowId: second.id,
    placement: { mode: 'split', besideWindowId: first.id, side: 'right' },
  }).workspace;
  assert.equal(workspace.spaces.length, 1);
  const spaceId = workspace.spaces[0].id;
  workspace = command(workspace, { type: 'space.layout', spaceId, weights: [1, 3] }).workspace;
  workspace = command(workspace, {
    type: 'window.place',
    windowId: second.id,
    placement: { mode: 'split', besideWindowId: first.id, side: 'left' },
  }).workspace;
  assert.deepEqual(workspace.spaces[0].windowIds, [second.id, first.id]);
  assert.deepEqual(workspace.spaces[0].weights, [0.75, 0.25]);
  removeWindow(workspace, second.id);
  assert.deepEqual(workspace.spaces[0].weights, [1]);
  assert.equal(workspace.spaces[0].focusedWindowId, first.id);
  removeWindow(workspace, first.id);
  assert.deepEqual(workspace.spaces, []);
  assert.equal(workspace.activeSpaceId, null);
});

test('window limits and per-space limits reject without changing input state', () => {
  let workspace = open(empty());
  const besideWindowId = workspace.windows[0].id;
  for (let count = 0; count < 2; count++)
    workspace = command(workspace, {
      type: 'window.open',
      appId: 'files',
      placement: { mode: 'split', besideWindowId, side: 'right' },
    }).workspace;
  assert.throws(
    () =>
      command(workspace, {
        type: 'window.open',
        appId: 'files',
        placement: { mode: 'split', besideWindowId, side: 'right' },
      }),
    { code: 'limit_exceeded' },
  );
  assert.equal(workspace.windows.length, 3);
  while (workspace.windows.length < 16) workspace = open(workspace, 'files');
  assert.throws(() => open(workspace), { code: 'limit_exceeded' });
});

test('settings are a singleton local App and window state is bounded', () => {
  let workspace = open(empty(), 'settings');
  const id = workspace.windows[0].id;
  workspace = open(workspace, 'settings');
  assert.equal(workspace.windows.length, 1);
  assert.equal(workspace.tabs.length, 0);
  workspace = command(workspace, {
    type: 'window.state',
    windowId: id,
    state: { section: 'apps' },
  }).workspace;
  assert.deepEqual(workspace.windows[0].state, { section: 'apps' });
  assert.throws(
    () => command(workspace, { type: 'window.state', windowId: id, state: { text: 'x'.repeat(8192) } }),
    /8 KiB/,
  );
  assert.throws(() => command(workspace, { type: 'tab.create', windowId: id }), { code: 'invalid_request' });
});

test('web Apps carry one remote tab and uninstall uses the close queue', () => {
  let workspace = command(empty(), {
    type: 'app.install',
    name: 'Mail',
    startUrl: 'https://example.com/mail/',
    themeColor: '#AABBCC',
  }).workspace;
  const appId = 'web:' + workspace.apps[0].id;
  workspace = open(workspace, appId);
  assert.equal(workspace.tabs[0].url, 'https://example.com/mail/');
  assert.equal(workspace.apps[0].themeColor, '#aabbcc');
  assert.throws(() => command(workspace, { type: 'tab.create', windowId: workspace.windows[0].id }), {
    code: 'conflict',
  });
  const plan = command(workspace, { type: 'app.uninstall', appId });
  assert.equal(plan.workspace.pendingAppUninstallId, workspace.apps[0].id);
  assert.equal(plan.workspace.pendingWindowCloseId, workspace.windows[0].id);
  assert.equal(plan.workspace.apps.length, 1);
  assert.deepEqual(plan.effects, [{ kind: 'closeWindow' }]);
  assert.throws(() => open(plan.workspace, appId), { code: 'conflict' });
});

test('queued window closures reject tab changes and incoming or outgoing placement', () => {
  const workspace = open(open(open(empty())));
  const [closing, queued, available] = workspace.windows;
  workspace.pendingWindowCloseId = closing.id;
  workspace.pendingWindowCloseIds = [queued.id];
  for (const window of [closing, queued]) {
    assert.throws(() => command(workspace, { type: 'tab.create', windowId: window.id }), {
      code: 'conflict',
    });
    assert.throws(
      () => command(workspace, { type: 'window.place', windowId: window.id, placement: { mode: 'space' } }),
      { code: 'conflict' },
    );
    assert.throws(
      () =>
        command(workspace, {
          type: 'window.place',
          windowId: available.id,
          placement: { mode: 'split', besideWindowId: window.id, side: 'right' },
        }),
      { code: 'conflict' },
    );
    assert.throws(
      () =>
        command(workspace, {
          type: 'tab.move',
          tabId: workspace.tabs.find((tab) => tab.windowId === available.id)!.id,
          windowId: window.id,
        }),
      { code: 'conflict' },
    );
    assert.throws(
      () =>
        command(workspace, {
          type: 'tab.move',
          tabId: workspace.tabs.find((tab) => tab.windowId === window.id)!.id,
          windowId: available.id,
        }),
      { code: 'conflict' },
    );
  }
});

test('settings updates merge each section and reject fields in the wrong section', () => {
  const original = empty();
  const workspace = command(original, {
    type: 'settings.update',
    settings: { workspace: { uiScale: 1.5 }, browser: { searchEngine: 'bing' } },
  }).workspace;
  assert.equal(workspace.settings.workspace.uiScale, 1.5);
  assert.equal(workspace.settings.workspace.avSync, false);
  assert.equal(workspace.settings.browser.searchEngine, 'bing');
  assert.equal(workspace.settings.browser.memorySaverEnabled, true);
  assert.equal(original.settings.browser.searchEngine, 'google');
  assert.throws(() =>
    command(original, {
      type: 'settings.update',
      settings: { workspace: { searchEngine: 'bing' } },
    } as unknown as ProductAction),
  );
});

test('favorites normalize URLs and update existing titles', () => {
  let workspace = command(empty(), {
    type: 'favorite.add',
    url: 'https://example.com/?token=private&utm_source=tracker#fragment',
    title: 'First',
  }).workspace;
  workspace = command(workspace, {
    type: 'favorite.add',
    url: 'https://example.com/',
    title: 'Latest',
  }).workspace;
  assert.equal(workspace.favorites.length, 1);
  assert.equal(workspace.favorites[0].title, 'Latest');
  assert.equal(workspace.favorites[0].url, 'https://example.com/');
  for (const url of ['about:blank', 'invalid', 'https://user:password@example.com/'])
    assert.throws(() => command(workspace, { type: 'favorite.add', url, title: 'Invalid' }), {
      code: 'invalid_request',
    });
  workspace = command(workspace, { type: 'favorite.remove', id: workspace.favorites[0].id }).workspace;
  assert.deepEqual(workspace.favorites, []);
});

test('web App popups split beside the opener and new tabs move to the recent browser', async () => {
  let workspace = command(empty(), {
    type: 'app.install',
    name: 'Mail',
    startUrl: 'https://example.com/mail/',
  }).workspace;
  const appId = 'web:' + workspace.apps[0].id;
  workspace = open(open(workspace), appId);
  const browser = workspace.windows[0];
  const opener = workspace.tabs.find((tab) => tab.windowId === workspace.windows[1].id)!;
  const popupService = new Popups(
    {
      clock: { wallMs: () => sequence * 1000 },
      store: {
        transaction: (operation: () => void) => operation(),
        operations: { popupTabId: () => null, savePopupWorkspace: () => {} },
        workspaces: { viewId: () => String(++sequence) },
      },
    } as unknown as ConstructorParameters<typeof Popups>[0],
    {
      workspace: { recordAction: () => {} },
      operations: { saveWorkspace: () => {} },
      viewers: { push: () => {} },
    } as unknown as ConstructorParameters<typeof Popups>[1],
  );
  const popup = (provisionalId: string, disposition: number) => ({
    provisionalId,
    disposition,
    openerViewId: opener.webviewId,
    status: 'pending',
    userGesture: true,
    url: 'https://example.com/child',
  });
  await popupService.observePopups(workspace, { pendingPopups: [popup('popup', 5)] });
  const appSpace = workspace.spaces.find((space) => space.windowIds.includes(opener.windowId))!;
  const popupTab = workspace.tabs.find((tab) => tab.popup?.provisionalId === 'popup')!;
  assert.deepEqual(appSpace.windowIds, [opener.windowId, popupTab.windowId]);
  assert.equal(workspace.windows.find((window) => window.id === popupTab.windowId)!.appId, appId);
  await popupService.observePopups(workspace, { pendingPopups: [popup('tab', 4)] });
  const browserTab = workspace.tabs.find((tab) => tab.popup?.provisionalId === 'tab')!;
  assert.equal(browserTab.windowId, browser.id);
  assert.equal(browser.activeTabId, browserTab.id);
  assert.equal(
    workspace.activeSpaceId,
    workspace.spaces.find((space) => space.windowIds.includes(browser.id))!.id,
  );
  const previousCount = workspace.tabs.length;
  workspace.pendingAppUninstallId = workspace.apps[0].id;
  await popupService.observePopups(workspace, { pendingPopups: [popup('uninstalling', 5)] });
  assert.equal(workspace.tabs.length, previousCount);
  delete workspace.pendingAppUninstallId;
  workspace.pendingWindowCloseId = opener.windowId;
  await popupService.observePopups(workspace, { pendingPopups: [popup('closing', 5)] });
  assert.equal(workspace.tabs.length, previousCount);
});

test('cross-group placement targets either side, rejects full groups and detaches into a new group', () => {
  let workspace = open(open(open(open(empty(), 'files'), 'files'), 'files'), 'files');
  const [a, b, c, d] = workspace.windows;
  workspace = command(workspace, {
    type: 'window.place',
    windowId: b.id,
    placement: { mode: 'split', besideWindowId: a.id, side: 'left' },
  }).workspace;
  workspace = command(workspace, {
    type: 'window.place',
    windowId: c.id,
    placement: { mode: 'split', besideWindowId: a.id, side: 'right' },
  }).workspace;
  assert.deepEqual(workspace.spaces[0].windowIds, [b.id, a.id, c.id]);
  const before = structuredClone(workspace);
  assert.throws(
    () =>
      command(workspace, {
        type: 'window.place',
        windowId: d.id,
        placement: { mode: 'split', besideWindowId: a.id, side: 'right' },
      }),
    (error: any) => error.code === 'limit_exceeded',
  );
  assert.deepEqual(workspace, before);
  workspace = command(workspace, {
    type: 'window.place',
    windowId: a.id,
    placement: { mode: 'space' },
  }).workspace;
  assert.deepEqual(workspace.spaces[0].windowIds, [b.id, c.id]);
  assert.deepEqual(workspace.spaces[2].windowIds, [a.id]);
  assert.equal(workspace.activeSpaceId, workspace.spaces[2].id);
});

test('opening a replacement retains slot and weight, preserves the old window, and validates its target', () => {
  let workspace = open(empty());
  const first = workspace.windows[0];
  workspace = command(workspace, {
    type: 'window.open',
    appId: 'files',
    placement: { mode: 'split', besideWindowId: first.id, side: 'right' },
  }).workspace;
  const spaceId = workspace.activeSpaceId!;
  workspace = command(workspace, { type: 'space.layout', spaceId, weights: [1, 3] }).workspace;
  const replaced = structuredClone(workspace.windows[1]);
  workspace = command(workspace, {
    type: 'window.open',
    appId: 'browser',
    placement: { mode: 'replace', windowId: replaced.id },
  }).workspace;
  const newWindow = workspace.windows[2];
  assert.deepEqual(workspace.spaces[0].windowIds, [first.id, newWindow.id]);
  assert.deepEqual(workspace.spaces[0].weights, [0.25, 0.75]);
  assert.equal(workspace.activeSpaceId, spaceId);
  assert.equal(workspace.spaces[0].focusedWindowId, newWindow.id);
  assert.deepEqual(workspace.windows[1], replaced);
  assert.deepEqual(workspace.spaces[1].windowIds, [replaced.id]);
  assert.equal(workspace.spaces[1].lastActiveAt, replaced.lastActiveAt);
  const before = structuredClone(workspace);
  assert.throws(
    () =>
      command(workspace, {
        type: 'window.open',
        appId: 'files',
        placement: { mode: 'replace', windowId: 'missing' },
      }),
    { code: 'not_found' },
  );
  assert.deepEqual(workspace, before);
  workspace.pendingWindowCloseId = replaced.id;
  assert.throws(
    () =>
      command(workspace, {
        type: 'window.open',
        appId: 'files',
        placement: { mode: 'replace', windowId: replaced.id },
      }),
    { code: 'conflict' },
  );
});

test('navigation size errors keep their code through workspace commands', () => {
  const workspace = open(empty());
  const tabId = workspace.tabs[0].id;
  assert.throws(() => command(workspace, { type: 'tab.navigate', tabId, url: 'a'.repeat(8193) }), {
    code: 'limit_exceeded',
  });
  assert.throws(
    () =>
      command(workspace, {
        type: 'app.install',
        name: 'Oversize',
        startUrl: 'https://example.test/' + '中'.repeat(1000),
      }),
    { code: 'limit_exceeded' },
  );
});
