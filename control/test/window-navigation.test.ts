import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ViewerAudioOutput } from '../client/media/audio-output';
import { FileChannel } from '../client/files/file-channel';
import { FileLibraryContext, useFileLibrary } from '../client/files/file-library-state';
import { projectOperations } from '../client/control/product-operations';
import type { ViewerSession } from '../client/viewer-session';
import { WindowFrame } from '../client/app/window-frame';
import { emptyWorkspace } from '../server/persistence/workspaces';
import type { ProductState, ProductTab, ProductWindow } from '../shared/product';

const windowWithTab: ProductWindow = { id: 'window-id', activeTabId: 'tab-id', weight: 1 };
const startTab: ProductTab = {
  id: 'tab-id',
  windowId: windowWithTab.id,
  webviewId: '1',
  kind: 'start',
  title: '新标签页',
  url: '',
};

function snapshot(win?: ProductWindow, tab?: ProductTab): ProductState {
  return {
    user: { id: 'user-id', username: 'viewer', isAdmin: false },
    workspace: {
      ...emptyWorkspace('tenant-id'),
      windows: win ? [win] : [],
      tabs: tab ? [tab] : [],
      activeWindowId: win?.id ?? null,
    },
    pageDialogs: [],
    fileRequests: [],
    quality: {
      resourceLimitation: null,
      mode: 'product',
      preference: 'auto',
      clientScale: 1,
      effectiveDpr: 1,
      requested: { degradationPreference: 'balanced', maxFps: 60, audio: true },
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
    constraints: { clientScaleMin: 1, clientScaleMax: 2 },
  };
}

function Frame({ state, online }: { state: ProductState; online: boolean }) {
  const unexpected = (): never => assert.fail('Rendering must not dispatch any operation');
  const transport = {
    observations: { audio: new ViewerAudioOutput(unexpected) },
    files: new FileChannel(() => null),
  };
  const library = useFileLibrary(unexpected, transport.files, false, false, undefined, []);
  const win = state.workspace.windows.find((window) => window.id === state.workspace.activeWindowId)!;
  return createElement(
    FileLibraryContext.Provider,
    { value: library },
    createElement(WindowFrame, {
      win,
      state,
      transport: transport as unknown as ViewerSession,
      online,
      action: unexpected,
      report: unexpected,
      onSettings: unexpected,
      onAdmin: unexpected,
      onLogout: unexpected,
      onGeometry: unexpected,
      focusAddress: null,
      visible: true,
      fullscreen: false,
      audioSaving: false,
      audioError: '',
      saveAudio: unexpected,
    }),
  );
}

function checkNavigation(
  state: ProductState,
  options: { inputs: number; disabled: boolean; creating?: boolean; online?: boolean },
) {
  const html = renderToStaticMarkup(createElement(Frame, { state, online: options.online ?? true }));
  const inputs = html.match(/<input\b[^>]*aria-label="搜索或输入网址"[^>]*>/g) ?? [];
  assert.equal(inputs.length, options.inputs);
  for (const input of inputs) assert.equal(/\sdisabled(?:=""|\s|>)/.test(input), options.disabled);
  assert.equal(html.includes('role="status">正在创建标签页…'), options.creating ?? false);
}

test('projected window and tab cannot take navigation drafts before their IDs are confirmed', () => {
  const confirmed = snapshot(windowWithTab, startTab);
  const pendingWindow = projectOperations(snapshot(), [
    {
      operationId: 'create-window',
      operationGeneration: 'generation',
      action: { type: 'window.create' },
    },
  ])!;
  const pendingTab = projectOperations(confirmed, [
    {
      operationId: 'create-tab',
      operationGeneration: 'generation',
      action: { type: 'tab.create', windowId: windowWithTab.id },
    },
  ])!;
  checkNavigation(pendingWindow, { inputs: 2, disabled: true, creating: true });
  checkNavigation(snapshot({ ...pendingWindow.workspace.windows[0], activeTabId: null }), {
    inputs: 2,
    disabled: true,
    creating: true,
  });
  checkNavigation(pendingTab, { inputs: 2, disabled: true, creating: true });
  checkNavigation(confirmed, { inputs: 2, disabled: false });
  checkNavigation(confirmed, { inputs: 2, disabled: true, online: false });
});

test('confirmed empty windows and file tabs keep their address controls', () => {
  checkNavigation(snapshot({ ...windowWithTab, activeTabId: null }), { inputs: 2, disabled: false });
  checkNavigation(snapshot(windowWithTab, { ...startTab, kind: 'files' }), { inputs: 1, disabled: false });
});
