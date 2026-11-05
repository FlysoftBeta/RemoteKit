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
  private keyboardHintUntil = 0;
  private changedUntil = 0;
  keyboard = false;
  get deadline() { return this.keyboard ? this.changedUntil : 0; }

  measure(changed: boolean, change: ViewportChange, now: number) {
    if (change === 'keyboard') {
      this.keyboardHintUntil = now + KEYBOARD_SETTLE_MS;
      if (this.changedUntil > now) {
        this.keyboard = true;
        this.changedUntil = this.keyboardHintUntil;
      }
    } else if (change === 'ordinary') {
      this.keyboardHintUntil = 0;
    }
    if (changed) {
      this.keyboard = this.keyboardHintUntil > now;
      this.changedUntil = now + KEYBOARD_SETTLE_MS;
      this.keyboardHintUntil = 0;
    }
    return this.keyboard;
  }

  clear() {
    this.keyboard = false;
    this.changedUntil = this.keyboardHintUntil = 0;
  }
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
    if (this.desired && !sameViewportSize(bounds, this.desired)) return false;
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
