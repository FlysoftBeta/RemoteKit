import { LibraryStore } from '../client/files/library-store';
import { notices } from '../client/failures';
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
  const owner = new LibraryStore(
    (async (method: string, params: unknown) =>
      method === 'library.import' ? library.mutate(method, params as never) : snapshot) as never,
    library.rpc as never,
  );
  library.importQueue = owner.importQueue;
  const queue = owner.importQueue('library', 'files');
  let mounted = true;
  const closeWindow = () =>
    act(async () => {
      if (mounted) {
        root.unmount();
        mounted = false;
      }
    });
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
      owner.configure(library.online, !!library.scope, library.scope, []);
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
    queue,
    closeWindow,
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
    close: async () => {
      await closeWindow();
      owner.dispose();
      notices.clear();
    },
  };
}

test('upload failures stay in queue items and collapse to one note below the toolbar', async () => {
  const window = await mount();
  try {
    await window.add(2);
    assert(document.querySelector('[data-upload-job] [role=progressbar]'));
    await act(async () => {
      window.pending[0].reject(new RemoteKitError('internal', 'upload failed'));
      await flush();
    });
    const area = document.querySelector('[data-upload-queue-area]')!;
    const queue = area.querySelector('[data-upload-queue]')!;
    const note = queue.querySelector('.failure-C')!;
    assert(note.closest('[data-upload-job]'));
    assert.match(note.textContent!, /file-0.txt 未能导入/);
    assert.match(note.textContent!, /错误 ID v-[0-9a-f]{10}/);
    assert.equal(document.querySelector('.tab-bar .failure-note'), null);
    assert(area.previousElementSibling);
    assert.equal(area.parentElement?.classList.contains('library-tab'), true);
    const toggle = [...queue.querySelectorAll('button')].find(
      (button) => button.textContent === '收起上传队列',
    )!;
    await act(async () => toggle.click());
    assert.equal(queue.querySelector('[data-upload-job]'), null);
    assert.equal(queue.querySelectorAll('.failure-note').length, 1);
    assert.equal(queue.querySelector('.failure-note')?.closest('[data-upload-job]'), null);
    assert.match(queue.textContent!, /file-0.txt 未能导入/);
  } finally {
    await window.close();
  }
});

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

test('window closure keeps background uploads and authorization revocation aborts the task', async () => {
  for (const revoke of [false, true]) {
    const window = await mount();
    try {
      await window.add(2);
      const first = window.pending[0];
      await window.select('document');
      if (revoke) {
        window.library.scope = undefined;
        window.library.online = false;
        await window.render();
      } else await window.closeWindow();
      assert.equal(first.signal.aborted, revoke);
      await act(async () => {
        first.resolve(asset);
        await flush();
      });
      assert.equal(window.calls.length, revoke ? 0 : 1);
      assert.equal(window.pending.length, revoke ? 1 : 2);
    } finally {
      await window.close();
    }
  }
});

test('capacity notes clear on acceptance and upload recovery survives library tabs automatically', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const window = await mount();
  try {
    await window.add(65);
    assert.match(document.querySelector('.failure-B')?.textContent ?? '', /超出限制/);
    await window.add(1);
    assert.equal(document.querySelector('.failure-B'), null);
    const first = window.pending[0];
    await act(async () => {
      first.reject(new RemoteKitError('unavailable', 'connection lost', { retryAfterMs: 5000 }));
      await flush();
    });
    await act(async () => {
      t.mock.timers.tick(1500);
      await flush();
    });
    assert.match(document.querySelector('.failure-A')?.textContent ?? '', /正在上传/);
    assert.equal(document.querySelector('.failure-C'), null);
    await window.select('document');
    await window.select('library2');
    assert.equal(window.queue.getSnapshot().error?.code, 'unavailable');
    assert(![...document.querySelectorAll('button')].some((button) => button.textContent === '继续上传'));
    await act(async () => {
      t.mock.timers.tick(3500);
      await flush();
    });
    assert.equal(window.pending[1].id, first.id);
    await act(async () => {
      window.pending[1].resolve(asset);
      await flush();
    });
    assert.equal(window.calls.length, 1);
    assert.equal(window.calls[0].operationId, first.id);
    assert.equal(document.querySelector('.failure-A'), null);
  } finally {
    await window.close();
  }
});
