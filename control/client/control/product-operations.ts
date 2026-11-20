import {
  focusWindow,
  placeWindow,
  removeWindow,
  replaceWindow,
  windowClosing,
} from '../../server/workspace/model';
import { RemoteKitError, parseWireError } from '../../shared/errors';
import {
  isSingletonApp,
  creationIdFields,
  placeTab,
  type OperationReceipt,
  type ProductAction,
  type ProductOperation,
  type ProductState,
  type ProductWorkspace,
  type WindowPlacement,
} from '../../shared/product';
import { randomUuid } from '../../shared/random-uuid';
import type { RecordedAction } from '../../shared/recorded-action';
/** Product actions return execution receipts, never an authoritative workspace. */
export type ProductActionHandler = (action: ProductAction) => Promise<OperationReceipt>;
export function requireAcceptedReceipt(receipt: OperationReceipt): OperationReceipt {
  if (receipt.status === 'failed')
    throw parseWireError(receipt.error) ?? new RemoteKitError('internal', '操作收据缺少错误码');
  return receipt;
}
export interface PendingOperation extends ProductOperation {
  receipt?: OperationReceipt;
}
export function createdIds(action: RecordedAction): string[] {
  const fields = action as unknown as Record<string, unknown>;
  return creationIdFields(action)
    .map((field) => fields[field])
    .filter((id): id is string => typeof id === 'string');
}

export function targetIds(action: ProductAction): string[] {
  if (action.type === 'space.close') return action.spaceIds;
  const created = new Set<string>(creationIdFields(action));
  const ids = Object.entries(action)
    .filter(([key]) => (key === 'id' || key.endsWith('Id')) && !created.has(key))
    .map(([, value]) => value);
  if ('placement' in action) {
    if (action.placement.mode === 'split') ids.push(action.placement.besideWindowId);
    if (action.placement.mode === 'replace') ids.push(action.placement.windowId);
  }
  return ids.filter((id): id is string => typeof id === 'string');
}

