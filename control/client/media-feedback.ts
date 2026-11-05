/** Windowed receiver observations. RAF measures callback capacity, never drives paint. */
export interface MediaFeedback {
  type: 'media.feedback';
  version: 1;
  seq: number;
  layoutEpoch: string;
  outputGeneration: string;
  visible: boolean;
  windowMs: number;
  rafSamples: number;
  displayHzEstimate?: number;
  decodedFrames?: number;
  videoFrames?: number;
  packetsLost?: number;
  framesDropped?: number;
  planes: { view: string; frames?: number }[];
  roundTripTimeMs?: number;
}
export interface FeedbackCounters {
  layoutEpoch: string;
  outputGeneration: string;
  decodedFrames?: number;
  videoFrames?: number;
  packetsLost?: number;
  framesDropped?: number;
  planes: { view: string; frames?: number }[];
  roundTripTimeMs?: number;
}
export interface FeedbackEnvironment {
  now(): number;
  visible(): boolean;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  onVisibility(callback: () => void): () => void;
}
const counter = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const delta = (current: number | undefined, previous: number | undefined) =>
  counter(current) && counter(previous) && current >= previous ? current - previous : undefined;
export class MediaFeedbackSampler {
  private active = false;
  private frame: number | undefined;
  private removeVisibility: (() => void) | undefined;
  private startedAt = 0;
  private seq = 0;
  private previous: FeedbackCounters | undefined;
  private lastRaf: number | undefined;
  private intervals: number[] = [];
  private visibleWindow = false;
  constructor(private environment: FeedbackEnvironment) {}
  start() {
    this.stop();
    this.active = true;
    this.seq = 0;
    this.previous = undefined;
    this.startedAt = this.environment.now();
    this.visibleWindow = this.environment.visible();
    this.removeVisibility = this.environment.onVisibility(() => {
      // A window which included hidden time cannot describe foreground capacity.
      this.visibleWindow = false;
      this.lastRaf = undefined;
      this.intervals = [];
    });
    this.frame = this.environment.requestFrame(this.observeRaf);
  }
  stop() {
    this.active = false;
    if (this.frame !== undefined) this.environment.cancelFrame(this.frame);
    this.frame = undefined;
    this.removeVisibility?.();
    this.removeVisibility = undefined;
    this.lastRaf = undefined;
    this.intervals = [];
    this.previous = undefined;
  }
  private observeRaf = (at: number) => {
    if (!this.active) return;
    if (this.environment.visible() && Number.isFinite(at)) {
      const interval = this.lastRaf === undefined ? undefined : at - this.lastRaf;
      // Cover 10–250Hz callback cadence. Pauses and duplicate timestamps are not refresh samples.
      if (interval !== undefined && interval >= 4 && interval <= 100) {
        this.intervals.push(interval);
        if (this.intervals.length > 512) this.intervals.shift();
      }
      this.lastRaf = at;
    } else {
      this.visibleWindow = false;
      this.lastRaf = undefined;
    }
    this.frame = this.environment.requestFrame(this.observeRaf);
  };
  sample(current: FeedbackCounters): MediaFeedback | undefined {
    if (!this.active) return;
    const now = this.environment.now(),
      windowMs = now - this.startedAt;
    if (!Number.isFinite(windowMs) || windowMs < 1500) return;
    const visible = this.environment.visible(),
      previous = this.previous;
    const sameLayout =
      previous?.layoutEpoch === current.layoutEpoch && previous.outputGeneration === current.outputGeneration;
    const report: MediaFeedback = {
      type: 'media.feedback',
      version: 1,
      seq: ++this.seq,
      layoutEpoch: current.layoutEpoch,
      outputGeneration: current.outputGeneration,
      visible,
      windowMs,
      rafSamples: this.intervals.length,
      planes: current.planes.map((plane) => ({ view: plane.view })),
    };
    if (visible && this.visibleWindow && this.intervals.length >= 20) {
      const sorted = [...this.intervals].sort((a, b) => a - b),
        middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      report.displayHzEstimate = 1000 / median;
    }
    if (sameLayout) {
      for (const name of ['decodedFrames', 'videoFrames', 'packetsLost', 'framesDropped'] as const) {
        const value = delta(current[name], previous[name]);
        if (value !== undefined) report[name] = value;
      }
      for (const plane of report.planes) {
        const value = delta(
          current.planes.find((item) => item.view === plane.view)?.frames,
          previous.planes.find((item) => item.view === plane.view)?.frames,
        );
        if (value !== undefined) plane.frames = value;
      }
    }
    if (
      typeof current.roundTripTimeMs === 'number' &&
      Number.isFinite(current.roundTripTimeMs) &&
      current.roundTripTimeMs >= 0
    )
      report.roundTripTimeMs = current.roundTripTimeMs;
    this.previous = { ...current, planes: current.planes.map((plane) => ({ ...plane })) };
    this.startedAt = now;
    this.intervals = [];
    this.lastRaf = undefined;
    this.visibleWindow = visible;
    return report;
  }
}
