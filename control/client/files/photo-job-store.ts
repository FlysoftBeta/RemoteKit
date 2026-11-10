import { errorHandling, retryDelay } from '../../shared/error-policy';
import { diagnostics } from '../media/diagnostics';
import { Store } from '../util/store';
import { formatError } from '../util/format-error';
import { RemoteKitError } from '../../shared/errors';
import type {
  Asset,
  LibraryEntry,
  LibraryMethods,
  LibrarySnapshot,
  PhotoMetadata,
} from '../../shared/file-library';
import type { CapturedBurst } from './camera-capture';
import { operationId } from '../control/product-operations';
import type { FileChannel, ProcessedPhoto } from './file-channel';

export interface PhotoServices {
  mutate<K extends 'library.import' | 'library.replace'>(
    method: K,
    params: LibraryMethods[K]['params'],
    windowId?: string,
  ): Promise<LibrarySnapshot>;
  latestSnapshot: () => LibrarySnapshot | undefined;
  rpc: Pick<FileChannel, 'uploadAsset' | 'processPhoto'>;
}
// One job retains at most two JPEG originals from an 8 Mi pixel source.
const maxEncodedBytesPerJob = 24 * 1024 * 1024;
const maxPhotoJobs = 2;
const lowQualityWarning = '照片可能不够清晰，可查看或重拍';

export interface PhotoDestination {
  windowId?: string;
  destination: 'basket' | 'library';
  insertion?: { afterId?: string };
  origin: LibraryMethods['library.import']['params']['origin'];
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
  rotationTurns?: number;
}

interface Task extends PhotoJob {
  controller: AbortController;
  burst?: CapturedBurst;
  uploads?: Map<string, { operationId: string; assetId?: string }>;
  process?: () => Promise<void>;
  rotationTimer?: ReturnType<typeof setTimeout>;
  resume?: () => Promise<void>;
  waiting?: () => Promise<void>;
}

export class PhotoJobStore extends Store<readonly PhotoJob[]> {
  private tasks = new Map<string, Task>();
  private chain = Promise.resolve();
  private available = false;
  private identity?: string;
  constructor(private readonly services: PhotoServices) {
    super([]);
  }
  configure(available: boolean, identity?: string) {
    if (available === this.available && identity === this.identity) return;
    this.dispose();
    this.available = available;
    this.identity = identity;
  }
  dispose = () => {
    this.tasks.forEach((task) => this.disposeTask(task));
    this.tasks.clear();
    this.chain = Promise.resolve();
    this.available = false;
    this.emit();
  };
  private emit() {
    this.publish(
      [...this.tasks.values()].map(
        ({ controller, burst, process, rotationTimer, resume, waiting, uploads, ...job }) => ({
          ...job,
          origin: { ...job.origin },
          insertion: job.insertion && { ...job.insertion },
          candidates: job.candidates && [...job.candidates],
        }),
      ),
    );
  }
  private disposeTask(task: Task) {
    clearTimeout(task.rotationTimer);
    task.process = undefined;
    task.burst = undefined;
    task.resume = undefined;
    task.waiting = undefined;
    task.controller.abort();
  }
  reserve = (destination: PhotoDestination, mode: PhotoMetadata['mode']) => {
    if (
      !this.available ||
      this.tasks.size >= maxPhotoJobs ||
      [...this.tasks.values()].some(
        (task) =>
          task.state === 'sampling' || (destination.replace && task.replace?.id === destination.replace.id),
      )
    )
      return;
    const task: Task = {
      ...destination,
      origin: { ...destination.origin },
      id: operationId(),
      mode,
      state: 'sampling',
      controller: new AbortController(),
    };
    this.tasks.set(task.id, task);
    this.emit();
    return { id: task.id, signal: task.controller.signal };
  };

  update = (id: string, fields: Partial<PhotoJob>) => {
    const task = this.tasks.get(id);
    if (task) {
      Object.assign(task, fields);
      this.emit();
    }
  };

  cancel = (id: string) => {
    const task = this.tasks.get(id);
    if (!task || task.state === 'committing') return;
    this.disposeTask(task);
    this.tasks.delete(id);
    this.emit();
    this.advance(task.destination);
  };

  private valid(task: Task) {
    return !task.controller.signal.aborted && this.available && this.tasks.get(task.id) === task;
  }

