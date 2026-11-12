import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import { retryDelay } from '../../shared/error-policy';

export function recoveryDelay(error: unknown, attempt: number, cap = 60_000) {
  const failure = toRemoteKitError(error);
  const delay =
    retryDelay(failure, attempt) ??
    (failure.code === 'outcome_unknown' ? Math.min(cap, 1000 * 2 ** Math.min(attempt, 16)) : undefined);
  return delay === undefined ? undefined : Math.min(cap, delay);
}

export function waitForRecovery(delay: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RemoteKitError('canceled', ''));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new RemoteKitError('canceled', ''));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function recover<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  failed?: (error: RemoteKitError) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new RemoteKitError('canceled', '');
    try {
      return await work();
    } catch (error) {
      const failure = toRemoteKitError(error);
      failed?.(failure);
      const delay = recoveryDelay(failure, attempt);
      if (delay === undefined) throw failure;
      await waitForRecovery(delay, signal);
    }
  }
}
