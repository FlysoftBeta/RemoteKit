import { buildAction } from '../client/control/action-builder';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ViewerAudioOutput } from '../client/media/audio-output';
import { FileChannel } from '../client/files/file-channel';
import { Events } from '../client/util/store';
import { FileLibraryContext, useFileLibrary } from '../client/files/file-library-state';
import { projectOperations, type PendingOperation } from '../client/control/product-operations';
import type { ViewerSession } from '../client/viewer-session';
import { WindowFrame } from '../client/app/window-frame';
import { emptyWorkspace } from '../server/persistence/workspaces';
import type { ProductState, ProductTab, ProductWindow } from '../shared/product';

const windowWithTab: ProductWindow = {
  id: 'window-id',
  activeTabId: 'tab-id',
  appId: 'browser',
  lastActiveAt: 1,
};
const startTab: ProductTab = {
  id: 'tab-id',
  windowId: windowWithTab.id,
  idleKeepAlive: false,
  webviewId: '1',
  kind: 'start',
  title: '新标签页',
  url: '',
};

function snapshot(win?: ProductWindow, tab?: ProductTab): ProductState {
  return {
    browser: { state: 'available' },
    learning: {
      accounts: { changyan: { status: 'signed_out' }, xinjiaoyu: { status: 'signed_out' } },
      study: { retentionDays: 7, syncing: false },
    },
    user: { id: 'user-id', username: 'viewer', isAdmin: false },
    announcements: [],
    workspace: {
      ...emptyWorkspace('tenant-id'),
      windows: win ? [win] : [],
      tabs: tab ? [tab] : [],
      activeSpaceId: win ? 's1' : null,
      spaces: win
        ? [{ id: 's1', windowIds: [win.id], weights: [1], focusedWindowId: win.id, lastActiveAt: 1 }]
        : [],
    },
    pageDialogs: [],
    fileRequests: [],
    quality: {
      resourceLimitation: null,
      mode: 'product',
      preference: 'auto',
      clientScale: 1,
      effectiveDpr: 1,
      requested: { degradationPreference: 'maintain-resolution', maxFps: 60, audio: true },
      applied: null,
      estimatedLatencyMs: null,
      clockUncertaintyMs: null,
      feedbackStatus: 'unknown',
      reason: '',
    },
    endpointGeneration: 1,
    endpointError: null,
    viewer: { connected: true },
    integrations: { siteUa: false, lifecycle: false, popupAdoption: false },
  };
}

function Frame({
  state,
  online,
  authoritative,
  pending,
}: {
  state: ProductState;
  online: boolean;
  authoritative: ProductState;
  pending: PendingOperation[];
}) {
  const unexpected = (): never => assert.fail('Rendering must not dispatch any operation');
  const transport = {
    authorization: { getSnapshot: () => ({ locked: false }) },
    operations: {
      subscribe: () => () => {},
      getSnapshot: () => ({ error: undefined, authoritative, pending }),
    },
    presentation: { getSnapshot: () => ({ error: undefined }) },
    observations: { audio: new ViewerAudioOutput(unexpected) },
    files: new FileChannel(() => null),
  };
  const library = useFileLibrary(unexpected, transport.files, false, false, undefined, [], new Events());
  const win = state.workspace.windows.find(
    (window) =>
      window.id ===
      state.workspace.spaces.find((space) => space.id === state.workspace.activeSpaceId)?.focusedWindowId,
  )!;
  return createElement(
    FileLibraryContext.Provider,
    { value: library },
    createElement(WindowFrame, {
      win,
      state,
      transport: transport as unknown as ViewerSession,
      shellReady: online,
      action: unexpected,
      appContent: () => null,
      call: unexpected,
      weight: 1,
      onGeometry: unexpected,
      visible: true,
      fullscreen: false,
    }),
  );
}

function checkNavigation(
  state: ProductState,
  options: {
    inputs: number;
    disabled: boolean;
    creating?: boolean;
    online?: boolean;
    authoritative?: ProductState;
    pending?: PendingOperation[];
  },
) {
  const html = renderToStaticMarkup(
    createElement(Frame, {
      state,
      online: options.online ?? true,
      authoritative: options.authoritative ?? state,
      pending: options.pending ?? [],
    }),
  );
  const inputs = html.match(/<input\b[^>]*aria-label="搜索或输入网址"[^>]*>/g) ?? [];
  assert.equal(inputs.length, options.inputs);
  for (const input of inputs) assert.equal(/\sdisabled(?:=""|\s|>)/.test(input), options.disabled);
  assert.equal(
    /class="page-overlay" role="status">(?:(?!<\/div>)[\s\S])*正在创建标签页…/.test(html),
    options.creating ?? false,
  );
}

test('projected windows and tabs accept navigation while showing creation progress', () => {
  const confirmed = snapshot(windowWithTab, startTab);
  const windowOperation = {
    operationId: 'create-window',
    operationGeneration: 'generation',
    action: buildAction({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
  };
  const tabOperation = {
    operationId: 'create-tab',
    operationGeneration: 'generation',
    action: buildAction({ type: 'tab.create', windowId: windowWithTab.id }),
  };
  const pendingWindow = projectOperations(snapshot(), [windowOperation])!;
  const pendingTab = projectOperations(confirmed, [tabOperation])!;
  checkNavigation(pendingWindow, {
    inputs: 2,
    disabled: false,
    creating: true,
    authoritative: snapshot(),
    pending: [windowOperation],
  });
  checkNavigation(snapshot({ ...pendingWindow.workspace.windows[0], activeTabId: null }), {
    inputs: 2,
    disabled: false,
    creating: true,
    authoritative: snapshot(),
    pending: [windowOperation],
  });
  checkNavigation(pendingTab, {
    inputs: 2,
    disabled: false,
    creating: true,
    authoritative: confirmed,
    pending: [tabOperation],
  });
  checkNavigation(confirmed, { inputs: 2, disabled: false });
  checkNavigation(confirmed, { inputs: 2, disabled: true, online: false });
});

test('confirmed empty browser windows keep their address controls', () => {
  checkNavigation(snapshot({ ...windowWithTab, activeTabId: null }), { inputs: 2, disabled: false });
});