export function isBeingCreated(
  state: ProductState | null,
  pending: { action: RecordedAction; receipt?: OperationReceipt }[],
  id: string | null,
): boolean {
  if (!state || !id) return false;
  if (
    [...state.workspace.windows, ...state.workspace.tabs, ...state.workspace.spaces].some(
      (item) => item.id === id,
    )
  )
    return false;
  return pending.some(
    (operation) => operation.receipt?.status !== 'failed' && createdIds(operation.action).includes(id),
  );
}
function canPlace(workspace: ProductWorkspace, windowId: string, placement: WindowPlacement) {
  if (windowClosing(workspace, windowId)) return false;
  if (placement.mode === 'space') return true;
  if (placement.mode === 'replace')
    return (
      workspace.windows.some((win) => win.id === placement.windowId) &&
      !windowClosing(workspace, placement.windowId)
    );
  const target = workspace.spaces.find((space) => space.windowIds.includes(placement.besideWindowId));
  return (
    !!target &&
    placement.besideWindowId !== windowId &&
    !windowClosing(workspace, placement.besideWindowId) &&
    (target.windowIds.includes(windowId) || target.windowIds.length < 3)
  );
}
function awaitingUser(workspace: ProductWorkspace, tabIds: string[]) {
  const close = workspace.pendingClose;
  return !!close && !close.awaiting && tabIds.includes(close.id);
}
function removeTab(workspace: ProductWorkspace, tab: ProductWorkspace['tabs'][number]) {
  workspace.tabs = workspace.tabs.filter((t) => t.id !== tab.id);
  const win = workspace.windows.find((win) => win.id === tab.windowId);
  if (win?.activeTabId === tab.id)
    win.activeTabId = workspace.tabs.find((t) => t.windowId === win.id)?.id ?? null;
  if (win?.appId.startsWith('web:')) removeWindow(workspace, win.id);
}
/** Snapshots are the only product authority; projections live for this page only. */
export function projectOperations(
  state: ProductState | null,
  pending: PendingOperation[],
): ProductState | null {
  if (!state) return null;
  const next = JSON.parse(JSON.stringify(state)) as ProductState,
    w = next.workspace;
  for (const operation of pending) {
    const a = operation.action;
    if (operation.receipt && ['failed'].includes(operation.receipt.status)) continue;
    if (
      operation.receipt &&
      ['committed', 'unknown'].includes(operation.receipt.status) &&
      (operation.receipt.revision ?? Infinity) <= w.revision
    )
      continue;
    switch (a.type) {
      case 'window.open': {
        const id = a.windowId;
        if (w.windows.some((win) => win.id === id)) break;
        const existing = isSingletonApp(a.appId) && w.windows.find((win) => win.appId === a.appId);
        if (existing) {
          focusWindow(w, existing.id);
          break;
        }
        if (w.windows.length >= 16 || !canPlace(w, id, a.placement)) break;
        w.windows.push({ id, appId: a.appId, activeTabId: null, lastActiveAt: Date.now() });
        if (a.placement.mode === 'replace') replaceWindow(w, id, a.placement.windowId, a.spaceId!);
        else placeWindow(w, id, a.placement, a.spaceId!);
        if (creationIdFields(a).includes('tabId')) {
          const url = a.url ?? w.apps.find((app) => `web:${app.id}` === a.appId)?.startUrl;
          w.tabs.push({
            id: a.tabId!,
            windowId: id,
            idleKeepAlive: false,
            webviewId: '',
            kind: 'start',
            title: '正在打开…',
            url: '',
            pendingUrl: url,
          });
          w.windows.find((win) => win.id === id)!.activeTabId = a.tabId!;
        }
        break;
      }
      case 'window.focus':
        if (w.windows.some((win) => win.id === a.windowId)) focusWindow(w, a.windowId);
        break;
      case 'window.place':
        if (w.windows.some((win) => win.id === a.windowId) && canPlace(w, a.windowId, a.placement))
          placeWindow(w, a.windowId, a.placement, a.spaceId!);
        break;
      case 'space.activate': {
        const space = w.spaces.find((space) => space.id === a.spaceId);
        if (space) focusWindow(w, space.focusedWindowId);
        break;
      }
      case 'space.layout': {
        const space = w.spaces.find((space) => space.id === a.spaceId);
        if (space) {
          const sum = a.weights.reduce((sum, value) => sum + value, 0);
          space.weights = a.weights.map((value) => value / sum);
        }
        break;
      }
      case 'window.state': {
        const win = w.windows.find((win) => win.id === a.windowId);
        if (win) win.state = a.state;
        break;
      }
      case 'settings.update':
        if (a.settings.workspace) Object.assign(w.settings.workspace, a.settings.workspace);
        if (a.settings.browser) Object.assign(w.settings.browser, a.settings.browser);
        break;
      case 'favorite.add':
        if (!w.favorites.some((favorite) => favorite.url === a.url))
          w.favorites.push({ id: a.favoriteId, title: a.title, url: a.url, createdAt: Date.now() });
        break;
      case 'favorite.remove':
        w.favorites = w.favorites.filter((favorite) => favorite.id !== a.id);
        break;
      case 'app.update': {
        const app = w.apps.find((app) => `web:${app.id}` === a.appId);
        const { type, appId, ...changes } = a;
        if (app) Object.assign(app, changes);
        break;
      }
      case 'app.uninstall':
        w.pendingAppUninstallId = a.appId.slice(4);
        break;
      case 'app.install':
        if (w.apps.some((app) => app.id === a.appId)) break;
        w.apps.push({
          id: a.appId,
          name: a.name,
          startUrl: a.startUrl,
          scope: a.scope ?? a.startUrl,
          display: a.display ?? 'standalone',
          themeColor: a.themeColor,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        break;
      case 'site.set':
        w.sites[a.origin] = {
          ...w.sites[a.origin],
          tabletUa: a.tabletUa,
        };
        break;
      case 'tab.create': {
        if (w.tabs.some((tab) => tab.id === a.tabId)) break;
        const win = w.windows.find((win) => win.id === a.windowId);
        if (win) {
          w.tabs.push({
            id: a.tabId,
            windowId: win.id,
            idleKeepAlive: false,
            webviewId: '',
            kind: 'start',
            title: '正在打开…',
            url: '',
            pendingUrl: a.url,
          });
          win.activeTabId = a.tabId;
          focusWindow(w, win.id);
        }
        break;
      }
      case 'tab.activate': {
        const tab = w.tabs.find((t) => t.id === a.tabId);
        if (tab) {
          focusWindow(w, tab.windowId);
          w.windows.find((x) => x.id === tab.windowId)!.activeTabId = tab.id;
        }
        break;
      }
      case 'tab.move': {
        const tab = w.tabs.find((t) => t.id === a.tabId),
          target = w.windows.find((x) => x.id === a.windowId);
        if (tab && target) {
          const source = w.windows.find((x) => x.id === tab.windowId);
          placeTab(w.tabs, tab.id, target.id, a.index);
          if (source && source !== target && source.activeTabId === tab.id)
            source.activeTabId = w.tabs.find((t) => t.windowId === source.id)?.id ?? null;
          target.activeTabId = tab.id;
          focusWindow(w, target.id);
        }
        break;
      }
      case 'tab.navigate': {
        const tab = w.tabs.find((t) => t.id === a.tabId);
        if (tab) {
          tab.kind = 'remote';
          tab.pendingUrl = a.url;
          tab.loading = true;
        }
        break;
      }
      case 'tab.command': {
        const tab = w.tabs.find((tab) => tab.id === a.tabId);
        if (tab) tab.loading = a.command !== 'stop';
        break;
      }
      case 'tab.close': {
        const tab = w.tabs.find((t) => t.id === a.tabId);
        if (tab && !a.cancel && (a.confirm || !awaitingUser(w, [tab.id]))) removeTab(w, tab);
        break;
      }
      case 'space.rename': {
        const space = w.spaces.find((space) => space.id === a.spaceId);
        if (space) space.name = a.name.trim() || null;
        break;
      }
      case 'space.close':
      case 'window.close': {
        const ids =
          a.type === 'window.close'
            ? [a.windowId]
            : w.spaces.filter((space) => a.spaceIds.includes(space.id)).flatMap((space) => space.windowIds);
        // A page asking to stay keeps its window on screen beside the leave dialog.
        for (const windowId of ids)
          if (
            !awaitingUser(
              w,
              w.tabs.filter((tab) => tab.windowId === windowId).map((tab) => tab.id),
            )
          )
            removeWindow(w, windowId);
        break;
      }
    }
  }
  const fullscreen = next.pageFullscreen;
  if (
    fullscreen &&
    !w.windows.some((window) => window.id === fullscreen.windowId && window.activeTabId === fullscreen.tabId)
  )
    delete next.pageFullscreen;
  return next;
}
export function snapshotNewer(next: ProductState, previous: ProductState | null) {
  if (
    typeof next.serverIncarnation !== 'string' ||
    !next.serverIncarnation ||
    !Number.isSafeInteger(next.snapshotSequence) ||
    next.snapshotSequence! < 1
  )
    return false;
  return (
    !previous ||
    next.serverIncarnation !== previous.serverIncarnation ||
    (next.snapshotSequence ?? 0) > (previous.snapshotSequence ?? -1)
  );
}

export const operationId = randomUuid;
