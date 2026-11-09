import type { LibrarySnapshot, LibrarySource } from '../../shared/file-library';

export type FilesView = 'all' | 'recent' | 'settings' | { partition: string } | { source: LibrarySource };
export type FilesTab =
  | { id: string; kind: 'library'; view: FilesView; query: string }
  | { id: string; kind: 'document'; entryId: string; from?: FilesView };
export interface FilesLaunch {
  requestId: string;
  entryId?: string;
  view?: FilesView;
}
export interface FilesWindowState {
  tabs: FilesTab[];
  activeTabId: string;
  layout: 'grid' | 'list';
  launch?: FilesLaunch;
}
export const MAX_FILES_TABS = 16;
const MAX_STATE_BYTES = 8192;
export const filesTabId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
export const defaultFilesWindowState = (id = filesTabId()): FilesWindowState => ({
  tabs: [{ id, kind: 'library', view: 'all', query: '' }],
  activeTabId: id,
  layout: 'grid',
});
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,132}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: object, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function validFilesView(view: unknown): view is FilesView {
  return (
    view === 'all' ||
    view === 'recent' ||
    view === 'settings' ||
    (object(view) &&
      ((keys(view, ['partition']) && identifier(view.partition)) ||
        (keys(view, ['source']) &&
          object(view.source) &&
          keys(view.source, ['app', 'channel']) &&
          identifier(view.source.app) &&
          typeof view.source.channel === 'string' &&
          view.source.channel.length <= (view.source.app === 'download' ? 259 : 253))))
  );
}
export function readFilesLaunch(value: unknown): FilesLaunch | undefined {
  if (
    !object(value) ||
    !keys(value, ['requestId', 'entryId', 'view']) ||
    !identifier(value.requestId) ||
    (value.entryId !== undefined && !identifier(value.entryId)) ||
    (value.view !== undefined && !validFilesView(value.view)) ||
    (value.entryId === undefined && value.view === undefined)
  )
    return;
  return value as unknown as FilesLaunch;
}
export function hasValidFilesTabs(value: unknown): value is FilesWindowState {
  if (!object(value) || !keys(value, ['tabs', 'activeTabId', 'layout', 'launch'])) return false;
  const { tabs, activeTabId, layout } = value;
  if (
    !Array.isArray(tabs) ||
    !tabs.length ||
    tabs.length > MAX_FILES_TABS ||
    (layout !== 'grid' && layout !== 'list')
  )
    return false;
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (!object(tab) || typeof tab.id !== 'string' || !/^[a-z0-9]{8}$/.test(tab.id) || ids.has(tab.id))
      return false;
    ids.add(tab.id);
    if (tab.kind === 'library') {
      if (
        !keys(tab, ['id', 'kind', 'view', 'query']) ||
        !validFilesView(tab.view) ||
        typeof tab.query !== 'string' ||
        tab.query.length > 256
      )
        return false;
    } else if (tab.kind === 'document') {
      if (
        !keys(tab, ['id', 'kind', 'entryId', 'from']) ||
        !identifier(tab.entryId) ||
        (tab.from !== undefined && !validFilesView(tab.from))
      )
        return false;
    } else return false;
  }
  return (
    typeof activeTabId === 'string' &&
    ids.has(activeTabId) &&
    (value.launch === undefined || !!readFilesLaunch(value.launch))
  );
}
export function readFilesWindowState(value: unknown): FilesWindowState {
  try {
    if (hasValidFilesTabs(value) && bytes(value) <= MAX_STATE_BYTES) return JSON.parse(JSON.stringify(value));
  } catch {}
  return defaultFilesWindowState();
}

