import type { ProductState } from '../shared/product';
export function foregroundRequest(state: ProductState, width: number): {
    kind: 'page' | 'file';
    id: string;
} | null {
    const workspace = state.workspace;
    const split = workspace.layoutMode === 'side-by-side' && width >= Math.max(720, workspace.windows.length * 365 - 5);
    const windows = [...workspace.windows].sort((a, b) => Number(b.id === workspace.activeWindowId) - Number(a.id === workspace.activeWindowId));
    for (const window of windows) {
        if (!split && window.id !== workspace.activeWindowId)
            continue;
        const page = state.pageDialogs?.find(request => request.tabId === window.activeTabId);
        if (page)
            return { kind: 'page', id: page.id };
        const file = state.fileRequests?.find(request => request.tabId === window.activeTabId);
        if (file)
            return { kind: 'file', id: file.id };
    }
    return null;
}
