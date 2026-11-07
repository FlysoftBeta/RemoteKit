import { useSyncExternalStore } from 'react';

// The Viewer always streams at the device's physical resolution. The user-facing scale zooms the
// whole app: <body> is laid out at viewport / scale and scaled back up with a transform (so portaled
// overlays follow it without a container override), and remote
// pages get DIP = layout px with deviceScaleFactor = devicePixelRatio × scale. A transform keeps
// getBoundingClientRect and pointer coordinates in the same (visual) space on every supported
// Chrome version; CSS zoom does not before Chrome 128.

export const UI_SCALE_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

const NARROW = 600;
const COMPACT = 760;

let scale = 1;
let layoutWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
const listeners = new Set<() => void>();

function publish() {
  layoutWidth = window.innerWidth / scale;
  const root = document.documentElement;
  root.classList.toggle('layout-narrow', layoutWidth <= NARROW);
  root.classList.toggle('layout-compact', layoutWidth <= COMPACT);
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', publish);
  publish();
}

export function setUiScale(value: number) {
  const next = Number.isFinite(value) && value > 0 ? value : 1;
  if (next === scale) return;
  scale = next;
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String(scale));
  root.classList.toggle('ui-scaled', scale !== 1);
  publish();
}

export const uiScale = () => scale;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useUiScale() {
  return useSyncExternalStore(subscribe, uiScale, () => 1);
}

// Width breakpoints follow the scaled layout, not the physical viewport.
export function useLayoutNarrow(width: 'narrow' | 'compact' = 'narrow') {
  return useSyncExternalStore(
    subscribe,
    () => layoutWidth <= (width === 'narrow' ? NARROW : COMPACT),
    () => false,
  );
}

// MUI Popover positions its paper in container px from the anchor's client rect and clamps it to
// the anchor window's size. Under the scaled root both have to be expressed in layout px.
export function scaledAnchor(element: Element | null | undefined) {
  if (!element || scale === 1) return element ?? null;
  const factor = scale;
  const view = element.ownerDocument.defaultView ?? window;
  const layoutWindow = {
    get innerWidth() {
      return view.innerWidth / factor;
    },
    get innerHeight() {
      return view.innerHeight / factor;
    },
    addEventListener: view.addEventListener.bind(view),
    removeEventListener: view.removeEventListener.bind(view),
  };
  return {
    nodeType: 1,
    ownerDocument: { defaultView: layoutWindow },
    getBoundingClientRect() {
      const rect = element.getBoundingClientRect();
      return new DOMRect(rect.left / factor, rect.top / factor, rect.width / factor, rect.height / factor);
    },
  } as unknown as Element;
}
