import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { ViewportPreviewAdapter } from './presentation/viewport-preview-adapter';
import type { Surface } from './types';
import type { ViewerSession } from './viewer-session';
export function useViewportTransition(
  host: RefObject<HTMLElement | null>,
  session: ViewerSession,
  viewId: string,
  surface: Surface | undefined,
  frameReady: boolean,
  owner: string | undefined,
  editor: RefObject<HTMLTextAreaElement | null>,
) {
  const [adapter, setAdapter] = useState<ViewportPreviewAdapter>();
  useLayoutEffect(() => {
    if (!host.current || !editor.current) return;
    const value = new ViewportPreviewAdapter(session.presentation, viewId, host.current, editor.current);
    setAdapter(value);
    return () => value.detach();
  }, [session, viewId, host, editor]);
  useLayoutEffect(
    () => adapter?.configure(surface, frameReady, owner),
    [adapter, surface, frameReady, owner],
  );
  const snapshot = useSyncExternalStore(
    adapter?.subscribe ?? emptySubscribe,
    adapter?.getSnapshot ?? initialSnapshot,
  );
  return { ...snapshot, blocksInput: adapter?.blocksInput ?? unblocked };
}
const initial: import('./presentation/viewport-preview-adapter').ResizeSnapshot = {
  frozen: false,
  waiting: false,
  keyboard: false,
  keyboardOpen: false,
  keyboardDismissals: 0,
};
const initialSnapshot = () => initial;
const emptySubscribe = () => () => {};
const unblocked = () => false;
