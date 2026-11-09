import { retryDelay } from '../../../../shared/error-policy.js';
import { RemoteKitError } from '../../../../shared/errors.js';
import {
  HttpClient,
  type HttpOptions,
  delay,
  record,
  malformed,
  requiredText,
  serviceError,
} from '../http.js';
import type { ProviderResult } from '../models.js';
import { CLIENT, createHandshakeEncrypt, createRequestEncrypt, decryptSafeCode } from './crypto.js';
import { DEFAULT_RATE_LIMIT, RateLimiter } from './rate-limiter.js';

export interface XinjiaoyuSession {
  token: string;
  accessToken: string;
  clientSessionId: string;
  device: string;
  deviceType: string;
  safeCode?: string;
  userAgent?: string;
  acceptLanguage?: string;
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
}

export interface RateLimitOptions {
  concurrency: number;
  minIntervalMs: number;
  jitterMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

export interface XinjiaoyuOptions extends Omit<HttpOptions, 'maxRetries' | 'retryBaseMs'> {
  stageId?: string;
  rateLimit?: Partial<RateLimitOptions>;
}

export class APIClient {
  readonly stageId: string;
  private readonly http: HttpClient;
  private readonly limiter: RateLimiter;
  private readonly rateLimit: RateLimitOptions;
  private readonly baseUrl = 'https://www.xinjiaoyu.com';

  constructor(options: XinjiaoyuOptions = {}) {
    this.http = new HttpClient(options, 'xinjiaoyu');
    this.stageId = options.stageId ?? '10000';
    this.rateLimit = { ...DEFAULT_RATE_LIMIT, ...options.rateLimit };
    if (
      !Number.isInteger(this.rateLimit.concurrency) ||
      this.rateLimit.concurrency < 1 ||
      !Number.isInteger(this.rateLimit.maxRetries) ||
      this.rateLimit.maxRetries < 0 ||
      [this.rateLimit.minIntervalMs, this.rateLimit.jitterMs, this.rateLimit.retryBaseMs].some(
        (value) => !Number.isFinite(value) || value < 0,
      )
    ) {
      throw new RemoteKitError('invalid_request', '新教育请求频率配置无效');
    }
    this.limiter = new RateLimiter(this.rateLimit);
  }

  get<T>(
    session: XinjiaoyuSession,
    path: string,
    query?: Record<string, unknown>,
  ): Promise<ProviderResult<T, XinjiaoyuSession>> {
    return this.request(session, 'GET', path, query);
  }

  post<T>(
    session: XinjiaoyuSession,
    path: string,
    body: unknown,
  ): Promise<ProviderResult<T, XinjiaoyuSession>> {
    return this.request(session, 'POST', path, body);
  }

  async handshake(input: XinjiaoyuSession): Promise<XinjiaoyuSession> {
    if (!input.clientSessionId || !input.device || !input.deviceType)
      throw new RemoteKitError('unauthenticated', '请重新登录新教育');
    if (input.safeCode) return input;
    const clientSessionId = input.clientSessionId;
    const data = await this.retry(() =>
      this.limiter.schedule(async () => {
        const timestamp = Date.now();
        const url = new URL('/api/v3/server_system/system/code', this.baseUrl);
        url.search = new URLSearchParams({
          clientSessionId,
          t: String(timestamp),
          client: CLIENT,
          encrypt: createHandshakeEncrypt(clientSessionId, timestamp),
        }).toString();
        return this.envelope(
          await this.http.json(
            url,
            {
              headers: {
                ...this.deviceHeaders(input),
                authorization: `JBY ${input.token}`,
                accesstoken: input.accessToken,
                t: String(timestamp),
                encrypt: '',
              },
            },
            0,
          ),
        );
      }),
    );
    let safeCode: string;
    try {
      safeCode = decryptSafeCode(requiredText(data));
    } catch {
      return malformed();
    }
    if (!safeCode) return malformed();
    return { ...input, clientSessionId, safeCode };
  }

  private async request<T>(
    input: XinjiaoyuSession,
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<ProviderResult<T, XinjiaoyuSession>> {
    if (!input.token || !input.accessToken) throw new RemoteKitError('unauthenticated', '请先登录新教育');
    const session = await this.handshake(input);
    const data = await this.retry(
      () =>
        this.limiter.schedule(async () => {
          const timestamp = Date.now();
          const url = new URL(path, this.baseUrl);
          if (method === 'GET' && payload && typeof payload === 'object') {
            for (const [key, value] of Object.entries(payload)) {
              if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
            }
          }
          const headers = {
            ...this.deviceHeaders(session),
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            ...(method === 'POST' ? { origin: this.baseUrl } : {}),
            authorization: `JBY ${session.token}`,
            accesstoken: session.accessToken,
            t: String(timestamp),
            encrypt: createRequestEncrypt(session.safeCode!, session.clientSessionId, timestamp),
          };
          return this.envelope(
            await this.http.json(
              url,
              {
                method,
                headers,
                ...(method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
              },
              0,
            ),
          );
        }),
      method === 'GET',
    );
    return { session, data: data as T };
  }

  private envelope(value: unknown): unknown {
    const envelope = record(value);
    if (typeof envelope.code !== 'number') return malformed();
    if (envelope.code !== 200) serviceError(envelope.code, '新教育');
    if (envelope.data === undefined) return malformed();
    return envelope.data;
  }

  private deviceHeaders(session: XinjiaoyuSession): Record<string, string> {
    return {
      accept: 'application/json, text/plain, */*',
      client: CLIENT,
      clientsession: session.clientSessionId,
      device: session.device,
      devicetype: session.deviceType,
      platformtype: '1',
      referer: `${this.baseUrl}/teacher/question_base_paper/selectNew`,
      ...(session.userAgent ? { 'user-agent': session.userAgent } : {}),
      ...(session.acceptLanguage ? { 'accept-language': session.acceptLanguage } : {}),
      ...(session.secChUa ? { 'sec-ch-ua': session.secChUa } : {}),
      ...(session.secChUaMobile ? { 'sec-ch-ua-mobile': session.secChUaMobile } : {}),
      ...(session.secChUaPlatform ? { 'sec-ch-ua-platform': session.secChUaPlatform } : {}),
    };
  }

  private async retry<T>(run: () => Promise<T>, read = true): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (
          !read ||
          !(error instanceof RemoteKitError) ||
          retryDelay(error, attempt) === undefined ||
          attempt >= this.rateLimit.maxRetries
        )
          throw error;
        await delay(error.retryAfterMs ?? retryDelay(error, attempt)!);
      }
    }
  }
}

export function decodeIdentity(token: string): {
  userId?: string;
  schoolId?: string;
  displayName?: string;
} {
  try {
    const payload = record(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')));
    const subject = record(typeof payload.sub === 'string' ? JSON.parse(payload.sub) : payload.sub);
    const school = subject.school == null ? {} : record(subject.school);
    return {
      ...(typeof subject.name === 'string' ? { displayName: subject.name } : {}),
      ...(subject.id !== undefined ? { userId: String(subject.id) } : {}),
      ...(school.schoolId !== undefined ? { schoolId: String(school.schoolId) } : {}),
    };
  } catch {
    return {};
  }
}
