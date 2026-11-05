import { diagnostics } from './media/diagnostics';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../shared/errors';
import type { LibraryMethods, LibrarySnapshot, SelectionState } from '../shared/file-library';
import { operationId } from './control/product-operations';
import { FileThumbnails } from './file-thumbnails';
import type { FileChannel } from './files/file-channel';
import { usePhotoJobs } from './photo-jobs';

export type LibraryRequest = <K extends keyof LibraryMethods>(
  method: K,
  params: LibraryMethods[K]['params'],
) => Promise<LibraryMethods[K]['result']>;
interface Checkout {
  operationId: string;
  entryIds: string[];
  groupId: string | null;
  selectionId?: string;
  state: SelectionState;
  active: boolean;
  nextCheck: number;
  followUntil: number;
}

export function useFileLibrary(
  request: LibraryRequest,
  rpc: FileChannel,
  online: boolean,
  enabled: boolean,
  identity: string | undefined,
  requestIds: string[],
) {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>();
  const latestSnapshot = useRef<LibrarySnapshot | undefined>(undefined);
  const [, render] = useState(0);
  const checkouts = useRef(new Map<string, Checkout>());
  const [thumbnails] = useState(
    () => new FileThumbnails((assetId, signal) => rpc.photoThumbnail(assetId, signal)),
  );
  const currentIdentity = useRef(identity);
  if (identity && currentIdentity.current !== identity) {
    checkouts.current.clear();
    currentIdentity.current = identity;
  }
  const liveRequests = useRef(requestIds);
  liveRequests.current = requestIds;
  const authorization = useRef(0);
  const active = useRef(enabled);
  if (active.current !== enabled) {
    authorization.current++;
    active.current = enabled;
  }
  const publish = (next: LibrarySnapshot) => {
    if (currentIdentity.current !== identity || !active.current || authorization.current !== epoch) return;
    if (!latestSnapshot.current || next.revision > latestSnapshot.current.revision) {
      latestSnapshot.current = next;
      setSnapshot(next);
    }
  };
  const epoch = authorization.current;
  useEffect(() => {
    latestSnapshot.current = undefined;
    setSnapshot(undefined);
    return () => thumbnails.clear();
  }, [identity, enabled, thumbnails]);

  async function mutate<
    K extends
      | 'library.import'
      | 'library.replace'
      | 'library.basket'
      | 'library.group'
      | 'library.move'
      | 'library.delete',
  >(method: K, params: LibraryMethods[K]['params']) {
    try {
      const next = await request(method, params);
      publish(next);
      return next;
    } catch (error) {
      if (
        (method === 'library.basket' || method === 'library.replace') &&
        error instanceof RemoteKitError &&
        error.code === 'conflict'
      ) {
        await refresh().catch((error) => diagnostics.record('file-library-state', error));
        throw new Error(
          method === 'library.basket' ? '文件篮已更新，请检查当前顺序后重试' : '文件已更新，请重新打开后重试',
        );
      }
      throw error;
    }
  }

  const refresh = async () => publish(await request('library.get', {}));
  async function confirm(requestId: string, transaction: Checkout, submit: boolean) {
    if (transaction.active) return;
    transaction.active = true;
    if (submit) transaction.followUntil = Date.now() + 150_000;
    try {
      if (!transaction.selectionId) {
        if (!submit) return;
        try {
          const { selectionId } = await request('library.prepare', {
            operationId: transaction.operationId,
            requestId,
            entryIds: transaction.entryIds,
            groupId: transaction.groupId,
          });
          transaction.selectionId = selectionId;
        } catch (error) {
          if (
            error instanceof RemoteKitError &&
            ['invalid_request', 'not_found', 'conflict', 'limit_exceeded'].includes(error.code) &&
            checkouts.current.get(requestId) === transaction
          )
            checkouts.current.delete(requestId);
          throw error;
        }
      }
      if (currentIdentity.current !== identity || !active.current || authorization.current !== epoch) return;
      if (submit) {
        // Even a lost RTC response can correspond to a successful native callback.
        await rpc
          .commitSelection(requestId, transaction.selectionId)
          .catch((error) => diagnostics.record('file-library-state', error));
      }
      const result = await request('library.finish', { selectionId: transaction.selectionId });
      transaction.state = result.state;
      publish(result.snapshot);
    } finally {
      transaction.active = false;
      transaction.nextCheck = Date.now() + (transaction.state === 'unknown' ? 15_000 : 1500);
      if (currentIdentity.current === identity && authorization.current === epoch) render((n) => n + 1);
    }
  }

  async function select(requestId: string, entryIds: string[], groupId: string | null) {
    let transaction = checkouts.current.get(requestId);
    if (!transaction) {
      transaction = {
        operationId: operationId(),
        entryIds,
        groupId,
        state: 'pending',
        active: false,
        nextCheck: 0,
        followUntil: 0,
      };
      checkouts.current.set(requestId, transaction);
    }
    await confirm(requestId, transaction, true);
    return transaction.state;
  }

  useEffect(() => {
    if (!enabled || !online || !identity) return;
    // Keep terminal reconciliation alive when a native request disappears or
    // the user navigates away. This path never sends another RTC commit.
    const reconcile = () => {
      for (const [id, checkout] of checkouts.current) {
        const live = liveRequests.current.includes(id);
        const terminal = checkout.state === 'selected' || checkout.state === 'cancelled';
        if (
          !live &&
          !checkout.active &&
          (terminal || !checkout.selectionId || Date.now() >= checkout.followUntil)
        ) {
          checkouts.current.delete(id);
        } else if (
          !terminal &&
          checkout.selectionId &&
          !checkout.active &&
          Date.now() >= checkout.nextCheck
        ) {
          void confirm(id, checkout, false).catch((error) => diagnostics.record('file-library-state', error));
          break;
        }
      }
    };
    void refresh().catch((error) => diagnostics.record('file-library-state', error));
    const timer = setInterval(reconcile, 1500);
    return () => clearInterval(timer);
  }, [request, rpc, enabled, online, identity]);

  const photos = usePhotoJobs(
    { mutate, rpc, latestSnapshot: () => latestSnapshot.current },
    online && enabled && !!identity,
    identity,
  );
  return {
    snapshot,
    refresh,
    mutate,
    select,
    photos,
    checkout: (id: string) => checkouts.current.get(id),
    thumbnails,
    rpc,
    online,
  };
}

export type FileLibrary = ReturnType<typeof useFileLibrary>;
export const FileLibraryContext = createContext<FileLibrary | null>(null);
export function useLibrary() {
  const library = useContext(FileLibraryContext);
  if (!library) throw new Error('文件服务未初始化');
  return library;
}
