import type { LauncherItem, ProductAction, ProductWorkspace, WindowPlacement } from '../../shared/product';

export function launcherActions(
  workspace: ProductWorkspace,
  item: LauncherItem,
  placement?: WindowPlacement,
  reuseExisting = false,
): ProductAction[] {
  let appId = item.kind === 'file' ? 'files' : (item.appId ?? 'browser');
  if (item.kind === 'page' && item.url) {
    const app = workspace.apps
      .filter((app) => item.url!.startsWith(app.scope))
      .sort((a, b) => b.scope.length - a.scope.length)[0];
    appId = app ? `web:${app.id}` : 'browser';
  }
  const existing = [...workspace.windows]
    .filter((win) => win.appId === (item.kind === 'page' ? 'browser' : appId))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  const url = item.kind === 'page' ? item.url : undefined;
  if (!placement && existing && (reuseExisting || appId === 'settings')) {
    if (item.kind === 'page') return [{ type: 'tab.create', windowId: existing.id, url, source: 'launcher' }];
    return [{ type: 'window.focus', windowId: existing.id, source: 'launcher' }];
  }
  return [{ type: 'window.open', appId, url, placement: placement ?? { mode: 'space' }, source: 'launcher' }];
}

export function launcherNavigation(url: string): ProductAction {
  return {
    type: 'window.open',
    appId: 'browser',
    url,
    placement: { mode: 'space' },
    source: 'launcher',
  };
}
