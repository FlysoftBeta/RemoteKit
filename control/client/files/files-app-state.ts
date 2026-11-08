import type { LibrarySnapshot, LibrarySource } from '../../shared/file-library';

export type FilesView = 'all' | 'recent' | 'settings' | { partition: string } | { source: LibrarySource };
export interface FilesState {
  view: FilesView;
  query: string;
  layout: 'grid' | 'list';
}
const defaults = (): FilesState => ({ view: 'all', query: '', layout: 'grid' });
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,132}$/.test(value);

export function readFilesState(value: unknown): FilesState {
  if (!value || typeof value !== 'object') return defaults();
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 4096) return defaults();
  } catch {
    return defaults();
  }
  const state = value as FilesState;
  const view = state.view;
  const validView =
    view === 'all' ||
    view === 'recent' ||
    view === 'settings' ||
    (view &&
      typeof view === 'object' &&
      (('partition' in view && identifier(view.partition)) ||
        ('source' in view &&
          view.source &&
          identifier(view.source.app) &&
          typeof view.source.channel === 'string' &&
          view.source.channel.length <= (view.source.app === 'download' ? 259 : 253))));
  if (
    !validView ||
    typeof state.query !== 'string' ||
    state.query.length > 512 ||
    (state.layout !== 'grid' && state.layout !== 'list')
  )
    return defaults();
  return {
    view:
      typeof view === 'object'
        ? 'partition' in view
          ? { partition: view.partition }
          : { source: { app: view.source.app, channel: view.source.channel } }
        : view,
    query: state.query,
    layout: state.layout,
  };
}

export const sameSource = (a: LibrarySource | null, b: LibrarySource) =>
  a?.app === b.app && a.channel === b.channel;
export const sourceKey = (source: LibrarySource) => JSON.stringify([source.app, source.channel]);
export function sourceAppName(app: string, apps: readonly { id: string; name: string }[] = []) {
  if (app === 'download') return '下载';
  if (app === 'browser') return '浏览器';
  if (app === 'files') return '我的文件';
  return apps.find((item) => `web:${item.id}` === app)?.name ?? app;
}
export function sourceChannelName(source: LibrarySource) {
  if (source.app === 'files') return source.channel === 'camera' ? '拍照' : '上传';
  return source.channel;
}
export function filesInView(snapshot: LibrarySnapshot, view: FilesView, now = Date.now()) {
  return snapshot.entries
    .filter((entry) => {
      if (view === 'settings') return false;
      if (typeof view === 'object')
        return 'partition' in view
          ? entry.partitionId === view.partition
          : sameSource(entry.source, view.source);
      if (entry.source && snapshot.excludedSources.some((source) => sameSource(entry.source, source)))
        return false;
      return view === 'all' || entry.createdAt >= now - 7 * 86400_000;
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function removalCounts(
  snapshot: LibrarySnapshot,
  target: { partition: string } | { source: LibrarySource },
) {
  const entries = snapshot.entries.filter((entry) =>
    'partition' in target ? entry.partitionId === target.partition : sameSource(entry.source, target.source),
  );
  const kept = entries.filter(
    (entry) =>
      snapshot.basket.includes(entry.id) ||
      ('partition' in target ? entry.collected && entry.source !== null : entry.partitionId !== null),
  ).length;
  return { deleted: entries.length - kept, kept };
}
