import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { LibraryMethods, LibrarySnapshot, SelectionState } from '../shared/file-library';
import type { DcFileClient } from './dc-file-client';
import { operationId } from './product-operations';
import { ControlRequestError } from './control-connection';
import { FileThumbnails } from './file-thumbnails';

export type LibraryRequest = <K extends keyof LibraryMethods>(method: K, params: LibraryMethods[K]['params']) => Promise<LibraryMethods[K]['result']>;
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

export function useFileLibrary(request: LibraryRequest, rpc: DcFileClient, online: boolean, enabled: boolean, identity: string | undefined, requestIds: string[]) {
    const [snapshot, setSnapshot] = useState<LibrarySnapshot>();
    const [, render] = useState(0);
    const checkouts = useRef(new Map<string, Checkout>());
    const [thumbnails] = useState(() => new FileThumbnails((assetId, signal) => rpc.photoThumbnail(assetId, signal)));
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
        setSnapshot(old => !old || next.revision > old.revision ? next : old);
    };
    const epoch = authorization.current;
    useEffect(() => {
        setSnapshot(undefined);
        return () => thumbnails.clear();
    }, [identity, enabled, thumbnails]);

    async function mutate<K extends 'library.import' | 'library.basket' | 'library.group' | 'library.move' | 'library.delete'>(method: K, params: LibraryMethods[K]['params']) {
        try {
            const next = await request(method, params);
            publish(next);
            return next;
        } catch (error) {
            if (method === 'library.basket' && error instanceof ControlRequestError && error.code === 409) {
                await refresh().catch(() => {});
                throw new Error('文件篮已更新，请检查当前顺序后重试');
            }
            throw error;
        }
    }

    const refresh = async () => publish(await request('library.get', {}));
    function rememberPreview(assetId: string, blob: Blob) {
        if (currentIdentity.current === identity && active.current && authorization.current === epoch) thumbnails.remember(assetId, blob);
    }

    async function confirm(requestId: string, transaction: Checkout, submit: boolean) {
        if (transaction.active) return;
        transaction.active = true;
        if (submit) transaction.followUntil = Date.now() + 150_000;
        try {
            if (!transaction.selectionId) {
                if (!submit) return;
                try {
                    const { selectionId } = await request('library.prepare', {
                        operationId: transaction.operationId, requestId,
                        entryIds: transaction.entryIds, groupId: transaction.groupId,
                    });
                    transaction.selectionId = selectionId;
                } catch (error) {
                    if (error instanceof ControlRequestError && [400, 404, 409, 413].includes(error.code) &&
                        checkouts.current.get(requestId) === transaction) checkouts.current.delete(requestId);
                    throw error;
                }
            }
            if (currentIdentity.current !== identity || !active.current || authorization.current !== epoch) return;
            if (submit) {
                // Even a lost RTC response can correspond to a successful native callback.
                await rpc.commitSelection(requestId, transaction.selectionId).catch(() => {});
            }
            const result = await request('library.finish', { selectionId: transaction.selectionId });
            transaction.state = result.state;
            publish(result.snapshot);
        } finally {
            transaction.active = false;
            transaction.nextCheck = Date.now() + (transaction.state === 'unknown' ? 15_000 : 1500);
            if (currentIdentity.current === identity && authorization.current === epoch) render(n => n + 1);
        }
    }

    async function select(requestId: string, entryIds: string[], groupId: string | null) {
        let transaction = checkouts.current.get(requestId);
        if (!transaction) {
            transaction = { operationId: operationId(), entryIds, groupId, state: 'pending', active: false, nextCheck: 0, followUntil: 0 };
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
                if (!live && !checkout.active && (terminal || !checkout.selectionId || Date.now() >= checkout.followUntil)) {
                    checkouts.current.delete(id);
                } else if (!terminal && checkout.selectionId && !checkout.active && Date.now() >= checkout.nextCheck) {
                    void confirm(id, checkout, false).catch(() => {});
                    break;
                }
            }
        };
        void refresh().catch(() => {});
        const timer = setInterval(reconcile, 1500);
        return () => clearInterval(timer);
    }, [request, rpc, enabled, online, identity]);

    return { snapshot, refresh, mutate, select, checkout: (id: string) => checkouts.current.get(id),
        rememberPreview, thumbnails, rpc, online };
}

export type FileLibrary = ReturnType<typeof useFileLibrary>;
export const FileLibraryContext = createContext<FileLibrary | null>(null);
export function useLibrary() {
    const library = useContext(FileLibraryContext);
    if (!library) throw new Error('文件服务未初始化');
    return library;
}