  private async save(
    task: Task,
    asset: Pick<Asset, 'assetId' | 'type'>,
    photo: PhotoMetadata,
    originalAssetId: string,
  ) {
    if (!this.valid(task)) return;
    const latest = this.services.latestSnapshot();
    const target = task.replace;
    if (target) {
      const entry = latest?.entries.find((item) => item.id === target.id);
      if (
        !latest ||
        !entry ||
        JSON.stringify(entry) !== JSON.stringify(target) ||
        (task.destination === 'basket' && !latest.basket.includes(target.id))
      ) {
        throw new RemoteKitError('conflict', '原文件已更新，请重新拍摄或选片');
      }
      const params = {
        operationId: operationId(),
        expectedRevision: latest.revision,
        entryId: target.id,
        assetId: asset.assetId,
        originalAssetId,
        photo,
      };
      task.resume = async () => {
        await this.services.mutate('library.replace', params);
      };
    } else {
      const extension = asset.type === 'image/jpeg' ? 'jpg' : asset.type.split('/')[1];
      const name = `photo-${task.id}.${extension}`;
      const params = {
        operationId: task.id,
        assetId: asset.assetId,
        photo,
        originalAssetId,
        name,
        origin: task.origin,
        destination: task.destination,
        afterId: task.insertion?.afterId,
      };
      task.resume = async () => {
        const next = await this.services.mutate('library.import', params, task.windowId);
        if (task.insertion && task.insertion.afterId && this.valid(task)) {
          const inserted = next.entries.find((entry) => entry.name === name);
          if (inserted) task.insertion.afterId = inserted.id;
        }
      };
    }
    await this.commit(task);
  }

  private async commit(task: Task) {
    if (!this.valid(task) || !task.resume) return;
    this.update(task.id, { state: 'committing' });
    await task.resume();
    if (this.valid(task)) {
      this.tasks.delete(task.id);
      this.emit();
      this.advance(task.destination);
    }
  }
  private async finish(task: Task, originalId: string, quarterTurns?: 0 | 1 | 2 | 3) {
    let asset: ProcessedPhoto;
    try {
      asset = await this.services.rpc.processPhoto(
        originalId,
        task.mode,
        quarterTurns,
        task.controller.signal,
      );
    } catch (failure) {
      if (!this.valid(task)) return;
      if (task.mode !== 'scan' || task.rotationTurns !== undefined) throw failure;
      const warning = formatError(failure);
      if (task.replace) {
        this.update(task.id, {
          state: 'scan-error',
          originalId,
          candidates: undefined,
          error: warning,
        });
      } else {
        await this.save(
          task,
          { assetId: originalId, type: 'image/jpeg' },
          { mode: task.mode, pending: 'scan-error', warning },
          originalId,
        );
      }
      return;
    }
    if (!this.valid(task)) return;
    const photo: PhotoMetadata = {
      mode: task.mode,
      warning: task.warning,
      ...(asset.quarterTurns ? { quarterTurns: asset.quarterTurns } : {}),
    };
    await this.save(task, asset, photo, originalId);
  }

  private async execute(task: Task, action: () => Promise<void>) {
    if (!this.valid(task)) return;
    try {
      await action();
    } catch (failure) {
      if (this.valid(task))
        this.update(task.id, {
          state: 'error',
          retryable:
            !!(task.resume || task.burst || task.process) &&
            failure instanceof RemoteKitError &&
            (retryDelay(failure, 0) !== undefined ||
              failure.code === 'limit_exceeded' ||
              (errorHandling(failure.code) === 'reconcile' && !!task.resume)),
          error: formatError(failure),
        });
    }
  }

  private enqueue(task: Task, action: () => Promise<void>) {
    this.chain = this.chain.then(() => this.execute(task, action));
  }

  private advance(destination: PhotoDestination['destination']) {
    const task = [...this.tasks.values()].find((item) => !item.replace && item.destination === destination);
    if (!task?.waiting) return;
    const action = task.waiting;
    task.waiting = undefined;
    this.enqueue(task, action);
  }

  capture = (id: string, result: Promise<CapturedBurst>) => {
    const task = this.tasks.get(id);
    if (!task) {
      void result.catch((error) => diagnostics.record('photo-jobs', error));
      return;
    }
    // Attach before earlier jobs complete, including when the capture rejects.
    let failure: unknown;
    const settled = result.then(
      (burst) => {
        if (!this.valid(task)) return;
        const size = burst.frames.reduce((total, frame) => total + frame.blob.size, 0);
        if (size > maxEncodedBytesPerJob) {
          failure = new RemoteKitError('limit_exceeded', '照片超出处理容量');
          return;
        }
        task.burst = burst;
        const preview = burst.frames.find(
          (frame) => frame.frameId === burst.decision.selectedFrameId,
        )?.preview;
        if (preview) this.update(task.id, { preview });
      },
      (error) => {
        failure = error;
      },
    );
    this.enqueue(task, async () => {
      await settled;
      if (!this.valid(task)) return;
      if (failure) throw failure;
      // A failed predecessor holds its insertion place until retried or removed.
      const first = [...this.tasks.values()].find(
        (item) => !item.replace && item.destination === task.destination,
      );
      if (!task.replace && first !== task) {
        task.waiting = () => this.upload(task);
        return;
      }
      await this.upload(task);
    });
  };
  private async uploadFrames(task: Task) {
    const burst = task.burst;
    if (!burst) return;
    const { frames, decision } = burst;
    const assets = new Map<string, string>();
    for (const frame of frames) {
      if (!this.valid(task)) return;
      task.uploads ??= new Map();
      let upload = task.uploads.get(frame.frameId);
      if (!upload) {
        upload = { operationId: operationId() };
        task.uploads.set(frame.frameId, upload);
      }
      const asset = upload.assetId
        ? { assetId: upload.assetId }
        : await this.services.rpc.uploadAsset(
            new File([frame.blob], 'photo.jpg', { type: 'image/jpeg' }),
            upload.operationId,
            task.controller.signal,
          );
      if (!this.valid(task)) return;
      upload.assetId = asset.assetId;
      assets.set(frame.frameId, asset.assetId);
    }
    task.burst = undefined;
    const originalId = assets.get(decision.selectedFrameId);
    if (!originalId) throw new RemoteKitError('internal', '拍摄结果缺少选中照片');
    const candidates = [
      ...new Set([originalId, ...decision.candidates.flatMap((item) => assets.get(item.frameId) ?? [])]),
    ];
    return { originalId, candidates, uncertain: decision.uncertain, reason: decision.reason };
  }

