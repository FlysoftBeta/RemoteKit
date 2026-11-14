import type { RateLimitOptions } from './client.js';

type Work<T> = {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  concurrency: 1,
  minIntervalMs: 850,
  jitterMs: 250,
  maxRetries: 4,
};

export class RateLimiter {
  private readonly queue: Work<unknown>[] = [];
  private active = 0;
  private lastStartedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly options: RateLimitOptions) {}

  schedule<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve, reject } as Work<unknown>);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer || this.active >= this.options.concurrency || this.queue.length === 0) return;

    const jitter = this.options.jitterMs > 0 ? Math.floor(Math.random() * this.options.jitterMs) : 0;
    const wait = Math.max(0, this.lastStartedAt + this.options.minIntervalMs + jitter - Date.now());
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, wait);
      return;
    }

    const work = this.queue.shift();
    if (!work) return;
    this.active += 1;
    this.lastStartedAt = Date.now();
    void work
      .run()
      .then(work.resolve, work.reject)
      .finally(() => {
        this.active -= 1;
        this.pump();
      });

    if (this.active < this.options.concurrency) this.pump();
  }
}
