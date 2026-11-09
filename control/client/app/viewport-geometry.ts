import { sameEditingDocument } from '../editing/mobile-editing-state';
import { surfaceDipSize } from '../input/coordinates';
import type { Surface } from '../presentation/types';
import type { EditableMessage, SelectionMenu } from '../rtc/protocol';

export interface ViewportGeometry {
  width: number;
  height: number;
  canvas: { left: number; top: number; width: number; height: number };
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));

export function projectRootRect(
  surface: Surface,
  geometry: ViewportGeometry,
  rect: { x: number; y: number; width: number; height: number },
) {
  const dip = surfaceDipSize(surface);
  const scaleX = geometry.canvas.width / dip.width;
  const scaleY = geometry.canvas.height / dip.height;
  return {
    left: geometry.canvas.left + rect.x * scaleX,
    top: geometry.canvas.top + rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

export function projectEditableCaret(
  surface: Surface,
  message: EditableMessage | undefined,
  geometry: ViewportGeometry,
) {
  if (
    !message?.view ||
    !sameEditingDocument(surface, message.view) ||
    !message.editable.active ||
    !(message.editable.flags & 2) ||
    geometry.width <= 0 ||
    geometry.height <= 0
  )
    return;
  const caret = message.editable;
  const rect = projectRootRect(surface, geometry, {
    x: caret.caretX,
    y: caret.caretY,
    width: caret.caretWidth,
    height: caret.caretHeight,
  });
  const height = clamp(rect.height, 1, geometry.height);
  const fontSize = Math.max(12, height);
  return {
    left: clamp(rect.left, 0, geometry.width - 1),
    top: clamp(rect.top, 0, geometry.height - height),
    height,
    fontSize,
    lineHeight: `${fontSize}px`,
  };
}

export function placeSelectionMenu(
  surface: Surface,
  menu: SelectionMenu,
  geometry: ViewportGeometry,
  menuWidth: number,
) {
  const anchor = projectRootRect(surface, geometry, menu);
  const handle = projectRootRect(surface, geometry, { x: 0, y: 0, width: 0, height: menu.handleHeight });
  return placeViewportSelectionMenu(
    anchor,
    { left: 0, top: 0, width: geometry.width, height: geometry.height },
    menuWidth,
    handle.height,
  );
}

export function placeViewportSelectionMenu(
  anchor: { left: number; top: number; width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number },
  menuWidth: number,
  handleHeight: number,
) {
  const above = anchor.top - 8 - 36;
  return {
    left: clamp(
      anchor.left + anchor.width / 2 - menuWidth / 2,
      viewport.left + 8,
      viewport.left + viewport.width - menuWidth - 8,
    ),
    top: clamp(
      above >= viewport.top + 8 ? above : anchor.top + anchor.height + handleHeight + 8,
      viewport.top + 8,
      viewport.top + viewport.height - 36 - 8,
    ),
  };
}
