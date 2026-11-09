import { useSyncExternalStore } from 'react';
import { uiScale } from './ui-scale';

// One tab drag at a time across all window frames, so a tab can be dropped into another
// side-by-side window's strip. Positions are visual px except `width`, which is layout px.
export interface TabDragState {
  tabId: string;
  sourceWindowId: string;
  title: string;
  from: number;
  width: number;
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  target: { windowId: string; index: number } | null;
}

const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 400;
const EDGE = 24;

let current: TabDragState | null = null;
const listeners = new Set<() => void>();
const strips = new Map<string, { group: string; element: HTMLElement }>();

function publish(next: TabDragState | null) {
  current = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useTabDrag = () =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );

export function registerTabStrip(windowId: string, group: string, element: HTMLElement | null) {
  if (element) strips.set(windowId, { group, element });
  else strips.delete(windowId);
}

// Insertion index among the strip's other tabs, from layout positions (offsetLeft ignores the
// transforms used to animate the drag).
function dropTarget(x: number, y: number, tabId: string, group: string) {
  for (const [windowId, registered] of strips) {
    if (registered.group !== group) continue;
    const strip = registered.element;
    const rect = strip.getBoundingClientRect();
    const slack = rect.height;
    if (x < rect.left || x > rect.right || y < rect.top - slack || y > rect.bottom + slack) continue;
    const scale = uiScale();
    const local = (x - rect.left) / scale + strip.scrollLeft;
    const edge = EDGE / scale;
    if (local - strip.scrollLeft < edge) strip.scrollLeft -= 8;
    else if (local - strip.scrollLeft > rect.width / scale - edge) strip.scrollLeft += 8;
    let index = 0;
    for (const tab of strip.querySelectorAll<HTMLElement>('.window-tab'))
      if (tab.dataset.tabId !== tabId && tab.offsetLeft + tab.offsetWidth / 2 < local) index++;
    return { windowId, index };
  }
  return null;
}

export interface TabDragRequest {
  event: React.PointerEvent<HTMLElement>;
  tabId: string;
  windowId: string;
  title: string;
  index: number;
  move: (tabId: string, windowId: string, index: number) => void;
  longPress: (element: HTMLElement) => void;
}

// Mouse and pen start dragging after a few px; touch needs a long press so a swipe still scrolls
// the strip. A touch long press released without moving opens the tab menu instead.
export function beginTabPointer({ event, tabId, windowId, title, index, move, longPress }: TabDragRequest) {
  if (current || (event.pointerType === 'mouse' && event.button !== 0)) return;
  if ((event.target as Element).closest('.tab-close')) return;
  const group = strips.get(windowId)?.group;
  if (!group) return;
  const element = event.currentTarget;
  const pointerId = event.pointerId;
  const touch = event.pointerType === 'touch';
  const startX = event.clientX,
    startY = event.clientY;
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const start = (x: number, y: number) => {
    const rect = element.getBoundingClientRect();
    publish({
      tabId,
      sourceWindowId: windowId,
      title,
      from: index,
      width: element.offsetWidth + parseFloat(getComputedStyle(element.parentElement!).columnGap || '0'),
      x,
      y,
      grabX: startX - rect.left,
      grabY: startY - rect.top,
      target: { windowId, index },
    });
  };
  const finish = (commit: boolean) => {
    clearTimeout(timer);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    const drag = current;
    if (!drag) return;
    publish(null);
    // The click that follows a drag would only re-activate the moved tab.
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    const target = drag.target;
    if (!commit || !target) return;
    if (target.windowId === drag.sourceWindowId && target.index === drag.from) return;
    move(drag.tabId, target.windowId, target.index);
  };
  const swallow = (e: Event) => e.stopPropagation();
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (!current) {
      if (touch && !armed) {
        if (moved > TOUCH_SLOP) finish(false);
        return;
      }
      if (!touch && moved <= MOUSE_SLOP) return;
      start(e.clientX, e.clientY);
    }
    if (!current) return;
    publish({
      ...current,
      x: e.clientX,
      y: e.clientY,
      target: dropTarget(e.clientX, e.clientY, tabId, group),
    });
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const pressed =
      touch && armed && current && Math.hypot(e.clientX - startX, e.clientY - startY) <= TOUCH_SLOP;
    if (pressed) {
      publish(null);
      finish(false);
      longPress(element);
      return;
    }
    finish(true);
  };
  const onCancel = (e: PointerEvent) => e.pointerId === pointerId && finish(false);
  const onTouchMove = (e: TouchEvent) => {
    if (armed && e.cancelable) e.preventDefault();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !current) return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  // A long press arms the drag; the platform's own long-press menu would interrupt it.
  const onContextMenu = (e: Event) => {
    if (armed) e.preventDefault();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  if (touch)
    timer = setTimeout(() => {
      armed = true;
      start(startX, startY);
    }, LONG_PRESS_MS);
}

// Horizontal shift (layout px) that opens the drop gap in a strip while a tab is dragged.
export function tabShift(drag: TabDragState | null, windowId: string, tabId: string, position: number) {
  if (!drag || tabId === drag.tabId) return 0;
  const inSource = windowId === drag.sourceWindowId;
  const inTarget = drag.target?.windowId === windowId;
  // Position among the strip's tabs without the dragged one.
  const rank = inSource && position > drag.from ? position - 1 : position;
  let shift = 0;
  if (inSource && position > drag.from) shift -= drag.width;
  if (inTarget && rank >= drag.target!.index) shift += drag.width;
  return shift;
}
