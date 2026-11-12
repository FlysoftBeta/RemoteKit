import { RemoteKitError, toRemoteKitError } from '../../shared/errors';

export function learningError(value: unknown): RemoteKitError {
  const error = toRemoteKitError(value);
  return error.code === 'unauthenticated'
    ? new RemoteKitError('forbidden', '学习账号登录已失效，请重新登录', { cause: error })
    : error;
}
