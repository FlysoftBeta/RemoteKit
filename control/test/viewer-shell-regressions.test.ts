import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import test, { afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { act, createElement, useRef, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import type { ProductState, ProductTab, ProductWindow, LauncherItem } from '../shared/product';
import type { ViewerSession } from '../client/viewer-session';
import type { Action } from '../client/app/product-dialogs';
import type { WorkspaceSnapshot } from '../client/control/workspace-session';
import type { OperationsSnapshot } from '../client/control/operations-store';

const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const name of [
  'window',
  'document',
  'navigator',
  'localStorage',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'DocumentFragment',
  'ShadowRoot',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'DOMRect',
  'getComputedStyle',
] as const)
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
Object.defineProperty(document.documentElement, 'requestFullscreen', {
  configurable: true,
  value: async () => {},
});
Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: async () => {} });
let dark = false;
const preference = new dom.window.EventTarget();
Object.defineProperty(preference, 'matches', { get: () => dark });
Object.defineProperty(window, 'matchMedia', { value: () => preference, configurable: true });

// Resolve real icons lazily so this UI test does not load the entire icon catalog.
const require = createRequire(import.meta.url);
const iconBarrel = require.resolve('@mui/icons-material');
const iconModule = new Module(iconBarrel);
iconModule.exports = new Proxy(
  { __esModule: true },
  {
    get: (exports, name) =>
      name === '__esModule' ? exports.__esModule : require('@mui/icons-material/' + String(name)).default,
  },
);
require.cache[iconBarrel] = iconModule;
const { RemoteKitError } = require('../shared/errors') as typeof import('../shared/errors');
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { ThemeProvider, createTheme } = require('@mui/material') as typeof import('@mui/material');
const { beginTabPointer, registerTabStrip, useTabDrag } =
  require('../client/app/tab-drag') as typeof import('../client/app/tab-drag');
const { TabStrip } = require('../client/app/tab-strip') as typeof import('../client/app/tab-strip');
const { useBrowserNavigation } =
  require('../client/app/browser-chrome') as typeof import('../client/app/browser-chrome');
const { enterWindowFullscreen, exitWindowFullscreen, currentWindowFullscreen } =
  require('../client/app/window-fullscreen') as typeof import('../client/app/window-fullscreen');
const { AnnouncementDialog } =
  require('../client/app/announcements') as typeof import('../client/app/announcements');
const { DiagnosticSettings } =
  require('../client/app/diagnostic-collection-view') as typeof import('../client/app/diagnostic-collection-view');
const { SiteSettingsBody } =
  require('../client/app/site-settings') as typeof import('../client/app/site-settings');
const { WindowDragProvider, useItemDrag, useWindowDrag, useDropTarget } =
  require('../client/app/window-drag') as typeof import('../client/app/window-drag');
const { SpaceSnapshots } =
  require('../client/app/space-snapshots') as typeof import('../client/app/space-snapshots');
const { ContextMenu } = require('../client/app/context-menu') as typeof import('../client/app/context-menu');
const { notices } = require('../client/failures') as typeof import('../client/failures');
const { useSystemControls } =
  require('../client/app/system-controls') as typeof import('../client/app/system-controls');
const { FloatingActions } =
  require('../client/app/floating-actions') as typeof import('../client/app/floating-actions');
const { FloatingDock } =
  require('../client/app/floating-dock') as typeof import('../client/app/floating-dock');
const { colorScheme, createViewerTheme, useViewerTheme } =
  require('../client/theme/theme') as typeof import('../client/theme/theme');
const { setUiScale } = require('../client/app/ui-scale') as typeof import('../client/app/ui-scale');
const { PageOverlay } = require('../client/app/page-overlay') as typeof import('../client/app/page-overlay');
const { waitForWorkspaceRevision } =
  require('../client/app/window-state') as typeof import('../client/app/window-state');

const theme = createTheme({
  components: {
    MuiDialog: { defaultProps: { transitionDuration: 0 } },
    MuiMenu: { defaultProps: { transitionDuration: 0 } },
  },
});
const roots = new Set<Root>();
const mount = () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  return {
    host,
    root,
    render: (node: ReactNode) => act(async () => root.render(createElement(ThemeProvider, { theme }, node))),
  };
};
afterEach(async () => {
  await act(async () => {
    pointer(window, 'pointercancel', 0);
    for (const root of roots) root.unmount();
    roots.clear();
    exitWindowFullscreen();
    notices.clear();
    setUiScale(1);
  });
  registerTabStrip('gesture', '', null);
  document.body.replaceChildren();
});
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function pointer(target: EventTarget, type: string, x: number, y = 20, pointerType = 'mouse') {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    clientX: x,
    clientY: y,
    pointerType,
    buttons: 1,
    button: 0,
    isPrimary: true,
  });
  target.dispatchEvent(event);
}
const rect = (left: number, width = 200) => new DOMRect(left, 0, width, 100);
function box(element: HTMLElement, left = 0, width = 200) {
  element.getBoundingClientRect = () => rect(left, width);
  Object.defineProperty(element, 'offsetWidth', { value: width, configurable: true });
}
function gestureFixture() {
  const strip = document.createElement('div');
  const tab = document.createElement('div');
  tab.className = 'window-tab';
  strip.append(tab);
  document.body.append(strip);
  box(strip);
  box(tab);
  registerTabStrip('gesture', 'browser', strip);
  const moves: unknown[] = [];
  const begin = (pointerType: string) =>
    beginTabPointer({
      event: {
        currentTarget: tab,
        target: tab,
        pointerId: 1,
        pointerType,
        button: 0,
        clientX: 10,
        clientY: 20,
      } as unknown as React.PointerEvent<HTMLElement>,
      tabId: 'gesture-tab',
      windowId: 'gesture',
      title: 'tab',
      index: 0,
      move: (...args) => moves.push(args),
      longPress: () => moves.push('menu'),
    });
  return { tab, strip, moves, begin };
}

