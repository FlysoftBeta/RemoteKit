import type { AssetDescription } from '../../shared/file-library';
import { RemoteKitError } from '../../shared/errors';
import { diagnostics } from '../media/diagnostics';
import type { FileChannel } from './file-channel';

export type PhotoLayer = 1280 | 2560 | 'original';
export interface PhotoPreview {
  blob: Blob;
  asset: AssetDescription;
  source: AssetDescription;
}

export class PhotoPreviewCache {
  private readonly values = new Map<string, PhotoPreview>();
  private readonly pending = new Map<string, Promise<PhotoPreview>>();
  private readonly scope = new AbortController();
  private bytes = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly rpc: Pick<FileChannel, 'photoPreview' | 'describeAsset' | 'readPhoto'>) {}
  get(assetId: string, layer: PhotoLayer): Promise<PhotoPreview> {
    const key = `${assetId}:${layer}`;
    const value = this.values.get(key);
    if (value) {
      this.values.delete(key);
      this.values.set(key, value);
      return Promise.resolve(value);
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 12) return Promise.reject(new RemoteKitError('busy', '照片预览队列繁忙'));
    const task = this.tail
      .then(async () => {
        if (this.scope.signal.aborted) throw new RemoteKitError('canceled', '');
        const asset =
          layer === 'original'
            ? await this.rpc.describeAsset(assetId, this.scope.signal)
            : await this.rpc.photoPreview(assetId, layer, this.scope.signal);
        const source =
          asset.assetId === assetId ? asset : await this.rpc.describeAsset(assetId, this.scope.signal);
        const blob = await this.rpc.readPhoto(asset, this.scope.signal);
        if (this.scope.signal.aborted) throw new RemoteKitError('canceled', '');
        const preview = { blob, asset, source };
        if (blob.size <= 48 * 1024 * 1024) {
          this.values.set(key, preview);
          this.bytes += blob.size;
          while (this.bytes > 48 * 1024 * 1024 || this.values.size > 12) {
            const oldest = this.values.keys().next().value!;
            this.bytes -= this.values.get(oldest)!.blob.size;
            this.values.delete(oldest);
          }
        }
        return preview;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    this.tail = task.catch((failure) => {
      if (!this.scope.signal.aborted) diagnostics.record('photo-preview-cache', failure);
    });
    return task;
  }
  dispose() {
    this.scope.abort();
    this.values.clear();
    this.pending.clear();
    this.bytes = 0;
  }
}
