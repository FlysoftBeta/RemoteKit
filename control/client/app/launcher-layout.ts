import type { LauncherItem } from '../../shared/product';

export type TileSize = 'small' | 'wide' | 'large';
export interface LauncherTile extends LauncherItem {
  size: TileSize;
  /** Grid cell of the top-left corner and the span, in tile units. */
  column: number;
  row: number;
  columns: number;
  rows: number;
}
export interface LauncherGroup {
  id: string;
  title: string;
  rows: number;
  columns: number;
  tiles: LauncherTile[];
}
export interface LauncherLayout {
  unit: number;
  gap: number;
  groups: LauncherGroup[];
}
export const LAUNCHER_GAP = 8;
const UNIT = { preferred: 104, minimum: 64 };
const SPANS: Record<TileSize, [number, number]> = { small: [1, 1], wide: [2, 1], large: [2, 2] };
const titles = { frequent: '常用', apps: 'App', pages: '网页', files: '文件' };
const builtin = ['browser', 'files', 'study', 'questions', 'settings', 'admin'];
const byScore = (a: LauncherItem, b: LauncherItem) => b.score - a.score;

/**
 * Size follows how used an item is relative to its group: the score ratio to the group's top
 * score, gated by rank so that a group of equally used items still mixes sizes.
 */
export function tileSize(item: LauncherItem, rank: number, items: LauncherItem[]): TileSize {
  const maximum = Math.max(0, ...items.map((entry) => entry.score));
  const ratio = maximum > 0 ? item.score / maximum : 0;
  const count = items.length;
  if (count >= 3 && ratio >= 0.6 && rank < Math.max(1, Math.floor(count / 6))) return 'large';
  if (ratio >= 0.25 && rank < Math.ceil(count / 2)) return 'wide';
  return 'small';
}

/**
 * Column-first packing: each tile takes the leftmost column with room, top to bottom, so the
 * first columns hold the most used items and a group grows to the right only once they are full.
 * A single row holds same-size tiles: wide and small tiles side by side in one row look ragged.
 */
export function packTiles(sizes: TileSize[], rows: number) {
  const taken: boolean[][] = [];
  const free = (column: number, row: number) => !taken[column]?.[row];
  let columns = 0;
  const cells = sizes.map((requested) => {
    const size = rows < 2 ? 'small' : requested;
    const [width, height] = SPANS[size];
    for (let column = 0; ; column++) {
      for (let row = 0; row + height <= rows; row++) {
        let fits = true;
        for (let x = 0; x < width && fits; x++)
          for (let y = 0; y < height && fits; y++) fits = free(column + x, row + y);
        if (!fits) continue;
        for (let x = 0; x < width; x++)
          for (let y = 0; y < height; y++) (taken[column + x] ??= [])[row + y] = true;
        columns = Math.max(columns, column + width);
        return { size, column, row, columns: width, rows: height };
      }
    }
  });
  return { cells, columns };
}

// Three or more tiles wrap onto a second row rather than squeeze mixed sizes into one line.
function minimumRows(sizes: TileSize[]) {
  return sizes.includes('large') || sizes.length >= 3 ? 2 : 1;
}

// A group wraps to the visible width; the Start screen scrolls vertically when groups are tall.
function groupRows(sizes: TileSize[], visibleColumns: number) {
  const area = sizes.reduce((sum, size) => sum + SPANS[size][0] * SPANS[size][1], 0);
  return Math.max(minimumRows(sizes), Math.ceil(area / Math.max(1, visibleColumns)));
}

/** The tile unit from the width (about three columns on narrow screens) and rows per group. */
export function fitGroups(groupSizes: TileSize[][], width: number) {
  const unit = Math.max(UNIT.minimum, Math.min(UNIT.preferred, Math.floor((width - 2 * LAUNCHER_GAP) / 3)));
  const columns = Math.max(2, Math.floor((width + LAUNCHER_GAP) / (unit + LAUNCHER_GAP)));
  return { unit, rows: groupSizes.map((sizes) => groupRows(sizes, columns)) };
}

export function launcherLayout(items: LauncherItem[], query = '', width = Infinity): LauncherLayout {
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
      return (ai < 0 ? builtin.length : ai) - (bi < 0 ? builtin.length : bi) || byScore(a, b);
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
  const sizes = groups.map(({ entries }) => entries.map((item, rank) => tileSize(item, rank, entries)));
  const fit = fitGroups(sizes, Number.isFinite(width) ? width : 1600);
  return {
    unit: fit.unit,
    gap: LAUNCHER_GAP,
    groups: groups.map(({ id, title, entries }, index): LauncherGroup => {
      const packed = packTiles(sizes[index], fit.rows[index]);
      return {
        id,
        title,
        rows: fit.rows[index],
        columns: packed.columns,
        tiles: entries.map((item, rank) => ({ ...item, ...packed.cells[rank] })),
      };
    }),
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
    origin = url;
  }
  let hash = 0;
  for (const character of origin) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return palette[(hash >>> 0) % palette.length];
}
