import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createRequire, Module } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import type { ViewerSession } from '../client/viewer-session';
import type { Action } from '../client/app/product-dialogs';

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
] as const) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
const preference = new dom.window.EventTarget();
Object.defineProperty(preference, 'matches', { value: false });
Object.defineProperty(window, 'matchMedia', { value: () => preference });
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
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { ThemeProvider, createTheme } = require('@mui/material') as typeof import('@mui/material');
const { OverlayHost } = require('../client/app/overlay-host') as typeof import('../client/app/overlay-host');
const { SyncStatus } = require('../client/app/sync-status') as typeof import('../client/app/sync-status');
const { productSnapshot } = require('./client-fixture') as typeof import('./client-fixture');
const theme = createTheme({
  components: {
    MuiDialog: {
      defaultProps: { transitionDuration: 0 },
    },
  },
});
const roots = new Set<Root>();
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  return {
    render: (node: ReactNode) => act(async () => root.render(createElement(ThemeProvider, { theme }, node))),
  };
}
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
    roots.clear();
  });
  document.body.replaceChildren();
});

function closeFixture() {
  const f = mount();
  const state = productSnapshot();
  state.workspace.pendingClose = {
    id: 'tab',
    enteredAt: 0,
    observationEpoch: '',
    observationSequence: '0',
    requestId: 'token',
    nativeRequestId: 'native',
    browserIncarnation: 'browser',
    instance: '1',
    document: '1',
    awaiting: false,
  };
  const calls: Parameters<Action>[0][] = [];
  const props = {
    state,
    media: {} as ViewerSession,
    stage: {
      shell: { current: null },
      snapshots: {},
      call: async () => {},
      action: async (action: Parameters<Action>[0]) => {
        calls.push(action);
        return {};
      },
    },
    controls: {
      shellReady: true,
      browserReady: false,
      lock() {},
      audio: null,
      sync: { pending: 1, unknown: false, controlReady: true, dismissUnknown() {} },
      browserFullscreen: { active: false, toggle() {} },
      fullscreen: false,
    },
    overlays: { launcherOpen: false, launcherVisible: false, openLauncher() {}, closeLauncher() {} },
    foreground: null,
    readAnnouncement: async () => {},
  } as unknown as React.ComponentProps<typeof OverlayHost>;
  return { ...f, props, calls };
}

test('close confirmation uses Control readiness without an Endpoint data channel and sends both replies', async () => {
  const f = closeFixture();
  const { props, calls } = f;
  await f.render(createElement(OverlayHost, props));
  assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /离开此页面/);
  await act(async () =>
    [...document.querySelectorAll('button')].find((button) => button.textContent === '离开')!.click(),
  );
  assert.deepEqual(calls[0], { type: 'tab.close', tabId: 'tab', requestId: 'token', confirm: true });
  await act(async () =>
    [...document.querySelectorAll('button')].find((button) => button.textContent === '保留页面')!.click(),
  );
  assert.deepEqual(calls[1], { type: 'tab.close', tabId: 'tab', requestId: 'token', cancel: true });
});

test('a disconnected Control connection keeps the confirmation hidden', async () => {
  const f = closeFixture();
  await f.render(
    createElement(OverlayHost, { ...f.props, controls: { ...f.props.controls, shellReady: false } }),
  );
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test('sync status exposes an in-flight close even without a local operation receipt', async () => {
  const f = mount();
  await f.render(
    createElement(SyncStatus, {
      pending: 0,
      closing: true,
      unknown: false,
      controlReady: true,
      dismissUnknown() {},
    }),
  );
  assert.ok(document.querySelector('button[aria-label="正在关闭…"]'));
});
