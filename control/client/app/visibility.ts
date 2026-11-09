import type { ProductState } from '../../shared/product';

/** The window filling the Viewer: a page's own fullscreen wins over one the user chose. */
export function fullscreenWindowId(state: ProductState, windowFullscreen: string | null) {
  if (state.pageFullscreen) return state.pageFullscreen.windowId;
  return windowFullscreen && state.workspace.windows.some((window) => window.id === windowFullscreen)
    ? windowFullscreen
    : undefined;
}

export function selectVisibility(
  state: ProductState,
  shellWidth: number,
  windowFullscreen: string | null = null,
) {
  const workspace = state.workspace;
  const fullscreen = fullscreenWindowId(state, windowFullscreen);
  const space = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
  const sideBySide =
    !fullscreen &&
    !!space &&
    space.windowIds.length > 1 &&
    shellWidth - 16 - (space.windowIds.length - 1) * 8 >= space.windowIds.length * 360;
  const visibleWindowIds = fullscreen
    ? [fullscreen]
    : space
      ? sideBySide
        ? space.windowIds
        : [space.focusedWindowId]
      : [];
  const windows = [...workspace.windows].sort(
    (a, b) => Number(b.id === space?.focusedWindowId) - Number(a.id === space?.focusedWindowId),
  );
  let foreground: { kind: 'page' | 'file'; id: string } | null = null;
  for (const window of windows) {
    if (!visibleWindowIds.includes(window.id)) continue;
    const page = state.pageDialogs?.find(
      (request) =>
        request.tabId === window.activeTabId &&
        request.kind !== 'permission' &&
        request.kind !== 'protocol_handler',
    );
    if (page) {
      foreground = { kind: 'page', id: page.id };
      break;
    }
    const file = state.fileRequests?.find((request) => request.tabId === window.activeTabId);
    if (file) {
      foreground = { kind: 'file', id: file.id };
      break;
    }
  }
  return { space, sideBySide, visibleWindowIds, foreground };
}
