import { useLayoutEffect, useRef } from 'react';
import type { ViewerSession } from '../viewer-session';
import type { Surface } from '../presentation/types';
import type { SelectionAction, SelectionMessage } from '../rtc/protocol';
import { surfaceDipSize } from '../input/coordinates';
import { projectRootRect, type ViewportGeometry } from '../app/viewport-geometry';
import { sameEditingDocument } from '../editing/mobile-editing-state';
import { selectionSession } from './selection-session';
import { clipboardCommand } from '../clipboard/device-clipboard';
import type { HandleKind, Point, SelectionHandles, SelectionTarget } from './target';

export class RemoteSelectionTarget implements SelectionTarget {
  private consumed = false;
  constructor(
    private readonly transport: Pick<ViewerSession, 'input'>,
    private message: SelectionMessage,
    private surface: Surface,
    private geometry: ViewportGeometry,
    private canvas: HTMLCanvasElement,
  ) {}

  update(message: SelectionMessage, surface: Surface, geometry: ViewportGeometry, canvas: HTMLCanvasElement) {
    if (message.revision !== this.message.revision) this.consumed = false;
    this.message = message;
    this.surface = surface;
    this.geometry = geometry;
    this.canvas = canvas;
  }

  private project(rect: { x: number; y: number; width: number; height: number }) {
    const local = projectRootRect(this.surface, this.geometry, rect);
    const bounds = this.canvas.getBoundingClientRect();
    const scaleX = bounds.width / this.geometry.canvas.width;
    const scaleY = bounds.height / this.geometry.canvas.height;
    return {
      left: bounds.left + (local.left - this.geometry.canvas.left) * scaleX,
      top: bounds.top + (local.top - this.geometry.canvas.top) * scaleY,
      width: local.width * scaleX,
      height: local.height * scaleY,
    };
  }

  handles(): SelectionHandles {
    if (this.consumed) return {};
    const handles: SelectionHandles = {};
    const bounds = this.canvas.getBoundingClientRect();
    for (const which of ['start', 'end', 'insertion'] as const) {
      const handle = this.message.handles[which];
      if (!handle) continue;
      const rect = this.project({
        x: handle.x,
        y: handle.y - handle.lineHeight,
        width: 0,
        height: handle.lineHeight,
      });
      handles[which] = {
        x: rect.left,
        y: rect.top + rect.height,
        lineHeight: rect.height,
        visible:
          rect.left >= bounds.left &&
          rect.left <= bounds.right &&
          rect.top >= bounds.top &&
          rect.top + rect.height <= bounds.bottom,
      };
    }
    return handles;
  }

  anchor() {
    const menu = this.message.menu;
    if (menu) return this.project(menu);
    const handles = this.handles();
    const point = handles.start ?? handles.insertion ?? handles.end;
    return {
      left: point?.x ?? 0,
      top: (point?.y ?? 0) - (point?.lineHeight ?? 0),
      width: 0,
      height: point?.lineHeight ?? 0,
    };
  }

  commands(): SelectionAction[] {
    const menu = this.message.menu;
    return !this.consumed && menu ? [...menu.commands, ...(menu.more ? ['contextMenu' as const] : [])] : [];
  }

  run(command: SelectionAction) {
    const menu = this.message.menu;
    if (!menu || this.consumed) return;
    const surface = this.surface;
    clipboardCommand(command, () => {
      if (
        !this.alive() ||
        this.message.menu?.id !== menu.id ||
        !sameEditingDocument(surface, this.surface) ||
        surface.focus !== this.surface.focus
      )
        return;
      this.transport.input.ensureInputFocus(this.surface);
      if (this.transport.input.sendInput(this.surface, { type: 'selection_command', menu: menu.id, command })) {
        if (command !== 'selectAll') this.consumed = true;
      }
    });
  }

  dragHandle(which: HandleKind, point: Point) {
    const bounds = this.canvas.getBoundingClientRect();
    const dip = surfaceDipSize(this.surface);
    this.transport.input.sendInput(this.surface, {
      type: 'selection.extent',
      which,
      x: ((point.x - bounds.left) * dip.width) / bounds.width,
      y: ((point.y - bounds.top) * dip.height) / bounds.height,
    });
  }

  collapse() {
    if (this.consumed) return;
    this.consumed = true;
    this.transport.input.sendInput(this.surface, {
      type: 'selection_command',
      menu: this.message.menu?.id ?? '0',
      command: 'dismiss',
    });
  }

  alive() {
    return !this.consumed && this.canvas.isConnected;
  }
}

export function RemoteSelection({
  transport,
  message,
  surface,
  geometry,
  canvas,
  ready,
}: {
  transport: ViewerSession;
  message?: SelectionMessage;
  surface?: Surface;
  geometry?: ViewportGeometry;
  canvas: HTMLCanvasElement | null;
  ready: boolean;
}) {
  const target = useRef<RemoteSelectionTarget | undefined>(undefined);
  const layout = transport.presentation.layout;
  const valid =
    ready &&
    message?.view &&
    surface &&
    geometry &&
    canvas &&
    layout &&
    sameEditingDocument(surface, message.view) &&
    message.outputGeneration === layout.generation &&
    message.layoutEpoch === layout.epoch &&
    (message.menu || Object.values(message.handles).some(Boolean));
  useLayoutEffect(() => {
    if (!valid) {
      if (target.current) selectionSession.release(target.current);
      return;
    }
    if (!target.current)
      target.current = new RemoteSelectionTarget(transport, message, surface, geometry, canvas);
    else target.current.update(message, surface, geometry, canvas);
    if (target.current.alive()) {
      const previous = selectionSession.current();
      if (previous && previous !== target.current) previous.collapse();
      selectionSession.show(target.current);
    }
  }, [valid, transport, message, surface, geometry, canvas]);
  useLayoutEffect(
    () => () => {
      if (target.current) selectionSession.release(target.current);
    },
    [],
  );
  return null;
}
