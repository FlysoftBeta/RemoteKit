import type { LauncherItem, ProductAction, ProductWorkspace, WindowPlacement } from '../../shared/product';

export function launcherActions(
  workspace: ProductWorkspace,
  item: LauncherItem,
  placement?: WindowPlacement,
  newWindow = false,
): ProductAction[] {
  let appId = item.kind === 'file' ? 'files' : (item.appId ?? 'browser');
  if (item.kind === 'page' && item.url) {
    const app = workspace.apps
      .filter((app) => item.url!.startsWith(app.scope))
      .sort((a, b) => b.scope.length - a.scope.length)[0];
    appId = app ? `web:${app.id}` : 'browser';
  }
  const existing = [...workspace.windows]
    .filter((win) => win.appId === appId)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  const url = item.kind === 'page' ? item.url : undefined;
  if (!placement && !newWindow && existing) {
    if (item.kind === 'page' && appId === 'browser')
      return [{ type: 'tab.create', windowId: existing.id, url, source: 'launcher' }];
    const actions: ProductAction[] = [{ type: 'window.focus', windowId: existing.id, source: 'launcher' }];
    if (url && existing.activeTabId)
      actions.push({ type: 'tab.navigate', tabId: existing.activeTabId, url, source: 'launcher' });
    return actions;
  }
  return [{ type: 'window.open', appId, url, placement: placement ?? { mode: 'space' }, source: 'launcher' }];
}

export function launcherNavigation(
  workspace: ProductWorkspace,
  url: string,
  placement?: WindowPlacement,
): ProductAction {
  const browser = [...workspace.windows]
    .filter((win) => win.appId === 'browser')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  return browser && !placement
    ? { type: 'tab.create', windowId: browser.id, url, source: 'launcher' }
    : {
        type: 'window.open',
        appId: 'browser',
        url,
        placement: placement ?? { mode: 'space' },
        source: 'launcher',
      };
}
