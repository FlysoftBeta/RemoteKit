import { recover, recoverRead } from '../client/failures/recovery';
import { FileThumbnails, type Preview } from '../client/files/file-thumbnails';
import { ChannelDocumentSource } from '../client/documents/channel-source';
import { ViewportRequests } from '../client/control/viewport-requests';
import { ImportQueue } from '../client/files/import-queue';
import { DeviceClipboardSync } from '../client/clipboard/device-clipboard';
import { HttpClient } from '../server/learning/providers/http';
import { productSnapshot } from './client-fixture';
import { operation, type OwnerFactory } from './retry-loop-boundary';
import type { LibrarySnapshot } from '../shared/file-library';

const library: LibrarySnapshot = {
  revision: 1,
  entries: [],
  basket: [],
  partitions: [],
  sources: [],
  excludedSources: [],
  basketPartitionId: null,
};

export const driveRecovery: OwnerFactory = (boundary) => {
  const controller = new AbortController();
  const result = operation();
  const run = () =>
    result.run(() =>
      recoverRead(() => boundary.call({ query: boundary.version }, 'ready'), controller.signal),
    );
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      boundary.version++;
      run();
    },
    error: result.error,
    dispose: () => controller.abort(),
  };
};

export const driveIdentifiedRecovery: OwnerFactory = (boundary) => {
  const controller = new AbortController();
  const result = operation();
  const run = () =>
    result.run(() =>
      recover(
        () => boundary.call({ operationId: 'operation-' + boundary.version }, 'ready'),
        controller.signal,
        undefined,
        { identity: 'operation-' + boundary.version, recompute: async () => {} },
      ),
    );
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      boundary.version++;
      run();
    },
    error: result.error,
    dispose: () => controller.abort(),
  };
};

export const driveThumbnails: OwnerFactory = (boundary) => {
  const owner = new FileThumbnails((asset) => boundary.call({ asset }, new Blob(['thumbnail'])));
  let preview: Preview = {};
  let leave: (() => void) | undefined;
  const run = () => {
    leave = owner.subscribe('asset-' + boundary.version, (value) => {
      preview = value;
    });
  };
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      leave?.();
      boundary.version++;
      run();
    },
    error: () => preview.error,
    dispose: () => {
      leave?.();
      owner.clear();
    },
  };
};

export const driveDocument: OwnerFactory = (boundary) => {
  const controller = new AbortController();
  const owner = new ChannelDocumentSource(
    {
      documentOpen: (asset, type) =>
        boundary.call({ asset, type }, {
          state: 'ready',
          documentId: 'document',
          title: 'title',
          pages: [],
        } as never),
      documentResource: async () => {
        throw new Error('unexpected resource request');
      },
    },
    'asset',
    'application/pdf',
  );
  const result = operation();
  const run = () => result.run(() => owner.open(controller.signal));
  return {
    start: run,
    drive: () => {},
    changeInput: run,
    error: result.error,
    dispose: () => controller.abort(),
  };
};

export function driveViewportOwner(reset: boolean): OwnerFactory {
  return (boundary) => {
    const owner = new ViewportRequests((params) => boundary.call(params, {}));
    if (reset) owner.reset();
    const state = productSnapshot();
    state.workspace.windows = [{ id: 'window', activeTabId: 'tab', appId: 'browser', lastActiveAt: 0 }];
    state.workspace.tabs = [
      {
        id: 'tab',
        windowId: 'window',
        webviewId: 'view',
        title: '',
        url: 'about:blank',
        kind: 'remote',
        idleKeepAlive: false,
      },
    ];
    const run = () => {
      owner.observe(state, true);
      owner.measure(800 + boundary.version, 600, 1, true);
    };
    return {
      start: run,
      drive: () => {},
      changeInput: () => {
        boundary.version++;
        run();
      },
      error: () => owner.getSnapshot(),
      dispose: () => owner.reset(),
    };
  };
}
export const driveViewport = driveViewportOwner(false);

export function driveQueuedImport(stage: 'upload' | 'commit'): OwnerFactory {
  return (boundary) => {
    const owner = new ImportQueue(
      {
        rpc: {
          uploadAsset: (file, identity) =>
            stage === 'upload'
              ? boundary.call(
                  { name: file.name, identity },
                  {
                    assetId: 'a'.repeat(64),
                    size: file.size,
                    type: file.type,
                  },
                )
              : Promise.resolve({ assetId: 'a'.repeat(64), size: file.size, type: file.type }),
        },
        mutate: (method, params) =>
          stage === 'commit' ? boundary.call({ method, params }, library) : Promise.resolve(library),
      },
      'library',
    );
    owner.configure(true, 'viewer');
    const run = () => {
      owner.enqueue([new File(['x'], 'file-' + boundary.version)], 0, {
        kind: 'files',
        channel: 'picker',
        partitionId: null,
      } as never);
    };
    return {
      start: run,
      drive: () => owner.upload(),
      changeInput: () => {
        owner.discard();
        boundary.version++;
        run();
      },
      error: () => owner.getSnapshot().jobs[0]?.error,
      dispose: owner.dispose,
    };
  };
}
export const driveImportQueue = driveQueuedImport('upload');

export function driveClipboard(direction: 'inbound' | 'outbound' | 'read'): OwnerFactory {
  return (boundary) => {
    let focused = false;
    const owner = new DeviceClipboardSync({
      focused: () => focused,
      granted: async () => true,
      read: () =>
        direction === 'read' ? boundary.call({ read: 'clipboard' }, 'local') : Promise.resolve('local'),
      write: (text) => (direction === 'inbound' ? boundary.call({ text }, undefined) : Promise.resolve()),
      failed: () => {},
    });
    owner.configure('viewer', true, (text) =>
      direction === 'outbound'
        ? boundary.call({ text }, { revision: '2' })
        : Promise.resolve({ revision: '2' }),
    );
    focused = true;
    const result = operation();
    const run = () => {
      if (direction === 'inbound') owner.receive({ revision: String(boundary.version), text: 'remote' });
      else if (direction === 'outbound') result.run(() => owner.send('local-' + boundary.version));
      else result.run(() => owner.focus());
    };
    return {
      start: run,
      drive: direction !== 'read' ? run : () => {},
      changeInput: () => {
        boundary.version++;
        run();
      },
      error: () => owner.failure,
      dispose: () => owner.configure(undefined, false, async () => ({ revision: '0' })),
    };
  };
}

export const driveHttpRead: OwnerFactory = (boundary) => {
  const controller = new AbortController();
  const owner = new HttpClient({
    fetch: (url, init) =>
      boundary.call({ url: String(url), method: init?.method ?? 'GET' }, new Response('{}')),
  });
  const result = operation();
  const run = () =>
    result.run(() => owner.response('https://example.test/read', { signal: controller.signal }));
  return {
    start: run,
    drive: () => {},
    changeInput: run,
    error: result.error,
    dispose: () => controller.abort(),
  };
};
