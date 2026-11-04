import { useEffect, useRef, useState } from 'react';
import type { LibraryEntry, LibraryMethods, LibrarySnapshot, PhotoMetadata } from '../shared/file-library';
import type { DcFileClient } from './dc-file-client';
import type { CapturedBurst } from './camera-capture';
import { operationId } from './product-operations';

interface PhotoServices {
    mutate<K extends 'library.import' | 'library.replace'>(method: K, params: LibraryMethods[K]['params']): Promise<LibrarySnapshot>;
    latestSnapshot: () => LibrarySnapshot | undefined;
    rpc: DcFileClient;
}
// At most two retained bursts, each with two lossless images from an 8 Mi pixel source.
const maxEncodedBytesPerJob = 72 * 1024 * 1024;
const maxPhotoJobs = 2;
const lowQualityWarning = '照片可能不够清晰，可查看或重拍';

export interface PhotoDestination {
    destination: 'basket' | 'library';
    insertion?: { afterId?: string };
    groupId: string | null;
    replace?: LibraryEntry;
}

export interface PhotoJob extends PhotoDestination {
    id: string;
    mode: PhotoMetadata['mode'];
    state: 'sampling' | 'processing' | 'committing' | 'error' | 'choice' | 'scan-error';
    preview?: Blob;
    candidates?: string[];
    originalId?: string;
    error?: string;
    warning?: string;
    retryable?: boolean;
}

interface Task extends PhotoJob {
    controller: AbortController;
    burst?: CapturedBurst;
    retake?: boolean;
    resume?: () => Promise<void>;
    waiting?: () => Promise<void>;
}

