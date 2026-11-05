import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { FileChannel } from './file-channel';
import { LibraryStore, type LibraryRequest } from './library-store';
export type { LibraryRequest } from './library-store';
export function useFileLibrary(
  request: LibraryRequest,
  rpc: FileChannel,
  online: boolean,
  enabled: boolean,
  identity: string | undefined,
  requestIds: string[],
) {
  const [store] = useState(() => new LibraryStore(request, rpc));
  useEffect(() => {
    store.configure(online, enabled, identity, requestIds);
  }, [store, online, enabled, identity, requestIds]);
  useEffect(() => () => store.dispose(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const jobs = useSyncExternalStore(
    store.photos.subscribe,
    store.photos.getSnapshot,
    store.photos.getSnapshot,
  );
  return {
    ...state,
    refresh: store.refresh,
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
      retry: store.photos.retry,
      resolve: store.photos.resolve,
    },
    thumbnails: store.thumbnails,
    rpc,
  };
}
export type FileLibrary = ReturnType<typeof useFileLibrary>;
export const FileLibraryContext = createContext<FileLibrary | null>(null);
export function useLibrary() {
  const library = useContext(FileLibraryContext);
  if (!library) throw new Error('File library is not initialized');
  return library;
}
