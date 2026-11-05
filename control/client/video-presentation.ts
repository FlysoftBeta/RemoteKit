import type { Layout, Surface } from './types';

export interface PresentationBarrier {
  version: 1;
  barrierId: string;
  outputGeneration: string;
  layoutEpoch: string;
}
export function presentationBarrier(value: unknown): PresentationBarrier | undefined {
  const v = value as Partial<PresentationBarrier> | null;
  return v?.version === 1 &&
    [v.barrierId, v.outputGeneration, v.layoutEpoch].every(
      (n) => typeof n === 'string' && /^(0|[1-9]\d*)$/.test(n),
    )
    ? {
        version: 1,
        barrierId: v.barrierId!,
        outputGeneration: v.outputGeneration!,
        layoutEpoch: v.layoutEpoch!,
      }
    : undefined;
}
export function barrierMatchesLayout(key: PresentationBarrier, layout: Layout | null) {
  return key.outputGeneration === layout?.generation && key.layoutEpoch === layout.epoch;
}
/** Target bounds belong to the client input surface; atlas positions only select pixels. */
export function videoPlaneGeometry(view: Surface, layout: Layout, bounds: { width: number; height: number }) {
  if (
    ![
      bounds.width,
      bounds.height,
      view.x,
      view.y,
      view.width,
      view.height,
      layout.width,
      layout.height,
    ].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    view.width <= 0 ||
    view.height <= 0 ||
    view.x < 0 ||
    view.y < 0 ||
    view.x + view.width > layout.width ||
    view.y + view.height > layout.height
  )
    return undefined;
  const sx = bounds.width / view.width,
    sy = bounds.height / view.height;
  return { width: layout.width * sx, height: layout.height * sy, left: -view.x * sx, top: -view.y * sy };
}

type VideoTiming = Pick<VideoFrameCallbackMetadata, 'presentationTime' | 'expectedDisplayTime'> & {
  receiveTime?: number;
  processingDuration?: number;
};
const duration = (end?: number, start?: number) =>
  typeof end === 'number' && typeof start === 'number' && Number.isFinite(end - start) && end >= start
    ? end - start
    : undefined;
const timingPercentile = (samples: (number | undefined)[]) => {
  const sorted = samples.filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  return sorted.length
    ? { samples: sorted.length, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
    : undefined;
};

/** Tracks compositor submissions, JS callbacks and element counters separately. */
export class VideoCompositorStats {
  private previous?: { at: number; frames: number };
  private samples: {
    at: number;
    start: number;
    frames: number;
    receiveToSubmit?: number;
    submitToCallback?: number;
    expectedDisplayLateness?: number;
    processing?: number;
  }[] = [];
  frames = 0;
  callbacks = 0;
  observationRevision = 0;
  private windowStart?: {
    at: number;
    frames: number;
    callbacks: number;
    quality?: Pick<VideoPlaybackQuality, 'totalVideoFrames' | 'droppedVideoFrames'>;
  };
  observe(at: number, frames: unknown, visible: boolean, timing?: VideoTiming) {
    this.callbacks++;
    if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 0) {
      this.resetObservation();
      return;
    }
    if (this.previous && frames < this.previous.frames) this.resetObservation();
    const old = this.previous;
    this.previous = { at, frames };
    if (visible && old && at > old.at && frames > old.frames) {
      const delta = frames - old.frames;
      this.frames += delta;
      const processing = timing?.processingDuration;
      this.samples.push({
        at,
        start: old.at,
        frames: delta,
        receiveToSubmit: duration(timing?.presentationTime, timing?.receiveTime),
        submitToCallback: duration(at, timing?.presentationTime),
        expectedDisplayLateness: timing
          ? duration(Math.max(at, timing.expectedDisplayTime), timing.expectedDisplayTime)
          : undefined,
        processing:
          typeof processing === 'number' && Number.isFinite(processing) && processing >= 0
            ? processing * 1000
            : undefined,
      });
    }
    this.samples = this.samples.filter((sample) => sample.at >= at - 1000).slice(-256);
  }
  resetObservation() {
    this.previous = undefined;
    this.samples = [];
    this.windowStart = undefined;
    this.observationRevision++;
  }
  sampleWindow(
    at: number,
    visible: boolean,
    quality?: Pick<VideoPlaybackQuality, 'totalVideoFrames' | 'droppedVideoFrames'>,
  ) {
    const previous = this.windowStart;
    this.windowStart =
      visible && this.previous ? { at, frames: this.frames, callbacks: this.callbacks, quality } : undefined;
    if (!this.windowStart || !previous || at <= previous.at) return;
    const scale = 1000 / (at - previous.at);
    const total = duration(quality?.totalVideoFrames, previous.quality?.totalVideoFrames);
    return {
      fps: (this.frames - previous.frames) * scale,
      callbackFps: (this.callbacks - previous.callbacks) * scale,
      videoElementFps: total === undefined ? undefined : total * scale,
      videoElementDrops: duration(quality?.droppedVideoFrames, previous.quality?.droppedVideoFrames),
    };
  }
  timing(now: number) {
    const samples = this.samples.filter((sample) => sample.at >= now - 1000 && sample.at <= now);
    return {
      receiveToSubmit: timingPercentile(samples.map((sample) => sample.receiveToSubmit)),
      submitToCallback: timingPercentile(samples.map((sample) => sample.submitToCallback)),
      expectedDisplayLateness: timingPercentile(samples.map((sample) => sample.expectedDisplayLateness)),
      processing: timingPercentile(samples.map((sample) => sample.processing)),
    };
  }
  snapshot(now: number) {
    const samples = this.samples.filter((sample) => sample.at >= now - 1000),
      first = samples[0];
    const elapsed = first ? Math.max(now, samples[samples.length - 1].at) - first.start : 0;
    return {
      frames: this.frames,
      callbacks: this.callbacks,
      fps: elapsed > 0 ? (samples.reduce((n, sample) => n + sample.frames, 0) * 1000) / elapsed : undefined,
    };
  }
}

export function configurePresentationVideo(video: HTMLVideoElement) {
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.tabIndex = -1;
  video.draggable = false;
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.setAttribute?.('controlsList', 'nodownload nofullscreen noremoteplayback');
  video.setAttribute?.('aria-hidden', 'true');
  video.oncontextmenu = (event) => {
    event.preventDefault();
  };
}
