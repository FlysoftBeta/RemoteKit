import { LibraryStore, type LibraryRequest } from '../client/files/library-store';
import { FileChannel } from '../client/files/file-channel';
import { wireError } from '../shared/errors';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveLibrary(path: 'refresh' | 'mutation' | 'checkout'): OwnerFactory {
  return (boundary, t) => {
    const snapshot = { revision: 1, entries: [], basket: [], partitions: [], sources: [] };
    const request = (method: string, params: unknown) => {
      const targeted =
        path === 'refresh'
          ? method === 'library.get'
          : path === 'mutation'
            ? method === 'library.delete'
            : method === 'library.finish';
      if (targeted)
        return boundary.call(
          { method, params },
          path === 'checkout' ? { state: 'selected', snapshot } : snapshot,
        );
      if (method === 'library.prepare')
        return Promise.resolve({ selectionId: 'selection-' + boundary.version });
      return Promise.resolve(snapshot);
    };
    const rpc = {
      photoThumbnail: async () => new Blob(),
      uploadAsset: async () => ({}),
      processPhoto: async () => ({}),
      commitSelection: async () => ({ state: 'selected', selectionId: 'selection-' + boundary.version }),
      cancelSelection: async () => ({ state: 'cancelled' }),
    };
    const owner = new LibraryStore(
      request as LibraryRequest,
      rpc as unknown as ConstructorParameters<typeof LibraryStore>[1],
    );
    const callbacks: (() => void)[] = [];
    const interval = setInterval;
    t.mock.method(globalThis, 'setInterval', (callback: () => void, ms: number) => {
      callbacks.push(callback);
      return interval(callback, ms);
    });
    const result = operation();
    const configure = () => owner.configure(true, true, 'scope-' + boundary.version, ['chooser']);
    const run = () => {
      if (path === 'mutation')
        result.run(() =>
          owner.mutate('library.delete', { operationId: 'delete-' + boundary.version, ids: ['entry'] }),
        );
      if (path === 'checkout') result.run(() => owner.select('chooser', ['entry']));
    };
    return {
      start: () => {
        configure();
        run();
      },
      drive: () => {
        if (path === 'checkout') callbacks.forEach((callback) => callback());
      },
      changeInput: () => {
        boundary.version++;
        configure();
        run();
      },
      error: () =>
        path === 'checkout'
          ? owner.getSnapshot().checkouts.chooser?.error
          : (owner.getSnapshot().error ?? result.error()),
      dispose: () => owner.dispose(),
    };
  };
}

export const driveFileChannel: OwnerFactory = (boundary) => {
  const controller = new AbortController();
  let owner: FileChannel;
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (data: string) => {
      const { requestId, method, params } = JSON.parse(data);
      void boundary.call({ method, params }, { assetId: params.assetId, size: 0, type: 'text/plain' }).then(
        (result) => owner.handle({ type: 'files.result', requestId, ok: true, result } as never),
        (error) =>
          owner.handle({ type: 'files.result', requestId, ok: false, error: wireError(error) } as never),
      );
    },
  } as unknown as RTCDataChannel;
  owner = new FileChannel(
    () => channel,
    () => 1,
  );
  const result = operation();
  const run = () => result.run(() => owner.describeAsset('asset-' + boundary.version, controller.signal));
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      boundary.version++;
      run();
    },
    error: result.error,
    dispose: () => {
      controller.abort();
      owner.disconnect();
    },
  };
};
