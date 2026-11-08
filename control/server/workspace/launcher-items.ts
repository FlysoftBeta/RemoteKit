import type { InstalledApp, LauncherItem } from '../../shared/product';
import { normalizedUsagePage } from '../navigation-url';
import { computeFrecency, type UsageEvent } from './frecency';

export interface LauncherFileEntry {
  id: string;
  name: string;
  organized: boolean;
  hidden: boolean;
}

export function launcherItems(input: {
  events: readonly UsageEvent[];
  now: number;
  query?: string;
  favorites: readonly { url: string; title: string }[];
  apps: readonly InstalledApp[];
  admin: boolean;
  files: readonly LauncherFileEntry[];
  previews: ReadonlyMap<string, string>;
}): LauncherItem[] {
  const favorites = new Set(input.favorites.map((favorite) => favorite.url));
  const organizedBoost = new Set(input.files.filter((entry) => entry.organized).map((entry) => entry.id));
  const frecency = computeFrecency(input.events, input.now, {
    favorites,
    organized: organizedBoost,
  });
  const scores = new Map([...frecency].map(([item, score]) => [item, score.score]));
  // A page is frequent once it came up in two separate chains and was either a destination
  // or a pass-through to varied places (a chat home before each new conversation). A page
  // seen once, or one always passed through to the same place (sign-in, bot checks,
  // redirects), is history; it stays searchable.
  const established = (item: LauncherItem) => {
    if (item.kind !== 'page' || item.favorite) return true;
    const usage = frecency.get(item.key);
    return !!usage && usage.chains >= 2 && (usage.returns >= 1 || usage.ends >= 2);
  };
  const matchingApp = (url: string) =>
    input.apps.filter((app) => url.startsWith(app.scope)).sort((a, b) => b.scope.length - a.scope.length)[0];
  const apps: LauncherItem[] = [
    {
      key: 'app:browser',
      kind: 'app',
      group: 'apps',
      title: '浏览器',
      appId: 'browser',
      score: scores.get('app:browser') ?? 0,
    },
    {
      key: 'app:files',
      kind: 'app',
      group: 'apps',
      title: '我的文件',
      appId: 'files',
      score: scores.get('app:files') ?? 0,
    },
    {
      key: 'app:settings',
      kind: 'app',
      group: 'apps',
      title: '设置',
      appId: 'settings',
      score: scores.get('app:settings') ?? 0,
    },
    ...(['study', 'questions'] as const).map((appId) => ({
      key: 'app:' + appId,
      kind: 'app' as const,
      group: 'apps' as const,
      title: appId === 'study' ? '学习' : '题库',
      appId,
      score: scores.get('app:' + appId) ?? 0,
    })),
    ...(input.admin
      ? [
          {
            key: 'app:admin',
            kind: 'app',
            group: 'apps',
            title: '管理',
            appId: 'admin',
            score: scores.get('app:admin') ?? 0,
          } satisfies LauncherItem,
        ]
      : []),
    ...input.apps
      .map((app): LauncherItem => ({
        key: 'app:web:' + app.id,
        kind: 'app',
        group: 'apps',
        title: app.name,
        appId: 'web:' + app.id,
        url: app.startUrl,
        score: scores.get('app:web:' + app.id) ?? 0,
        themeColor: app.themeColor,
        iconUrl: app.iconUrl,
      }))
      .sort((a, b) => b.score - a.score),
  ];
  const previews = input.previews;
  const pageMap = new Map<string, LauncherItem>();
  const page = (url: string, title: string, favorite: boolean) => {
    const app = matchingApp(url);
    return {
      key: 'page:' + url,
      kind: 'page',
      group: 'pages',
      ...(previews.has('page:' + normalizedUsagePage(url))
        ? { previewUrl: '/api/previews/' + previews.get('page:' + normalizedUsagePage(url)) }
        : {}),
      title: title || url,
      subtitle: new URL(url).hostname,
      url,
      favorite,
      score: scores.get('page:' + url) ?? 0,
      ...(app ? { appId: 'web:' + app.id, themeColor: app.themeColor, iconUrl: app.iconUrl } : {}),
    } satisfies LauncherItem;
  };
  // A page's usual title, not its latest: one visit stuck on a bot check or an error must
  // not rename the tile. Ties go to the more recent title.
  const titles = new Map<string, Map<string, number>>();
  for (const event of input.events)
    if (event.item.startsWith('page:') && event.title) {
      const url = normalizedUsagePage(event.item.slice(5));
      if (!url) continue;
      const counts = titles.get(url) ?? new Map<string, number>();
      titles.set(url, counts);
      counts.set(event.title, (counts.get(event.title) ?? 0) + 1);
    }
  const usualTitle = (url: string) => {
    let best = '';
    let count = 0;
    for (const [title, seen] of titles.get(url) ?? []) if (seen >= count) [best, count] = [title, seen];
    return best;
  };
  for (const event of input.events)
    if (event.item.startsWith('page:')) {
      const url = normalizedUsagePage(event.item.slice(5));
      if (url && !pageMap.has(url)) pageMap.set(url, page(url, usualTitle(url) || url, favorites.has(url)));
    }
  for (const favorite of input.favorites)
    pageMap.set(favorite.url, page(favorite.url, pageMap.get(favorite.url)?.title ?? favorite.title, true));
  const pages = [...pageMap.values()].sort(
    (a, b) => Number(b.favorite) - Number(a.favorite) || b.score - a.score,
  );
  const files = input.files
    .filter((entry) => !entry.hidden)
    .map((entry): LauncherItem => ({
      key: 'file:' + entry.id,
      kind: 'file',
      group: 'files',
      title: entry.name,
      entryId: entry.id,
      organized: entry.organized,
      score: scores.get('file:' + entry.id) ?? 0,
    }))
    .sort((a, b) => Number(b.organized) - Number(a.organized) || b.score - a.score);
  if (input.query?.trim()) {
    const needle = input.query.trim().toLocaleLowerCase();
    return [...apps, ...pages, ...files].filter((item) =>
      [item.title, item.subtitle, item.url].some((text) => text?.toLocaleLowerCase().includes(needle)),
    );
  }
  const frequent = [...apps, ...pages, ...files]
    .filter((item) => item.score > 0 && established(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  const frequentKeys = new Set(frequent.map((item) => item.key));
  return [
    ...frequent.map((item): LauncherItem => ({ ...item, group: 'frequent' })),
    ...apps,
    ...pages.filter((item) => established(item) && !frequentKeys.has(item.key)).slice(0, 16),
    ...files
      .filter((item) => !frequentKeys.has(item.key) && (item.organized || scores.has(item.key)))
      .slice(0, 12),
  ];
}
