import type { FileRequestAnchor } from '../../shared/product';
import { surfaceDipSize } from '../input/coordinates';
import { surfaceMatchesViewport } from '../presentation/viewport-transition';
import type { Layout, Surface } from '../presentation/types';

type Bounds = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>;
export function projectFileInput(
  anchor: FileRequestAnchor,
  layout: Layout,
  surface: Surface,
  bounds: Bounds,
  scale: number,
): Bounds | undefined {
  if (
    layout.reconfiguring ||
    surface.stale ||
    surface.instance !== anchor.instance ||
    surface.document !== anchor.document ||
    layout.generation !== anchor.layoutGeneration ||
    Math.abs(surface.deviceScaleFactor - anchor.deviceScaleFactor) > 0.001 ||
    !surfaceMatchesViewport(surface, { width: bounds.width / scale, height: bounds.height / scale })
  )
    return;
  const dip = surfaceDipSize(surface);
  const { x, y, width, height, viewportWidth, viewportHeight } = anchor;
  if (
    ![x, y, width, height, viewportWidth, viewportHeight, bounds.left, bounds.top].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > viewportWidth ||
    y + height > viewportHeight ||
    Math.abs(viewportWidth - dip.width) > 1 ||
    Math.abs(viewportHeight - dip.height) > 1
  )
    return;
  return {
    left: bounds.left + (x * bounds.width) / viewportWidth,
    top: bounds.top + (y * bounds.height) / viewportHeight,
    width: (width * bounds.width) / viewportWidth,
    height: (height * bounds.height) / viewportHeight,
  };
}

export function placeFileChooser(anchor: Bounds, viewport: Bounds, scale: number) {
  const padding = 12 * scale,
    gap = 8 * scale,
    width = Math.min(420 * scale, viewport.width - padding * 2);
  const right = viewport.left + viewport.width,
    bottom = viewport.top + viewport.height;
  const anchorBottom = anchor.top + anchor.height;
  if (
    width < 276 * scale ||
    anchor.left < viewport.left ||
    anchor.left + anchor.width > right ||
    anchor.top < viewport.top ||
    anchorBottom > bottom
  )
    return;
  const below = bottom - anchorBottom - gap - padding;
  const above = anchor.top - viewport.top - gap - padding;
  const useBelow = below >= 420 * scale || below >= above;
  const height = Math.min(420 * scale, useBelow ? below : above);
  if (height < 156 * scale) return;
  const left = Math.max(viewport.left + padding, Math.min(anchor.left, right - width - padding));
  return {
    width,
    left,
    maxHeight: height,
    top: useBelow ? anchorBottom + gap : anchor.top - gap,
    above: !useBelow,
  };
}
