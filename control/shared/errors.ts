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
export type ErrorCapacity =
  'storage' | 'basket' | 'catalog' | 'windows' | 'tabs' | 'site-settings' | 'field' | 'selection' | 'file';
const capacities: ErrorCapacity[] = [
  'storage',
  'basket',
  'catalog',
  'windows',
  'tabs',
  'site-settings',
  'field',
  'selection',
  'file',
];
// errorId names the log record that holds this error's full diagnosis
// (`c-` Control, `e-` Endpoint, `v-` Viewer). It is assigned once and forwarded unchanged.
const errorIdPattern = /^[cev]-[0-9a-f]{10}$/;
export function isErrorId(value: unknown): value is string {
  return typeof value === 'string' && errorIdPattern.test(value);
}
export class RemoteKitError extends Error {
  readonly detail?: string;
  readonly reason?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
  readonly capacity?: ErrorCapacity;
  errorId?: string;
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: {
      detail?: string;
      reason?: string;
      retryAfterMs?: number;
      cause?: unknown;
      errorId?: string;
      capacity?: ErrorCapacity;
    },
  ) {
    super(message);
    this.name = 'RemoteKitError';
    this.detail = options?.detail;
    this.reason = options?.reason;
    this.cause = options?.cause;
    this.capacity = options?.capacity;
    if (isErrorId(options?.errorId)) this.errorId = options!.errorId;
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
        cause: e,
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
export type WireError = {
  code: ErrorCode;
  message: string;
  reason?: NativeErrorReason;
  capacity?: ErrorCapacity;
  retryAfterMs?: number;
  errorId?: string;
};
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
    capacity: capacities.includes(wire.capacity as ErrorCapacity)
      ? (wire.capacity as ErrorCapacity)
      : undefined,
    reason: nativeReasonMessage(wire.reason) ? (wire.reason as NativeErrorReason) : undefined,
    retryAfterMs: validRetryHint(wire.retryAfterMs) ? wire.retryAfterMs : undefined,
    errorId: isErrorId(wire.errorId) ? wire.errorId : undefined,
  });
}
export function wireError(error: RemoteKitError): WireError {
  return {
    code: error.code,
    message: error.message,
    ...(error.capacity ? { capacity: error.capacity } : {}),
    ...(nativeReasonMessage(error.reason) ? { reason: error.reason as NativeErrorReason } : {}),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.errorId === undefined ? {} : { errorId: error.errorId }),
  };
}

export function nativeWireError(error: RemoteKitError) {
  return { ...wireError(error), ...(error.reason === undefined ? {} : { reason: error.reason }) };
}

export type NativeErrorReason =
  | 'browser_crashed'
  | 'browser_restarting'
  | 'output_failed'
  | 'document_encrypted'
  | 'document_corrupt'
  | 'document_unsupported'
  | 'document_too_complex'
  | 'file_too_large'
  | 'storage_quota_exceeded'
  | 'browser_state_too_large'
  | 'no_document_contour'
  | 'corrupt_state'
  | 'session_data_on_offline_node'
  | 'no_eligible_node';
const nativeMessages: Record<NativeErrorReason, string> = {
  no_eligible_node: '没有可用的节点，恢复后自动继续',
  session_data_on_offline_node: '会话数据所在节点离线，恢复后自动继续',
  browser_crashed: '浏览器异常退出，正在恢复…',
  browser_restarting: '浏览器正在恢复，请稍候…',
  output_failed: '浏览器画面输出失败，请稍后重试',
  document_encrypted: '文档受密码保护，无法转换',
  document_corrupt: '文档已损坏，无法转换',
  document_unsupported: '不支持此文档格式',
  document_too_complex: '文档过于复杂，超出处理限制',
  file_too_large: '文件大小超过限制',
  storage_quota_exceeded: '存储空间已满，请释放空间',
  browser_state_too_large: '浏览器状态超出同步容量',
  no_document_contour: '照片中未找到文档轮廓，请重新拍摄',
  corrupt_state: '会话数据已损坏，请联系管理员重置浏览器数据',
};
const codeMessages: Record<ErrorCode, string> = {
  invalid_request: '请求格式无效',
  unauthenticated: '登录已过期，请重新登录',
  forbidden: '没有执行此操作的权限',
  locked: '浏览器已锁定，请先解锁',
  not_found: '请求的内容不存在，请刷新状态',
  conflict: '状态已改变，请刷新后重新决定',
  limit_exceeded: '超出容量限制，请释放空间或缩小输入',
  rate_limited: '请求过于频繁，请稍后重试',
  busy: '服务繁忙，请稍后重试',
  unavailable: '服务暂时不可用，请稍后重试',
  rejected: '无法处理此内容',
  outcome_unknown: '操作结果未知，请核对当前状态',
  canceled: '',
  internal: '服务内部错误',
};

export function nativeReasonMessage(reason: unknown): string | undefined {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(nativeMessages, reason)
    ? nativeMessages[reason as NativeErrorReason]
    : undefined;
}
export function errorCodeMessage(code: ErrorCode): string {
  return codeMessages[code];
}

export function nativeError(wire: unknown): RemoteKitError {
  const parsed = parseWireError(wire);
  const code = parsed?.code ?? 'outcome_unknown';
  const value = wire && typeof wire === 'object' ? (wire as Record<string, unknown>) : undefined;
  const message = nativeReasonMessage(value?.reason);
  const reason = message === undefined ? undefined : (value?.reason as NativeErrorReason);
  return new RemoteKitError(code, message ?? errorCodeMessage(code), {
    detail: typeof value?.message === 'string' ? value.message : String(wire),
    reason,
    retryAfterMs: parsed?.retryAfterMs,
    errorId: parsed?.errorId,
  });
}

// Converts whatever an Endpoint call rejected with: our own errors pass through,
// native wire errors become RemoteKitError.
export function endpointError(error: unknown): RemoteKitError {
  if (isRemoteKitError(error)) return error;
  if (error instanceof Error) return toRemoteKitError(error);
  return nativeError(error);
}