test('tab gesture cancellation clears long press and global listeners', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = gestureFixture();
  const remove = t.mock.method(window, 'removeEventListener');
  const cancel = f.begin('touch');
  assert.equal(typeof cancel, 'function');
  cancel!();
  f.tab.remove();
  assert.doesNotThrow(() => t.mock.timers.tick(400));
  pointer(window, 'pointerup', 10);
  assert.deepEqual(f.moves, []);
  for (const type of ['pointermove', 'pointerup', 'pointercancel', 'touchmove', 'keydown', 'contextmenu'])
    assert.ok(
      remove.mock.calls.some((call) => call.arguments[0] === type),
      type,
    );
  registerTabStrip('gesture', '', null);
});

test('a disconnected long-press source cancels without reading detached layout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = gestureFixture();
  const remove = t.mock.method(window, 'removeEventListener');
  const cancel = f.begin('touch');
  f.tab.remove();
  assert.doesNotThrow(() => t.mock.timers.tick(400));
  assert.ok(remove.mock.calls.some((call) => call.arguments[0] === 'pointermove'));
  pointer(window, 'pointerup', 10);
  assert.deepEqual(f.moves, []);
  cancel?.();
  registerTabStrip('gesture', '', null);
});

for (const removal of ['tab', 'strip'] as const)
  test(`removing the ${removal} cancels an active tab drag`, async () => {
    const f = mount();
    const moves: unknown[] = [];
    function Probe() {
      const drag = useTabDrag();
      return createElement('output', null, drag?.tabId ?? 'idle');
    }
    const render = (items: string[], visible = true) =>
      f.render(
        createElement(
          'div',
          null,
          createElement(Probe),
          visible &&
            createElement(TabStrip, {
              windowId: 'source',
              group: 'browser',
              items: items.map((id) => ({ id, title: id, icon: null })),
              select() {},
              close() {},
              move: (...args) => moves.push(args),
              menu() {},
              create() {},
            }),
        ),
      );
    await render(['a', 'b']);
    const strip = f.host.querySelector<HTMLElement>('.tab-strip')!;
    box(strip);
    strip.style.columnGap = '0px';
    const tab = f.host.querySelector<HTMLElement>('.window-tab')!;
    box(tab);
    await act(async () => {
      pointer(tab, 'pointerdown', 10);
      pointer(window, 'pointermove', 180);
    });
    assert.equal(f.host.querySelector('output')!.textContent, 'a');
    await render(removal === 'tab' ? ['b'] : ['a', 'b'], removal !== 'strip');
    assert.equal(f.host.querySelector('output')!.textContent, 'idle');
    await act(async () => pointer(window, 'pointerup', 180));
    assert.deepEqual(moves, []);
  });

const tabA = { id: 'a', windowId: 'w', kind: 'remote', url: 'https://a.test', title: 'A' } as ProductTab;
const tabB = { ...tabA, id: 'b', url: 'https://b.test', title: 'B' };
const win = { id: 'w', appId: 'browser' } as ProductWindow;
function stateFor(tabs = [tabA, tabB]): ProductState {
  return {
    workspace: {
      tabs,
      windows: [win],
      favorites: [],
      apps: [],
      sites: {},
      spaces: [{ name: null, id: 'space', windowIds: ['w'], weights: [1] }],
      activeSpaceId: 'space',
      settings: { workspace: { audioChannels: { left: true, right: true } } },
    },
    integrations: {},
  } as unknown as ProductState;
}
async function navigationFixture() {
  const f = mount();
  const calls: ReturnType<typeof deferred<any>>[] = [];
  let navigation!: ReturnType<typeof useBrowserNavigation>;
  const action: Action = () => {
    const call = deferred<any>();
    calls.push(call);
    return call.promise;
  };
  function Probe({ active, state }: { active?: ProductTab; state: ProductState }) {
    navigation = useBrowserNavigation({
      win,
      state,
      active,
      focused: true,
      fullscreen: false,
      online: true,
      navigationReady: true,
      action,
      report() {},
    });
    return createElement('input', { ref: navigation.input });
  }
  const render = (active: ProductTab | undefined, state = stateFor()) =>
    f.render(createElement(Probe, { active, state }));
  await render(tabA);
  return {
    ...f,
    calls,
    render,
    get navigation() {
      return navigation;
    },
  };
}

test('a failed navigation restores only its source tab draft', async () => {
  const f = await navigationFixture();
  let submitted!: Promise<unknown>;
  await act(async () => {
    submitted = f.navigation.submit('https://draft.test').catch(() => {});
  });
  await f.render(tabB);
  await act(async () => {
    f.calls[0].reject(new Error('failed'));
    await submitted;
  });
  const updatedB = { ...tabB, url: 'https://b.test/new' };
  await f.render(updatedB, stateFor([tabA, updatedB]));
  assert.equal(f.navigation.address, updatedB.url);
  await f.render(tabA);
  assert.equal(f.navigation.address, 'https://draft.test');
});

