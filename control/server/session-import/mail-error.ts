import { RemoteKitError, toRemoteKitError } from '../../shared/errors';

export function mailError(error: unknown, sending: boolean): RemoteKitError {
  if (error instanceof RemoteKitError) return error;
  const evidence = error as
    | { code?: string; responseCode?: number; authenticationFailed?: boolean; serverResponseCode?: string }
    | undefined;
  const detail = error instanceof Error ? error.message : String(error);
  if (
    evidence?.code === 'EAUTH' ||
    evidence?.authenticationFailed ||
    evidence?.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    evidence?.responseCode === 535 ||
    evidence?.responseCode === 530
  )
    return new RemoteKitError('unauthenticated', '会话导入邮箱认证失败，请检查邮箱凭据', { detail });
  if (evidence?.responseCode === 550 || evidence?.responseCode === 553)
    return new RemoteKitError('forbidden', '会话导入邮箱拒绝访问或投递', { detail });
  if (
    evidence?.code &&
    [
      'ECONNECTION',
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ESOCKET',
    ].includes(evidence.code)
  )
    return new RemoteKitError(sending ? 'outcome_unknown' : 'unavailable', '会话导入邮箱连接中断', {
      detail,
    });
  return toRemoteKitError(error);
}
