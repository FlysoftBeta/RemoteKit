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
export const KEYBOARD_SETTLE_MS = 140;
const VIEWPORT_NOISE_PX = 2;
const VISUAL_OCCLUSION_PX = 48;
const LAYOUT_OCCLUSION_PX = 80;
type ViewportChange = 'keyboard' | 'ordinary' | undefined;

/** Classifies browser viewport geometry without touching editor focus. */
export class KeyboardViewport {
  private width?: number;
  private height?: number;
  private baseline?: number;
  private restoreAt?: number;
  private observedOpen = false;
  dismissals = 0;

  get open() { return this.observedOpen; }
  get deadline() { return this.restoreAt; }

  measure(metrics: ViewportMetrics, focused: boolean, coarse: boolean, now: number): ViewportChange {
    const { visual, layoutWidth, layoutHeight, scale } = metrics;
    const height = Math.min(visual?.height ?? layoutHeight, layoutHeight);
    const width = Math.min(visual?.width ?? layoutWidth, layoutWidth);
    const previous = this.height;
    if (Math.abs(scale - 1) >= .02 || this.width !== undefined && Math.abs(this.width - width) > VIEWPORT_NOISE_PX) {
      this.clear();
      return 'ordinary';
    }

    this.width ??= width;
    const occlusion = layoutHeight - height;
    const meaningful = previous !== undefined && Math.abs(height - previous) > VIEWPORT_NOISE_PX;
    if (previous === undefined || meaningful) this.height = height;

    // Without a prior sample, the layout viewport still supplies the full
    // height on browsers that resize only their visual viewport.
    this.baseline ??= Math.max(height, layoutHeight);
    if (this.open) {
      if (height >= this.baseline - VIEWPORT_NOISE_PX) this.restoreAt ??= now + KEYBOARD_SETTLE_MS;
      else this.restoreAt = undefined;
      return meaningful ? 'keyboard' : undefined;
    }

    const drop = this.baseline - height;
    if (focused && (occlusion >= VISUAL_OCCLUSION_PX || coarse && drop >= LAYOUT_OCCLUSION_PX)) {
      this.observedOpen = true;
      return 'keyboard';
    }
    // Preserve the unoccluded baseline through small steps during a possible
    // keyboard animation. Grow it immediately for browser chrome restoration.
    if (!focused || !coarse && occlusion <= VIEWPORT_NOISE_PX) this.baseline = height;
    else this.baseline = Math.max(this.baseline, height);
    return meaningful ? 'ordinary' : undefined;
  }

  settle(now: number) {
    if (this.restoreAt === undefined || now < this.restoreAt) return false;
    this.observedOpen = false;
    this.restoreAt = undefined;
    ++this.dismissals;
    return true;
  }

  clear() {
    this.width = this.height = this.baseline = this.restoreAt = undefined;
    this.observedOpen = false;
  }
}

/** A viewport event may precede or follow the content observer in one resize. */
export class ResizePreview {
  private keyboardHint = false;
  private active = false;
  private settleAt = 0;
  keyboard = false;
  get deadline() { return this.active && this.keyboard ? this.settleAt : 0; }

  measure(changed: boolean, change: ViewportChange, now: number) {
    if (change === 'keyboard') {
      this.keyboardHint = true;
      if (this.active) this.keyboard = true;
      this.settleAt = now + KEYBOARD_SETTLE_MS;
    } else if (change === 'ordinary') {
      this.keyboardHint = this.keyboard = false;
    }
    if (changed) {
      // An IME inset and the resulting content bounds need not arrive in the
      // same frame. Keep the cause until presentation completes the transition.
      this.keyboard = this.keyboardHint || this.active && this.keyboard;
      this.active = true;
      this.settleAt = now + KEYBOARD_SETTLE_MS;
      this.keyboardHint = false;
    }
    return this.keyboard;
  }

  clear() {
    this.active = this.keyboard = this.keyboardHint = false;
    this.settleAt = 0;
  }
  complete() { if (this.active) this.clear(); }
}
export const FREEZE_MAX_PIXELS = 4 * 1024 * 1024;
export interface ResizeFreeze { owner: string; layout: string; bounds: ViewportBounds }
/** A freeze only retains old pixels; it never supplies media/input readiness. */
export class ViewportTransition {
  desired?: ViewportBounds;
  confirmed?: { owner: string; layout: string; bounds: ViewportBounds };
  freeze?: ResizeFreeze;
  begin(owner: string, bounds: ViewportBounds, pixels: number, ready: boolean, mediaBarrier = false) {
    this.desired = { ...bounds };
    if (this.freeze) return false; // One bounded copy for the complete keyboard animation.
    const previous = this.confirmed;
    if (!ready || !previous || previous.owner !== owner || !mediaBarrier && sameViewportSize(previous.bounds, bounds) || !Number.isFinite(pixels) || pixels <= 0 || pixels > FREEZE_MAX_PIXELS) return false;
    this.freeze = { ...previous, bounds: { ...previous.bounds } };
    return true;
  }
  ready(owner: string, layout: string, bounds: ViewportBounds) {
    if (this.desired && !sameViewportSize(bounds, this.desired)) return false;
    this.confirmed = { owner, layout, bounds: { ...bounds } };
    if (this.freeze && (this.freeze.owner !== owner || (!this.desired || sameViewportBounds(bounds, this.desired)) &&
        (layout !== this.freeze.layout || sameViewportSize(this.freeze.bounds, bounds)))) this.freeze = undefined;
  }
  invalidate(owner: string | undefined) {
    if (this.freeze && this.freeze.owner !== owner) this.freeze = undefined;
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
