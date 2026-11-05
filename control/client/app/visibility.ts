import type { ProductState } from '../../shared/product';

export function selectVisibility(state: ProductState, shellWidth: number) {
  const workspace = state.workspace;
  const sideBySide =
    !state.pageFullscreen &&
    workspace.layoutMode === 'side-by-side' &&
    shellWidth >= Math.max(720, workspace.windows.length * 365 - 5);
  const visibleWindowIds = workspace.windows
    .filter((window) =>
      state.pageFullscreen
        ? window.id === state.pageFullscreen.windowId
        : sideBySide || window.id === workspace.activeWindowId,
    )
    .map((window) => window.id);
  const windows = [...workspace.windows].sort(
    (a, b) => Number(b.id === workspace.activeWindowId) - Number(a.id === workspace.activeWindowId),
  );
  let foreground: { kind: 'page' | 'file'; id: string } | null = null;
  for (const window of windows) {
    if (!visibleWindowIds.includes(window.id)) continue;
    const page = state.pageDialogs?.find((request) => request.tabId === window.activeTabId);
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
  return { sideBySide, visibleWindowIds, foreground };
}
