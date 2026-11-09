import { retryDelay, errorHandling } from '../../shared/error-policy';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryMethods, LibrarySnapshot } from '../../shared/file-library';
import { FILE_LIMITS } from '../../shared/product';
import { operationId } from '../control/product-operations';
import { formatError } from '../util/format-error';
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
  readonly error?: string;
  readonly retryable?: boolean;
}
interface ImportServices {
  rpc: Pick<FileChannel, 'uploadAsset'>;
  mutate(
    method: 'library.import',
    params: LibraryMethods['library.import']['params'],
  ): Promise<LibrarySnapshot>;
}

export class ImportQueue extends Store<ImportState> {
  private batches: ImportBatch[] = [];
  private controller?: AbortController;
  private online = false;
  private scope?: string;
  private error?: string;
  private retryable?: boolean;
  constructor(
    private readonly services: ImportServices,
    private readonly destination: 'library' | 'basket',
  ) {
    super({ remaining: 0, busy: false });
  }
  configure(online: boolean, scope: string | undefined) {
    if (scope !== this.scope) this.discard();
    this.scope = scope;
    this.online = online;
    if (!online) this.controller?.abort();
  }
  enqueue = (files: File[], basketSize: number, origin: ImportBatch['origin'], afterId?: string) => {
    if (!files.length) return false;
    const maxFiles = this.destination === 'basket' ? 64 - basketSize - this.getSnapshot().remaining : 64;
    if (files.length > maxFiles)
      throw new RemoteKitError('limit_exceeded', `本次最多可添加 ${maxFiles} 个文件`);
    if (files.some((file) => file.size > FILE_LIMITS.maxFileBytes))
      throw new RemoteKitError('limit_exceeded', '单个文件不能超过 256 MiB');
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
  discard = () => {
    this.controller?.abort();
    this.batches = [];
    this.error = undefined;
    this.retryable = undefined;
    this.emit();
  };
  dispose = () => {
    this.online = false;
    this.discard();
  };
  upload = async () => {
    if (!this.batches.length || this.controller || !this.online || this.retryable === false) return;
    const abort = new AbortController();
    this.controller = abort;
    this.error = undefined;
    this.retryable = undefined;
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
        batch.jobs.shift();
        if (!batch.jobs.length) this.batches.shift();
        this.emit();
      }
    } catch (error) {
      if (!abort.signal.aborted && this.batches[0] === batch) {
        this.error = formatError(error);
        this.retryable =
          error instanceof RemoteKitError &&
          (retryDelay(error, 0) !== undefined ||
            error.code === 'limit_exceeded' ||
            (errorHandling(error.code) === 'reconcile' && !!batch?.jobs[0]?.assetId));
      }
    } finally {
      this.controller = undefined;
      this.emit();
      if (abort.signal.aborted && this.batches.length && this.batches[0] !== batch) void this.upload();
    }
  };
  private emit() {
    this.publish({
      remaining: this.batches.reduce((total, batch) => total + batch.jobs.length, 0),
      busy: !!this.controller && !this.controller.signal.aborted,
      error: this.error,
      retryable: this.retryable,
    });
  }
}

export type ImportControls = Pick<
  ImportQueue,
  'subscribe' | 'getSnapshot' | 'enqueue' | 'discard' | 'upload'
>;
