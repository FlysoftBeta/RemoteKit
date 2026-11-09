import type { ErrorCode, WireError } from './errors';

export type ErrorHandling =
  | 'retry-soon'
  | 'retry-after'
  | 'backoff'
  | 'reconcile'
  | 'refresh'
  | 'drop'
  | 'unlock'
  | 'sign-in'
  | 'final'
  | 'canceled';

const handling: Record<ErrorCode, ErrorHandling> = {
  busy: 'retry-soon',
  rate_limited: 'retry-after',
  unavailable: 'backoff',
  outcome_unknown: 'reconcile',
  conflict: 'refresh',
  not_found: 'drop',
  locked: 'unlock',
  unauthenticated: 'sign-in',
  forbidden: 'final',
  limit_exceeded: 'final',
  invalid_request: 'final',
  rejected: 'final',
  internal: 'final',
  canceled: 'canceled',
};
export function errorHandling(code: ErrorCode): ErrorHandling {
  return handling[code];
}
export function retryDelay(
  error: Pick<WireError, 'code' | 'retryAfterMs'>,
  attempt: number,
): number | undefined {
  if (!['retry-soon', 'retry-after', 'backoff'].includes(errorHandling(error.code))) return;
  if (error.retryAfterMs !== undefined) return error.retryAfterMs;
  if (error.code === 'rate_limited') return 30_000;
  const exponent = Math.max(0, Math.min(20, Math.floor(attempt)));
  if (error.code === 'unavailable') return Math.min(300_000, 1_000 * 2 ** exponent);
  return Math.min(5_000, Math.round(Math.min(5_000, 250 * 2 ** exponent) * (0.8 + Math.random() * 0.4)));
}
