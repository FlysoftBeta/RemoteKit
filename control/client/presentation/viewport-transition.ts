import { surfaceDipSize, surfacePixelScale } from '../input/coordinates';
import type { Surface } from './types';
export interface ViewportBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface VisualBounds {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}
export function pixelAlignedViewportBounds(
  bounds: ViewportBounds,
  scale: number,
  dpr: number,
): ViewportBounds {
  // Integer DIP sizes match the Chromium viewport request. Align the origin so
  // video filtering cannot sample the atlas gutter at a fractional flex edge.
  // Float noise in devicePixelRatio must not place an integer origin just below
  // the browser's layout grid.
  const ratio = Math.round(dpr * 1e6) / 1e6;
  return {
    left: Math.round(bounds.left * ratio) / ratio / scale,
    top: Math.round(bounds.top * ratio) / ratio / scale,
    width: Math.round(bounds.width / scale),
    height: Math.round(bounds.height / scale),
  };
}
export function visibleContentBounds(content: ViewportBounds, visual?: VisualBounds | null): ViewportBounds {
  if (!visual) return { ...content };
  const left = Math.max(content.left, visual.offsetLeft),
    top = Math.max(content.top, visual.offsetTop);
  return {
    left,
    top,
    width: Math.max(0, Math.min(content.left + content.width, visual.offsetLeft + visual.width) - left),
    height: Math.max(0, Math.min(content.top + content.height, visual.offsetTop + visual.height) - top),
  };
}
export function sameViewportBounds(a: ViewportBounds, b: ViewportBounds) {
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}
export function sameViewportSize(a: ViewportBounds, b: ViewportBounds) {
  return Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);
}
export function resizeSnapshotSize(width: number, height: number) {
  const pixels = width * height;
  if (!Number.isFinite(pixels) || width <= 0 || height <= 0) return;
  const scale = Math.min(1, Math.sqrt(FREEZE_MAX_PIXELS / pixels));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
export const FREEZE_MAX_PIXELS = 4 * 1024 * 1024;
export interface ResizeFreeze {
  owner: string;
  layout: string;
  bounds: ViewportBounds;
}
export type ResizeState =
  | { phase: 'stable' }
  | { phase: 'waiting'; snapshot?: ResizeFreeze; cause: 'layout' }
  | { phase: 'settling' };
export function transitionResize(
  state: ResizeState,
  event: { phase: 'stable' | 'settling' } | { phase: 'waiting'; cause: 'layout'; snapshot?: ResizeFreeze },
): ResizeState {
  if (event.phase === 'waiting')
    return { ...event, snapshot: event.snapshot ?? (state.phase === 'waiting' ? state.snapshot : undefined) };
  return event;
}
/** A freeze only retains old pixels; it never supplies media/input readiness. */
export class ViewportTransition {
  state: ResizeState = { phase: 'stable' };
  wait(cause: 'layout') {
    this.state = transitionResize(this.state, { phase: 'waiting', cause, snapshot: this.freeze });
  }
  settled() {
    this.state = transitionResize(this.state, { phase: 'stable' });
  }
  settling() {
    this.state = transitionResize(this.state, { phase: 'settling' });
  }
  desired?: ViewportBounds;
  confirmed?: { owner: string; layout: string; bounds: ViewportBounds };
  freeze?: ResizeFreeze;
  begin(owner: string, bounds: ViewportBounds, pixels: number, ready: boolean, mediaBarrier = false) {
    this.desired = { ...bounds };
    if (this.freeze) return false;
    const previous = this.confirmed;
    if (
      !ready ||
      !previous ||
      previous.owner !== owner ||
      (!mediaBarrier && sameViewportSize(previous.bounds, bounds)) ||
      !Number.isFinite(pixels) ||
      pixels <= 0 ||
      pixels > FREEZE_MAX_PIXELS
    )
      return false;
    this.freeze = { ...previous, bounds: { ...previous.bounds } };
    this.wait(this.state.phase === 'waiting' ? this.state.cause : 'layout');
    return true;
  }
  ready(owner: string, layout: string, bounds: ViewportBounds) {
    if (this.desired && !sameViewportSize(bounds, this.desired)) return false;
    this.confirmed = { owner, layout, bounds: { ...bounds } };
    if (
      this.freeze &&
      (this.freeze.owner !== owner ||
        ((!this.desired || sameViewportBounds(bounds, this.desired)) &&
          (layout !== this.freeze.layout || sameViewportSize(this.freeze.bounds, bounds))))
    )
      this.freeze = undefined;
    if (!this.freeze) this.settled();
  }
  invalidate(owner: string | undefined) {
    if (this.freeze && this.freeze.owner !== owner) this.freeze = undefined;
    if (this.confirmed?.owner !== owner) this.confirmed = undefined;
  }
  clear() {
    this.settled();
    this.freeze = undefined;
    this.confirmed = undefined;
    this.desired = undefined;
  }
}

/** New media is eligible only when both sampling axes match the requested DIP. */
export function surfaceMatchesViewport(surface: Surface, bounds: Pick<ViewportBounds, 'width' | 'height'>) {
  const size = surfaceDipSize(surface);
  return (
    [size.width, size.height, bounds.width, bounds.height].every(Number.isFinite) &&
    size.width > 0 &&
    size.height > 0 &&
    // Atlas dimensions round to whole encoded pixels; downsampling magnifies
    // that rounding when converted back to CSS pixels.
    Math.abs(surface.width - Math.round(bounds.width) * surfacePixelScale(surface)) <= 1 &&
    Math.abs(surface.height - Math.round(bounds.height) * surfacePixelScale(surface, 'y')) <= 1
  );
}
