import { useSyncExternalStore } from 'react';
import { diagnostics } from '../media/diagnostics';

// Window fullscreen also requests document fullscreen when the browser supports it.
type FullscreenState =
  | { phase: 'idle' }
  | { phase: 'requesting'; windowId: string; token: symbol }
  | { phase: 'active'; windowId: string; document: 'owned' | 'external' };

let state: FullscreenState = { phase: 'idle' };
const listeners = new Set<() => void>();

function publish(next: FullscreenState) {
  document.removeEventListener('fullscreenchange', documentFullscreenChanged);
  state = next;
  if (state.phase !== 'idle') document.addEventListener('fullscreenchange', documentFullscreenChanged);
  for (const listener of listeners) listener();
}

function documentFullscreenChanged() {
  if (!document.fullscreenElement && state.phase === 'active' && state.document === 'owned')
    publish({ phase: 'idle' });
}

export const currentWindowFullscreen = () => (state.phase === 'idle' ? null : state.windowId);

export function enterWindowFullscreen(id: string) {
  const target = document.documentElement;
  if (document.fullscreenElement || !document.fullscreenEnabled || !target.requestFullscreen) {
    const ownership = state.phase === 'active' ? state.document : 'external';
    publish({ phase: 'active', windowId: id, document: ownership });
    return;
  }
  const token = Symbol();
  publish({ phase: 'requesting', windowId: id, token });
  void target
    .requestFullscreen()
    .then(
      async () => {
        if (state.phase !== 'requesting' || state.token !== token) {
          await document.exitFullscreen();
          return;
        }
        publish({ phase: 'active', windowId: id, document: 'owned' });
      },
      (error) => {
        if (state.phase === 'requesting' && state.token === token)
          publish({ phase: 'active', windowId: id, document: 'external' });
        diagnostics.record('window-fullscreen', error);
      },
    )
    .catch((error) => diagnostics.record('window-fullscreen', error));
}

export function exitWindowFullscreen() {
  if (state.phase === 'idle') return;
  const release = state.phase === 'requesting' || state.document === 'owned';
  publish({ phase: 'idle' });
  if (release && document.fullscreenElement)
    void document.exitFullscreen().catch((error) => diagnostics.record('window-fullscreen', error));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useWindowFullscreen = () => useSyncExternalStore(subscribe, currentWindowFullscreen);
