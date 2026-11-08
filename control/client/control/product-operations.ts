import { focusWindow, replaceWindow, placeWindow, windowClosing } from '../../server/workspace/model';
import { RemoteKitError } from '../../shared/errors';
import {
  placeTab,
  type OperationReceipt,
  type ProductAction,
  type ProductOperation,
  type ProductState,
  type ProductWorkspace,
  type WindowPlacement,
} from '../../shared/product';
/** Product actions return execution receipts, never an authoritative workspace. */
export type ProductActionHandler = (action: ProductAction) => Promise<OperationReceipt>;
export function requireAcceptedReceipt(receipt: OperationReceipt): OperationReceipt {
  if (receipt.status === 'rejected' || receipt.status === 'expired')
    throw new RemoteKitError('rejected', receipt.error ?? '操作被拒绝');
  return receipt;
}
export interface PendingOperation extends ProductOperation {
  receipt?: OperationReceipt;
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
/** Snapshots are the only product authority; projections live for this page only. */
export function projectOperations(
  state: ProductState | null,
  pending: PendingOperation[],
): ProductState | null {
  if (!state) return null;
  const next = JSON.parse(JSON.stringify(state)) as ProductState,
    w = next.workspace;
  for (const operation of pending) {
    const a = operation.action,
      id = 'pending-' + operation.operationId;
    if (operation.receipt && ['rejected', 'expired'].includes(operation.receipt.status)) continue;
    if (
      operation.receipt &&
      ['committed', 'unknown'].includes(operation.receipt.status) &&
      (operation.receipt.revision ?? Infinity) <= w.revision
    )
      continue;
    switch (a.type) {
      case 'window.open': {
        const existing = a.appId === 'settings' && w.windows.find((win) => win.appId === 'settings');
        if (existing) {
          focusWindow(w, existing.id);
          break;
        }
        if (w.windows.length >= 16 || !canPlace(w, id, a.placement)) break;
        w.windows.push({ id, appId: a.appId, activeTabId: null, lastActiveAt: Date.now() });
        if (a.placement.mode === 'replace') replaceWindow(w, id, a.placement.windowId, id + '-space');
        else placeWindow(w, id, a.placement, id + '-space');
        if (a.appId === 'browser' || a.appId.startsWith('web:')) {
          const url = a.url ?? w.apps.find((app) => `web:${app.id}` === a.appId)?.startUrl;
          w.tabs.push({
            id: id + '-tab',
            windowId: id,
            webviewId: '',
            kind: 'start',
            title: '正在打开…',
            url: '',
            pendingUrl: url,
          });
          w.windows.find((win) => win.id === id)!.activeTabId = id + '-tab';
        }
        break;
      }
      case 'window.focus':
        if (w.windows.some((win) => win.id === a.windowId)) focusWindow(w, a.windowId);
        break;
      case 'window.place':
        if (w.windows.some((win) => win.id === a.windowId) && canPlace(w, a.windowId, a.placement))
          placeWindow(w, a.windowId, a.placement, id + '-space');
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
          w.favorites.push({ id, title: a.title, url: a.url, createdAt: Date.now() });
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
        w.apps.push({
          id,
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
          tabletUa: a.tabletUa ?? w.sites[a.origin]?.tabletUa ?? false,
          manualKeyboard: a.manualKeyboard ?? w.sites[a.origin]?.manualKeyboard ?? false,
        };
        break;
      case 'tab.create': {
        const win = w.windows.find((win) => win.id === a.windowId);
        if (win) {
          w.tabs.push({
            id,
            windowId: win.id,
            webviewId: '',
            kind: 'start',
            title: '正在打开…',
            url: '',
            pendingUrl: a.url,
          });
          win.activeTabId = id;
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
      case 'tab.close': {
        const tab = w.tabs.find((t) => t.id === a.tabId);
        if (tab) tab.title = tab.title.replace(/（待确认）$/, '') + '（待确认）';
        break;
      }
      case 'space.close':
        for (const winId of w.spaces.find((space) => space.id === a.spaceId)?.windowIds ?? [])
          for (const tab of w.tabs.filter((tab) => tab.windowId === winId))
            tab.title = tab.title.replace(/（待确认）$/, '') + '（待确认）';
        break;
      case 'window.close':
        for (const tab of w.tabs.filter((t) => t.windowId === a.windowId))
          tab.title = tab.title.replace(/（待确认）$/, '') + '（待确认）';
        break;
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

export function operationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  );
}
