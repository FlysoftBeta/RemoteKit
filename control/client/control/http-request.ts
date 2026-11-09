import { RemoteKitError, parseWireError } from '../../shared/errors';
import { diagnostics } from '../media/diagnostics';
export async function request<T>(path: string, body?: unknown): Promise<T> {
  let encoded: string | undefined;
  if (body !== undefined) {
    try {
      encoded = JSON.stringify(body);
    } catch (error) {
      throw new RemoteKitError('internal', '请求编码失败', { detail: String(error) });
    }
  }
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: encoded }),
    });
  } catch (error) {
    if (body === undefined && error instanceof DOMException && error.name === 'AbortError')
      throw new RemoteKitError('canceled', '');
    throw new RemoteKitError(
      body === undefined ? 'unavailable' : 'outcome_unknown',
      body === undefined ? '连接不可用' : '请求结果未知，请核对当前状态',
      { detail: String(error) },
    );
  }
  const value = await response.json().catch((error: unknown) => {
    diagnostics.record('http-response', error);
    if (body === undefined && error instanceof DOMException && error.name === 'AbortError')
      throw new RemoteKitError('canceled', '');
    const code =
      body !== undefined ? 'outcome_unknown' : error instanceof SyntaxError ? 'internal' : 'unavailable';
    throw new RemoteKitError(code, code === 'unavailable' ? '连接不可用' : '服务返回了无效回复', {
      detail: String(error),
    });
  });
  if (!response.ok)
    throw (
      parseWireError(value?.error) ??
      new RemoteKitError(body === undefined ? 'internal' : 'outcome_unknown', '服务返回了无效错误')
    );
  return value as T;
}
