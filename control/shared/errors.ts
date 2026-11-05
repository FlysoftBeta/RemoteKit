export type ErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'locked'
  | 'not_found'
  | 'conflict'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'unavailable'
  | 'rejected'
  | 'outcome_unknown'
  | 'internal';
export class RemoteKitError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'RemoteKitError';
  }
}
export function isRemoteKitError(e: unknown): e is RemoteKitError {
  return e instanceof RemoteKitError;
}
export function toRemoteKitError(e: unknown): RemoteKitError {
  return isRemoteKitError(e)
    ? e
    : new RemoteKitError('internal', '服务内部错误', e instanceof Error ? (e.stack ?? e.message) : String(e));
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
  unavailable: 503,
  rejected: 422,
  outcome_unknown: 504,
  internal: 500,
};
export type WireError = { code: ErrorCode; message: string };
