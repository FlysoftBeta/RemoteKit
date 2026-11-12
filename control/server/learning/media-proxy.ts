import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RemoteKitError } from '../../shared/errors';
import type { LearningProvider } from '../../shared/learning';
import { AUTH_CONFIG } from './providers/changyan/config';
import { providerEndpoint } from './providers/endpoint';

interface MediaToken {
  tenant: string;
  url: string;
  expiry: number;
  provider: LearningProvider;
}
interface CachedMedia {
  bytes: Buffer;
  type: string;
}
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ITEM = 2 * 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;

export class MediaProxy {
  private readonly key = randomBytes(32);
  private readonly cache = new Map<string, CachedMedia>();
  private bytes = 0;
  constructor(
    private readonly fetchImpl = globalThis.fetch,
    private readonly now = Date.now,
    private readonly identityHeaders: (
      tenant: string,
      provider: LearningProvider,
    ) => Record<string, string> = () => ({}),
  ) {}

  url(tenant: string, url: string, provider: LearningProvider): string {
    const address = this.address(url);
    const payload = Buffer.from(
      JSON.stringify({
        tenant,
        url: address.href,
        expiry: this.now() + 24 * 3600_000,
        provider,
      } satisfies MediaToken),
    ).toString('base64url');
    const signature = createHmac('sha256', this.key).update(payload).digest('base64url');
    return `/api/learning/media/${payload}${signature}`;
  }
  private address(url: string) {
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      throw new RemoteKitError('invalid_request', '无效媒体地址');
    }
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password)
      throw new RemoteKitError('invalid_request', '无效媒体地址');
    return address;
  }
  verify(tenant: string, token: string): MediaToken {
    const payload = token.slice(0, -43);
    const signature = token.slice(-43);
    const expected = createHmac('sha256', this.key)
      .update(payload ?? '')
      .digest();
    const actual = Buffer.from(signature ?? '', 'base64url');
    if (
      !/^[A-Za-z0-9_-]+$/.test(token) ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new RemoteKitError('forbidden', '媒体链接无效');
    let value: MediaToken;
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch {
      throw new RemoteKitError('forbidden', '媒体链接无效');
    }
    if (
      value.tenant !== tenant ||
      !Number.isFinite(value.expiry) ||
      value.expiry <= this.now() ||
      !['changyan', 'xinjiaoyu'].includes(value.provider)
    )
      throw new RemoteKitError('forbidden', '媒体链接已过期或不属于当前用户');
    this.address(value.url);
    return value;
  }
  async serve(tenant: string, token: string, req: IncomingMessage, res: ServerResponse) {
    const value = this.verify(tenant, token);
    const key = JSON.stringify([tenant, value.provider, value.url]);
    const range = req.headers.range;
    if (range !== undefined && !/^bytes=\d*-\d*$/.test(range))
      throw new RemoteKitError('invalid_request', '无效媒体范围');
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.cached(cached, range, res);
      return;
    }
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    res.once('close', disconnected);
    try {
      const headers =
        value.provider === 'xinjiaoyu'
          ? {
              referer: 'https://www.xinjiaoyu.com/teacher/question_base_paper/selectNew',
              'user-agent': 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36',
            }
          : { referer: 'https://www.zhixue.com/', 'user-agent': AUTH_CONFIG.zhixue.webViewUserAgent };
      const upstream = await this.fetchImpl(providerEndpoint(value.url), {
        headers: {
          ...headers,
          ...this.identityHeaders(tenant, value.provider),
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
      });
      if (upstream.status === 416) {
        await upstream.body?.cancel();
        res.writeHead(416, { 'Content-Range': upstream.headers.get('content-range') ?? 'bytes */*' });
        res.end();
        return;
      }
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        throw new RemoteKitError('unavailable', '媒体读取失败');
      }
      if (Number(upstream.headers.get('content-length')) > MAX_BYTES) {
        await upstream.body.cancel();
        throw new RemoteKitError('limit_exceeded', '媒体超过 32 MiB', { capacity: 'file' });
      }
      const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
      res.writeHead(upstream.status === 206 ? 206 : 200, {
        ...this.headers(type),
        ...(upstream.headers.has('content-range')
          ? { 'Content-Range': upstream.headers.get('content-range')! }
          : {}),
      });
      const reader = upstream.body.getReader();
      let received = 0;
      const chunks: Buffer[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > MAX_BYTES)
            throw new RemoteKitError('limit_exceeded', '媒体超过 32 MiB', { capacity: 'file' });
          if (received <= MAX_ITEM) chunks.push(Buffer.from(chunk.value));
          else chunks.length = 0;
          if (!res.write(chunk.value)) await once(res, 'drain', { signal: abort.signal });
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!range && upstream.status === 200 && received <= MAX_ITEM) {
        const entry = { type, bytes: Buffer.concat(chunks) };
        const previous = this.cache.get(key);
        if (previous) this.bytes -= previous.bytes.length;
        this.cache.delete(key);
        this.cache.set(key, entry);
        this.bytes += received;
        while (this.bytes > CACHE_BYTES) {
          const oldest = this.cache.keys().next().value!;
          this.bytes -= this.cache.get(oldest)!.bytes.length;
          this.cache.delete(oldest);
        }
      }
      res.end();
    } catch (error) {
      if (res.headersSent) res.destroy();
      else throw error instanceof RemoteKitError ? error : new RemoteKitError('unavailable', '媒体读取失败');
    } finally {
      res.off('close', disconnected);
    }
  }
  private headers(type: string) {
    return {
      'Content-Type': type,
      'Cache-Control': 'private, max-age=3600',
      Vary: 'Cookie',
      'Accept-Ranges': 'bytes',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    };
  }
  private cached(entry: CachedMedia, range: string | undefined, res: ServerResponse) {
    let start = 0;
    let end = entry.bytes.length - 1;
    if (range) {
      const [left, right] = range.slice(6).split('-');
      if (!left && !right) throw new RemoteKitError('invalid_request', '无效媒体范围');
      start = left ? Number(left) : Math.max(0, entry.bytes.length - Number(right));
      end = left && right ? Math.min(Number(right), end) : end;
      if (start > end || start >= entry.bytes.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${entry.bytes.length}` });
        res.end();
        return;
      }
    }
    res.writeHead(range ? 206 : 200, {
      ...this.headers(entry.type),
      'Content-Length': Math.max(0, end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${entry.bytes.length}` } : {}),
    });
    res.end(entry.bytes.subarray(start, end + 1));
  }
  forget(tenant: string) {
    for (const [key, entry] of this.cache)
      if ((JSON.parse(key) as string[])[0] === tenant) {
        this.cache.delete(key);
        this.bytes -= entry.bytes.length;
      }
  }
}
