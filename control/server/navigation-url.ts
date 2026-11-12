import { RemoteKitError } from '../shared/errors';
import type { SearchEngine } from '../shared/product';
import { cleanUrl } from './url-clean';

const searchUrls: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  baidu: 'https://www.baidu.com/s?wd=',
};

export function normalizedUsagePage(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  for (const template of Object.values(searchUrls)) {
    const search = new URL(template);
    if (
      url.origin === search.origin &&
      url.pathname === search.pathname &&
      [...search.searchParams.keys()].some((key) => url.searchParams.has(key))
    )
      return null;
  }
  return cleanUrl(value);
}

/** User text is resolved only here, shared by address-bar and start-page actions. */
export function resolveNavigation(value: unknown, engine: SearchEngine): string {
  return boundedUrl(resolveInput(value, engine));
}

export function resolveSearch(value: unknown, engine: SearchEngine): string {
  return boundedUrl(searchUrl(inputText(value), engine));
}

function boundedUrl(url: string): string {
  if (Buffer.byteLength(url, 'utf8') > 8192)
    throw new RemoteKitError('limit_exceeded', '网址或搜索内容编码后过长（最多 8192 字节）', {
      capacity: 'field',
    });
  return url;
}

function inputText(value: unknown): string {
  if (typeof value !== 'string') throw new RemoteKitError('invalid_request', '无效网址或搜索内容');
  if (value.length > 8192)
    throw new RemoteKitError('limit_exceeded', '网址或搜索内容超过 8192 字符', { capacity: 'field' });
  const text = value.trim();
  if (!text) throw new RemoteKitError('invalid_request', '请输入网址或搜索内容');
  return text;
}

function resolveInput(value: unknown, engine: SearchEngine): string {
  const text = inputText(value);
  if (text === 'about:blank') return text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (!parsed.hostname || parsed.username || parsed.password || /[\s\\]/.test(text))
        throw new RemoteKitError('invalid_request', '无效输入');
      return parsed.href;
    } catch {
      throw new RemoteKitError('invalid_request', '请输入有效的 HTTP 或 HTTPS 网址');
    }
  }
  // A colon may be a bare host port, but no other explicit scheme is executable.
  // Misspelled or unsupported schemes become ordinary search text.
  if (!/[\s\\]/.test(text) && !text.startsWith('//')) {
    try {
      const parsed = new URL(`https://${text}`);
      const host = parsed.hostname;
      const domain =
        host.includes('.') && host.split('.').every((part) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(part));
      if (!parsed.username && !parsed.password && (host === 'localhost' || host.startsWith('[') || domain))
        return parsed.href;
    } catch {
      /* Search text, including malformed schemes. */
    }
  }
  return searchUrl(text, engine);
}

function searchUrl(text: string, engine: SearchEngine) {
  try {
    return searchUrls[engine] + encodeURIComponent(text);
  } catch (error) {
    if (error instanceof URIError) throw new RemoteKitError('invalid_request', '搜索内容包含无效字符');
    throw error;
  }
}
