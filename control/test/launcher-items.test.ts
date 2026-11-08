import assert from 'node:assert/strict';
import test from 'node:test';
import { launcherItems, type LauncherFileEntry } from '../server/workspace/launcher-items';
import type { UsageEvent } from '../server/workspace/frecency';
import type { InstalledApp } from '../shared/product';
import { BUILTIN_APP_TITLES } from '../shared/product';

const now = 1_800_000_000_000;
function input(
  overrides: Partial<Parameters<typeof launcherItems>[0]> = {},
): Parameters<typeof launcherItems>[0] {
  return {
    events: [],
    now,
    favorites: [],
    apps: [],
    admin: false,
    files: [],
    previews: new Map(),
    ...overrides,
  };
}
function app(id: string, scope = `https://${id}.test/`): InstalledApp {
  return {
    id,
    name: `Installed ${id}`,
    startUrl: scope,
    scope,
    display: 'standalone',
    createdAt: 1,
    updatedAt: 1,
    themeColor: '#123456',
    iconUrl: `/api/apps/${id}/icon?h=hash`,
  };
}
function visit(item: string, chain: string, at = now, title?: string): UsageEvent {
  return { item, chain, at, windowId: 'window', ...(title ? { title } : {}) };
}

test('launcher groups obey caps, favorite and organized priority, source exclusion and App presentation', () => {
  const apps = Array.from({ length: 15 }, (_, index) => app(`app-${index}`, `https://app${index}.test/`));
  const files: LauncherFileEntry[] = Array.from({ length: 30 }, (_, index) => ({
    id: `file-${index}`,
    name: `File ${index}`,
    organized: index >= 20,
    hidden: index === 0,
  }));
  files.push({ id: 'excluded-organized', name: 'Excluded', organized: true, hidden: true });
  files.push({ id: 'unused', name: 'Unused searchable file', organized: false, hidden: false });
  const events: UsageEvent[] = [];
  const record = (item: string, visits: number, title?: string) => {
    for (let index = 0; index < visits; index++)
      events.push(visit(item, `${item}:${index}:${events.length}`, now, title));
  };
  for (const installed of apps) record('app:web:' + installed.id, 40);
  for (let index = 0; index < 30; index++) record(`page:https://pages.test/${index}`, 2, `Page ${index}`);
  record('page:https://once.test/sign-in', 1, 'Sign in once');
  record('page:https://pages.test/1', 1, 'Just a moment...');
  for (const file of files.filter((file) => file.id !== 'unused'))
    record('file:' + file.id, file.id === 'file-0' ? 100 : 1);
  const data = input({
    apps,
    files,
    events,
    favorites: [{ title: 'Favorite page', url: 'https://app0.test/favorite' }],
  });
  const items = launcherItems(data);
  const group = (name: string) => items.filter((item) => item.group === name);
  assert.equal(group('frequent').length, 12);
  const builtIns = Object.keys(BUILTIN_APP_TITLES).filter((appId) => appId !== 'admin');
  assert.equal(group('apps').length, builtIns.length + apps.length);
  assert.deepEqual(
    group('apps')
      .slice(0, 3)
      .map((item) => item.appId),
    ['browser', 'files', 'settings'],
  );
  assert.equal(group('pages').length, 16);
  assert.equal(group('pages')[0].favorite, true);
  assert.equal(group('pages')[0].themeColor, '#123456');
  assert.equal(group('pages')[0].iconUrl, '/api/apps/app-0/icon?h=hash');
  assert.equal(group('files').length, 12);
  assert.ok(
    group('files')
      .slice(0, 10)
      .every((item) => item.organized),
  );
  assert.equal(
    items.some((item) => item.entryId === 'file-0'),
    false,
  );
  assert.equal(
    items.some((item) => item.entryId === 'excluded-organized'),
    false,
  );
  const frequent = new Set(group('frequent').map((item) => item.key));
  assert.ok([...group('pages'), ...group('files')].every((item) => !frequent.has(item.key)));
  assert.deepEqual(
    launcherItems({ ...data, query: 'favorite' }).map((item) => item.url),
    ['https://app0.test/favorite'],
  );
  assert.equal(
    items.some((item) => item.url === 'https://once.test/sign-in'),
    false,
  );
  assert.equal(items.find((item) => item.url === 'https://pages.test/1')?.title, 'Page 1');
  assert.deepEqual(
    launcherItems({ ...data, query: 'sign in once' }).map((item) => item.url),
    ['https://once.test/sign-in'],
  );
  assert.deepEqual(
    launcherItems({ ...data, query: 'unused searchable' }).map((item) => item.entryId),
    ['unused'],
  );
  assert.equal(
    items.some((item) => item.entryId === 'unused'),
    false,
  );
});