test('address drafts survive tab switches and disappear when a tab closes', async () => {
  const f = await navigationFixture();
  await act(async () => f.navigation.setAddress('draft A'));
  await f.render(tabB);
  await act(async () => f.navigation.setAddress('draft B'));
  await f.render(tabA);
  assert.equal(f.navigation.address, 'draft A');
  await f.render(tabB, stateFor([tabB]));
  assert.equal(f.navigation.address, 'draft B');
  await f.render(tabA);
  assert.equal(f.navigation.address, tabA.url);
});

test('overlapping navigation operations keep busy until the last completion', async () => {
  const f = await navigationFixture();
  await act(async () => {
    f.navigation.run({ type: 'tab.activate', tabId: 'a' });
    f.navigation.run({ type: 'tab.activate', tabId: 'b' });
  });
  await act(async () => f.calls[0].resolve({}));
  assert.equal(f.navigation.busy, true);
  await act(async () => f.calls[1].resolve({}));
  assert.equal(f.navigation.busy, false);
});

test('late navigation success does not blur the selected tab input', async () => {
  const f = await navigationFixture();
  let submitted!: Promise<unknown>;
  await act(async () => {
    submitted = f.navigation.submit('https://next.test');
  });
  await f.render(tabB);
  const input = f.host.querySelector('input')!;
  input.focus();
  await act(async () => {
    f.calls[0].resolve({});
    await submitted;
  });
  assert.equal(document.activeElement, input);
});

test('exiting a pending fullscreen request revokes its late success', async (t) => {
  const requested = deferred();
  t.mock.method(document.documentElement, 'requestFullscreen', () => requested.promise);
  let full: Element | null = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  const exit = t.mock.method(document, 'exitFullscreen', async () => {
    full = null;
  });
  enterWindowFullscreen('w');
  exitWindowFullscreen();
  full = document.documentElement;
  requested.resolve();
  await requested.promise;
  await Promise.resolve();
  assert.equal(exit.mock.callCount(), 1);
  assert.equal(currentWindowFullscreen(), null);
});

test('dismissal completions remove only their own announcement from the pending set', async () => {
  const f = mount();
  const a = deferred(),
    b = deferred();
  const items = [
    { id: 'b', title: 'B', body: 'body B', publishedAt: 2, read: false },
    { id: 'a', title: 'A', body: 'body A', publishedAt: 1, read: false },
  ];
  const calls: string[] = [];
  const render = () =>
    f.render(
      createElement(AnnouncementDialog, {
        announcements: [...items],
        read: (id) => {
          calls.push(id);
          return id === 'a' ? a.promise : b.promise;
        },
      }),
    );
  await render();
  await act(async () =>
    (document.querySelector('.MuiDialogActions-root button') as HTMLButtonElement).click(),
  );
  assert.equal(document.querySelector('.MuiDialogTitle-root')?.textContent, 'A');
  items.reverse();
  await render();
  assert.equal(document.querySelector('.MuiDialogTitle-root')?.textContent, 'B');
  await act(async () =>
    (document.querySelector('.MuiDialogActions-root button') as HTMLButtonElement).click(),
  );
  assert.equal(document.querySelector('.MuiDialogTitle-root')?.textContent, 'B');
  await act(async () => a.resolve());
  await render();
  assert.equal(document.querySelector('.MuiDialogTitle-root')?.textContent, 'B');
  await act(async () =>
    (document.querySelector('.MuiDialogActions-root button') as HTMLButtonElement).click(),
  );
  assert.deepEqual(calls, ['a', 'b']);
  await act(async () => b.resolve());
  assert.equal(document.querySelector('.MuiDialogTitle-root')?.textContent ?? null, null);
});

test('diagnostic start-error leaves the start button available for another attempt', async () => {
  const f = mount();
  let starts = 0;
  await f.render(
    createElement(DiagnosticSettings, {
      state: { phase: 'start-error', error: new RemoteKitError('internal', 'failed') },
      online: true,
      start: () => starts++,
    }),
  );
  const button = f.host.querySelector('button')!;
  assert.equal(button.disabled, false);
  await act(async () => button.click());
  assert.equal(starts, 1);
});

test('site permissions use the scaled menu anchor and current setting action', async () => {
  const f = mount();
  const commands: unknown[] = [];
  await act(async () => setUiScale(2));
  await f.render(
    createElement(SiteSettingsBody, {
      origin: 'https://a.test',
      state: stateFor(),
      online: true,
      action: async (command) => {
        commands.push(command);
        return {} as never;
      },
    }),
  );
  const combo = f.host.querySelector<HTMLElement>('[role="combobox"]')!;
  assert.equal(combo.tagName, 'INPUT');
  box(combo.closest('.MuiTextField-root') as HTMLElement, 100, 200);
  await act(async () => combo.click());
  const menu = document.querySelector('[role="menu"]')!;
  const paper = menu.closest<HTMLElement>('.MuiMenu-paper')!;
  assert.equal(paper.style.left, '50px');
  await act(async () =>
    ([...menu.querySelectorAll('li')].find((item) => item.textContent === '允许') as HTMLElement).click(),
  );
  assert.deepEqual(commands[0], {
    type: 'site.permission',
    origin: 'https://a.test',
    permission: 'geolocation',
    setting: 'allow',
  });
});

