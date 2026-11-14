import './window-drag.css';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DeleteOutline } from '@mui/icons-material';
import type {
  LauncherItem,
  ProductAction,
  ProductSpace,
  ProductState,
  WindowPlacement,
} from '../../shared/product';
import type { Action } from './product-dialogs';
import { AppIcon, appName } from './app-icon';
import { GroupList } from './group-list';
import { SpaceSnapshots } from './space-snapshots';
import { uiScale } from './ui-scale';

// A launcher item is not a window yet: dropping it opens a window at the chosen placement.
type Source = { windowId: string } | { item: LauncherItem };
type Target = { action?: ProductAction; placement?: WindowPlacement; marker?: number; replaceId?: string };
type Drag = { source: Source; x: number; y: number; target?: Target; hovered?: Registration };
export interface PointerStart {
  pointerId: number;
  clientX: number;
  clientY: number;
  pointerType: string;
}
const WindowDragContext = createContext<(event: React.PointerEvent<HTMLElement>, source: Source) => void>(
  () => {},
);
const ItemDragContext = createContext<(pointer: PointerStart, item: LauncherItem) => void>(() => {});
const DraggingContext = createContext<Source | undefined>(undefined);
export const useWindowDragging = () => useContext(DraggingContext);
export const useWindowDrag = () => useContext(WindowDragContext);
export const useItemDrag = () => useContext(ItemDragContext);

type DropPayload = {
  shell: undefined;
  stage: undefined;
  panel: undefined;
  window: string;
  divider: undefined;
  group: string;
  new: undefined;
  close: undefined;
};
type Registration = { element: HTMLElement | null; kind: keyof DropPayload; payload: string | undefined };
const DropContext = createContext<{
  register(target: Registration): () => void;
  drag?: Drag;
}>({ register: () => () => {} });

export function useDropTarget<K extends keyof DropPayload>(kind: K, payload: DropPayload[K]) {
  const { register, drag } = useContext(DropContext);
  const target = useRef<Registration>({ element: null, kind, payload });
  target.current.kind = kind;
  target.current.payload = payload;
  const unregister = useRef<(() => void) | undefined>(undefined);
  const ref = useCallback(
    (element: HTMLElement | null) => {
      unregister.current?.();
      target.current.element = element;
      unregister.current = element ? register(target.current) : undefined;
    },
    [register],
  );
  return {
    ref,
    hovered: drag?.hovered === target.current,
    replace: kind === 'window' && drag?.target?.replaceId === payload,
  };
}

function containsPoint(element: HTMLElement, x: number, y: number) {
  if (!element.offsetWidth || getComputedStyle(element).pointerEvents === 'none') return false;
  const rect = element.getBoundingClientRect();
  if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return false;
  // Scroll strips clip cards that extend beyond their visible region.
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (style.visibility === 'hidden') return false;
    if (style.overflowX !== 'visible' && (x < bounds.left || x >= bounds.right)) return false;
    if (style.overflowY !== 'visible' && (y < bounds.top || y >= bounds.bottom)) return false;
  }
  return true;
}

function insertionPositions(stage: HTMLElement, space: ProductSpace, targets: Registration[]) {
  const bounds = stage.getBoundingClientRect();
  const frames = space.windowIds
    .map((id) => targets.find((target) => target.kind === 'window' && target.payload === id)?.element)
    .filter((element): element is HTMLElement => !!element && element.offsetWidth > 0);
  if (frames.length === space.windowIds.length)
    return [
      frames[0].getBoundingClientRect().left,
      ...frames.map((frame) => frame.getBoundingClientRect().right),
    ];
  return [
    bounds.left,
    ...space.weights.map(
      (_, index) =>
        bounds.left +
        bounds.width * space.weights.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0),
    ),
  ];
}

function DropColumn({ children }: { children: React.ReactNode }) {
  const target = useDropTarget('panel', undefined);
  return (
    <div className="window-drop-column" ref={target.ref}>
      {children}
    </div>
  );
}

function CloseTarget() {
  const target = useDropTarget('close', undefined);
  return (
    <div
      className="window-drop-close"
      data-close-window
      ref={target.ref}
      data-window-drop-hover={target.hovered ? 'true' : undefined}
    >
      <DeleteOutline />
      关闭窗口
    </div>
  );
}

