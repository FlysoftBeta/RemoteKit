import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { Asset, LibraryMethods, LibrarySnapshot } from '../shared/file-library';
import { RemoteKitError } from '../shared/errors';
import { FileLibraryContext, type FileLibrary } from '../client/files/file-library-state';
import { FilesWindow } from '../client/files/files-window';
import type { FilesWindowState } from '../client/files/files-app-state';

const dom = new JSDOM('<html><body><div id="app"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'DocumentFragment',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'getComputedStyle',
] as const) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
const { createRoot } = await import('react-dom/client');
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const asset: Asset = { assetId: 'a'.repeat(64), size: 1, type: 'text/plain' };
const snapshot: LibrarySnapshot = {
  revision: 0,
  entries: [],
  basket: [],
  partitions: [],
  sources: [],
  excludedSources: [],
  basketPartitionId: null,
};

async function mount() {
  const root = createRoot(document.getElementById('app')!);
  const calls: LibraryMethods['library.import']['params'][] = [];
  const pending: {
    resolve(value: Asset): void;
    reject(error: Error): void;
    signal: AbortSignal;
    id: string;
  }[] = [];
  const library = {
    online: true,
    scope: 'viewer',
    snapshot,
    apps: [],
    photos: { jobs: [] },
    refresh: async () => snapshot,
    rpc: {
      uploadAsset: (_file: File, id: string, signal: AbortSignal) =>
        new Promise<Asset>((resolve, reject) => {
          pending.push({ resolve, reject, signal, id });
        }),
    },
    mutate: async (_method: string, params: LibraryMethods['library.import']['params']) => {
      calls.push(params);
      return snapshot;
    },
  } as unknown as FileLibrary;
  const state: FilesWindowState = {
    tabs: [
      { id: 'library1', kind: 'library', view: 'all', query: '' },
      { id: 'library2', kind: 'library', view: 'recent', query: '' },
      { id: 'document', kind: 'document', entryId: 'missing' },
    ],
    activeTabId: 'library1',
    layout: 'list',
  };
  const render = () =>
    act(async () => {
      root.render(
        createElement(
          FileLibraryContext.Provider,
          { value: { ...library } },
          createElement(FilesWindow, {
            windowId: 'files',
            state: { ...state },
            onState: () => {},
            handle: null,
          }),
        ),
      );
    });
  await render();
  return {
    calls,
    pending,
    library,
    async select(id: string) {
      state.activeTabId = id;
      await render();
    },
    render,
    async add(count: number) {
      const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: Array.from({ length: count }, (_, index) => new File(['a'], `file-${index}.txt`)),
      });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    },
    close: () => act(async () => root.unmount()),
  };
}

test('Files window uploads survive document and library tab unmounts', async () => {
  const window = await mount();
  try {
    await window.add(10);
    const first = window.pending[0];
    await window.select('document');
    assert.equal(document.querySelector('input[type=file]'), null);
    assert.equal(first.signal.aborted, false);
    await act(async () => {
      first.resolve(asset);
      await flush();
    });
    assert.equal(window.calls.length, 1);
    await window.select('library2');
    assert(document.querySelector('[role=progressbar]'));
    for (let index = 1; index < 10; index++) {
      await act(async () => {
        window.pending[index].resolve(asset);
        await flush();
      });
    }
    await window.select('library1');
    assert.equal(window.calls.length, 10);
    assert.equal(document.querySelector('[role=progressbar]'), null);
  } finally {
    await window.close();
  }
});

test('window closure and authorization revocation abort uploads even while a document tab is active', async () => {
  for (const revoke of [false, true]) {
    const window = await mount();
    await window.add(2);
    const first = window.pending[0];
    await window.select('document');
    if (revoke) {
      window.library.scope = undefined;
      window.library.online = false;
      await window.render();
    } else await window.close();
    assert.equal(first.signal.aborted, true);
    await act(async () => {
      first.resolve(asset);
      await flush();
    });
    assert.equal(window.calls.length, 0);
    assert.equal(window.pending.length, 1);
    if (revoke) {
      await window.select('library2');
      assert.equal(document.querySelector('[role=progressbar]'), null);
      await window.close();
    }
  }
});

test('upload warnings clear on acceptance and runtime failures remain visible across library tabs', async () => {
  const window = await mount();
  try {
    await window.add(65);
    assert.match(document.querySelector('[role=alert]')?.textContent ?? '', /最多可添加 64 个文件/);
    await window.add(1);
    assert.equal(document.querySelector('[role=alert]'), null);
    const first = window.pending[0];
    await act(async () => {
      first.reject(new RemoteKitError('unavailable', 'connection lost'));
      await flush();
    });
    const error = document.querySelector('[role=alert]')?.textContent;
    assert(error);
    await window.select('document');
    await window.select('library2');
    assert.equal(document.querySelector('[role=alert]')?.textContent, error);
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '继续上传',
    )!;
    await act(async () => retry.click());
    assert.equal(window.pending[1].id, first.id);
    await act(async () => {
      window.pending[1].resolve(asset);
      await flush();
    });
    assert.equal(window.calls.length, 1);
    assert.equal(window.calls[0].operationId, first.id);
    assert.equal(document.querySelector('[role=alert]'), null);
  } finally {
    await window.close();
  }
});
