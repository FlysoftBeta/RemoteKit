import { useSyncExternalStore } from 'react';
import { diagnostics } from '../media/diagnostics';

// A window the user chose to show fullscreen from its More menu. It is a display mode of this
// Viewer only: it lays the window out like a page that went fullscreen and, when the Viewer is not
// fullscreen yet, also asks the browser for fullscreen. Leaving either one leaves both.
let windowId: string | null = null;
let ownsDocumentFullscreen = false;
const listeners = new Set<() => void>();

function publish(next: string | null) {
  windowId = next;
  for (const listener of listeners) listener();
}

function documentFullscreenChanged() {
  if (document.fullscreenElement || !ownsDocumentFullscreen) return;
  ownsDocumentFullscreen = false;
  publish(null);
}

export const currentWindowFullscreen = () => windowId;

export function enterWindowFullscreen(id: string) {
  publish(id);
  const target = document.documentElement;
  if (document.fullscreenElement || !document.fullscreenEnabled || !target.requestFullscreen) return;
  ownsDocumentFullscreen = true;
  document.addEventListener('fullscreenchange', documentFullscreenChanged);
  target.requestFullscreen().catch((error) => {
    ownsDocumentFullscreen = false;
    diagnostics.record('window-fullscreen', error);
  });
}

export function exitWindowFullscreen() {
  if (!windowId) return;
  const release = ownsDocumentFullscreen && !!document.fullscreenElement;
  ownsDocumentFullscreen = false;
  publish(null);
  if (release) document.exitFullscreen().catch((error) => diagnostics.record('window-fullscreen', error));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useWindowFullscreen = () => useSyncExternalStore(subscribe, currentWindowFullscreen);
