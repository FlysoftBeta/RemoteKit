import { createHash } from 'node:crypto';
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
  if (value === '429' || (Number(value) >= 500 && Number(value) < 600)) {
    throw new RemoteKitError('unavailable', `${service}暂时不可用，请稍后重试`);
  }
  if (
    ['401', '416', '900004'].includes(value) ||
    auth ||
    /token|tgt|ticket|password|account|credential/.test(value)
  ) {
    throw new RemoteKitError('unauthenticated', `${service}登录已失效或账号密码错误，请重新登录`);
  }
  if (/captcha/.test(value)) {
    throw new RemoteKitError('rejected', '请完成极验验证后重新登录');
  }
  throw new RemoteKitError(
    'rejected',
    `${service}请求被拒绝（${/^[\w.-]{1,60}$/.test(value) ? value : '未知错误'}）`,
  );
}

export class HttpClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  readonly maxRetries: number;
  readonly retryBaseMs: number;
  readonly timeoutMs: number;

  constructor(options: HttpOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
  }

  async response(url: string | URL, init: RequestInit = {}, retries = this.maxRetries): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetchImpl(providerEndpoint(url), {
          ...init,
          signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        });
        if (response.status === 401 || response.status === 403 || response.status === 416) {
          await response.body?.cancel();
          throw new RemoteKitError('unauthenticated', '学习服务登录已失效，请重新登录');
        }
        if (response.status === 429 || response.status >= 500 || response.status === 408) {
          await response.body?.cancel();
          throw new RemoteKitError('unavailable', '学习服务暂时不可用，请稍后重试');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new RemoteKitError('rejected', '学习服务请求被拒绝');
        }
        return response;
      } catch (error) {
        if (error instanceof RemoteKitError && error.code !== 'unavailable') throw error;
        if (attempt >= retries || init.signal?.aborted) {
          throw new RemoteKitError('unavailable', '学习服务连接失败或超时，请稍后重试');
        }
        await delay(this.retryBaseMs * 2 ** attempt);
      }
    }
  }

  async json(url: string | URL, init: RequestInit = {}, retries = this.maxRetries): Promise<unknown> {
    const response = await this.response(url, init, retries);
    return this.parseJson(response);
  }

  async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) return malformed();
      throw new RemoteKitError('unavailable', '学习服务读取超时或连接中断，请稍后重试');
    }
  }

  async retry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof RemoteKitError) || error.code !== 'unavailable' || attempt >= this.maxRetries)
          throw error;
        await delay(this.retryBaseMs * 2 ** attempt);
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
