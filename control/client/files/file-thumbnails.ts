type Listener = (blob: Blob | undefined) => void;
interface Preview {
  blob?: Blob;
  retryAt?: number;
}
interface PendingPreview {
  listeners: Set<Listener>;
  controller?: AbortController;
}

const MAX_PREVIEWS = 96;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 128;

export class FileThumbnails {
  private previews = new Map<string, Preview>();
  private pending = new Map<string, PendingPreview>();
  private active = 0;
  private bytes = 0;

  constructor(private readonly load: (assetId: string, signal: AbortSignal) => Promise<Blob>) {}

  get(assetId: string): Blob | undefined {
    return this.previews.get(assetId)?.blob;
  }

  remember(assetId: string, blob: Blob) {
    if (blob.size > 128 * 1024) return;
    this.cache(assetId, { blob });
    this.pending.get(assetId)?.listeners.forEach((listener) => listener(blob));
  }

  subscribe(assetId: string, listener: Listener) {
    const cached = this.previews.get(assetId);
    if (cached && (!cached.retryAt || cached.retryAt > Date.now())) {
      this.previews.delete(assetId);
      this.previews.set(assetId, cached);
      listener(cached.blob);
      return () => {};
    }
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
        this.pending.delete(assetId);
      }
    };
  }

  clear() {
    this.previews.clear();
    for (const job of this.pending.values()) job.controller?.abort();
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
      if (job.controller) continue;
      const controller = new AbortController();
      job.controller = controller;
      this.active++;
      void this.load(id, controller.signal)
        .then(
          (blob) => {
            if (this.pending.get(id) !== job) return;
            const chosen = this.previews.get(id)?.blob ?? blob;
            this.cache(id, { blob: chosen });
            job.listeners.forEach((listener) => listener(chosen));
          },
          () => {
            if (this.pending.get(id) === job && !this.previews.get(id)?.blob) {
              this.cache(id, { retryAt: Date.now() + 30_000 });
              job.listeners.forEach((listener) => listener(undefined));
            }
          },
        )
        .finally(() => {
          this.active--;
          if (this.pending.get(id) === job) this.pending.delete(id);
          this.pump();
        });
    }
  }
}
