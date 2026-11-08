import {
  isSingletonApp,
  type LauncherItem,
  type ProductAction,
  type ProductWorkspace,
  type WindowPlacement,
} from '../../shared/product';

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
  if (existing && (reuseExisting || isSingletonApp(appId))) {
    if (item.kind === 'page') return [{ type: 'tab.create', windowId: existing.id, url, source: 'launcher' }];
    return [{ type: 'window.focus', windowId: existing.id, source: 'launcher' }];
  }
  return [
    {
      type: 'window.open',
      appId,
      url,
      placement: placement ?? launcherPlacement(workspace),
      source: 'launcher',
    },
  ];
}

export function launcherPlacement(workspace: ProductWorkspace): WindowPlacement {
  const space = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
  if (!space || space.windowIds.length >= 3) return { mode: 'space' };
  return { mode: 'split', besideWindowId: space.windowIds[space.windowIds.length - 1], side: 'right' };
}

export function launcherNavigation(url: string, placement: WindowPlacement): ProductAction {
  return {
    type: 'window.open',
    appId: 'browser',
    url,
    placement,
    source: 'launcher',
  };
}
