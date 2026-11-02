export interface ViewportBounds { left: number; top: number; width: number; height: number }
export interface VisualBounds { offsetLeft: number; offsetTop: number; width: number; height: number }
export function visibleContentBounds(content: ViewportBounds, visual?: VisualBounds | null): ViewportBounds {
  if (!visual) return { ...content };
  const left = Math.max(content.left, visual.offsetLeft), top = Math.max(content.top, visual.offsetTop);
  return { left, top, width: Math.max(0, Math.min(content.left + content.width, visual.offsetLeft + visual.width) - left), height: Math.max(0, Math.min(content.top + content.height, visual.offsetTop + visual.height) - top) };
}
export function sameViewportBounds(a: ViewportBounds, b: ViewportBounds) {
  return Math.abs(a.left - b.left) < .5 && Math.abs(a.top - b.top) < .5 && Math.abs(a.width - b.width) < .5 && Math.abs(a.height - b.height) < .5;
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
    if (!ready || !previous || previous.owner !== owner || Math.round(previous.bounds.width) === Math.round(bounds.width) && Math.round(previous.bounds.height) === Math.round(bounds.height) || !Number.isFinite(pixels) || pixels <= 0 || pixels > FREEZE_MAX_PIXELS) return false;
    this.freeze = { ...previous, bounds: { ...previous.bounds }, expires: now + FREEZE_MAX_MS };
    return true;
  }
  ready(owner: string, layout: string, bounds: ViewportBounds) {
    this.confirmed = { owner, layout, bounds: { ...bounds } };
    if (this.freeze && (this.freeze.owner !== owner || layout !== this.freeze.layout && (!this.desired || sameViewportBounds(bounds, this.desired)))) this.freeze = undefined;
  }
  invalidate(owner: string | undefined, now: number) {
    if (this.freeze && (this.freeze.owner !== owner || now >= this.freeze.expires)) this.freeze = undefined;
    if (this.confirmed?.owner !== owner) this.confirmed = undefined;
  }
  clear() { this.freeze = undefined; this.confirmed = undefined; this.desired = undefined; }
}