async function windowDragFixture() {
  const f = mount();
  const sourceWindow = { ...win, id: 'source' };
  const targetWindow = { ...win, id: 'target' };
  let state = stateFor();
  state.workspace.windows = [sourceWindow, targetWindow];
  state.workspace.spaces = [
    { name: null, id: 'space', windowIds: ['source', 'target'], weights: [0.5, 0.5] } as never,
  ];
  const calls: { owner: string; value: unknown }[] = [];
  let owner = 'old';
  const snapshots = new SpaceSnapshots();
  const item = { kind: 'app', appId: 'browser', title: 'Browser' } as LauncherItem;
  function Targets({ ids }: { ids: string[] }) {
    const stage = useDropTarget('stage', undefined);
    const beginWindow = useWindowDrag();
    const beginItem = useItemDrag();
    return createElement(
      'div',
      {
        'data-stage': true,
        ref: (element: HTMLDivElement | null) => {
          if (element) box(element, 0, 600);
          stage.ref(element);
        },
        style: { overflow: 'visible' },
      },
      createElement(
        'button',
        {
          'data-start-item': true,
          onPointerDown: (event: React.PointerEvent<HTMLElement>) => beginItem(event, item),
        },
        'item',
      ),
      createElement(
        'button',
        {
          'data-start-window': true,
          onPointerDown: (event: React.PointerEvent<HTMLElement>) =>
            beginWindow(event, { windowId: 'source' }),
        },
        'window',
      ),
      ...ids.map((id, index) =>
        createElement(TargetWindow, {
          key: id,
          id,
          left: (index * 600) / ids.length,
          width: 600 / ids.length,
        }),
      ),
    );
  }
  function TargetWindow({ id, left, width }: { id: string; left: number; width: number }) {
    const target = useDropTarget('window', id);
    return createElement('div', {
      'data-target': id,
      style: { overflow: 'visible' },
      ref: (element: HTMLDivElement | null) => {
        if (element) box(element, left, width);
        target.ref(element);
      },
    });
  }
  const render = async () => {
    const capturedOwner = owner;
    await f.render(
      createElement(WindowDragProvider, {
        state,
        snapshots,
        action: async (value) => {
          calls.push({ owner: capturedOwner, value });
          return {} as never;
        },
        report(error) {
          throw error;
        },
        openItem: async (_item, value) => {
          calls.push({ owner: capturedOwner, value });
        },
        children: createElement(Targets, {
          ids: state.workspace.spaces.find((space) => space.id === state.workspace.activeSpaceId)!.windowIds,
        }),
      }),
    );
  };
  await render();
  return {
    ...f,
    calls,
    render,
    setState: (next: ProductState) => {
      state = next;
    },
    get state() {
      return state;
    },
    setOwner: (next: string) => {
      owner = next;
    },
  };
}

test('window drag drop recalculates placement from the current active group', async () => {
  const f = await windowDragFixture();
  await act(async () => pointer(f.host.querySelector('[data-start-item]')!, 'pointerdown', 450));
  const next = structuredClone(f.state);
  next.workspace.windows.push({ ...win, id: 'new-target' });
  next.workspace.spaces = [
    { name: null, id: 'other', windowIds: ['new-target', 'target'], weights: [0.5, 0.5] } as never,
  ];
  next.workspace.activeSpaceId = 'other';
  f.setState(next);
  await f.render();
  await act(async () => {
    pointer(window, 'pointermove', 10);
    pointer(window, 'pointerup', 10);
  });
  assert.deepEqual(f.calls, [
    { owner: 'old', value: { mode: 'split', besideWindowId: 'new-target', side: 'left' } },
  ]);
});

test('window drag uses the current openItem callback on drop', async () => {
  const f = await windowDragFixture();
  await act(async () => pointer(f.host.querySelector('[data-start-item]')!, 'pointerdown', 450));
  f.setOwner('new');
  await f.render();
  await act(async () => pointer(window, 'pointerup', 450));
  assert.deepEqual(f.calls, [{ owner: 'new', value: { mode: 'replace', windowId: 'target' } }]);
});

for (const missing of ['source', 'target'] as const)
  for (const event of ['pointermove', 'pointerup'])
    test(`window drag cancels when ${missing} disappears before ${event}`, async () => {
      const f = await windowDragFixture();
      await act(async () => {
        pointer(f.host.querySelector('[data-start-window]')!, 'pointerdown', 10);
        pointer(window, 'pointermove', 450);
      });
      assert.ok(document.querySelector('.window-drag-ghost'));
      const next = structuredClone(f.state);
      next.workspace.windows = next.workspace.windows.filter((window) => window.id !== missing);
      next.workspace.spaces[0].windowIds = next.workspace.spaces[0].windowIds.filter((id) => id !== missing);
      next.workspace.spaces[0].weights = [1];
      f.setState(next);
      await f.render();
      await act(async () => pointer(window, event, 450));
      assert.equal(!!document.querySelector('.window-drag-ghost'), false);
      await act(async () => pointer(window, 'pointerup', 450));
      assert.deepEqual(f.calls, []);
    });