test('a once-visited page is hidden but searchable without group limits', () => {
  const events = Array.from({ length: 25 }, (_, index) =>
    visit(`page:https://once.test/${index}`, `chain-${index}`, now, `Once ${index}`),
  );
  assert.equal(
    launcherItems(input({ events })).some((item) => item.kind === 'page'),
    false,
  );
  const results = launcherItems(input({ events, query: '  ONCE  ' }));
  assert.equal(results.length, 25);
  assert.ok(results.every((item) => item.group === 'pages'));
});

test('sign-in pages always ending at the same app are hidden even across chains', () => {
  const events: UsageEvent[] = [];
  for (let chain = 0; chain < 3; chain++) {
    const start = now - 100_000 + chain * 30_000;
    events.push(visit('page:https://accounts.test/signin', String(chain), start, 'Sign in'));
    events.push(visit('page:https://app.test/', String(chain), start + 1_000, 'App'));
  }
  const data = input({ events });
  assert.equal(
    launcherItems(data).some((item) => item.url === 'https://accounts.test/signin'),
    false,
  );
  assert.ok(launcherItems(data).some((item) => item.url === 'https://app.test/'));
  assert.equal(launcherItems({ ...data, query: 'sign in' }).length, 1);
});

test('chat homes ending at different conversations are established across chains', () => {
  const events = [
    visit('page:https://chat.test/', 'first', now - 10_000, 'Chat home'),
    visit('page:https://chat.test/conversation/one', 'first', now - 9_000),
    visit('page:https://chat.test/', 'second', now - 5_000, 'Chat home'),
    visit('page:https://chat.test/conversation/two', 'second', now - 4_000),
  ];
  const pages = launcherItems(input({ events })).filter((item) => item.kind === 'page');
  assert.deepEqual(
    pages.map((item) => item.url),
    ['https://chat.test/'],
  );
});

test('the usual title beats a single bot-check title and ties favor the later title', () => {
  const url = 'https://claude.ai/';
  const events = [
    visit('page:' + url, 'first', now - 3_000, 'Claude'),
    visit('page:' + url, 'second', now - 2_000, 'Claude'),
    visit('page:' + url, 'third', now - 1_000, 'Just a moment...'),
  ];
  const pages = launcherItems(input({ events })).filter((item) => item.kind === 'page');
  assert.equal(pages[0].title, 'Claude');
  const tie = launcherItems(input({ events: events.slice(1) })).find((item) => item.kind === 'page');
  assert.equal(tie?.title, 'Just a moment...');
});

test('favorites appear without usage and override the established-page filter', () => {
  const favorites = [
    { url: 'https://favorite.test/', title: 'Favorite' },
    { url: 'https://once.test/', title: 'Once' },
  ];
  const events = [visit('page:https://once.test/', 'once', now, 'Usual title')];
  const pages = launcherItems(input({ favorites, events })).filter((item) => item.kind === 'page');
  assert.equal(pages.length, 2);
  assert.ok(pages.every((item) => item.favorite));
  assert.equal(pages.find((item) => item.url === 'https://once.test/')?.title, 'Usual title');
});

test('page presentation picks the longest installed app scope and normalized preview key', () => {
  const apps = [app('broad', 'https://app.test/'), app('narrow', 'https://app.test/work/')];
  const url = 'https://app.test/work/document';
  const favorites = [{ url, title: 'Document' }];
  const pages = launcherItems(
    input({ apps, favorites, previews: new Map([['page:' + url, 'image-hash']]) }),
  ).filter((item) => item.kind === 'page');
  assert.equal(pages[0].appId, 'web:narrow');
  assert.equal(pages[0].iconUrl, '/api/apps/narrow/icon?h=hash');
  assert.equal(pages[0].previewUrl, '/api/previews/image-hash');
});

test('organized files receive the frecency boost and hidden files stay excluded from search', () => {
  const events = [
    visit('file:plain', 'plain'),
    visit('file:organized', 'organized'),
    visit('file:hidden', 'hidden'),
  ];
  const files = [
    { id: 'plain', name: 'Plain', organized: false, hidden: false },
    { id: 'organized', name: 'Organized', organized: true, hidden: false },
    { id: 'hidden', name: 'Hidden', organized: true, hidden: true },
  ];
  const data = input({ events, files });
  const items = launcherItems(data);
  assert.equal(
    items.find((item) => item.entryId === 'organized')?.score,
    1.5 * items.find((item) => item.entryId === 'plain')!.score,
  );
  assert.deepEqual(launcherItems({ ...data, query: 'hidden' }), []);
});