export function WindowDragProvider({
  state,
  snapshots,
  action,
  report,
  openItem,
  children,
}: {
  state: ProductState;
  snapshots: SpaceSnapshots;
  action: Action;
  report(error: unknown): void;
  openItem(item: LauncherItem, placement: WindowPlacement): Promise<void>;
  children: React.ReactNode;
}) {
  const [drag, setDrag] = useState<Drag>();
  const registry = useRef(new Set<Registration>());
  const register = useCallback((target: Registration) => {
    registry.current.add(target);
    return () => {
      registry.current.delete(target);
    };
  }, []);
  const targets = () => [...registry.current];
  const elementFor = (kind: keyof DropPayload) => targets().find((target) => target.kind === kind)?.element;
  const hitAt = (x: number, y: number) => {
    const priority: (keyof DropPayload)[] = ['close', 'group', 'new', 'panel', 'divider', 'window', 'stage'];
    for (const kind of priority) {
      const target = targets().find(
        (target) => target.kind === kind && target.element && containsPoint(target.element, x, y),
      );
      if (target) return target;
    }
  };
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  const workspace = state.workspace;
  const active = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
  const targetAt = (source: Source, x: number, y: number): Target | undefined => {
    const hit = hitAt(x, y);
    const stage = elementFor('stage');
    const movingId = 'windowId' in source ? source.windowId : undefined;
    const place = (placement: Exclude<WindowPlacement, { mode: 'replace' }>): Target =>
      'windowId' in source
        ? { action: { type: 'window.place', windowId: source.windowId, placement } }
        : { placement };
    if (movingId && hit?.kind === 'close') return { action: { type: 'window.close', windowId: movingId } };
    if (hit?.kind === 'group') {
      const space = workspace.spaces.find((space) => space.id === hit.payload);
      if (space && space.windowIds.length < 3) {
        const beside = space.windowIds.filter((id) => id !== movingId).pop();
        if (beside) return place({ mode: 'split', besideWindowId: beside, side: 'right' });
      }
      return;
    }
    if (hit?.kind === 'new') return place({ mode: 'space' });
    if (!stage || !active || !hit || !['window', 'divider', 'stage'].includes(hit.kind)) return;
    const own = !!movingId && active.windowIds.includes(movingId);

    const boundaries = insertionPositions(stage, active, targets());
    let slot = 0;
    boundaries.forEach((position, index) => {
      if (Math.abs(x - position) < Math.abs(x - boundaries[slot])) slot = index;
    });
    if ('item' in source) {
      // The outer fifth of each window inserts beside it; its middle replaces it.
      const frame = hit.kind === 'window' ? hit.element : undefined;
      const id = hit.kind === 'window' ? hit.payload : undefined;
      if (!frame || !id || !active.windowIds.includes(id)) {
        // Over a separator: insert at the nearest boundary.
        if (active.windowIds.length >= 3 || hit.kind !== 'divider') return;
      } else {
        const rect = frame.getBoundingClientRect();
        const edge = Math.max(48 * uiScale(), Math.min(120 * uiScale(), rect.width / 5));
        const index = active.windowIds.indexOf(id);
        if (active.windowIds.length >= 3 || (x - rect.left > edge && rect.right - x > edge))
          return { placement: { mode: 'replace', windowId: id }, replaceId: id };
        slot = x - rect.left <= edge ? index : index + 1;
      }
    }
    if (!own && active.windowIds.length >= 3) return;
    const remaining = active.windowIds.filter((id) => id !== movingId);
    const before = active.windowIds.slice(0, slot).filter((id) => id !== movingId).length;
    const beside = remaining[Math.min(before, remaining.length - 1)];
    if (!beside) return;
    return {
      ...place({ mode: 'split', besideWindowId: beside, side: before < remaining.length ? 'left' : 'right' }),
      marker: boundaries[slot],
    };
  };
  const latest = useRef({ workspace, active, targetAt, hitAt, openItem, action, report });
  latest.current = { workspace, active, targetAt, hitAt, openItem, action, report };
  const begin = (event: React.PointerEvent<HTMLElement>, source: Source) => {
    if (!(event.buttons & 1)) return;
    event.preventDefault();
    event.stopPropagation();
    start(event, source, event.pointerType !== 'mouse');
  };
  const beginItem = (pointer: PointerStart, item: LauncherItem) => start(pointer, { item }, true);
  const start = (pointer: PointerStart, source: Source, immediate: boolean) => {
    stop.current();
    const pointerId = pointer.pointerId;
    const startX = pointer.clientX,
      startY = pointer.clientY;
    let moved = immediate && 'item' in source;
    const shell = elementFor('shell');
    const space =
      'windowId' in source
        ? workspace.spaces.find((space) => space.windowIds.includes(source.windowId))
        : undefined;
    if (shell && space) snapshots.capture(shell, space.windowIds);
    let previousTarget: Target | undefined;
    let hovered: Registration | undefined;
    const valid = (target = previousTarget) => {
      const { workspace } = latest.current;
      const hasWindow = (id: string) => workspace.windows.some((win) => win.id === id);
      if ('windowId' in source && !hasWindow(source.windowId)) return false;
      if (hovered && (!registry.current.has(hovered) || !hovered.element?.isConnected)) return false;
      if (hovered?.kind === 'window' && !hasWindow(hovered.payload!)) return false;
      if (hovered?.kind === 'group' && !workspace.spaces.some((space) => space.id === hovered?.payload))
        return false;
      const placement =
        target?.placement ?? (target?.action?.type === 'window.place' ? target.action.placement : undefined);
      if (placement?.mode === 'split' && !hasWindow(placement.besideWindowId)) return false;
      if (placement?.mode === 'replace' && !hasWindow(placement.windowId)) return false;
      return true;
    };
    const update = (x: number, y: number) => {
      if (!valid()) {
        cleanup();
        return;
      }
      const target = latest.current.targetAt(source, x, y);
      hovered = latest.current.hitAt(x, y);
      if (!valid(target)) {
        cleanup();
        return;
      }
      previousTarget = target;
      setDrag({ source, x, y, target, hovered });
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!valid()) {
        cleanup();
        return;
      }
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
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const canDrop = valid();
      cleanup();
      if (moved && canDrop) {
        next.preventDefault();
        next.stopPropagation();
        const suppress = (click: MouseEvent) => {
          click.preventDefault();
          click.stopPropagation();
        };
        window.addEventListener('click', suppress, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', suppress, true), 0);
        const target = latest.current.targetAt(source, next.clientX, next.clientY);
        if (!valid(target)) return;
        if (target?.action) void latest.current.action(target.action).catch(latest.current.report);
        else if (target?.placement && 'item' in source)
          void latest.current.openItem(source.item, target.placement).catch(latest.current.report);
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
    if (immediate) update(startX, startY);
  };
  const source = drag?.source;
  const id = source && 'windowId' in source ? source.windowId : undefined;
  const item = source && 'item' in source ? source.item : undefined;
  const win = workspace.windows.find((win) => win.id === id);
  const stageElement = drag && elementFor('stage');
  const stage = stageElement?.getBoundingClientRect();
  const slots = stageElement && active ? insertionPositions(stageElement, active, targets()) : [];
  return (
    <DropContext.Provider value={{ register, drag }}>
      <WindowDragContext.Provider value={begin}>
        <ItemDragContext.Provider value={beginItem}>
          <DraggingContext.Provider value={drag?.source}>
            <div
              className={
                drag ? `window-drag-active${item ? ' item-dragging' : ' handle-dragging'}` : undefined
              }
              style={{ display: 'contents' }}
            >
              {children}
              {drag &&
                win &&
                createPortal(
                  // The same group column Start shows while a tile is dragged, plus closing.
                  <DropColumn>
                    <GroupList state={state} snapshots={snapshots} online newTarget={false} />
                    <CloseTarget />
                  </DropColumn>,
                  document.body,
                )}
              {drag &&
                (win || item) &&
                createPortal(
                  <>
                    <div
                      className="window-drag-ghost"
                      style={ghostPosition(drag.x / uiScale(), drag.y / uiScale())}
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
                          left:
                            Math.max(stage.left + 2, Math.min(stage.right - 2, drag.target.marker)) /
                            uiScale(),
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
                  {(('windowId' in drag.source && active.windowIds.includes(drag.source.windowId)) ||
                    active.windowIds.length < 3) &&
                    slots.map((position, index) => (
                      <i key={index} style={{ left: (position - (stage?.left ?? 0)) / uiScale() }} />
                    ))}
                </div>
              )}
            </div>
          </DraggingContext.Provider>
        </ItemDragContext.Provider>
      </WindowDragContext.Provider>
    </DropContext.Provider>
  );
}

const GHOST = { width: 180, height: 124, gap: 16 };
// Above the pointer so neither the preview nor a finger covers the drop target under it.
function ghostPosition(x: number, y: number) {
  const width = window.innerWidth / uiScale();
  const above = y - GHOST.gap - GHOST.height;
  return {
    left: Math.max(0, Math.min(x - GHOST.width / 2, width - GHOST.width)),
    top: above >= 0 ? above : y + GHOST.gap,
  };
}
