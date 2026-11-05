import { surfacePixelScale } from './coordinates';
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
/** Consume synchronously: the image may be reused after the current presentation. */
export interface PresentedPlaneSource {
  image: CanvasImageSource;
  sourceRect: PixelRect;
  kind: 'atlas';
  viewId: string;
  rtpTimestamp: number;
  layoutEpoch: string;
  /** Encoded plane dimensions, independent of image/atlas extent and page DIP. */
  encodedWidth: number;
  encodedHeight: number;
  pixelsPerDip: number;
  /** Present only when the displayed ROI's vertical scale differs from its horizontal scale. */
  pixelsPerDipY?: number;
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