// Keep tab identity and views when trimming search drafts to fit the wire budget.
export function fitFilesWindowState(next: FilesWindowState, previous: FilesWindowState): FilesWindowState {
  let state = next;
  if (bytes(state) > MAX_STATE_BYTES)
    state = {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.kind === 'library' && tab.id !== state.activeTabId ? { ...tab, query: '' } : tab,
      ),
    };
  if (bytes(state) > MAX_STATE_BYTES)
    state = {
      ...state,
      tabs: state.tabs.map((tab) => (tab.kind === 'library' ? { ...tab, query: '' } : tab)),
    };
  return bytes(state) <= MAX_STATE_BYTES ? state : previous;
}
export function selectFilesTab(state: FilesWindowState, tabId: string): FilesWindowState {
  return state.tabs.some((tab) => tab.id === tabId) ? { ...state, activeTabId: tabId } : state;
}
export function updateFilesLibraryTab(
  state: FilesWindowState,
  tabId: string,
  update: { view?: FilesView; query?: string },
): FilesWindowState {
  return fitFilesWindowState(
    {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === tabId && tab.kind === 'library'
          ? { ...tab, ...update, query: (update.query ?? tab.query).slice(0, 256) }
          : tab,
      ),
    },
    state,
  );
}
export function setFilesLayout(state: FilesWindowState, layout: 'grid' | 'list'): FilesWindowState {
  return { ...state, layout };
}
export function openFilesEntry(state: FilesWindowState, tabId: string, entryId: string): FilesWindowState {
  return fitFilesWindowState(
    {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? { id: tab.id, kind: 'document', entryId, from: tab.kind === 'library' ? tab.view : tab.from }
          : tab,
      ),
    },
    state,
  );
}
export function backFilesTab(state: FilesWindowState, tabId: string): FilesWindowState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId && tab.kind === 'document'
        ? { id: tab.id, kind: 'library', view: tab.from ?? 'all', query: '' }
        : tab,
    ),
  };
}
function appendFilesTab(state: FilesWindowState, tab: FilesTab): FilesWindowState {
  const tabs = [...state.tabs];
  const active = tabs.findIndex((item) => item.id === state.activeTabId);
  tabs.splice(active + (tabs.length === MAX_FILES_TABS ? 0 : 1), tabs.length === MAX_FILES_TABS ? 1 : 0, tab);
  return fitFilesWindowState({ ...state, tabs, activeTabId: tab.id }, state);
}
export function newFilesTab(state: FilesWindowState, id: string): FilesWindowState {
  return state.tabs.length === MAX_FILES_TABS
    ? state
    : appendFilesTab(state, { id, kind: 'library', view: 'all', query: '' });
}
export function closeFilesTab(
  state: FilesWindowState,
  tabId: string,
  replacementId: string,
): FilesWindowState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (!tabs.length) return { ...defaultFilesWindowState(replacementId), layout: state.layout };
  return {
    ...state,
    tabs,
    activeTabId: state.activeTabId === tabId ? tabs[Math.min(index, tabs.length - 1)].id : state.activeTabId,
  };
}
export function closeOtherFilesTabs(state: FilesWindowState, tabId: string): FilesWindowState {
  const tab = state.tabs.find((tab) => tab.id === tabId);
  return tab ? { ...state, tabs: [tab], activeTabId: tab.id } : state;
}
export function reorderFilesTab(state: FilesWindowState, tabId: string, index: number): FilesWindowState {
  const tab = state.tabs.find((tab) => tab.id === tabId);
  if (!tab) return state;
  const tabs = state.tabs.filter((item) => item.id !== tabId);
  tabs.splice(Math.max(0, Math.min(tabs.length, index)), 0, tab);
  return { ...state, tabs };
}
export function applyFilesLaunch(
  state: FilesWindowState,
  launch: FilesLaunch,
  id: string,
  hadTabs = true,
): FilesWindowState {
  const { launch: _, ...rest } = state;
  const tab: FilesTab = launch.entryId
    ? { id, kind: 'document', entryId: launch.entryId, from: launch.view ?? 'all' }
    : { id, kind: 'library', view: launch.view ?? 'all', query: '' };
  return hadTabs ? appendFilesTab(rest, tab) : { ...rest, tabs: [tab], activeTabId: id };
}

export const sameSource = (a: LibrarySource | null, b: LibrarySource) =>
  a?.app === b.app && a.channel === b.channel;
export const sourceKey = (source: LibrarySource) => JSON.stringify([source.app, source.channel]);
export function sourceAppName(app: string, apps: readonly { id: string; name: string }[] = []) {
  if (app === 'download') return '下载';
  if (app === 'browser') return '浏览器';
  if (app === 'files') return '我的文件';
  if (app === 'study') return '学习';
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
          : view.source.app === 'study' && !view.source.channel
            ? entry.source?.app === 'study'
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
