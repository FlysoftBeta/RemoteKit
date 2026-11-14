import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import { RetryUnit } from '../../shared/retry-unit';
import { diagnostics } from '../media/diagnostics';
import { resolvedFailure } from './operations';

export function recoveryDelay(error: unknown, attempt: number) {
  return RetryUnit.delay(toRemoteKitError(error), attempt);
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
  options: { read?: boolean; identity?: string; recompute?: () => Promise<void> } = {},
): Promise<T> {
  const unit = new RetryUnit({
    failed: (error) => diagnostics.record('recovery_failed', error),
    recovered: () => diagnostics.record('recovery_recovered', {}),
  });
  unit.ready(options.identity ?? 'request');
  for (;;) {
    if (signal.aborted) throw new RemoteKitError('canceled', '');
    try {
      const result = await work();
      unit.succeed();
      return result;
    } catch (error) {
      const failure = toRemoteKitError(error);
      failed?.(failure);
      const { delay } = unit.fail(failure);
      if (failure.code === 'outcome_unknown' && !options.read && !options.identity)
        throw resolvedFailure(failure);
      if (failure.code === 'conflict') {
        if (options.recompute) await options.recompute();
        else if (!options.read) throw failure;
      }
      if (delay === undefined) throw failure;
      await waitForRecovery(delay, signal);
    }
  }
}

export function recoverRead<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  failed?: (error: RemoteKitError) => void,
) {
  return recover(work, signal, failed, { read: true });
}