export function usePhotoJobs(services: PhotoServices, available: boolean, identity?: string) {
    const [jobs, setJobs] = useState<PhotoJob[]>([]);
    const tasks = useRef(new Map<string, Task>());
    const chain = useRef(Promise.resolve());
    const current = useRef({ available, identity });
    current.current = { available, identity };
    const publish = () => setJobs([...tasks.current.values()].map(({ controller, burst, retake, resume, waiting, ...job }) => job));
    function dispose(task: Task) {
        task.burst = undefined;
        task.resume = undefined;
        task.waiting = undefined;
        task.controller.abort();
    }
    useEffect(() => {
        setJobs([]);
        return () => {
            tasks.current.forEach(dispose);
            tasks.current.clear();
            chain.current = Promise.resolve();
        };
    }, [available, identity]);

    function reserve(destination: PhotoDestination, mode: PhotoMetadata['mode']) {
        if (!available || tasks.current.size >= maxPhotoJobs ||
            [...tasks.current.values()].some(task => task.state === 'sampling' || destination.replace && task.replace?.id === destination.replace.id)) return;
        const task: Task = { ...destination, id: operationId(), mode, state: 'sampling', retake: !!destination.replace, controller: new AbortController() };
        tasks.current.set(task.id, task);
        publish();
        return { id: task.id, signal: task.controller.signal };
    }

    function update(id: string, fields: Partial<PhotoJob>) {
        const task = tasks.current.get(id);
        if (task) { Object.assign(task, fields); publish(); }
    }

    function cancel(id: string) {
        const task = tasks.current.get(id);
        if (!task || task.state === 'committing') return;
        dispose(task);
        tasks.current.delete(id);
        publish();
        advance(task.destination);
    }

    function valid(task: Task) {
        return !task.controller.signal.aborted && current.current.available &&
            current.current.identity === identity && tasks.current.get(task.id) === task;
    }

    async function save(task: Task, assetId: string, photo: PhotoMetadata, originalAssetId?: string) {
        if (!valid(task)) return;
        const latest = services.latestSnapshot();
        const target = task.replace;
        if (target) {
            const entry = latest?.entries.find(item => item.id === target.id);
            if (!latest || !entry || JSON.stringify(entry) !== JSON.stringify(target) ||
                (task.destination === 'basket' && !latest.basket.includes(target.id))) {
                throw new Error('原文件已更新，请重新拍摄或选片');
            }
            const params = { operationId: operationId(), expectedRevision: latest.revision,
                entryId: target.id, assetId, originalAssetId, photo };
            task.resume = async () => { await services.mutate('library.replace', params); };
        } else {
            const name = `photo-${task.id}.png`;
            const params = { operationId: task.id, assetId, photo, originalAssetId,
                name, groupId: task.groupId, destination: task.destination, afterId: task.insertion?.afterId };
            task.resume = async () => {
                const next = await services.mutate('library.import', params);
                if (task.insertion && task.insertion.afterId && valid(task)) {
                    const inserted = next.entries.find(entry => entry.name === name);
                    if (inserted) task.insertion.afterId = inserted.id;
                }
            };
        }
        await commit(task);
    }

    async function commit(task: Task) {
        if (!valid(task) || !task.resume) return;
        update(task.id, { state: 'committing' });
        await task.resume();
        if (valid(task)) {
            tasks.current.delete(task.id);
            publish();
            advance(task.destination);
        }
    }
    async function finish(task: Task, originalId: string, useOriginal = false) {
        const photo: PhotoMetadata = { mode: task.mode, warning: task.warning };
        let assetId = originalId;
        if (task.mode === 'scan' && !useOriginal) {
            try { assetId = (await services.rpc.processPhoto(originalId, 'scan', task.controller.signal)).assetId; }
            catch (failure) {
                if (!valid(task)) return;
                const warning = failure instanceof Error ? failure.message : '文档扫描未完成';
                if (task.retake) {
                    update(task.id, { state: 'scan-error', originalId, candidates: undefined, error: warning });
                    return;
                }
                Object.assign(photo, { pending: 'scan-error', warning: task.warning ?? warning });
            }
        }
        await save(task, assetId, photo, assetId === originalId ? undefined : originalId);
    }

    function enqueue(task: Task, action: () => Promise<void>) {
        chain.current = chain.current.then(async () => {
            if (!valid(task)) return;
            try { await action(); }
            catch (failure) {
                if (valid(task)) update(task.id, { state: 'error', retryable: !!(task.resume || task.burst), error: failure instanceof Error ? failure.message : '照片处理未完成' });
            }
        });
    }

    function advance(destination: PhotoDestination['destination']) {
        const task = [...tasks.current.values()].find(item => !item.replace && item.destination === destination);
        if (!task?.waiting) return;
        const action = task.waiting;
        task.waiting = undefined;
        enqueue(task, action);
    }

    function capture(id: string, result: Promise<CapturedBurst>) {
        const task = tasks.current.get(id);
        if (!task) { void result.catch(() => {}); return; }
        // Attach before earlier jobs complete, including when the capture rejects.
        let failure: unknown;
        const settled = result.then(burst => {
            if (!valid(task)) return;
            const size = burst.frames.reduce((total, frame) => total + frame.blob.size, 0);
            if (size > maxEncodedBytesPerJob) { failure = new Error('照片超出处理容量'); return; }
            task.burst = burst;
            const preview = burst.frames.find(frame => frame.frameId === burst.decision.selectedFrameId)?.preview;
            if (preview) update(task.id, { preview });
        }, error => { failure = error; });
        enqueue(task, async () => {
            await settled;
            if (!valid(task)) return;
            if (failure) throw failure;
            // A failed predecessor holds its insertion place until retried or removed.
            const first = [...tasks.current.values()].find(item => !item.replace && item.destination === task.destination);
            if (!task.replace && first !== task) {
                task.waiting = () => upload(task);
                return;
            }
            await upload(task);
        });
    }
    async function uploadFrames(task: Task) {
        const burst = task.burst;
        if (!burst) return;
        const { frames, decision } = burst;
        const assets = new Map<string, string>();
        for (const frame of frames) {
            if (!valid(task)) return;
            const asset = await services.rpc.uploadAsset(new File([frame.blob], 'photo.png', { type: 'image/png' }),
                operationId(), task.controller.signal);
            if (!valid(task)) return;
            assets.set(frame.frameId, asset.assetId);
        }
        task.burst = undefined;
        const originalId = assets.get(decision.selectedFrameId);
        if (!originalId) throw new Error('无法确认拍摄结果');
        const candidates = [...new Set([originalId, ...decision.candidates.flatMap(item => assets.get(item.frameId) ?? [])])];
        return { originalId, candidates, uncertain: decision.uncertain, reason: decision.reason };
    }

    async function upload(task: Task) {
        const result = await uploadFrames(task);
        if (!result || !valid(task)) return;
        const { originalId, candidates, uncertain, reason } = result;
        if (uncertain && candidates.length > 1) {
            if (task.replace) {
                update(task.id, { state: 'choice', originalId, candidates });
                return;
            }
            await save(task, originalId, { mode: task.mode, pending: 'choice', candidateAssetIds: candidates });
        } else {
            if (reason === 'low-quality') update(task.id, { warning: lowQualityWarning });
            await finish(task, originalId);
        }
    }

    function retry(id: string) {
        const task = tasks.current.get(id);
        if (!task?.retryable || task.state !== 'error') return;
        update(id, { state: 'processing', error: undefined });
        enqueue(task, () => task.resume ? commit(task) : upload(task));
    }

    function resolve(entry: LibraryEntry, destination: PhotoDestination['destination'], assetId: string, useOriginal = false, id?: string) {
        const existing = id && tasks.current.get(id);
        if (existing && existing.state !== 'choice' && existing.state !== 'scan-error') return;
        if (!existing && (!entry.photo?.pending || !available || tasks.current.size >= maxPhotoJobs ||
            [...tasks.current.values()].some(task => task.replace?.id === entry.id))) return;
        const task: Task = existing || { id: operationId(), controller: new AbortController(), destination,
            groupId: entry.groupId, replace: entry, mode: entry.photo!.mode, state: 'processing',
            warning: entry.photo?.warning === lowQualityWarning ? lowQualityWarning : undefined };
        tasks.current.set(task.id, task);
        update(task.id, { state: 'processing', error: undefined });
        enqueue(task, () => finish(task, assetId, useOriginal));
    }

    return { jobs, reserve, update, cancel, capture, retry, resolve };
}
