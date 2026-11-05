import type { Layout } from '../types';
import type { PlaneRenderer, VideoObservation } from './types';
import { configurePresentationVideo, VideoCompositorStats, videoPlaneGeometry } from './video-presentation';

export class VideoPlane {
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
      overflow: 'hidden',
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
    const bounds = canvas.getBoundingClientRect(),
      container = parent.getBoundingClientRect();
    const geometry = videoPlaneGeometry(view, layout, bounds);
    if (!geometry) return false;
    const left = bounds.left - container.left,
      top = bounds.top - container.top;
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
