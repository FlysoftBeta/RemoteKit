import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { RemoteKitError } from '../shared/errors';
import type { LibraryFileEntry, SelectionState } from '../shared/file-library';
import type { FileRequest } from '../shared/product';

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
  'ShadowRoot',
  'DocumentFragment',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'getComputedStyle',
] as const)
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
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
const { FileChooserDialog } = await import('../client/files/file-chooser-dialog');
const { FileLibraryContext } = await import('../client/files/file-library-state');
const { ImportQueue } = await import('../client/files/import-queue');

const entry: LibraryFileEntry = {
  kind: 'file',
  id: 'entry',
  assetId: 'a'.repeat(64),
  name: 'file.pdf',
  size: 1,
  type: 'application/pdf',
  available: true,
  collected: true,
  createdAt: 0,
  partitionId: null,
  source: null,
};
const request = {
  id: 'chooser',
  tabId: 'tab',
  windowId: 'window',
  origin: 'https://example.test',
  multiple: true,
  accept: [],
  state: 'pending',
  limits: { maxFiles: 10, maxFileBytes: 100, maxBatchBytes: 100 },
} as unknown as FileRequest;

for (const outcome of ['handed-off', 'failed'] as const) {
  test(`sending the basket hides it at once; ${outcome === 'failed' ? 'a failed send shows it again' : 'it stays hidden while the page confirms'}`, async () => {
    let finish!: (state: SelectionState) => void;
    let fail!: (error: Error) => void;
    const selects: string[][] = [];
    const empty = {
      revision: 0,
      entries: [],
      basket: [],
      partitions: [],
      sources: [],
      excludedSources: [],
      basketPartitionId: null,
    };
    const queue = new ImportQueue(
      {
        rpc: { uploadAsset: async () => ({ assetId: 'b'.repeat(64), size: 1, type: 'text/plain' }) },
        mutate: async () => empty,
      },
      'basket',
    );
    const library = {
      online: true,
      snapshot: { ...empty, entries: [entry], basket: [entry.id] },
      photos: { jobs: [] },
      thumbnails: { get: () => undefined, subscribe: () => () => {} },
      importQueue: () => queue,
      cancellations: {},
      checkout: () => undefined,
      refresh: async () => ({ ...empty, entries: [entry], basket: [entry.id] }),
      select: (_request: string, ids: string[]) => {
        selects.push(ids);
        return new Promise<SelectionState>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      },
      cancelSelection: async () => 'cancelled',
      apps: [],
    };
    const root = createRoot(document.getElementById('app')!);
    try {
      await act(async () => {
        root.render(
          createElement(
            FileLibraryContext.Provider,
            { value: library as never },
            createElement(FileChooserDialog, { request, transport: {} as never } as never),
          ),
        );
      });
      const panel = () => document.querySelector('[role="dialog"][aria-label="文件篮"]');
      assert.ok(panel());
      const send = document.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!;
      assert.equal(send.disabled, false);
      await act(async () => {
        send.click();
      });
      assert.deepEqual(selects, [[entry.id]]);
      assert.equal(panel(), null);
      await act(async () => {
        if (outcome === 'failed') fail(new RemoteKitError('rejected', '文件无法交给页面'));
        else finish('validating');
      });
      if (outcome === 'failed') {
        assert.ok(panel());
        assert.match(document.body.textContent!, /未能发送文件/);
      } else assert.equal(panel(), null);
    } finally {
      await act(async () => root.unmount());
    }
  });
}
