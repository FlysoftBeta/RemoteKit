import { buildAction } from '../control/action-builder';
import './window-drag.css';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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
import { SnapshotImage, SpaceSnapshots } from './space-snapshots';
import { uiScale } from './ui-scale';

// A launcher item is not a window yet: dropping it opens a window at the chosen placement.
type Source = { windowId: string } | { item: LauncherItem };
type Target = { action?: ProductAction; placement?: WindowPlacement; marker?: number; replaceId?: string };
// Rendered drag state changes only with its target; the pointer position stays outside React.
type Drag = { source: Source; target?: Target; hovered?: Registration };
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
export const useWindowDragging = () => useDragSelector((drag) => drag?.source);
export const useWindowDrag = () => useContext(WindowDragContext);
export const useItemDrag = () => useContext(ItemDragContext);

class DragStore {
  private drag: Drag | undefined;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.drag;
  set(drag: Drag | undefined) {
    this.drag = drag;
    this.listeners.forEach((listener) => listener());
  }
}
const idleStore = new DragStore();
function useDragSelector<T>(selector: (drag: Drag | undefined) => T) {
  const { store } = useContext(DropContext);
  const getSnapshot = () => selector(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

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
  store: DragStore;
}>({ register: () => () => {}, store: idleStore });

export function useDropTarget<K extends keyof DropPayload>(kind: K, payload: DropPayload[K]) {
  const { ref, registration } = useDropRegistration(kind, payload);
  const hovered = useDragSelector(
    (drag) => ['group', 'new', 'close'].includes(kind) && drag?.hovered === registration,
  );
  return { ref, hovered };
}

export function useDropRegistration<K extends keyof DropPayload>(kind: K, payload: DropPayload[K]) {
  const { register } = useContext(DropContext);
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
  return { ref, registration: target.current };
}

export function WindowDragDecoration({
  windowId,
  frame,
}: {
  windowId: string;
  frame: React.RefObject<HTMLElement | null>;
}) {
  const source = useDragSelector(
    (drag) => !!drag && 'windowId' in drag.source && drag.source.windowId === windowId,
  );
  const replace = useDragSelector((drag) => drag?.target?.replaceId === windowId);
  useLayoutEffect(() => {
    frame.current?.toggleAttribute('data-window-drag-source', source);
  }, [frame, source]);
  return replace ? <div className="window-replacement" aria-hidden /> : null;
}

type Box = { left: number; top: number; right: number; bottom: number };
// The region of a target that receives drops; scroll strips clip cards beyond their visible region.
function hitRegion(element: HTMLElement): Box | null {
  if (!element.offsetWidth || getComputedStyle(element).pointerEvents === 'none') return null;
  let { left, top, right, bottom } = element.getBoundingClientRect();
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.visibility === 'hidden') return null;
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const bounds = parent.getBoundingClientRect();
    if (style.overflowX !== 'visible') {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (style.overflowY !== 'visible') {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  return left < right && top < bottom ? { left, top, right, bottom } : null;
}

/** Layout reads for one drag, reused across pointer moves until layout may have changed. */
class DragGeometry {
  private readonly regions = new Map<Registration, Box | null>();
  private readonly rects = new Map<HTMLElement, DOMRect>();
  stage: DOMRect | undefined;
  viewportWidth = 0;
  slots: number[] = [];
  measure(targets: Registration[], space: ProductSpace | undefined) {
    this.viewportWidth = window.innerWidth;
    this.regions.clear();
    this.rects.clear();
    for (const target of targets) {
      if (!target.element) continue;
      this.regions.set(target, hitRegion(target.element));
      this.rects.set(target.element, target.element.getBoundingClientRect());
    }
    const stage = targets.find((target) => target.kind === 'stage')?.element;
    this.stage = stage ? this.rects.get(stage) : undefined;
    this.slots = stage && space ? insertionPositions(this, stage, space, targets) : [];
  }
  contains(target: Registration, x: number, y: number) {
    const region = this.regions.get(target);
    return !!region && x >= region.left && x < region.right && y >= region.top && y < region.bottom;
  }
  rect(element: HTMLElement) {
    return this.rects.get(element)!;
  }
}

function insertionPositions(
  geometry: DragGeometry,
  stage: HTMLElement,
  space: ProductSpace,
  targets: Registration[],
) {
  const bounds = geometry.rect(stage);
  const frames = space.windowIds
    .map((id) => targets.find((target) => target.kind === 'window' && target.payload === id)?.element)
    .filter((element): element is HTMLElement => !!element && geometry.rect(element).width > 0);
  if (frames.length === space.windowIds.length)
    return [geometry.rect(frames[0]).left, ...frames.map((frame) => geometry.rect(frame).right)];
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
  const target = useDropRegistration('panel', undefined);
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
  const [store] = useState(() => new DragStore());
  const setDrag = store.set.bind(store);
  const registry = useRef(new Set<Registration>());
  const [geometry] = useState(() => new DragGeometry());
  const register = useCallback(
    (target: Registration) => {
      registry.current.add(target);
      scheduleMeasure.current();
      return () => {
        registry.current.delete(target);
        scheduleMeasure.current();
      };
    },
    [geometry],
  );
  const scheduleMeasure = useRef(() => {});
  const measure = useRef(() => {});
  const geometryFrame = useRef(0);
  scheduleMeasure.current = () => {
    if (!geometryFrame.current)
      geometryFrame.current = requestAnimationFrame(() => {
        geometryFrame.current = 0;
        measure.current();
      });
  };
  useLayoutEffect(() => {
    if (store.getSnapshot()) measure.current();
  });
  useEffect(() => {
    const refresh = () => measure.current();
    window.addEventListener('scroll', refresh, { capture: true, passive: true });
    window.addEventListener('resize', refresh);
    return () => {
      cancelAnimationFrame(geometryFrame.current);
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
    };
  }, []);
  const cursor = useRef({ x: 0, y: 0 });
  const ghost = useRef<HTMLDivElement>(null);
  const targets = () => [...registry.current];
  const elementFor = (kind: keyof DropPayload) => targets().find((target) => target.kind === kind)?.element;
  const hitAt = (x: number, y: number) => {
    const priority: (keyof DropPayload)[] = ['close', 'group', 'new', 'panel', 'divider', 'window', 'stage'];
    for (const kind of priority) {
      const target = targets().find((target) => target.kind === kind && geometry.contains(target, x, y));
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
        ? { action: buildAction({ type: 'window.place', windowId: source.windowId, placement }) }
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

    const boundaries = geometry.slots;
    if (!boundaries.length) return;
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
        const rect = geometry.rect(frame);
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
    let shown: { hovered?: Registration; target: string } | undefined;
    let frame = 0;
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
      cursor.current = { x, y };
      if (ghost.current) ghost.current.style.transform = ghostTransform(x, y, geometry.viewportWidth);
      const key = JSON.stringify(target ?? null);
      if (shown && shown.hovered === hovered && shown.target === key) return;
      shown = { hovered, target: key };
      setDrag({ source, target, hovered });
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!valid()) {
        cleanup();
        return;
      }
      if (!moved && Math.hypot(next.clientX - startX, next.clientY - startY) / uiScale() > 4) moved = true;
      if (!moved) return;
      next.preventDefault();
      // The first move lifts the window at once; later moves coalesce into one per frame.
      cursor.current = { x: next.clientX, y: next.clientY };
      if (!shown) update(next.clientX, next.clientY);
      else if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          update(cursor.current.x, cursor.current.y);
        });
    };
    const cleanup = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      shown = undefined;
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
    measure.current();
    if (immediate) update(startX, startY);
  };
  measure.current = () => {
    geometry.measure(targets(), latest.current.active);
    const drag = store.getSnapshot();
    if (drag) store.set({ ...drag });
  };
  const startLatest = useRef({ begin, beginItem });
  startLatest.current = { begin, beginItem };
  const stableBegin = useCallback(
    (event: React.PointerEvent<HTMLElement>, source: Source) => startLatest.current.begin(event, source),
    [],
  );
  const stableItem = useCallback(
    (pointer: PointerStart, item: LauncherItem) => startLatest.current.beginItem(pointer, item),
    [],
  );
  const drop = useMemo(() => ({ register, store }), [register, store]);
  return (
    <DropContext.Provider value={drop}>
      <WindowDragContext.Provider value={stableBegin}>
        <ItemDragContext.Provider value={stableItem}>
          <DragSurface>{children}</DragSurface>
          <DragOverlay
            state={state}
            snapshots={snapshots}
            geometry={geometry}
            ghost={ghost}
            cursor={cursor}
          />
        </ItemDragContext.Provider>
      </WindowDragContext.Provider>
    </DropContext.Provider>
  );
}
function DragSurface({ children }: { children: React.ReactNode }) {
  const source = useWindowDragging();
  return (
    <div
      style={{ display: 'contents' }}
      className={
        source
          ? `window-drag-active window-dragging${'item' in source ? ' item-dragging' : ' handle-dragging'}`
          : undefined
      }
    >
      {children}
    </div>
  );
}
function DragOverlay({
  state,
  snapshots,
  geometry,
  ghost,
  cursor,
}: {
  state: ProductState;
  snapshots: SpaceSnapshots;
  geometry: DragGeometry;
  ghost: React.RefObject<HTMLDivElement | null>;
  cursor: React.RefObject<{ x: number; y: number }>;
}) {
  const source = useWindowDragging();
  const drag = source ? { source } : undefined;
  const workspace = state.workspace;
  const active = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
  const id = source && 'windowId' in source ? source.windowId : undefined;
  const item = source && 'item' in source ? source.item : undefined;
  const win = workspace.windows.find((win) => win.id === id);
  const snapshot = win && snapshots.get(win.id);
  return (
    <>
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
              ref={ghost}
              className="window-drag-ghost"
              style={{
                transform: ghostTransform(cursor.current.x, cursor.current.y, geometry.viewportWidth),
              }}
            >
              {snapshot ? (
                <SnapshotImage source={snapshot} />
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
            <InsertionMarker geometry={geometry} />
          </>,
          document.body,
        )}
      <InsertionGuides geometry={geometry} active={active} />
    </>
  );
}
function InsertionMarker({ geometry }: { geometry: DragGeometry }) {
  const marker = useDragSelector((drag) => drag?.target?.marker);
  useDragSelector(() => geometry.stage);
  const stage = geometry.stage;
  return (
    <>
      {' '}
      {stage && marker !== undefined && (
        <div
          className="window-insertion-marker"
          style={{
            left: Math.max(stage.left + 2, Math.min(stage.right - 2, marker!)) / uiScale(),
            top: stage.top / uiScale(),
            height: stage.height / uiScale(),
          }}
        />
      )}
    </>
  );
}
function InsertionGuides({ geometry, active }: { geometry: DragGeometry; active: ProductSpace | undefined }) {
  const source = useWindowDragging();
  const drag = source ? { source } : undefined;
  useDragSelector(() => geometry.stage);
  const stage = geometry.stage,
    slots = geometry.slots;
  return (
    <>
      {' '}
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
    </>
  );
}

const GHOST = { width: 180, height: 124, gap: 16 };
// Above the pointer so neither the preview nor a finger covers the drop target under it.
function ghostTransform(clientX: number, clientY: number, viewportWidth: number) {
  const x = clientX / uiScale(),
    y = clientY / uiScale();
  const width = viewportWidth / uiScale();
  const above = y - GHOST.gap - GHOST.height;
  const left = Math.max(0, Math.min(x - GHOST.width / 2, width - GHOST.width));
  return `translate3d(${left}px, ${above >= 0 ? above : y + GHOST.gap}px, 0)`;
}
