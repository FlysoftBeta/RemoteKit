import type { LauncherItem } from '../../shared/product';

export type TileSize = 'small' | 'medium' | 'wide';
export interface LauncherTile extends LauncherItem {
  size: TileSize;
  /** Width in row-height units; every tile in a row shares the row height. */
  span: number;
  width: number;
}
export interface LauncherGroup {
  id: string;
  title: string;
  tiles: LauncherTile[];
}
export const LAUNCHER_SPACING = 12;
// Group label plus the space between rows.
export const LAUNCHER_ROW_CHROME = 48;
const SPANS: Record<TileSize, number> = { small: 1, medium: 2, wide: 3 };
const titles = { frequent: '常用', apps: 'App', pages: '网页', files: '文件' };
const builtin = ['browser', 'files', 'settings'];
const byScore = (a: LauncherItem, b: LauncherItem) => b.score - a.score;

export function tileSize(item: LauncherItem, index: number, items: LauncherItem[]): TileSize {
  const scores = items.map((entry) => entry.score).sort((a, b) => b - a);
  const maximum = scores[0] ?? 0;
  const ratio = maximum > 0 ? item.score / maximum : 0;
  const leads = maximum > 0 && item.score === maximum && maximum >= (scores[1] ?? 0) * 1.25;
  if (index === 0 && items.length >= 3 && leads) return 'wide';
  if (item.favorite || item.organized || (item.kind === 'app' && builtin.includes(item.appId ?? '')))
    return 'medium';
  return ratio >= 0.5 ? 'medium' : 'small';
}

export function rowHeight(availableHeight: number, rowCount: number) {
  const rows = Math.max(1, rowCount);
  return Math.round(Math.max(88, Math.min(168, availableHeight / rows - LAUNCHER_ROW_CHROME)));
}

export function launcherLayout(items: LauncherItem[], availableHeight: number, query = '') {
  const frequent = items
    .filter((item) => item.group === 'frequent')
    .sort(byScore)
    .slice(0, 12);
  const used = new Set(frequent.map((item) => item.key));
  const apps = items
    .filter((item) => item.group === 'apps')
    .sort((a, b) => {
      const ai = builtin.indexOf(a.appId ?? '');
      const bi = builtin.indexOf(b.appId ?? '');
      return (ai < 0 ? 3 : ai) - (bi < 0 ? 3 : bi) || byScore(a, b);
    });
  const pages = items
    .filter((item) => item.group === 'pages' && !used.has(item.key))
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || byScore(a, b))
    .slice(0, 16);
  const files = items
    .filter((item) => item.group === 'files' && !used.has(item.key))
    .sort((a, b) => Number(!!b.organized) - Number(!!a.organized) || byScore(a, b))
    .slice(0, 12);
  const rows: { id: string; title: string; entries: LauncherItem[] }[] = [];
  if (query.trim()) {
    const needle = query.trim().toLocaleLowerCase();
    const unique = new Map(items.map((item) => [item.key, item]));
    rows.push({
      id: 'search',
      title: '搜索结果',
      entries: [...unique.values()]
        .filter((item) =>
          [item.title, item.subtitle, item.url].some((value) => value?.toLocaleLowerCase().includes(needle)),
        )
        .sort(byScore),
    });
  } else {
    for (const [id, entries] of Object.entries({ frequent, apps, pages, files }))
      rows.push({ id, title: titles[id as keyof typeof titles], entries });
  }
  const groups = rows.filter((row) => row.entries.length);
  const height = rowHeight(availableHeight, groups.length);
  return {
    height,
    spacing: LAUNCHER_SPACING,
    groups: groups.map(({ id, title, entries }): LauncherGroup => ({
      id,
      title,
      tiles: entries.map((item, index) => {
        const size = tileSize(item, index, entries);
        const span = SPANS[size];
        return { ...item, size, span, width: span * height + (span - 1) * LAUNCHER_SPACING };
      }),
    })),
  };
}

function rgbFromHsl(h: number, s: number, l: number): number[] {
  const channel = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}
export function whiteContrast(rgb: number[]) {
  const linear = rgb.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 1.05 / (0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] + 0.05);
}
export function contrastColor(hex: string): string {
  const value = /^#[\da-f]{6}$/i.test(hex) ? hex : '#475569';
  const rgb = [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16) / 255);
  const maximum = Math.max(...rgb),
    minimum = Math.min(...rgb),
    delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta) {
    hue =
      maximum === rgb[0]
        ? ((rgb[1] - rgb[2]) / delta + 6) % 6
        : maximum === rgb[1]
          ? (rgb[2] - rgb[0]) / delta + 2
          : (rgb[0] - rgb[1]) / delta + 4;
    hue /= 6;
  }
  let low = 0,
    high = lightness;
  for (let index = 0; index < 30; index++) {
    const middle = (low + high) / 2;
    if (whiteContrast(rgbFromHsl(hue, saturation, middle)) >= 4.5) low = middle;
    else high = middle;
  }
  // Floor channels so rounding cannot reduce the promised contrast.
  return (
    '#' +
    rgbFromHsl(hue, saturation, low)
      .map((channel) =>
        Math.floor(channel * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
const palette = ['#3867ad', '#8049a5', '#137c80', '#ab5b23', '#a33d65', '#4f7138'];
export function originColor(url: string) {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    /* An app without a URL uses its stable key. */
  }
  let hash = 0;
  for (const character of origin) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return palette[(hash >>> 0) % palette.length];
}
