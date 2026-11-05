import { RemoteKitError } from '../../shared/errors';
import { diagnostics } from '../media/diagnostics';
export async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new RemoteKitError('unavailable', '连接不可用', String(error));
  }
  const value = await response.json().catch((error: unknown) => {
    diagnostics.record('http-response', error);
    return null;
  });
  if (!response.ok)
    throw new RemoteKitError(value?.error?.code ?? 'internal', value?.error?.message ?? '请求失败');
  return value as T;
}
