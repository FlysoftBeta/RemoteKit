import type { Surface } from './types';
import { surfaceDipSize } from './coordinates';
export interface ViewportBounds { left: number; top: number; width: number; height: number }
export interface VisualBounds { offsetLeft: number; offsetTop: number; width: number; height: number }
export interface ViewportMetrics {
  visual: VisualBounds | undefined;
  scale: number;
  layoutWidth: number;
  layoutHeight: number;
}
export function visibleContentBounds(content: ViewportBounds, visual?: VisualBounds | null): ViewportBounds {
  if (!visual) return { ...content };
  const left = Math.max(content.left, visual.offsetLeft), top = Math.max(content.top, visual.offsetTop);
  return { left, top, width: Math.max(0, Math.min(content.left + content.width, visual.offsetLeft + visual.width) - left), height: Math.max(0, Math.min(content.top + content.height, visual.offsetTop + visual.height) - top) };
}
export function sameViewportBounds(a: ViewportBounds, b: ViewportBounds) {
  return Math.abs(a.left - b.left) < .5 && Math.abs(a.top - b.top) < .5 && Math.abs(a.width - b.width) < .5 && Math.abs(a.height - b.height) < .5;
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
export class KeyboardViewport {
  private previous?: ViewportMetrics;
  private openHeight?: number;
  private restores = 0;
  get open() { return this.openHeight !== undefined; }
  get restoreCount() { return this.restores; }
  measure(metrics: ViewportMetrics, focused: boolean, coarse: boolean) {
    const previous = this.previous;
    this.previous = metrics;
    if (!previous) return false;
    const visual = metrics.visual, oldVisual = previous.visual;
    if (Math.abs(previous.layoutWidth - metrics.layoutWidth) >= 1 ||
        Math.abs((oldVisual?.width ?? previous.layoutWidth) - (visual?.width ?? metrics.layoutWidth)) >= 1 ||
        metrics.scale <= .98 || metrics.scale >= 1.02) {
      this.openHeight = undefined;
      return false;
    }
    const visualHeight = visual?.height ?? metrics.layoutHeight;
    const previousVisualHeight = oldVisual?.height ?? previous.layoutHeight;
    const height = Math.min(visualHeight, metrics.layoutHeight);
    const oldHeight = Math.min(previousVisualHeight, previous.layoutHeight);
    if (Math.abs(visualHeight - previousVisualHeight) < 1 &&
        Math.abs(metrics.layoutHeight - previous.layoutHeight) < 1) return false;
    if (this.openHeight !== undefined) {
      if (height >= this.openHeight - 1) {
        this.openHeight = undefined;
        ++this.restores;
      }
      return true;
    }
    const occluded = !!visual && visualHeight < metrics.layoutHeight - 24;
    if (focused && (occluded || coarse) && oldHeight - height >= 1) {
      this.openHeight = oldHeight;
      return true;
    }
    return false;
  }
  clear() { this.openHeight = this.previous = undefined; }
}
export const FREEZE_MAX_PIXELS = 4 * 1024 * 1024;
export const FREEZE_MAX_MS = 1800;
export interface ResizeFreeze { owner: string; layout: string; bounds: ViewportBounds; expires: number }
/** A freeze only retains old pixels; it never supplies media/input readiness. */
export class ViewportTransition {
  desired?: ViewportBounds;
  confirmed?: { owner: string; layout: string; bounds: ViewportBounds };
  freeze?: ResizeFreeze;
  begin(owner: string, bounds: ViewportBounds, now: number, pixels: number, ready: boolean) {
    this.desired = { ...bounds };
    if (this.freeze) return false; // One bounded copy for the complete keyboard animation.
    const previous = this.confirmed;
    if (!ready || !previous || previous.owner !== owner || sameViewportSize(previous.bounds, bounds) || !Number.isFinite(pixels) || pixels <= 0 || pixels > FREEZE_MAX_PIXELS) return false;
    this.freeze = { ...previous, bounds: { ...previous.bounds }, expires: now + FREEZE_MAX_MS };
    return true;
  }
  ready(owner: string, layout: string, bounds: ViewportBounds) {
    this.confirmed = { owner, layout, bounds: { ...bounds } };
    if (this.freeze && (this.freeze.owner !== owner || (!this.desired || sameViewportBounds(bounds, this.desired)) &&
        (layout !== this.freeze.layout || sameViewportSize(this.freeze.bounds, bounds)))) this.freeze = undefined;
  }
  invalidate(owner: string | undefined, now: number) {
    if (this.freeze && (this.freeze.owner !== owner || now >= this.freeze.expires)) this.freeze = undefined;
    if (this.confirmed?.owner !== owner) this.confirmed = undefined;
  }
  clear() { this.freeze = undefined; this.confirmed = undefined; this.desired = undefined; }
}

/** New media is eligible only when both sampling axes match the requested DIP. */
export function surfaceMatchesViewport(surface: Surface, bounds: Pick<ViewportBounds, 'width' | 'height'>) {
  const size = surfaceDipSize(surface);
  return [size.width, size.height, bounds.width, bounds.height].every(Number.isFinite) && size.width > 0 && size.height > 0 &&
    Math.abs(size.width - Math.round(bounds.width)) <= 1 && Math.abs(size.height - Math.round(bounds.height)) <= 1;
}
