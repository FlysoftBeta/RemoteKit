import { RemoteKitError, endpointError } from '../../shared/errors';
import { errorHandling } from '../../shared/error-policy';

/** Offer submission and reconciliation share the Viewer attempt identity. */
export class OfferResults<T> {
  private readonly entries = new Map<
    string,
    {
      input: string;
      state: 'pending' | 'ready' | 'unknown' | 'retired';
      result: Promise<T>;
      answer?: T;
    }
  >();
  private key(tenant: string, lease: string, attemptId: string) {
    return JSON.stringify([tenant, lease, attemptId]);
  }
  execute(tenant: string, lease: string, input: { attemptId: string }, work: () => Promise<T>): Promise<T> {
    if (typeof input.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.attemptId))
      return Promise.reject(new RemoteKitError('invalid_request', '无效媒体连接尝试'));
    const key = this.key(tenant, lease, input.attemptId);
    const fingerprint = JSON.stringify(input);
    const previous = this.entries.get(key);
    if (previous?.state === 'retired')
      return Promise.reject(new RemoteKitError('conflict', '媒体尝试已结束'));
    if (previous)
      return previous.input === fingerprint
        ? previous.result
        : Promise.reject(new RemoteKitError('conflict', '媒体尝试内容已改变'));
    const entry = {
      input: fingerprint,
      state: 'pending' as 'pending' | 'ready' | 'unknown' | 'retired',
      result: undefined as unknown as Promise<T>,
      answer: undefined as T | undefined,
    };
    entry.result = Promise.resolve()
      .then(work)
      .then(
        (answer) => {
          if (entry.state !== 'retired') {
            entry.state = 'ready';
            entry.answer = answer;
          }
          return answer;
        },
        (cause) => {
          if (entry.state !== 'retired') entry.state = 'unknown';
          const handling = errorHandling(endpointError(cause).code);
          if (['retry-soon', 'retry-after', 'backoff', 'refresh'].includes(handling))
            this.entries.delete(key);
          throw cause;
        },
      );
    this.entries.set(key, entry);
    return entry.result;
  }
  status(tenant: string, lease: string, attemptId: string) {
    const entry = this.entries.get(this.key(tenant, lease, attemptId));
    if (!entry) throw new RemoteKitError('not_found', '媒体尝试记录不存在');
    return { state: entry.state, ...(entry.state === 'ready' ? { answer: entry.answer! } : {}) };
  }
  retire(tenant: string, lease: string, attemptId: string) {
    const entry = this.entries.get(this.key(tenant, lease, attemptId));
    if (entry) {
      entry.state = 'retired';
      entry.answer = undefined;
    }
  }
}
