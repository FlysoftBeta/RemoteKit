import { useCallback, useLayoutEffect, useRef } from 'react';
import type { ProductState, ProductTab } from '../../shared/product';
import type { WorkspaceCall } from './window-state';
import { captureWindow } from './space-snapshots';

export function encodePagePreview(frame: HTMLElement | undefined): string | undefined {
  const canvas = captureWindow(frame, 320, 200);
  if (!canvas) return;
  for (let quality = 0.85; quality >= 0.15; quality -= 0.1) {
    const image = canvas.toDataURL('image/jpeg', quality);
    if ((image.length - 'data:image/jpeg;base64,'.length) * 0.75 <= 24 * 1024) return image;
  }
}

export function usePagePreviews(
  state: ProductState | null,
  root: React.RefObject<HTMLElement | null>,
  visibleWindowIds: string[],
  call: WorkspaceCall,
) {
  const uploaded = useRef(new Map<string, number>());
  const visible = useRef<ProductTab[]>([]);
  const capture = useCallback(
    (tabs = visible.current) => {
      if (!root.current || document.visibilityState !== 'visible') return;
      for (const tab of tabs) {
        if (tab.signIn || tab.kind !== 'remote' || !/^https?:\/\//i.test(tab.url)) continue;
        const now = Date.now();
        if (now - (uploaded.current.get(tab.id) ?? 0) < 30000) continue;
        const frame = [...root.current.querySelectorAll<HTMLElement>('[data-window-id]')].find(
          (node) => node.dataset.windowId === tab.windowId && node.offsetWidth > 0,
        );
        const image = frame && encodePagePreview(frame);
        if (!image) continue;
        uploaded.current.set(tab.id, now);
        void call('page.preview', { url: tab.url, image }).catch(() => {});
      }
    },
    [call, root],
  );
  const tabs =
    state?.workspace.windows
      .filter((win) => visibleWindowIds.includes(win.id))
      .map((win) => state.workspace.tabs.find((tab) => tab.id === win.activeTabId))
      .filter((tab): tab is ProductTab => !!tab && !tab.signIn && tab.kind === 'remote') ?? [];
  const identity = JSON.stringify(tabs.map((tab) => [tab.id, tab.url, tab.loading, tab.usageDocument]));
  useLayoutEffect(() => {
    capture(
      visible.current.filter((old) => {
        const current = tabs.find((tab) => tab.id === old.id);
        return !current || current.url !== old.url || (!old.loading && current.loading);
      }),
    );
    visible.current = tabs;
    const ready = tabs.filter((tab) => !tab.loading);
    const timer = setTimeout(() => capture(ready), 2000);
    return () => clearTimeout(timer);
  }, [identity, capture]);
  return capture;
}
