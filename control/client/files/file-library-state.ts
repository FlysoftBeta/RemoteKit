import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { LibrarySnapshot } from '../../shared/file-library';
import type { ProductState } from '../../shared/product';
import { canonicalJson } from '../util/canonical-json';
import type { Events } from '../util/store';
import type { FileChannel } from './file-channel';
import { LibraryStore, type LibraryRequest, type FilePort } from './library-store';
export type { LibraryRequest } from './library-store';
export function useFileLibrary(
  request: LibraryRequest,
  rpc: FileChannel,
  online: boolean,
  enabled: boolean,
  identity: string | undefined,
  requestIds: string[],
  updates: Events<LibrarySnapshot>,
  product?: Pick<ProductState, 'workspace'> | null,
) {
  const [store] = useState(() => new LibraryStore(request, rpc));
  useEffect(() => {
    store.configure(online, enabled, identity, requestIds);
  }, [store, online, enabled, identity, requestIds]);
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => updates.subscribe(store.receive), [store, updates]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const jobs = useSyncExternalStore(
    store.photos.subscribe,
    store.photos.getSnapshot,
    store.photos.getSnapshot,
  );
  const activeSpace = product?.workspace.spaces.find((space) => space.id === product.workspace.activeSpaceId);
  const photoVisible =
    !!product?.workspace.windows.some(
      (win) => win.appId === 'files' && activeSpace?.windowIds.includes(win.id),
    ) || requestIds.length > 0;
  useEffect(() => store.photos.setVisible(photoVisible), [store, photoVisible]);
  const apps = product?.workspace.apps;
  const stableApps = useMemo(() => apps ?? [], [canonicalJson(apps)]);
  return useMemo(
    () => ({
      ...state,
      apps: stableApps,
      importQueue: store.importQueue,
      refresh: store.refresh,
      recordUsage: store.recordUsage,
      snippet: store.snippet,
      copySnippet: store.copySnippet,
      mutate: store.mutate,
      select: store.select,
      cancelSelection: store.cancelSelection,
      checkout: (id: string) => state.checkouts[id],
      photos: {
        jobs,
        reserve: store.photos.reserve,
        update: store.photos.update,
        cancel: store.photos.cancel,
        capture: store.photos.capture,
        resolve: store.photos.resolve,
        rotate: store.photos.rotate,
      },
      thumbnails: store.thumbnails,
      rpc,
    }),
    [state, stableApps, store, jobs, rpc],
  );
}
export type FileLibrary = ReturnType<typeof useFileLibrary>;
export const FileLibraryContext = createContext<FileLibrary | null>(null);
export function useLibrary() {
  const library = useContext(FileLibraryContext);
  if (!library) throw new Error('File library is not initialized');
  return library;
}
