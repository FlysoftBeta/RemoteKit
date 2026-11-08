export function stripOptionLabel(html: string, index: number): string {
  const label = String.fromCharCode(65 + index);
  const pattern = new RegExp(`^((?:\\s|&nbsp;|<[^>]+>)*?)${label}\\s*[.．、:：)）]\\s*(?:&nbsp;\\s*)?`);
  return html.replace(pattern, '$1');
}

function decodeUrl(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return point <= 0x10ffff ? String.fromCodePoint(point) : '';
  });
}

export function collectMediaUrls(values: unknown[]): string[] {
  const urls = new Set<string>();
  const add = (value: string): void => {
    const url = decodeUrl(value.trim());
    if (/^https?:\/\/[^\s<>"']+$/i.test(url)) urls.add(url);
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    } else if (typeof value === 'string') {
      add(value);
      const attrs = /\b(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      for (const match of value.matchAll(attrs)) add(match[1] ?? match[2] ?? match[3]);
      for (const match of value.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
        for (const entry of match[1].split(',')) add(entry.trim().split(/\s+/)[0]);
      }
      for (const match of value.matchAll(/url\(\s*["']?(https?:\/\/[^\s)'"<>]+)["']?\s*\)/gi)) add(match[1]);
    }
  };
  values.forEach(visit);
  return [...urls];
}
