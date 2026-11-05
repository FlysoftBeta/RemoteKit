import { RemoteKitError } from '../../shared/errors';

interface Pending<T> {
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RequestTracker<T> {
  private readonly pending = new Map<string, Pending<T>>();
  private scope: unknown;

  get size() {
    return this.pending.size;
  }

  has(id: string) {
    return this.pending.has(id);
  }

  request(
    id: string,
    deadlineMs: number,
    send: () => void,
    signal?: AbortSignal,
    onDeadline?: () => void,
  ): Promise<T> {
    if (this.pending.has(id)) return Promise.reject(new RemoteKitError('conflict', 'Duplicate request'));
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.reject(id, new DOMException('Aborted', 'AbortError'));
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        if (this.reject(id, new RemoteKitError('outcome_unknown', '请求结果未知，请核对后重试')))
          onDeadline?.();
      }, deadlineMs);
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      try {
        send();
      } catch (error) {
        this.reject(
          id,
          error instanceof RemoteKitError
            ? error
            : new RemoteKitError('unavailable', '发送失败', String(error)),
        );
      }
    });
  }

  resolve(id: string, value: T) {
    const entry = this.take(id);
    entry?.resolve(value);
    return !!entry;
  }

  reject(id: string, error: Error) {
    const entry = this.take(id);
    entry?.reject(error);
    return !!entry;
  }

  setScope(scope: unknown) {
    if (Object.is(this.scope, scope)) return;
    this.scope = scope;
    this.clear(new RemoteKitError('outcome_unknown', '授权或连接已改变'));
  }

  clear(error = new RemoteKitError('outcome_unknown', '连接已中断')) {
    for (const id of this.pending.keys()) this.reject(id, error);
  }

  private take(id: string) {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }
    return entry;
  }
}
