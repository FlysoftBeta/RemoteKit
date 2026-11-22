import { surfacePixelScale } from '../input/coordinates';
import type { Layout, Surface } from './types';

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PlaneIdentity {
  view: Surface;
  layoutEpoch: string;
  layoutGeneration: string;
}
/** Consume synchronously: the image keeps advancing with the video. */
export interface FreezeSource {
  image: CanvasImageSource;
  sourceRect: PixelRect;
}

export function samePlane(a: Surface, b: Surface) {
  return (
    a.id === b.id &&
    a.session === b.session &&
    a.instance === b.instance &&
    a.document === b.document &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.deviceScaleFactor === b.deviceScaleFactor &&
    surfacePixelScale(a) === surfacePixelScale(b) &&
    surfacePixelScale(a, 'y') === surfacePixelScale(b, 'y') &&
    !!a.stale === !!b.stale
  );
}
export function planeMatchesLayout(identity: PlaneIdentity, layout: Layout | null) {
  return (
    !!layout &&
    identity.layoutEpoch === layout.epoch &&
    identity.layoutGeneration === layout.generation &&
    layout.views.some((view) => samePlane(identity.view, view))
  );
}