  private async upload(task: Task) {
    this.update(task.id, { state: 'processing' });
    const result = await this.uploadFrames(task);
    if (!result || !this.valid(task)) return;
    const { originalId, candidates, uncertain, reason } = result;
    this.update(task.id, { originalId });
    if (uncertain && candidates.length > 1) {
      if (task.replace) {
        this.update(task.id, { state: 'choice', candidates });
      } else {
        await this.save(
          task,
          { assetId: originalId, type: 'image/jpeg' },
          { mode: task.mode, pending: 'choice', candidateAssetIds: candidates },
          originalId,
        );
      }
      return;
    }
    if (reason === 'low-quality') this.update(task.id, { warning: lowQualityWarning });
    task.process = () => this.finish(task, originalId);
    await task.process();
  }

  retry = (id: string) => {
    const task = this.tasks.get(id);
    if (!task?.retryable || task.state !== 'error') return;
    this.update(id, { state: 'processing', error: undefined });
    const action = () =>
      task.resume ? this.commit(task) : task.process ? task.process() : this.upload(task);
    if (task.rotationTurns !== undefined) void this.execute(task, action);
    else this.enqueue(task, action);
  };

  resolve = (
    entry: LibraryEntry,
    destination: PhotoDestination['destination'],
    assetId: string,
    useOriginal = false,
    id?: string,
  ) => {
    const existing = id && this.tasks.get(id);
    if (existing && existing.state !== 'choice' && existing.state !== 'scan-error') return;
    let task = existing || undefined;
    if (!task) {
      if (
        !entry.photo ||
        !this.available ||
        this.tasks.size >= maxPhotoJobs ||
        [...this.tasks.values()].some((item) => item.replace?.id === entry.id)
      )
        return;
      task = {
        id: operationId(),
        controller: new AbortController(),
        destination,
        origin: { kind: 'files', channel: 'camera', partitionId: entry.partitionId },
        replace: entry,
        mode: entry.photo.mode,
        state: 'processing',
        warning: entry.photo.warning === lowQualityWarning ? lowQualityWarning : undefined,
      };
    }
    this.tasks.set(task.id, task);
    if (useOriginal) task.mode = 'photo';
    this.update(task.id, { state: 'processing', error: undefined });
    const quarterTurns = useOriginal ? (entry.photo?.quarterTurns ?? 0) : undefined;
    task.process = () => this.finish(task, assetId, quarterTurns);
    this.enqueue(task, task.process);
  };

  rotate = (entry: LibraryEntry, destination: PhotoDestination['destination']) => {
    if (!entry.photo || entry.photo.pending || !this.available) return;
    const existing = [...this.tasks.values()].find((task) => task.replace?.id === entry.id);
    if (existing && (existing.rotationTurns === undefined || existing.state === 'committing')) return;
    if (!existing && this.tasks.size >= maxPhotoJobs) return;
    const target = existing?.replace ?? entry;
    const rotationTurns = ((existing?.rotationTurns ?? 0) + 1) % 4;
    if (existing) {
      this.disposeTask(existing);
      this.tasks.delete(existing.id);
    }
    if (!rotationTurns) {
      this.emit();
      return;
    }
    const task: Task = {
      id: existing?.id ?? operationId(),
      controller: new AbortController(),
      destination,
      origin: { kind: 'files', channel: 'camera', partitionId: target.partitionId },
      replace: target,
      mode: target.photo!.mode,
      state: 'processing',
      warning: target.photo?.warning,
      rotationTurns,
    };
    const source = target.originalAssetId ?? target.assetId!;
    const quarterTurns = (((target.photo?.quarterTurns ?? 0) + rotationTurns) % 4) as 0 | 1 | 2 | 3;
    task.process = () => this.finish(task, source, quarterTurns);
    task.rotationTimer = setTimeout(() => {
      task.rotationTimer = undefined;
      void this.execute(task, task.process!);
    }, 600);
    this.tasks.set(task.id, task);
    this.emit();
  };
}
