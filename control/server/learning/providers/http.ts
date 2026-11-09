import { createHash } from 'node:crypto';
import { retryDelay } from '../../../shared/error-policy.js';
import { RemoteKitError } from '../../../shared/errors.js';
import { providerEndpoint } from './endpoint.js';

export interface HttpOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function malformed(): never {
  throw new RemoteKitError('internal', '学习服务返回的数据格式错误');
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return malformed();
  return value;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export function requiredText(value: unknown): string {
  const result = text(value);
  if (!result) return malformed();
  return result;
}

export function number(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RemoteKitError('invalid_request', `${label}必须是正整数`);
  }
  return value;
}

export function serviceError(code: unknown, service: string, auth = false): never {
  const value = String(code).toLowerCase();
  if (value === '429') throw new RemoteKitError('rate_limited', `${service}请求过于频繁`);
  if (value === '408' || (Number(value) >= 500 && Number(value) < 600)) {
    throw new RemoteKitError('unavailable', `${service}暂时不可用，请稍后重试`);
  }
  if (
    ['401', '900004'].includes(value) ||
    // XinJiaoyu business statuses 410 and 416 denote an expired sign-in session.
    (service === '新教育' && ['410', '416'].includes(value)) ||
    (auth && ['invalid_credentials', 'wrong_password', 'invalid_password'].includes(value))
  ) {
    throw new RemoteKitError('unauthenticated', `${service}登录已失效或账号密码错误，请重新登录`);
  }
  if (value === '403') throw new RemoteKitError('forbidden', `${service}无权访问`);
  if (value === '404') throw new RemoteKitError('not_found', `${service}内容不存在`);
  if (value === '409') throw new RemoteKitError('conflict', `${service}状态已改变`);
  if (value === '413') throw new RemoteKitError('limit_exceeded', `${service}内容超过限制`);
  throw new RemoteKitError(
    'internal',
    `${service}请求失败（${/^[\w.-]{1,60}$/.test(value) ? value : '未知错误'}）`,
  );
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(milliseconds)) return;
  return Math.min(86_400_000, Math.max(0, Math.ceil(milliseconds)));
}
export class HttpClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  readonly maxRetries: number;
  readonly retryBaseMs: number;
  readonly timeoutMs: number;

  constructor(
    options: HttpOptions = {},
    private readonly provider?: 'changyan' | 'zhixue' | 'xinjiaoyu',
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
  }

  async response(url: string | URL, init: RequestInit = {}, retries = this.maxRetries): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      if (init.signal?.aborted) throw new RemoteKitError('canceled', '');
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetchImpl(providerEndpoint(url), {
          ...init,
          signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        });
        if (!response.ok && this.provider) {
          let message: unknown = response.statusText;
          try {
            const value = await response.clone().json();
            message = value.msg ?? value.message ?? value.errorInfo ?? response.statusText;
          } catch {}
          this.logRejection(url, init, response.status, message);
        }
        if (response.status === 401) {
          await response.body?.cancel();
          throw new RemoteKitError('unauthenticated', '学习服务登录已失效，请重新登录');
        }
        if (response.status === 429) {
          await response.body?.cancel();
          throw new RemoteKitError('rate_limited', '学习服务请求过于频繁', {
            retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          });
        }
        if (response.status >= 500 || response.status === 408) {
          await response.body?.cancel();
          throw new RemoteKitError('unavailable', '学习服务暂时不可用，请稍后重试');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new RemoteKitError(
            response.status === 403
              ? 'forbidden'
              : response.status === 404
                ? 'not_found'
                : response.status === 409
                  ? 'conflict'
                  : response.status === 413
                    ? 'limit_exceeded'
                    : response.status === 416
                      ? 'invalid_request'
                      : 'internal',
            '学习服务请求失败',
          );
        }
        return response;
      } catch (error) {
        const read =
          !init.method || init.method.toUpperCase() === 'GET' || init.method.toUpperCase() === 'HEAD';
        if (init.signal?.aborted)
          throw new RemoteKitError(
            read ? 'canceled' : 'outcome_unknown',
            read ? '' : '学习服务请求结果待确认',
            { detail: String(error) },
          );
        const failure =
          error instanceof RemoteKitError
            ? error
            : new RemoteKitError(read ? 'unavailable' : 'outcome_unknown', '学习服务连接失败或超时', {
                detail: String(error),
              });
        const wait = retryDelay(failure, attempt);
        if (!read || wait === undefined || attempt >= retries) throw failure;
        await delay(failure.retryAfterMs ?? (wait * this.retryBaseMs) / 1000);
      }
    }
  }

  async json(url: string | URL, init: RequestInit = {}, retries = this.maxRetries): Promise<unknown> {
    const response = await this.response(url, init, retries);
    return this.parseJson(response, url, init);
  }

  async parseJson(response: Response, url?: string | URL, init: RequestInit = {}): Promise<unknown> {
    try {
      const value: unknown = await response.json();
      if (url && value && typeof value === 'object' && !Array.isArray(value)) {
        const envelope = value as Record<string, unknown>;
        const code = envelope.errorCode ?? envelope.code;
        if (
          (typeof code === 'string' || typeof code === 'number') &&
          !['200', '0', '000000', 'success'].includes(String(code))
        ) {
          this.logRejection(url, init, code, envelope.msg ?? envelope.message ?? envelope.errorInfo);
        }
      }
      return value;
    } catch (error) {
      if (error instanceof SyntaxError) return malformed();
      throw new RemoteKitError(
        !init.method || init.method.toUpperCase() === 'GET' ? 'unavailable' : 'outcome_unknown',
        '学习服务读取超时或连接中断',
      );
    }
  }

  private logRejection(url: string | URL, init: RequestInit, code: string | number, message: unknown) {
    if (!this.provider) return;
    const address = new URL(url);
    const sensitive = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && value.length > 0) sensitive.add(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    for (const [name, value] of new Headers(init.headers)) {
      if (!/authorization|token|cookie|session|user/.test(name)) continue;
      collect(value);
      const token = value.replace(/^(?:JBY|Bearer)\s+/i, '');
      collect(token);
      if (name === 'cookie') {
        for (const cookie of value.split(';')) collect(cookie.slice(cookie.indexOf('=') + 1).trim());
      }
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        collect(payload);
        if (typeof payload.sub === 'string') collect(JSON.parse(payload.sub));
      } catch {}
    }
    for (const value of address.searchParams.values()) collect(value);
    if (typeof init.body === 'string') {
      try {
        collect(JSON.parse(init.body));
      } catch {
        for (const value of new URLSearchParams(init.body).values()) collect(value);
      }
    } else if (init.body instanceof URLSearchParams) {
      for (const value of init.body.values()) collect(value);
    }
    let serviceMessage = typeof message === 'string' ? message : '';
    for (const value of [...sensitive].sort((a, b) => b.length - a.length)) {
      serviceMessage = serviceMessage.split(value).join('[redacted]');
    }
    serviceMessage = serviceMessage
      .replace(/\b(?:JBY|Bearer)\s+\S+/gi, '[redacted]')
      .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, '[redacted]');
    console.warn('Learning provider rejected', {
      provider: this.provider,
      path: address.pathname,
      code: Number.isFinite(Number(code)) ? Number(code) : code,
      message: serviceMessage.slice(0, 1024),
    });
  }

  async retry<T>(run: () => Promise<T>, read = true): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const wait = error instanceof RemoteKitError ? retryDelay(error, attempt) : undefined;
        if (!read || wait === undefined || attempt >= this.maxRetries) throw error;
        await delay(
          error instanceof RemoteKitError && error.retryAfterMs !== undefined
            ? wait
            : (wait * this.retryBaseMs) / 1000,
        );
      }
    }
  }

  async download(
    url: string | URL,
    init: RequestInit = {},
    expected: { size?: number; md5?: string } = {},
  ): Promise<StreamingDownload> {
    const response = await this.response(url, init);
    if (!response.body) return malformed();
    const body = response.body;
    const size = number(response.headers.get('content-length'));
    const contentType = response.headers.get('content-type') ?? undefined;
    const integrity: DownloadIntegrity = { bytes: 0, complete: false };
    async function* stream(): AsyncGenerator<Uint8Array> {
      const reader = body.getReader();
      const hash = createHash('md5');
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          hash.update(chunk.value);
          integrity.bytes += chunk.value.byteLength;
          yield chunk.value;
        }
        integrity.md5 = hash.digest('hex');
        if (
          (expected.size !== undefined && integrity.bytes !== expected.size) ||
          (expected.md5 && integrity.md5.toLowerCase() !== expected.md5.toLowerCase())
        ) {
          throw new RemoteKitError('unavailable', '下载文件校验失败，请重新下载');
        }
        integrity.complete = true;
      } catch (error) {
        if (error instanceof RemoteKitError) throw error;
        throw new RemoteKitError('unavailable', '下载中断或超时，请重新下载');
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    return { stream: stream(), size, contentType, integrity };
  }
}

export interface DownloadIntegrity {
  bytes: number;
  md5?: string;
  complete: boolean;
}

export interface StreamingDownload {
  stream: AsyncIterable<Uint8Array>;
  size?: number;
  contentType?: string;
  /** Final md5 is available only after the stream reaches EOF; partial streams stay incomplete. */
  integrity: DownloadIntegrity;
}
