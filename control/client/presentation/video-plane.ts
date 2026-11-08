import type { Layout } from './types';
import { uiScale } from '../app/ui-scale';
import { surfacePixelScale } from '../input/coordinates';
import type { PresentedPlaneSource } from './plane-source';
import type { PlaneRenderer, VideoObservation } from './types';
import { configurePresentationVideo, VideoCompositorStats, videoPlaneGeometry } from './video-presentation';

export class VideoPlane {
  static supported() {
    const video = document.createElement('video');
    configurePresentationVideo(video);
    return typeof video.requestVideoFrameCallback === 'function' && typeof ResizeObserver === 'function';
  }
  static visible(canvas: HTMLCanvasElement) {
    const bounds = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    return (
      bounds.width > 0 &&
      bounds.height > 0 &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse'
    );
  }
  readonly video = document.createElement('video');
  readonly clip = document.createElement('div');
  private readonly observer: ResizeObserver;
  private callback?: number;
  private disposed = false;
  ready = false;
  rtp?: number;
  stats = new VideoCompositorStats();
  observationSequence = 0;
  pendingObservation?: VideoObservation;
  private geometry?: number[];

  constructor(
    readonly track: MediaStreamTrack,
    private readonly renderer: PlaneRenderer,
    callbacks: { resized(): void; frame(metadata: VideoFrameCallbackMetadata): void; failed(): void },
  ) {
    const { video, clip } = this,
      canvas = renderer.canvas,
      parent = canvas.parentElement!;
    configurePresentationVideo(video);
    clip.className = 'remote-video-plane';
    clip.setAttribute('aria-hidden', 'true');
    Object.assign(clip.style, {
      position: 'absolute',
      clipPath: 'inset(0)',
      pointerEvents: 'none',
      opacity: '0',
    });
    Object.assign(video.style, {
      position: 'absolute',
      maxWidth: 'none',
      maxHeight: 'none',
      objectFit: 'fill',
      pointerEvents: 'none',
    });
    clip.append(video);
    parent.insertBefore(clip, canvas);
    canvas.width = renderer.view.width;
    canvas.height = renderer.view.height;
    canvas.style.opacity = '0';
    canvas.setAttribute('data-video-input', 'true');
    this.observer = new ResizeObserver(callbacks.resized);
    this.observer.observe(canvas);
    this.observer.observe(parent);
    const receive = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (this.disposed) return;
      try {
        callbacks.frame(metadata);
      } finally {
        if (!this.disposed) this.callback = video.requestVideoFrameCallback(receive);
      }
    };
    this.callback = video.requestVideoFrameCallback(receive);
    video.onerror = callbacks.failed;
    video.srcObject = new MediaStream([track]);
    void video.play().catch(callbacks.failed);
  }

  position(layout: Layout) {
    const { canvas, view } = this.renderer,
      parent = canvas.parentElement;
    if (!parent) return false;
    const visual = canvas.getBoundingClientRect(),
      container = parent.getBoundingClientRect();
    // Styles are layout px; client rects are visual px under the Viewer's UI scale transform.
    const scale = uiScale();
    const bounds = { width: visual.width / scale, height: visual.height / scale };
    const geometry = videoPlaneGeometry(view, layout, bounds);
    if (!geometry) return false;
    const left = (visual.left - container.left) / scale,
      top = (visual.top - container.top) / scale;
    const position = [
      left,
      top,
      bounds.width,
      bounds.height,
      geometry.left,
      geometry.top,
      geometry.width,
      geometry.height,
    ];
    if (position.every((value, index) => value === this.geometry?.[index])) return true;
    this.geometry = position;
    Object.assign(this.clip.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    });
    for (const [name, value] of Object.entries(geometry)) this.video.style.setProperty(name, `${value}px`);
    return true;
  }

  matchesAtlas(layout: Layout | null) {
    return !!layout && this.video.videoWidth === layout.width && this.video.videoHeight === layout.height;
  }
  resizeInput() {
    const { canvas, view } = this.renderer;
    if (canvas.width !== view.width) canvas.width = view.width;
    if (canvas.height !== view.height) canvas.height = view.height;
  }
  show(rtp?: number, resetObservation = false) {
    const wasReady = this.ready;
    this.ready = true;
    this.rtp = rtp;
    if (!wasReady) {
      if (resetObservation) this.stats.resetObservation();
      this.clip.style.opacity = '1';
    }
    return wasReady;
  }
  resetStats() {
    this.stats = new VideoCompositorStats();
  }
  sampleWindow(at: number, current: boolean) {
    return this.stats.sampleWindow(at, this.ready && current, this.video.getVideoPlaybackQuality?.());
  }
  presentedSource(layout: Layout, rtpTimestamp: number): PresentedPlaneSource | undefined {
    if (!this.ready || this.rtp !== rtpTimestamp) return;
    const view = this.renderer.view;
    return {
      image: this.video,
      sourceRect: { x: view.x, y: view.y, width: view.width, height: view.height },
      kind: 'atlas',
      viewId: view.id,
      rtpTimestamp,
      layoutEpoch: layout.epoch,
      encodedWidth: view.width,
      encodedHeight: view.height,
      pixelsPerDip: surfacePixelScale(view),
      pixelsPerDipY: surfacePixelScale(view, 'y'),
    };
  }

  hide() {
    this.clip.style.opacity = '0';
    this.ready = false;
    this.rtp = undefined;
    this.pendingObservation = undefined;
    this.observationSequence++;
    this.stats.resetObservation();
  }
  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    if (this.callback !== undefined) this.video.cancelVideoFrameCallback?.(this.callback);
    this.video.onerror = null;
    this.video.pause();
    this.video.srcObject = null;
    this.clip.remove();
    this.renderer.canvas.style.opacity = '';
    this.renderer.canvas.removeAttribute('data-video-input');
  }
}