test('a context menu product failure is presented after its menu unmounts', async () => {
  const f = mount();
  const request = deferred<any>();
  const surface = {
    id: 'view',
    session: 'session',
    instance: 'instance',
    document: 'doc',
    focus: 'focus',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    deviceScaleFactor: 1,
  };
  let closed = 0;
  const transport = {
    operations: { action: () => request.promise },
    input: { ensureInputFocus() {}, sendInput() {} },
    editing: { getSnapshot: () => ({}) },
    presentation: { layout: { views: [surface] } },
  } as unknown as ViewerSession;
  box(f.host);
  await f.render(
    createElement(ContextMenu, {
      menu: {
        id: 'menu',
        x: 10,
        y: 10,
        source: 'mouse',
        link: { url: 'https://example.test', text: 'Example' },
      } as never,
      surface,
      geometry: { width: 200, height: 100, canvas: { left: 0, top: 0, width: 200, height: 100 } },
      viewport: { current: f.host },
      editor: { current: null },
      transport,
      tab: tabA,
      engine: 'google',
      onClosed: () => closed++,
    }),
  );
  await act(async () => (document.querySelector('[role="menuitem"]') as HTMLElement).click());
  assert.equal(closed, 1);
  await f.render(null);
  await act(async () =>
    request.reject(new RemoteKitError('internal', 'failed', { errorId: 'c-1111111111' })),
  );
  const notice = notices.getSnapshot().find((notice) => notice.key === 'context-menu:w');
  assert.equal(notice?.presentation.errorId, 'c-1111111111');
});

test('system fullscreen failures reach the global presentation owner', async (t) => {
  const f = mount();
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: async () => {},
  });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: async () => {} });
  const request = deferred();
  t.mock.method(document.documentElement, 'requestFullscreen', () => request.promise);
  const authorization = { browserReady: true };
  const media = {
    authorization: { getSnapshot: () => authorization, subscribe: () => () => {}, setAuthCamera() {} },
    workspace: { shellReady: true, request: async () => {}, lock() {}, departureObserved() {} },
    observations: { audio: { state: 'playing' } },
    control: { request: async () => {} },
    operations: { dismissUnknown() {} },
  } as unknown as ViewerSession;
  const floating = new FloatingActions();
  let controls!: ReturnType<typeof useSystemControls>;
  function Probe() {
    controls = useSystemControls({
      media,
      workspaceState: { auth: null, status: 'online' } as unknown as WorkspaceSnapshot,
      operationState: { state: stateFor(), pending: [] } as unknown as OperationsSnapshot,
      action: async () => ({}) as never,
      showShell: true,
      floatingActions: floating,
    });
    return null;
  }
  await f.render(createElement(Probe));
  await act(async () => controls.browserFullscreen.toggle());
  await act(async () =>
    request.reject(new RemoteKitError('internal', 'failed', { errorId: 'c-2222222222' })),
  );
  assert.equal(
    notices.getSnapshot().find((notice) => notice.key === 'fullscreen:operation')?.presentation.errorId,
    'c-2222222222',
  );
  assert.equal('controlFailure' in controls, false);
});

test('system page fullscreen failures reach the global presentation owner', async () => {
  const f = mount();
  const request = deferred<any>();
  const authorization = { browserReady: true };
  const media = {
    authorization: { getSnapshot: () => authorization, subscribe: () => () => {}, setAuthCamera() {} },
    workspace: { shellReady: true, request: async () => {}, lock() {}, departureObserved() {} },
    observations: { audio: { state: 'playing' } },
    control: { request: async () => {} },
    operations: { dismissUnknown() {} },
  } as unknown as ViewerSession;
  const floating = new FloatingActions();
  const state = stateFor();
  state.pageFullscreen = { windowId: 'w', target: 'page' } as never;
  function Probe() {
    useSystemControls({
      media,
      workspaceState: { auth: null, status: 'online' } as unknown as WorkspaceSnapshot,
      operationState: { state, pending: [] } as unknown as OperationsSnapshot,
      action: () => request.promise,
      showShell: true,
      floatingActions: floating,
    });
    return null;
  }
  await f.render(createElement(Probe));
  await act(async () =>
    floating
      .getSnapshot()
      .find((entry) => entry.id === 'fullscreen')!
      .run(),
  );
  await act(async () =>
    request.reject(new RemoteKitError('internal', 'failed', { errorId: 'c-3333333333' })),
  );
  assert.equal(
    notices.getSnapshot().find((notice) => notice.key === 'fullscreen:operation')?.presentation.errorId,
    'c-3333333333',
  );
});

test('a floating button withdrawn or disabled mid-drag is visible again afterwards', async () => {
  const f = mount();
  const floating = new FloatingActions();
  const action = {
    id: 'start',
    order: 0,
    anchor: 'bottom-left',
    label: '开始',
    icon: 'start',
    run() {},
  } as const;
  floating.set('start', action);
  await f.render(createElement(FloatingDock, { actions: floating }));
  const button = () => f.host.querySelector<HTMLElement>('.dock-button:not(.dock-ghost)')!;
  const startDrag = async () => {
    box(f.host.querySelector<HTMLElement>('.floating-dock')!);
    button().setPointerCapture = () => {};
    await act(async () => {
      for (const [type, x] of [
        ['pointerdown', 10],
        ['pointermove', 80],
      ] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: 1, clientX: x, clientY: 20, isPrimary: true, button: 0 });
        button().dispatchEvent(event);
      }
    });
    assert.equal(button().style.visibility, 'hidden');
    assert.ok(f.host.querySelector('.dock-ghost'));
  };
  await startDrag();
  await act(async () => floating.set('start', undefined));
  await act(async () => floating.set('start', action));
  assert.equal(button().style.visibility, '');
  assert.equal(f.host.querySelector('.dock-ghost'), null);

  await startDrag();
  await act(async () => floating.set('start', { ...action, disabled: true }));
  await act(async () => floating.set('start', action));
  assert.equal(button().style.visibility, '');
  assert.equal(f.host.querySelector('.dock-ghost'), null);
});

