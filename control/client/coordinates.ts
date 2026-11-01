import type { Surface } from './types';
export type PointerAction = 'down' | 'move' | 'up' | 'cancel' | 'leave';
export const surfacePixelScale = (surface: Pick<Surface, 'deviceScaleFactor' | 'mediaScale'>) => surface.deviceScaleFactor * (surface.mediaScale ?? 1);
export function clientPointToDip(surface: Surface, rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number, outside: 'reject' | 'clamp' | 'allow' = 'reject') {
  const scale = surfacePixelScale(surface);
  const widthDip = surface.width / scale, heightDip = surface.height / scale;
  if (![rect.left, rect.top, rect.width, rect.height, clientX, clientY, scale, widthDip, heightDip].every(Number.isFinite) ||
      rect.width <= 0 || rect.height <= 0 || scale <= 0 || widthDip <= 0 || heightDip <= 0) return null;
  let x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (outside === 'clamp') {
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
  } else if (outside === 'reject' && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  const position = { x: x * widthDip, y: y * heightDip };
  return Number.isFinite(position.x) && Number.isFinite(position.y) ? position : null;
}
export function pointerPointToDip(surface: Surface, rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number, action: PointerAction, captured: boolean) {
  // Captured gestures retain outside coordinates for dragging/edge scrolling.
  const outside = action === 'leave' ? 'clamp' : captured && (action === 'move' || action === 'up' || action === 'cancel') ? 'allow' : 'reject';
  return clientPointToDip(surface, rect, clientX, clientY, outside);
}
export function markerSourceRect(surface: Surface, widthDip = 256, heightDip = 112) { const scale = surfacePixelScale(surface); return { x: surface.x, y: surface.y, width: widthDip * scale, height: heightDip * scale }; }
