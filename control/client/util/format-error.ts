import { RemoteKitError, errorCodeMessage } from '../../shared/errors';
export function formatError(error: unknown): string {
  if (error instanceof RemoteKitError) {
    if (error.code === 'canceled') return '';
    const text = error.message || errorCodeMessage(error.code);
    return error.errorId ? `${text}（错误 ID ${error.errorId}）` : text;
  }
  return error instanceof Error ? error.message : String(error);
}
