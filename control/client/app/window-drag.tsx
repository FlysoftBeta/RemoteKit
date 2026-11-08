import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  LauncherItem,
  ProductAction,
  ProductSpace,
  ProductState,
  WindowPlacement,
} from '../../shared/product';
import type { Action } from './product-dialogs';
import { AppIcon, appName } from './app-icon';
import { SpaceSnapshots } from './space-snapshots';
import { uiScale } from './ui-scale';

// A launcher item is not a window yet: dropping it opens a window at the chosen placement.
type Source = { windowId: string } | { spaceId: string } | { item: LauncherItem };
type Target = { action?: ProductAction; placement?: WindowPlacement; marker?: number };
type Drag = { source: Source; x: number; y: number; target?: Target };
export interface PointerStart {
  pointerId: number;
  clientX: number;
  clientY: number;
  pointerType: string;
  element: HTMLElement;
}
const WindowDragContext = createContext<(event: React.PointerEvent<HTMLElement>, source: Source) => void>(
  () => {},
);
const ItemDragContext = createContext<(pointer: PointerStart, item: LauncherItem) => void>(() => {});
const DraggingContext = createContext<Source | undefined>(undefined);
export const useWindowDragging = () => useContext(DraggingContext);
export const useWindowDrag = () => useContext(WindowDragContext);
export const useItemDrag = () => useContext(ItemDragContext);

function insertionPositions(stage: HTMLElement, space: ProductSpace) {
  const bounds = stage.getBoundingClientRect();
  const frames = [...stage.querySelectorAll<HTMLElement>('[data-window-id]')].filter(
    (node) => node.offsetWidth > 0,
  );
  if (frames.length === space.windowIds.length)
    return [bounds.left, ...frames.map((frame) => frame.getBoundingClientRect().right)];
  return [
    bounds.left,
    ...space.weights.map(
      (_, index) =>
        bounds.left +
        bounds.width * space.weights.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0),
    ),
  ];
}

