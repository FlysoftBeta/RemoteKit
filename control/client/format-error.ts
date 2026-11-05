import { RemoteKitError, type ErrorCode } from '../shared/errors';
const messages: Record<ErrorCode, string> = {
  invalid_request: '请求无效，请检查后重试',
  unauthenticated: '登录已过期，请重新登录',
  forbidden: '没有执行此操作的权限',
  locked: '浏览器已锁定',
  not_found: '请求的内容不存在',
  conflict: '状态已改变，请核对后重试',
  limit_exceeded: '超出可用范围，请减少内容或缩小窗口',
  rate_limited: '请求过于频繁，请稍后重试',
  unavailable: '连接尚未恢复，请稍后重试',
  rejected: '操作被拒绝',
  outcome_unknown: '操作结果未知，请核对当前工作区',
  internal: '服务内部错误',
};
const presentationReasons: Record<string, string> = {
  'video-capability-unavailable': '浏览器缺少视频呈现所需的功能。',
  'video-rtp-metadata-unavailable': '浏览器未提供视频帧时间戳，无法显示远程页面。',
  'video-playback-failed': '浏览器无法播放远程视频。',
  'presentation-protocol-unavailable': '远程视频呈现协商超时。',
  'invalid-presentation-mode': '远程节点返回了不兼容的视频呈现模式。',
  'invalid-presentation-barrier': '远程节点返回了无效的视频布局信息。',
};
export function formatError(error: unknown): string {
  return error instanceof RemoteKitError
    ? ((error.code === 'unavailable' && error.detail ? presentationReasons[error.detail] : undefined) ??
        messages[error.code])
    : error instanceof Error
      ? error.message
      : String(error);
}
