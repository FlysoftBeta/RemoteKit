import { RemoteKitError, type ErrorCode } from '../../shared/errors';
const messages: Record<ErrorCode, string> = {
  invalid_request: '请求格式无效',
  unauthenticated: '登录已过期，请重新登录',
  forbidden: '没有执行此操作的权限',
  locked: '浏览器已锁定',
  not_found: '请求的内容不存在',
  conflict: '状态已改变，请核对后重试',
  limit_exceeded: '超出可用范围，请减少内容或缩小窗口',
  rate_limited: '请求过于频繁，请稍后重试',
  busy: '服务繁忙，请稍后重试',
  unavailable: '连接尚未恢复，请稍后重试',
  rejected: '操作被拒绝',
  outcome_unknown: '操作结果未知，请核对当前工作区',
  internal: '服务内部错误',
  canceled: '',
};
export function formatError(error: unknown): string {
  return error instanceof RemoteKitError
    ? error.code === 'canceled'
      ? ''
      : error.message || messages[error.code]
    : error instanceof Error
      ? error.message
      : String(error);
}