export function WindowDragProvider({
  state,
  snapshots,
  action,
  report,
  railVisible,
  openItem,
  children,
}: {
  state: ProductState;
  snapshots: SpaceSnapshots;
  action: Action;
  report(error: unknown): void;
  railVisible: boolean;
  openItem(item: LauncherItem, placement: WindowPlacement): Promise<void>;
  children: React.ReactNode;
}) {
  const [drag, setDrag] = useState<Drag>();
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  const workspace = state.workspace;
  const active = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
  const targetAt = (source: Source, x: number, y: number): Target | undefined => {
    const element = document.elementFromPoint(x, y);
    const stage = document.querySelector<HTMLElement>('.window-workspace');
    if ('spaceId' in source) {
      const from = workspace.spaces.find((space) => space.id === source.spaceId);
      if (
        element?.closest('.window-workspace') &&
        from &&
        active &&
        from !== active &&
        from.windowIds.length + active.windowIds.length <= 3
      )
        return { action: { type: 'space.merge', spaceId: from.id, intoSpaceId: active.id } };
      return;
    }
    const movingId = 'windowId' in source ? source.windowId : undefined;
    const place = (placement: WindowPlacement): Target =>
      'windowId' in source
        ? { action: { type: 'window.place', windowId: source.windowId, placement } }
        : { placement };
    const card = element?.closest<HTMLElement>('[data-rail-space]');
    if (card) {
      const space = workspace.spaces.find((space) => space.id === card.dataset.railSpace);
      if (space && space.windowIds.length < 3) {
        const beside = space.windowIds.filter((id) => id !== movingId).pop();
        if (beside) return place({ mode: 'split', besideWindowId: beside, side: 'right' });
      }
      return;
    }
    if (element?.closest('[data-new-group]') || (element?.closest('.group-rail-list') && !card))
      return place({ mode: 'space' });
    if (!stage || !active || !element?.closest('.window-workspace')) return;
    const own = !!movingId && active.windowIds.includes(movingId);
    if (!own && active.windowIds.length >= 3) return;
    const boundaries = insertionPositions(stage, active);
    let slot = 0;
    boundaries.forEach((position, index) => {
      if (Math.abs(x - position) < Math.abs(x - boundaries[slot])) slot = index;
    });
    const remaining = active.windowIds.filter((id) => id !== movingId);
    const before = active.windowIds.slice(0, slot).filter((id) => id !== movingId).length;
    const beside = remaining[Math.min(before, remaining.length - 1)];
    if (!beside) return;
    return {
      ...place({ mode: 'split', besideWindowId: beside, side: before < remaining.length ? 'left' : 'right' }),
      marker: boundaries[slot],
    };
  };
  const begin = (event: React.PointerEvent<HTMLElement>, source: Source) => {
    if (!(event.buttons & 1)) return;
    event.preventDefault();
    event.stopPropagation();
    start({ ...event, element: event.currentTarget }, source, event.pointerType !== 'mouse');
  };
  // Items are lifted by a long press that already happened, so they show at once.
  const beginItem = (pointer: PointerStart, item: LauncherItem) => start(pointer, { item }, true);
  const start = (pointer: PointerStart, source: Source, immediate: boolean) => {
    stop.current();
    const pointerId = pointer.pointerId;
    const startX = pointer.clientX,
      startY = pointer.clientY;
    let moved = false;
    const shell =
      pointer.element.closest<HTMLElement>('.viewer-shell') ??
      document.querySelector<HTMLElement>('.viewer-shell');
    const space =
      'spaceId' in source
        ? workspace.spaces.find((space) => space.id === source.spaceId)
        : 'windowId' in source
          ? workspace.spaces.find((space) => space.windowIds.includes(source.windowId))
          : undefined;
    if (shell && space) snapshots.capture(shell, space.windowIds);
    const sourceFrame =
      'windowId' in source
        ? shell?.querySelector<HTMLElement>(`[data-window-id="${source.windowId}"]`)
        : undefined;
    const update = (x: number, y: number) => {
      setDrag({ source, x, y, target: targetAt(source, x, y) });
      if (sourceFrame) sourceFrame.style.opacity = '0.35';
      document.querySelector('[data-window-drop-hover]')?.removeAttribute('data-window-drop-hover');
      document
        .elementFromPoint(x, y)
        ?.closest('[data-rail-space], [data-new-group]')
        ?.setAttribute('data-window-drop-hover', 'true');
      shell?.classList.add('window-dragging');
    };
    if (immediate) update(startX, startY);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!moved && Math.hypot(next.clientX - startX, next.clientY - startY) / uiScale() > 4) moved = true;
      if (moved) {
        next.preventDefault();
        update(next.clientX, next.clientY);
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', key, true);
      setDrag(undefined);
      if (sourceFrame) sourceFrame.style.opacity = '';
      document.querySelector('[data-window-drop-hover]')?.removeAttribute('data-window-drop-hover');
      shell?.classList.remove('window-dragging');
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      cleanup();
      if (moved) {
        next.preventDefault();
        next.stopPropagation();
        const suppress = (click: MouseEvent) => {
          click.preventDefault();
          click.stopPropagation();
        };
        window.addEventListener('click', suppress, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', suppress, true), 0);
        const target = targetAt(source, next.clientX, next.clientY);
        if (target?.action) void action(target.action).catch(report);
        else if (target?.placement && 'item' in source)
          void openItem(source.item, target.placement).catch(report);
      }
    };
    const cancel = () => cleanup();
    const key = (next: KeyboardEvent) => {
      if (next.key === 'Escape') {
        next.preventDefault();
        next.stopPropagation();
        cleanup();
        const suppress = (click: MouseEvent) => {
          click.preventDefault();
          click.stopPropagation();
        };
        window.addEventListener('click', suppress, { capture: true, once: true });
        window.addEventListener(
          'pointerup',
          () => setTimeout(() => window.removeEventListener('click', suppress, true), 0),
          { once: true },
        );
      }
    };
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', key, true);
    stop.current = cleanup;
  };
  const source = drag?.source;
  const id =
    source &&
    ('windowId' in source
      ? source.windowId
      : 'spaceId' in source
        ? workspace.spaces.find((space) => space.id === source.spaceId)?.focusedWindowId
        : undefined);
  const item = source && 'item' in source ? source.item : undefined;
  const win = workspace.windows.find((win) => win.id === id);
  const stageElement = drag && document.querySelector<HTMLElement>('.window-workspace');
  const stage = stageElement?.getBoundingClientRect();
  const slots = stageElement && active ? insertionPositions(stageElement, active) : [];
  return (
    <WindowDragContext.Provider value={begin}>
      <ItemDragContext.Provider value={beginItem}>
        <DraggingContext.Provider value={drag?.source}>
          <div
            className={
              drag
                ? `window-drag-active${railVisible ? ' drag-with-rail' : ''}${item ? ' item-dragging' : ''}`
                : undefined
            }
            style={{ display: 'contents' }}
          >
            {children}
            {drag && (
              <div className="window-drop-bar" data-new-group>
                新窗口组
              </div>
            )}
            {drag &&
              (win || item) &&
              createPortal(
                <>
                  <div
                    className="window-drag-ghost"
                    style={{
                      left: Math.max(
                        0,
                        Math.min((drag.x + 14) / uiScale(), window.innerWidth / uiScale() - 192),
                      ),
                      top: Math.max(
                        0,
                        Math.min((drag.y + 14) / uiScale(), window.innerHeight / uiScale() - 136),
                      ),
                    }}
                  >
                    {win && snapshots.get(win.id) ? (
                      <img src={snapshots.get(win.id)} alt="" />
                    ) : win ? (
                      <AppIcon
                        appId={win.appId}
                        iconUrl={workspace.apps.find((app) => `web:${app.id}` === win.appId)?.iconUrl}
                      />
                    ) : (
                      <AppIcon appId={item?.appId} iconUrl={item?.iconUrl} file={item?.kind === 'file'} />
                    )}
                    <span>{win ? appName(workspace, win) : item?.title}</span>
                  </div>
                  {stage && drag.target?.marker !== undefined && (
                    <div
                      className="window-insertion-marker"
                      style={{
                        left: drag.target.marker / uiScale(),
                        top: stage.top / uiScale(),
                        height: stage.height / uiScale(),
                      }}
                    />
                  )}
                </>,
                document.body,
              )}
            {drag && active && (
              <div
                className="window-insertion-guides"
                aria-hidden
                style={{
                  left: stage ? stage.left / uiScale() : 0,
                  top: stage ? stage.top / uiScale() : 0,
                  width: stage ? stage.width / uiScale() : 0,
                  height: stage ? stage.height / uiScale() : 0,
                }}
              >
                {!('spaceId' in drag.source) &&
                  (('windowId' in drag.source && active.windowIds.includes(drag.source.windowId)) ||
                    active.windowIds.length < 3) &&
                  slots.map((position, index) => (
                    <i key={index} style={{ left: (position - (stage?.left ?? 0)) / uiScale() }} />
                  ))}
                {'spaceId' in drag.source && drag.target && (
                  <div className="group-merge-target">合并到当前窗口组</div>
                )}
              </div>
            )}
          </div>
        </DraggingContext.Provider>
      </ItemDragContext.Provider>
    </WindowDragContext.Provider>
  );
}
