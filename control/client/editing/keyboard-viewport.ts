interface ViewportMetrics {
  visual: { width: number; height: number; offsetLeft: number; offsetTop: number } | undefined;
  scale: number;
  layoutWidth: number;
  layoutHeight: number;
  screen?: { width: number; height: number };
}
export const KEYBOARD_SETTLE_MS = 140;
const VIEWPORT_NOISE_PX = 2;
const VISUAL_OCCLUSION_PX = 48;
export type ViewportChange = 'keyboard' | 'ordinary' | undefined;

/** Classifies browser viewport geometry without touching editor focus. */
export class KeyboardViewport {
  private width?: number;
  private height?: number;
  private baseline?: number;
  private restoreAt?: number;
  private observedOpen = false;
  private screen?: ViewportMetrics['screen'];
  dismissals = 0;

  get stableHeight() {
    return this.baseline ?? this.height ?? 0;
  }

  get occludedBottom() {
    return this.open ? Math.max(0, this.stableHeight - (this.height ?? this.stableHeight)) : 0;
  }

  get open() {
    return this.observedOpen;
  }
  get deadline() {
    return this.restoreAt;
  }

  measure(metrics: ViewportMetrics, focused: boolean, coarse: boolean, now: number): ViewportChange {
    const { visual, layoutWidth, layoutHeight, scale } = metrics;
    const height = Math.min(visual?.height ?? layoutHeight, layoutHeight);
    const width = Math.min(visual?.width ?? layoutWidth, layoutWidth);
    const previous = this.height;
    if (
      Math.abs(scale - 1) >= 0.02 ||
      (this.width !== undefined && Math.abs(this.width - width) > VIEWPORT_NOISE_PX)
    ) {
      const inset = this.occludedBottom;
      const screenRotated =
        this.screen &&
        metrics.screen &&
        this.width !== undefined &&
        Math.abs(this.screen.width - this.width) <= VIEWPORT_NOISE_PX &&
        Math.abs(metrics.screen.width - width) <= VIEWPORT_NOISE_PX &&
        Math.abs(metrics.screen.width - this.screen.height) <= VIEWPORT_NOISE_PX &&
        Math.abs(metrics.screen.height - this.screen.width) <= VIEWPORT_NOISE_PX;
      const rotatedHeight = screenRotated
        ? metrics.screen!.height - (this.screen!.height - this.stableHeight)
        : this.width;
      const rotated =
        this.open &&
        Math.abs(scale - 1) < 0.02 &&
        this.baseline !== undefined &&
        (screenRotated || Math.abs(width - this.baseline) <= VIEWPORT_NOISE_PX);
      const retainedHeight =
        this.open && Math.abs(scale - 1) < 0.02
          ? rotated
            ? (rotatedHeight ?? height)
            : layoutHeight > height + VIEWPORT_NOISE_PX
              ? layoutHeight
              : height + inset
          : height;
      this.clear();
      this.width = width;
      this.height = height;
      this.baseline = Math.max(height, layoutHeight, retainedHeight);
      this.observedOpen = this.baseline - height > VIEWPORT_NOISE_PX;
      this.screen = metrics.screen;
      return 'ordinary';
    }

    this.width ??= width;
    this.screen ??= metrics.screen;
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
    if (focused && (occlusion >= VISUAL_OCCLUSION_PX || (coarse && drop > VIEWPORT_NOISE_PX))) {
      this.observedOpen = true;
      return 'keyboard';
    }
    // Preserve the unoccluded baseline through small steps during a possible
    // keyboard animation. Grow it immediately for browser chrome restoration.
    if (!focused || (!coarse && occlusion <= VIEWPORT_NOISE_PX)) this.baseline = height;
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
    this.screen = undefined;
  }
}