test('the Start button is withdrawn only while a fullscreen exit control replaces it', async () => {
  const f = mount();
  const authorization = { browserReady: false };
  const media = {
    authorization: { getSnapshot: () => authorization, subscribe: () => () => {}, setAuthCamera() {} },
    workspace: { shellReady: true, request: async () => {}, lock() {}, departureObserved() {} },
    observations: { audio: { state: 'playing' } },
    control: { request: async () => {} },
    operations: { dismissUnknown() {} },
  } as unknown as ViewerSession;
  const floating = new FloatingActions();
  const state = stateFor();
  state.pageFullscreen = { windowId: 'w', target: 'page' } as never;
  let controls!: ReturnType<typeof useSystemControls>;
  function Probe() {
    controls = useSystemControls({
      media,
      workspaceState: { auth: null, status: 'online' } as unknown as WorkspaceSnapshot,
      operationState: { state, pending: [] } as unknown as OperationsSnapshot,
      action: async () => ({}) as never,
      showShell: true,
      floatingActions: floating,
    });
    return null;
  }
  // The page's fullscreen projection is ignored while its Browser is not ready: no exit control,
  // so nothing may take the Start button's place.
  await f.render(createElement(Probe));
  assert.equal(
    floating.getSnapshot().some((entry) => entry.id === 'fullscreen'),
    false,
  );
  assert.equal(controls.fullscreen, undefined);
  assert.match(source('app/overlay-host.tsx'), /'start',\s+controls\.fullscreen\s+\? null/);
});

test('color preference updates the subscribed MUI palette and rereads current tokens', async () => {
  const f = mount();
  const setTokens = (primary: string) => {
    for (const [key, value] of Object.entries({
      primary,
      'surface-background': '#eee',
      surface: '#fff',
      'text-primary': '#123',
      'text-secondary': '#456',
      border: '#ccc',
      'font-family': 'sans-serif',
      'radius-md': '8px',
    }))
      document.documentElement.style.setProperty('--' + key, value);
  };
  setTokens('#245db5');
  let current!: ReturnType<typeof createViewerTheme>;
  function Probe() {
    current = useViewerTheme();
    return null;
  }
  await f.render(createElement(Probe));
  assert.equal(current.palette.mode, 'light');
  assert.equal(current.palette.primary.main, '#245db5');
  await act(async () => {
    dark = true;
    setTokens('#90baff');
    preference.dispatchEvent(new Event('change'));
  });
  assert.equal(colorScheme.getSnapshot(), 'dark');
  assert.equal(current.palette.mode, 'dark');
  assert.equal(current.palette.primary.main, '#90baff');
  assert.equal(createViewerTheme().palette.mode, 'dark');
  await act(async () => {
    dark = false;
    preference.dispatchEvent(new Event('change'));
  });
});

