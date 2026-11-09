export type ErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'locked'
  | 'not_found'
  | 'conflict'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'busy'
  | 'unavailable'
  | 'rejected'
  | 'outcome_unknown'
  | 'canceled'
  | 'internal';
export class RemoteKitError extends Error {
  readonly detail?: string;
  readonly reason?: string;
  readonly retryAfterMs?: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { detail?: string; reason?: string; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'RemoteKitError';
    this.detail = options?.detail;
    this.reason = options?.reason;
    if (supportsRetryHint(code) && validRetryHint(options?.retryAfterMs))
      this.retryAfterMs = options!.retryAfterMs;
  }
}
export function isRemoteKitError(e: unknown): e is RemoteKitError {
  return e instanceof RemoteKitError;
}
export function toRemoteKitError(e: unknown): RemoteKitError {
  return isRemoteKitError(e)
    ? e
    : new RemoteKitError('internal', '服务内部错误', {
        detail: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
}
export const httpStatus: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  locked: 423,
  not_found: 404,
  conflict: 409,
  limit_exceeded: 413,
  rate_limited: 429,
  busy: 503,
  unavailable: 503,
  rejected: 422,
  outcome_unknown: 504,
  internal: 500,
  canceled: 409,
};
export type WireError = { code: ErrorCode; message: string; retryAfterMs?: number };
function supportsRetryHint(code: ErrorCode) {
  return code === 'busy' || code === 'rate_limited' || code === 'unavailable';
}
function validRetryHint(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 86_400_000;
}
export function parseWireError(value: unknown): RemoteKitError | undefined {
  if (!value || typeof value !== 'object') return;
  const wire = value as Record<string, unknown>;
  if (
    typeof wire.code !== 'string' ||
    !Object.prototype.hasOwnProperty.call(httpStatus, wire.code) ||
    typeof wire.message !== 'string'
  )
    return;
  return new RemoteKitError(wire.code as ErrorCode, wire.message, {
    retryAfterMs: validRetryHint(wire.retryAfterMs) ? wire.retryAfterMs : undefined,
  });
}
export function wireError(error: RemoteKitError): WireError {
  return {
    code: error.code,
    message: error.message,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
}
