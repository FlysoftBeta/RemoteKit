import type { Surface } from './types';
export const surfacePixelScale = (surface: Pick<Surface, 'deviceScaleFactor' | 'mediaScale'>) => surface.deviceScaleFactor * (surface.mediaScale ?? 1);
export function clientPointToDip(surface: Surface, rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number) {
  const scale = surfacePixelScale(surface);
  return { x: (clientX - rect.left) / rect.width * surface.width / scale, y: (clientY - rect.top) / rect.height * surface.height / scale };
}
export function markerSourceRect(surface: Surface, widthDip = 256, heightDip = 112) { const scale = surfacePixelScale(surface); return { x: surface.x, y: surface.y, width: widthDip * scale, height: heightDip * scale }; }