const source = (path: string) => readFileSync(new URL('../client/' + path, import.meta.url), 'utf8');
test('accent foreground and panel decoration use semantic theme tokens', () => {
  assert.match(source('theme/tokens.css'), /--on-accent:\s*#fff;/);
  for (const path of ['app/launcher.css', 'app/floating-dock.css'])
    assert.match(source(path), /color: var\(--on-accent\)/);
  assert.match(source('app/session-import.css'), /border-left: 2px solid var\(--border-neutral\)/);
  assert.match(
    source('app/floating-panel.tsx'),
    /boxShadow: '0 12px 32px var\(--shadow-dock\), 0 0 0 1px var\(--border-notice\)'/,
  );
});

test('progress overlays have no error or action branch and unused hints stay deleted', async () => {
  const f = mount();
  await f.render(createElement(PageOverlay, { kind: 'progress', children: 'Waiting' }));
  assert.equal(f.host.querySelector('[role="status"]')?.textContent, 'Waiting');
  assert.ok(f.host.querySelector('[role="progressbar"]'));
  assert.doesNotMatch(source('app/page-overlay.tsx'), /ErrorOutline|action\??:|kind ===/);
  assert.doesNotMatch(source('app/stage.tsx'), /rtcPhase|useViewerSessionSelector/);
  assert.doesNotMatch(source('app/remote-viewport.css'), /\.input-notice\s*\{/);
  assert.doesNotMatch(source('app/start-page.css'), /\.start-page-error\s*\{/);
});

test('waiting for a workspace revision subscribes without creating an unused abort controller', async (t) => {
  let revision = 1;
  let listener!: () => void;
  let removed = 0;
  const media = {
    operations: {
      getSnapshot: () => ({ authoritative: { workspace: { revision } } }),
      subscribe: (next: () => void) => {
        listener = next;
        return () => removed++;
      },
    },
  } as unknown as ViewerSession;
  const controller = t.mock.fn();
  const NativeAbortController = globalThis.AbortController;
  t.mock.method(
    globalThis,
    'AbortController',
    class extends NativeAbortController {
      constructor() {
        super();
        controller();
      }
    },
  );
  const waiting = waitForWorkspaceRevision(media, 2);
  revision = 2;
  listener();
  assert.equal((await waiting).revision, 2);
  assert.equal(removed, 1);
  assert.equal(controller.mock.callCount(), 0);
});

const { WindowHandle } =
  require('../client/app/window-handle') as typeof import('../client/app/window-handle');
const { LockScreen } = require('../client/auth/lock-screen') as typeof import('../client/auth/lock-screen');
const { setCompatibility, getSnapshot: deviceSnapshot } =
  require('../client/app/device-preferences') as typeof import('../client/app/device-preferences');

for (const pointerType of ['mouse', 'touch'])
  test(`handle opens immediately and captures a second ${pointerType} press on the backdrop`, async () => {
    const f = mount();
    const calls: unknown[] = [];
    await f.render(
      createElement(WindowHandle, {
        win,
        state: stateFor(),
        online: true,
        action: async (command) => {
          calls.push(command);
          return {} as never;
        },
        report: assert.fail,
      }),
    );
    const handle = f.host.querySelector('button')!;
    box(handle, 100, 28);
    await act(async () => handle.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    assert.ok(document.querySelector('[role="menu"]'), 'menu opens in the same turn');
    const backdrop = document.querySelector('.MuiBackdrop-root')!;
    let leaked = 0;
    backdrop.addEventListener('pointerdown', () => leaked++);
    backdrop.addEventListener('click', () => leaked++);
    await act(async () => {
      pointer(backdrop, 'pointerdown', 95, 20, pointerType);
      pointer(backdrop, 'pointerup', 95, 20, pointerType);
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
    });
    assert.deepEqual(calls, [{ type: 'window.close', windowId: win.id }]);
    assert.equal(leaked, 0);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(!!document.querySelector('[role="menu"]'), false);
  });
test('keyboard activation has no double press capture; outlying and expired presses propagate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { useHandleActivation } =
    require('../client/app/handle-activation') as typeof import('../client/app/handle-activation');
  const f = mount();
  let menus = 0,
    doubles = 0,
    down = 0;
  function Probe() {
    const activation = useHandleActivation({ onMenu: () => menus++, onDouble: () => doubles++ });
    return createElement('button', { ...activation.buttonProps, onPointerDown: () => down++ });
  }
  await f.render(createElement(Probe));
  const button = f.host.querySelector('button')!;
  box(button, 100, 28);
  await act(async () => button.click());
  await act(async () => pointer(button, 'pointerdown', 110));
  assert.equal(down, 1);
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  await act(async () => pointer(button, 'pointerdown', 300));
  await act(async () => pointer(button, 'pointerdown', 110));
  assert.equal(down, 3);
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  t.mock.timers.tick(251);
  await act(async () => pointer(button, 'pointerdown', 110));
  assert.equal(down, 4);
  assert.equal(menus, 3);
  assert.equal(doubles, 0);
});
test('lock blank taps start one face attempt and the fifth tap reveals the form with that attempt', async () => {
  const f = mount();
  const started = deferred<void>();
  let starts = 0;
  const camera = {
    explicit: 'verify',
    start: () => {
      starts++;
      return started.promise;
    },
    cancel() {},
  } as unknown as import('../client/auth/auth-camera').AuthCamera;
  const auth = {
    locked: true,
    methods: { face: true },
    face: { available: true },
  } as import('../shared/security').AuthState;
  await f.render(
    createElement(LockScreen, {
      auth,
      camera,
      children: (_close, face) => createElement('div', { 'data-unlock-form': true }, face.phase),
    }),
  );
  const tap = async () =>
    act(async () => {
      const blank = f.host.querySelector('.viewer-lock-blank')!;
      pointer(blank, 'pointerdown', 100);
      pointer(blank, 'pointerup', 100);
      blank.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
  for (let index = 0; index < 4; index++) await tap();
  assert.equal(starts, 1);
  assert.equal(f.host.querySelector('[data-unlock-form]'), null);
  await tap();
  assert.ok(f.host.querySelector('[data-unlock-form]'));
  assert.equal(starts, 1);
  await act(async () => started.resolve());
});
test('device preferences reject invalid formats, persist compatibility and tolerate storage failures', (t) => {
  for (const value of [
    null,
    {},
    { v: 2, compatibility: false },
    { v: 1, compatibility: 'false' },
    { v: 1, compatibility: false, extra: true },
  ]) {
    localStorage.setItem('remotekit.device.preferences', JSON.stringify(value));
    window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'remotekit.device.preferences' }));
    assert.equal(deviceSnapshot().compatibility, true);
  }
  setCompatibility(false);
  assert.deepEqual(JSON.parse(localStorage.getItem('remotekit.device.preferences')!), {
    v: 1,
    compatibility: false,
  });
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem', () => {
    throw new Error('blocked');
  });
  assert.doesNotThrow(() => setCompatibility(true));
  assert.equal(deviceSnapshot().compatibility, true);
  setItem.mock.restore();
});

