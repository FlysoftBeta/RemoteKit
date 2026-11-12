import { filesLaunch, filesState, filesView, readWindowState } from '../../shared/persisted-window-state';
import type { LibrarySnapshot, LibrarySource } from '../../shared/file-library';
import { BUILTIN_APP_TITLES, isBuiltinApp } from '../../shared/product';

export type FilesView =
  'all' | 'recent' | 'clipboard' | 'settings' | { partition: string } | { source: LibrarySource };
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
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function validFilesView(value: unknown): value is FilesView {
  try {
    filesView.read(value, '$');
    return true;
  } catch {
    return false;
  }
}
export function readFilesLaunch(value: unknown): FilesLaunch | undefined {
  if (value === undefined) return;
  return filesLaunch.read(value, '$');
}
export function hasValidFilesTabs(value: unknown): value is FilesWindowState {
  try {
    filesState.read(value, '$');
    return true;
  } catch {
    return false;
  }
}
export function readFilesWindowState(value: unknown): FilesWindowState {
  if (value === undefined) return defaultFilesWindowState();
  const state = readWindowState(value);
  if ('tabs' in state) return filesState.read(state, '$');
  return {
    ...defaultFilesWindowState(),
    ...(state.launch === undefined ? {} : { launch: filesLaunch.read(state.launch, '$.launch') }),
  };
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
  if (isBuiltinApp(app)) return BUILTIN_APP_TITLES[app];
  if (app === 'clipboard') return '剪贴板';
  return apps.find((item) => `web:${item.id}` === app)?.name ?? app;
}
export function sourceChannelName(source: LibrarySource) {
  if (source.app === 'files') return source.channel === 'camera' ? '拍照' : '上传';
  return source.channel;
}
export function filesInView(snapshot: LibrarySnapshot, view: FilesView, now = Date.now(), searching = false) {
  return snapshot.entries
    .filter((entry) => {
      if (view === 'settings') return false;
      if (view === 'clipboard') return entry.kind === 'snippet' && entry.source?.app === 'clipboard';
      if (typeof view === 'object')
        return 'partition' in view
          ? entry.partitionId === view.partition
          : view.source.app === 'study' && !view.source.channel
            ? entry.source?.app === 'study'
            : sameSource(entry.source, view.source);
      if (entry.source && snapshot.excludedSources.some((source) => sameSource(entry.source, source)))
        return false;
      if (entry.kind === 'snippet') return searching;
      return view === 'all' || entry.createdAt >= now - 7 * 86400_000;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
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
