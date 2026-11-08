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
  remaining: number;
  busy: boolean;
  error?: string;
}
interface ImportServices {
  rpc: Pick<FileChannel, 'uploadAsset'>;
  mutate(
    method: 'library.import',
    params: LibraryMethods['library.import']['params'],
  ): Promise<LibrarySnapshot>;
}

export class ImportQueue extends Store<ImportState> {
  private batch?: ImportBatch;
  private controller?: AbortController;
  private online = false;
  private scope?: string;
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
    if (!files.length || this.batch) return;
    const maxFiles = this.destination === 'basket' ? 64 - basketSize : 64;
    if (files.length > maxFiles || files.some((file) => file.size > FILE_LIMITS.maxFileBytes)) {
      throw new RemoteKitError('limit_exceeded', '选择的文件数量或大小超出限制');
    }
    this.batch = {
      jobs: files.map((file) => ({ file, operationId: operationId() })),
      origin: { ...origin },
      afterId,
    };
    this.publish({ remaining: files.length, busy: false });
    void this.upload();
  };
  discard = () => {
    this.controller?.abort();
    this.batch = undefined;
    this.publish({ remaining: 0, busy: false });
  };
  dispose = () => {
    this.online = false;
    this.discard();
  };
  upload = async () => {
    const batch = this.batch;
    if (!batch || this.controller || !this.online) return;
    const abort = new AbortController();
    this.controller = abort;
    this.publish({ ...this.getSnapshot(), busy: true, error: undefined });
    try {
      while (batch.jobs.length && !abort.signal.aborted && this.batch === batch) {
        const job = batch.jobs[0];
        job.assetId ??= (
          await this.services.rpc.uploadAsset(job.file, job.operationId, abort.signal)
        ).assetId;
        if (abort.signal.aborted || this.batch !== batch) break;
        const next = await this.services.mutate('library.import', {
          operationId: job.operationId,
          assetId: job.assetId,
          name: job.file.name,
          origin: batch.origin,
          destination: this.destination,
          afterId: batch.afterId,
        });
        if (this.batch !== batch) break;
        // Preserve the same operation identity across a lost mutation response.
        if (this.destination === 'basket' && batch.afterId) {
          const index = next.basket.indexOf(batch.afterId);
          if (index >= 0) batch.afterId = next.basket[index + 1] ?? batch.afterId;
        }
        batch.jobs.shift();
        this.publish({ ...this.getSnapshot(), remaining: batch.jobs.length });
      }
      if (this.batch === batch && !batch.jobs.length) this.discard();
    } catch (error) {
      if (!abort.signal.aborted && this.batch === batch)
        this.publish({ ...this.getSnapshot(), error: formatError(error) });
    } finally {
      this.controller = undefined;
      if (this.batch === batch) this.publish({ ...this.getSnapshot(), busy: false });
      else if (this.batch) void this.upload();
    }
  };
}
