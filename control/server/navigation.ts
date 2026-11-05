import type { SearchEngine } from '../shared/product';

const searchUrls: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  baidu: 'https://www.baidu.com/s?wd=',
};

/** User text is resolved only here, shared by address-bar and start-page actions. */
export function resolveNavigation(value: unknown, engine: SearchEngine): string {
  const url = resolveInput(value, engine);
  if (Buffer.byteLength(url, 'utf8') > 8192) throw new Error('网址或搜索内容编码后过长（最多 8192 字节）');
  return url;
}

function resolveInput(value: unknown, engine: SearchEngine): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('无效网址或搜索内容');
  const text = value.trim();
  if (!text) throw new Error('请输入网址或搜索内容');
  if (text === 'about:blank') return text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (!parsed.hostname || parsed.username || parsed.password || /[\s\\]/.test(text)) throw new Error();
      return parsed.href;
    } catch {
      throw new Error('请输入有效的 HTTP 或 HTTPS 网址');
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
  return (searchUrls[engine] ?? searchUrls.google) + encodeURIComponent(text);
}
