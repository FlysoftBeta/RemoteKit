import { createHash } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import { canonical, coordinationLimits } from './coordination';

export function rpcId(method: string, ...identity: unknown[]): string {
  return (
    'rpc:' +
    createHash('sha256')
      .update(canonical([method, ...identity]))
      .digest('base64url')
  );
}

export class RpcResults {
  private readonly entries = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  private readonly completed: string[] = [];

  execute<T>(request: Record<string, unknown>, action: () => Promise<T> | T): Promise<T> {
    const { id, replay, connectionEpoch, ...payload } = request;
    const opId = request.opId;
    if (typeof opId !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(opId) || typeof replay !== 'boolean')
      return Promise.reject(new RemoteKitError('invalid_request', 'opId and replay are required'));
    const fingerprint = canonical(payload);
    const previous = this.entries.get(opId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return Promise.reject(new RemoteKitError('conflict', 'opId payload conflicts'));
      return previous.result as Promise<T>;
    }
    if (replay) return Promise.reject(new RemoteKitError('outcome_unknown', 'RPC result is not retained'));
    const result = Promise.resolve()
      .then(action)
      .finally(() => {
        this.completed.push(opId);
        while (this.completed.length > coordinationLimits.results)
          this.entries.delete(this.completed.shift()!);
      });
    this.entries.set(opId, { fingerprint, result });
    return result;
  }
}
