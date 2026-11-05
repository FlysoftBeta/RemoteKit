import { diagnostics } from '../media/diagnostics';
import { Store } from '../util/store';
import { formatError } from '../util/format-error';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryEntry, LibraryMethods, LibrarySnapshot, PhotoMetadata } from '../../shared/file-library';
import type { CapturedBurst } from './camera-capture';
import { operationId } from '../control/product-operations';
import type { FileChannel } from './file-channel';

export interface PhotoServices {
  mutate<K extends 'library.import' | 'library.replace'>(
    method: K,
    params: LibraryMethods[K]['params'],
  ): Promise<LibrarySnapshot>;
  latestSnapshot: () => LibrarySnapshot | undefined;
  rpc: Pick<FileChannel, 'uploadAsset' | 'processPhoto'>;
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
      [...this.tasks.values()].map(({ controller, burst, retake, resume, waiting, ...job }) => ({
        ...job,
        insertion: job.insertion && { ...job.insertion },
        candidates: job.candidates && [...job.candidates],
      })),
    );
  }
  private disposeTask(task: Task) {
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
      id: operationId(),
      mode,
      state: 'sampling',
      retake: !!destination.replace,
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

  private async save(task: Task, assetId: string, photo: PhotoMetadata, originalAssetId?: string) {
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
        assetId,
        originalAssetId,
        photo,
      };
      task.resume = async () => {
        await this.services.mutate('library.replace', params);
      };
    } else {
      const name = `photo-${task.id}.png`;
      const params = {
        operationId: task.id,
        assetId,
        photo,
        originalAssetId,
        name,
        groupId: task.groupId,
        destination: task.destination,
        afterId: task.insertion?.afterId,
      };
      task.resume = async () => {
        const next = await this.services.mutate('library.import', params);
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
  private async finish(task: Task, originalId: string, useOriginal = false) {
    const photo: PhotoMetadata = { mode: task.mode, warning: task.warning };
    let assetId = originalId;
    if (task.mode === 'scan' && !useOriginal) {
      try {
        assetId = (await this.services.rpc.processPhoto(originalId, 'scan', task.controller.signal)).assetId;
      } catch (failure) {
        if (!this.valid(task)) return;
        const warning = formatError(failure);
        if (task.retake) {
          this.update(task.id, { state: 'scan-error', originalId, candidates: undefined, error: warning });
          return;
        }
        Object.assign(photo, { pending: 'scan-error', warning: task.warning ?? warning });
      }
    }
    await this.save(task, assetId, photo, assetId === originalId ? undefined : originalId);
  }

  private enqueue(task: Task, action: () => Promise<void>) {
    this.chain = this.chain.then(async () => {
      if (!this.valid(task)) return;
      try {
        await action();
      } catch (failure) {
        if (this.valid(task))
          this.update(task.id, {
            state: 'error',
            retryable: !!(task.resume || task.burst),
            error: formatError(failure),
          });
      }
    });
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
      const asset = await this.services.rpc.uploadAsset(
        new File([frame.blob], 'photo.png', { type: 'image/png' }),
        operationId(),
        task.controller.signal,
      );
      if (!this.valid(task)) return;
      assets.set(frame.frameId, asset.assetId);
    }
    task.burst = undefined;
    const originalId = assets.get(decision.selectedFrameId);
    if (!originalId) throw new RemoteKitError('outcome_unknown', '无法确认拍摄结果');
    const candidates = [
      ...new Set([originalId, ...decision.candidates.flatMap((item) => assets.get(item.frameId) ?? [])]),
    ];
    return { originalId, candidates, uncertain: decision.uncertain, reason: decision.reason };
  }

  private async upload(task: Task) {
    const result = await this.uploadFrames(task);
    if (!result || !this.valid(task)) return;
    const { originalId, candidates, uncertain, reason } = result;
    if (uncertain && candidates.length > 1) {
      if (task.replace) {
        this.update(task.id, { state: 'choice', originalId, candidates });
        return;
      }
      await this.save(task, originalId, {
        mode: task.mode,
        pending: 'choice',
        candidateAssetIds: candidates,
      });
    } else {
      if (reason === 'low-quality') this.update(task.id, { warning: lowQualityWarning });
      await this.finish(task, originalId);
    }
  }

  retry = (id: string) => {
    const task = this.tasks.get(id);
    if (!task?.retryable || task.state !== 'error') return;
    this.update(id, { state: 'processing', error: undefined });
    this.enqueue(task, () => (task.resume ? this.commit(task) : this.upload(task)));
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
    if (
      !existing &&
      (!entry.photo?.pending ||
        !this.available ||
        this.tasks.size >= maxPhotoJobs ||
        [...this.tasks.values()].some((task) => task.replace?.id === entry.id))
    )
      return;
    const task: Task = existing || {
      id: operationId(),
      controller: new AbortController(),
      destination,
      groupId: entry.groupId,
      replace: entry,
      mode: entry.photo!.mode,
      state: 'processing',
      warning: entry.photo?.warning === lowQualityWarning ? lowQualityWarning : undefined,
    };
    this.tasks.set(task.id, task);
    this.update(task.id, { state: 'processing', error: undefined });
    this.enqueue(task, () => this.finish(task, assetId, useOriginal));
  };
}
