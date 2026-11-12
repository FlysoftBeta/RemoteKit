import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type { LibraryMethods, LibrarySnapshot } from '../../shared/file-library';
import { FILE_LIMITS } from '../../shared/product';
import { operationId } from '../control/product-operations';
import { notices, presentFailure } from '../failures';
import { recoveryDelay } from '../failures/recovery';
import { Store } from '../util/store';
import type { FileChannel } from './file-channel';

interface ImportJob {
  file: File;
  operationId: string;
  assetId?: string;
}
interface ImportBatch {
  jobs: ImportJob[];
  origin: LibraryMethods['library.import']['params']['origin'];
  afterId?: string;
}
interface ImportState {
  readonly remaining: number;
  readonly busy: boolean;
  readonly error?: RemoteKitError;
  readonly jobs: { id: string; name: string; error?: RemoteKitError }[];
}
interface ImportServices {
  rpc: Pick<FileChannel, 'uploadAsset'>;
  mutate(
    method: 'library.import',
    params: LibraryMethods['library.import']['params'],
  ): Promise<LibrarySnapshot>;
}

export class ImportQueue extends Store<ImportState> {
  private visible = 0;
  show = () => {
    this.visible++;
    this.emit();
    return () => {
      this.visible--;
      this.emit();
    };
  };
  private batches: ImportBatch[] = [];
  private controller?: AbortController;
  private online = false;
  private scope?: string;
  private error?: RemoteKitError;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  constructor(
    private readonly services: ImportServices,
    private readonly destination: 'library' | 'basket',
  ) {
    super({ remaining: 0, busy: false, jobs: [] });
  }
  configure(online: boolean, scope: string | undefined) {
    if (online === this.online && scope === this.scope) return;
    if (scope !== this.scope) this.discard();
    this.scope = scope;
    this.online = online;
    if (!online) this.controller?.abort();
    else if (
      this.batches.length &&
      !this.controller &&
      (!this.error || recoveryDelay(this.error, 0) !== undefined)
    )
      void this.upload();
  }
  enqueue = (files: File[], basketSize: number, origin: ImportBatch['origin'], afterId?: string) => {
    if (!files.length) return false;
    const maxFiles = this.destination === 'basket' ? 64 - basketSize - this.getSnapshot().remaining : 64;
    if (files.length > maxFiles)
      throw new RemoteKitError('limit_exceeded', `本次最多可添加 ${maxFiles} 个文件`, {
        capacity: this.destination === 'basket' ? 'basket' : 'selection',
      });
    if (files.some((file) => file.size > FILE_LIMITS.maxFileBytes))
      throw new RemoteKitError('limit_exceeded', '单个文件不能超过 256 MiB', { capacity: 'file' });
    const empty = !this.batches.length;
    this.batches.push({
      jobs: files.map((file) => ({ file, operationId: operationId() })),
      origin: { ...origin },
      afterId,
    });
    this.emit();
    if (empty) void this.upload();
    return true;
  };
  capacityChanged = () => {
    if (this.error?.code === 'limit_exceeded') void this.upload();
  };
  discard = () => {
    for (const batch of this.batches)
      for (const job of batch.jobs) notices.resolve('task:upload:' + job.operationId);
    this.controller?.abort();
    this.batches = [];
    this.error = undefined;
    clearTimeout(this.retryTimer);
    this.emit();
  };
  dispose = () => {
    this.online = false;
    this.discard();
  };
  upload = async () => {
    if (!this.batches.length || this.controller || !this.online) return;
    const abort = new AbortController();
    this.controller = abort;
    this.error = undefined;
    clearTimeout(this.retryTimer);
    this.emit();
    let batch: ImportBatch | undefined;
    try {
      while (this.batches.length && !abort.signal.aborted) {
        batch = this.batches[0];
        const job = batch.jobs[0];
        job.assetId ??= (
          await this.services.rpc.uploadAsset(job.file, job.operationId, abort.signal)
        ).assetId;
        if (abort.signal.aborted || this.batches[0] !== batch) break;
        const next = await this.services.mutate('library.import', {
          operationId: job.operationId,
          assetId: job.assetId,
          name: job.file.name,
          origin: batch.origin,
          destination: this.destination,
          afterId: batch.afterId,
        });
        if (abort.signal.aborted || this.batches[0] !== batch) break;
        // Preserve the same operation identity across a lost mutation response.
        if (this.destination === 'basket' && batch.afterId) {
          const index = next.basket.indexOf(batch.afterId);
          if (index >= 0) batch.afterId = next.basket[index + 1] ?? batch.afterId;
        }
        this.attempt = 0;
        notices.resolve('task:upload:' + job.operationId);
        if (!this.visible)
          notices.post('task:upload:' + job.operationId, { class: 'B', text: '文件已导入我的文件' });
        batch.jobs.shift();
        if (!batch.jobs.length) this.batches.shift();
        this.emit();
      }
    } catch (error) {
      if (!abort.signal.aborted && this.batches[0] === batch) {
        this.error = toRemoteKitError(error);
        const delay = recoveryDelay(this.error, this.attempt++);
        if (delay !== undefined) this.retryTimer = setTimeout(() => void this.upload(), delay);
      }
    } finally {
      this.controller = undefined;
      this.emit();
      if (abort.signal.aborted && this.online && this.batches.length) void this.upload();
    }
  };
  private emit() {
    for (const batch of this.batches)
      for (const job of batch.jobs) {
        const key = 'task:upload:' + job.operationId;
        if (this.visible) notices.resolve(key);
        else
          notices.post(
            key,
            presentFailure(this.error ?? new RemoteKitError('unavailable', ''), {
              operation: '导入文件',
              scope: 'global',
              targetId: job.operationId,
              itemName: job.file.name,
            }),
          );
      }
    this.publish({
      remaining: this.batches.reduce((total, batch) => total + batch.jobs.length, 0),
      busy: !!this.controller && !this.controller.signal.aborted,
      error: this.error,
      jobs: this.batches.flatMap((batch, batchIndex) =>
        batch.jobs.map((job, index) => ({
          id: job.operationId,
          name: job.file.name,
          error: batchIndex === 0 && index === 0 ? this.error : undefined,
        })),
      ),
    });
  }
}

export type ImportControls = Pick<ImportQueue, 'subscribe' | 'getSnapshot' | 'enqueue' | 'discard' | 'show'>;
