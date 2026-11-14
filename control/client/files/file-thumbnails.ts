import { RetryUnit } from '../../shared/retry-unit';
import { toRemoteKitError, type RemoteKitError } from '../../shared/errors';
type Listener = (preview: Preview) => void;
export interface Preview {
  blob?: Blob;
  retryAt?: number;
  error?: RemoteKitError;
}
interface PendingPreview {
  listeners: Set<Listener>;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_PREVIEWS = 96;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 128;

export class FileThumbnails {
  private previews = new Map<string, Preview>();
  private pending = new Map<string, PendingPreview>();
  private readonly units = new Map<string, RetryUnit>();
  private active = 0;
  private bytes = 0;

  constructor(private readonly load: (assetId: string, signal: AbortSignal) => Promise<Blob>) {}

  get(assetId: string): Blob | undefined {
    return this.previews.get(assetId)?.blob;
  }

  remember(assetId: string, blob: Blob) {
    if (blob.size > 128 * 1024) return;
    this.cache(assetId, { blob });
    this.pending.get(assetId)?.listeners.forEach((listener) => listener({ blob }));
  }

  subscribe(assetId: string, listener: Listener) {
    const cached = this.previews.get(assetId);
    if (cached && (!cached.retryAt || cached.retryAt === Infinity)) {
      this.previews.delete(assetId);
      this.previews.set(assetId, cached);
      listener(cached);
      return () => {};
    }
    if (cached) listener(cached);
    let job = this.pending.get(assetId);
    if (!job) {
      if (this.pending.size >= MAX_PENDING) return () => {};
      job = { listeners: new Set() };
      this.pending.set(assetId, job);
    }
    const subscribed = job;
    job.listeners.add(listener);
    this.pump();
    return () => {
      subscribed.listeners.delete(listener);
      if (!subscribed.listeners.size && this.pending.get(assetId) === subscribed) {
        subscribed.controller?.abort();
        clearTimeout(subscribed.timer);
        this.pending.delete(assetId);
      }
    };
  }

  clear() {
    for (const unit of this.units.values()) unit.cancel();
    this.units.clear();
    this.previews.clear();
    for (const job of this.pending.values()) {
      job.controller?.abort();
      clearTimeout(job.timer);
    }
    this.pending.clear();
    this.bytes = 0;
  }

  private cache(id: string, preview: Preview) {
    this.remove(id);
    this.previews.set(id, preview);
    this.bytes += preview.blob?.size ?? 0;
    while (this.bytes > MAX_BYTES || this.previews.size > MAX_PREVIEWS) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private remove(id: string) {
    this.bytes -= this.previews.get(id)?.blob?.size ?? 0;
    this.previews.delete(id);
  }

  private pump() {
    for (const [id, job] of this.pending) {
      if (this.active >= 1) return;
      if (job.controller || job.timer) continue;
      let unit = this.units.get(id);
      if (!unit) {
        unit = new RetryUnit();
        this.units.set(id, unit);
      }
      if (!unit.ready(id)) {
        unit.schedule(() => this.pump());
        continue;
      }
      const controller = new AbortController();
      job.controller = controller;
      this.active++;
      void this.load(id, controller.signal)
        .then(
          (blob) => {
            if (this.pending.get(id) !== job) return;
            unit.succeed();
            const chosen = this.previews.get(id)?.blob ?? blob;
            this.cache(id, { blob: chosen });
            job.listeners.forEach((listener) => listener({ blob: chosen }));
          },
          (error) => {
            if (this.pending.get(id) === job && !this.previews.get(id)?.blob) {
              const failure = toRemoteKitError(error);
              const delay = unit.fail(failure).delay;
              if (failure.code !== 'canceled')
                this.cache(id, {
                  error: failure,
                  retryAt: delay === undefined ? Infinity : Date.now() + delay,
                });
              job.listeners.forEach((listener) => listener(this.previews.get(id) ?? {}));
            }
          },
        )
        .finally(() => {
          this.active--;
          if (this.pending.get(id) === job) {
            const retryAt = this.previews.get(id)?.retryAt;
            if (retryAt && retryAt !== Infinity && job.listeners.size) job.controller = undefined;
            else this.pending.delete(id);
          }
          this.pump();
        });
    }
  }
}
