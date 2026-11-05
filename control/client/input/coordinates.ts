import type { Surface } from '../presentation/types';
export type PointerAction = 'down' | 'move' | 'up' | 'cancel' | 'leave';
export const surfacePixelScale = (
  surface: Pick<Surface, 'deviceScaleFactor' | 'mediaScale' | 'mediaScaleX' | 'mediaScaleY'>,
  axis: 'x' | 'y' = 'x',
) =>
  surface.deviceScaleFactor *
  ((axis === 'x' ? surface.mediaScaleX : surface.mediaScaleY) ?? surface.mediaScale ?? 1);
export const surfaceDipSize = (surface: Surface) => ({
  width: surface.width / surfacePixelScale(surface),
  height: surface.height / surfacePixelScale(surface, 'y'),
});
export function clientPointToDip(
  surface: Surface,
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  outside: 'reject' | 'clamp' | 'allow' = 'reject',
) {
  const { width: widthDip, height: heightDip } = surfaceDipSize(surface);
  if (
    ![rect.left, rect.top, rect.width, rect.height, clientX, clientY, widthDip, heightDip].every(
      Number.isFinite,
    ) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    widthDip <= 0 ||
    heightDip <= 0
  )
    return null;
  let x = (clientX - rect.left) / rect.width,
    y = (clientY - rect.top) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (outside === 'clamp') {
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
  } else if (outside === 'reject' && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  const position = { x: x * widthDip, y: y * heightDip };
  return Number.isFinite(position.x) && Number.isFinite(position.y) ? position : null;
}
export function pointerPointToDip(
  surface: Surface,
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  action: PointerAction,
  captured: boolean,
) {
  // Captured gestures retain outside coordinates for dragging/edge scrolling.
  const outside =
    action === 'leave'
      ? 'clamp'
      : captured && (action === 'move' || action === 'up' || action === 'cancel')
        ? 'allow'
        : 'reject';
  return clientPointToDip(surface, rect, clientX, clientY, outside);
}
export function markerSourceRect(surface: Surface, widthDip = 256, heightDip = 112) {
  return {
    x: surface.x,
    y: surface.y,
    width: widthDip * surfacePixelScale(surface),
    height: heightDip * surfacePixelScale(surface, 'y'),
  };
}
export function wheelDeltaToDip(surface: Surface, deltaX: number, deltaY: number, deltaMode: number) {
  const size = surfaceDipSize(surface);
  return {
    x: deltaX * (deltaMode === 1 ? 16 : deltaMode === 2 ? size.width : 1),
    y: deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? size.height : 1),
  };
}