test('Start group menu keeps its name dialog mounted after closing the menu', async () => {
  const { LauncherSpaces } =
    require('../client/app/launcher-spaces') as typeof import('../client/app/launcher-spaces');
  const f = mount();
  const state = stateFor();
  state.workspace.spaces[0].name = '工作';
  const calls: unknown[] = [];
  await f.render(
    createElement(LauncherSpaces, {
      state,
      snapshots: new SpaceSnapshots(),
      online: true,
      newTarget: false,
      targetNew() {},
      close() {},
      report: assert.fail,
      action: async (command) => {
        calls.push(command);
        return {} as never;
      },
    }),
  );
  const card = f.host.querySelector('[data-space-card]')!;
  await act(async () =>
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  const rename = [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === '命名…',
  ) as HTMLElement;
  await act(async () => rename.click());
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  assert.equal(input.value, '工作');
  await act(async () =>
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  assert.deepEqual(calls, [{ type: 'space.rename', spaceId: 'space', name: '工作' }]);
});
test('five separate Enter presses reveal the unlock form', async () => {
  const { RevealScreen } =
    require('../client/auth/lock-screen') as typeof import('../client/auth/lock-screen');
  const f = mount();
  await f.render(
    createElement(RevealScreen, { children: () => createElement('div', { 'data-keyboard-form': true }) }),
  );
  for (let index = 0; index < 4; index++)
    await act(async () =>
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
  assert.equal(f.host.querySelector('[data-keyboard-form]'), null);
  await act(async () =>
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  assert.ok(f.host.querySelector('[data-keyboard-form]'));
});
test('reduced motion sets the root, removes MUI durations and disables ripple', () => {
  const { setReduceMotion } =
    require('../client/app/motion-preference') as typeof import('../client/app/motion-preference');
  const { createViewerTheme } = require('../client/theme/theme') as typeof import('../client/theme/theme');
  setReduceMotion(true);
  assert.ok(document.documentElement.hasAttribute('data-reduce-motion'));
  for (const [key, value] of Object.entries({
    primary: '#245db5',
    'surface-background': '#eee',
    surface: '#fff',
    'text-primary': '#123',
    'text-secondary': '#456',
    border: '#ccc',
    'font-family': 'sans-serif',
    'radius-md': '8px',
  }))
    document.documentElement.style.setProperty('--' + key, value);
  const reduced = createViewerTheme('light', true);
  assert.ok(Object.values(reduced.transitions.duration).every((duration) => duration === 0));
  assert.equal(reduced.components?.MuiButtonBase?.defaultProps?.disableRipple, true);
  assert.equal(reduced.components?.MuiDialog?.defaultProps?.transitionDuration, 0);
  setReduceMotion(false);
  assert.equal(document.documentElement.hasAttribute('data-reduce-motion'), false);
});

test('compatibility top inset keeps the safe area and reserves 24px only when enabled', () => {
  const { topInsetHeight } = require('../client/app/top-inset') as typeof import('../client/app/top-inset');
  assert.equal(topInsetHeight(true, { safeArea: 0 }), 24);
  assert.equal(topInsetHeight(false, { safeArea: 0 }), 0);
  assert.equal(topInsetHeight(true, { safeArea: 36 }), 36);
  assert.equal(topInsetHeight(false, { safeArea: 36 }), 36);
});

test('drag source and replacement decoration update without rendering workspace children', async () => {
  const { useDropRegistration, WindowDragDecoration } =
    require('../client/app/window-drag') as typeof import('../client/app/window-drag');
  const f = mount();
  let renders = 0;
  function Workspace() {
    renders++;
    const stage = useDropRegistration('stage', undefined);
    const target = useDropRegistration('window', 'w');
    const frame = useRef<HTMLElement | null>(null);
    const windowDrag = useWindowDrag();
    const itemDrag = useItemDrag();
    return createElement(
      'div',
      {
        ref: (element: HTMLDivElement | null) => {
          if (element) box(element, 0, 600);
          stage.ref(element);
        },
        style: { overflow: 'visible' },
      },
      createElement('button', {
        'data-source-handle': true,
        onPointerDown: (event: React.PointerEvent<HTMLElement>) => windowDrag(event, { windowId: 'w' }),
      }),
      createElement('button', {
        'data-source-item': true,
        onPointerDown: (event: React.PointerEvent<HTMLElement>) =>
          itemDrag(event, { kind: 'app', appId: 'files', title: 'Files' } as LauncherItem),
      }),
      createElement(
        'section',
        {
          className: 'window-frame',
          ref: (element: HTMLElement | null) => {
            frame.current = element;
            if (element) box(element, 0, 600);
            target.ref(element);
          },
          style: { overflow: 'visible' },
        },
        createElement(WindowDragDecoration, { windowId: 'w', frame }),
      ),
    );
  }
  await f.render(
    createElement(WindowDragProvider, {
      state: stateFor(),
      snapshots: new SpaceSnapshots(),
      action: async () => ({}) as never,
      report: assert.fail,
      openItem: async () => {},
      children: createElement(Workspace),
    }),
  );
  const initialRenders = renders;
  await act(async () => {
    pointer(f.host.querySelector('[data-source-handle]')!, 'pointerdown', 10);
    pointer(window, 'pointermove', 300);
  });
  assert.equal(renders, initialRenders);
  assert.ok(f.host.querySelector('[data-window-drag-source]'));
  await act(async () => pointer(window, 'pointerup', 300));
  assert.equal(!!f.host.querySelector('[data-window-drag-source]'), false);
  await act(async () => pointer(f.host.querySelector('[data-source-item]')!, 'pointerdown', 300));
  assert.ok(f.host.querySelector('.window-replacement'));
  assert.equal(renders, initialRenders);
  await act(async () => pointer(window, 'pointerup', 300));
  assert.equal(!!f.host.querySelector('.window-replacement'), false);
  assert.equal(renders, initialRenders);
});
