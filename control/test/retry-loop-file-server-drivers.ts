import { ControlDatabase } from '../server/persistence/database';
import { LibraryRepository } from '../server/persistence/library';
import { FileLibrary } from '../server/files/library';
import type { InternalFileRequest } from '../server/workspace/page-requests';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveFileServer(path: 'availability' | 'selection'): OwnerFactory {
  return async (boundary) => {
    const store = new ControlDatabase(':memory:', { buildId: 'test' });
    store.db.prepare('INSERT INTO library_state VALUES (?,0,NULL)').run('tenant');
    const asset = 'a'.repeat(64);
    let armed = false;
    const repository = new LibraryRepository(store.db);
    const limits = { maxFileBytes: 100, maxBatchBytes: 100, maxFiles: 10 };
    const owner = new FileLibrary(
      repository,
      {
        describeAsset: async () => ({ assetId: asset, size: 1, type: 'text/plain' }),
        prepareSelection: async () => ({ accepted: true }),
        selectionStatus: (_tenant, params) => boundary.call(params, { state: 'selected' }),
      },
      limits,
      {
        require: () => {},
        checkQuota: () => {},
        available: () => (armed && path === 'availability' ? boundary.callSync({ asset }, true) : true),
      },
      () => ({ app: 'files', channel: 'upload' }),
    );
    const request: InternalFileRequest = {
      id: 'chooser',
      tabId: 'tab',
      windowId: 'window',
      origin: 'https://example.test',
      multiple: true,
      accept: [],
      state: 'pending',
      limits,
      binding: {
        browserIncarnation: 'browser',
        view: 'view',
        instance: 'instance',
        document: 'document',
        request: 'native',
      },
    };
    const call = (method: string, params = {}) =>
      owner.request(
        'tenant',
        method,
        params,
        () => {},
        () => request,
      );
    const imported = (await call('library.import', {
      operationId: 'import',
      assetId: asset,
      name: 'file',
      destination: 'basket',
      origin: { kind: 'files', channel: 'upload', partitionId: null },
    })) as { basket: string[] };
    let prepared = (await call('library.prepare', {
      operationId: 'prepare',
      requestId: 'chooser',
      entryIds: imported.basket,
    })) as { selectionId: string };
    const result = operation();
    let dropped: unknown;
    const run = () => {
      if (path === 'availability') owner.objectsChanged([asset]);
      else
        result.run(async () => {
          const reply = (await call('library.finish', { selectionId: prepared.selectionId })) as {
            state: string;
          };
          dropped = reply.state === 'cancelled' ? reply : undefined;
        });
    };
    return {
      start: () => {
        armed = true;
        run();
      },
      drive: path === 'availability' ? () => {} : run,
      changeInput: async () => {
        owner.endpointReady();
        if (path === 'availability') owner.objectsChanged([asset, 'b'.repeat(64)]);
        else {
          if (dropped) {
            boundary.version++;
            prepared = (await call('library.prepare', {
              operationId: 'prepare-' + boundary.version,
              requestId: 'chooser',
              entryIds: imported.basket,
            })) as { selectionId: string };
          }
          run();
        }
      },
      error: () => owner.failures()[0] ?? dropped ?? result.error(),
      dispose: async () => {
        armed = false;
        await owner.close();
        store.db.close();
      },
    };
  };
}
