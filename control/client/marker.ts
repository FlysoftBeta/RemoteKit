import { decodeMarker, MARKER_WIDTH, MARKER_HEIGHT, percentiles } from '../public/marker-codec.js';
import type { Surface, VideoPresentation } from './types';
import { markerSourceRect } from './coordinates';
import { MarkerSchedule } from './marker-schedule';
import type { PresentedPlaneSource } from './plane-source';
export interface MarkerSample { observedAt: number; sampledAt: number; processedAt: number; paintToReadMs: number; processingMs: number; rtpTimestamp?: number; layoutEpoch?: string; frameId: number; stimulus: number; renderToObservedMs?: number; inputToObservedMs?: number }
export class MarkerMeasurement {
  private canvas = document.createElement('canvas');
  private samples: MarkerSample[] = [];
  private started = performance.now();
  private seenFrame?: number;
  private decodedFrames?: number;
  private invalid = 0;
  private skipped = 0;
  private inputs = new Map<number, number>();
  private running = false;
  private callback?: number;
  private raf?: number;
  private unsubscribe?: () => void;
  private schedule: MarkerSchedule;
  private paintCount = 0; private firstPaint?: number; private lastPaint?: number;
  private readCount = 0; private firstRead?: number; private lastRead?: number;
  constructor(private video: HTMLVideoElement, private surface: () => Surface | undefined, private options: { sameMachineClock: boolean; sampleHz?: number; parameters: Record<string, unknown>; decodedFrames?: () => number | undefined; planeSource?: (frame?: VideoPresentation) => PresentedPlaneSource | undefined; subscribeFrame?: (listener: (frame: VideoPresentation) => void) => () => void; recordCost?: (name: string, at: number, durationMs: number) => void }) { this.canvas.width = MARKER_WIDTH; this.canvas.height = MARKER_HEIGHT; this.schedule = new MarkerSchedule(options.sampleHz ?? 10); }
  start() {
    if (this.running) return; this.running = true;
    if (this.options.subscribeFrame) { this.unsubscribe = this.options.subscribeFrame(frame => this.read(true, frame)); return; }
    const video = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
    const tick = () => { if (!this.running) return; this.read(!!video.requestVideoFrameCallback); if (video.requestVideoFrameCallback) this.callback = video.requestVideoFrameCallback(tick); else this.raf = requestAnimationFrame(tick); };
    if (video.requestVideoFrameCallback) this.callback = video.requestVideoFrameCallback(tick); else this.raf = requestAnimationFrame(tick);
  }
  input(sequence: number) { this.inputs.set(sequence & 65535, performance.now()); }
  private read(frameCallback: boolean, frame?: VideoPresentation) {
    const video = this.video as HTMLVideoElement & { webkitDecodedFrameCount?: number };
    if (!frameCallback) { const count = video.webkitDecodedFrameCount ?? this.options.decodedFrames?.(); if (count === undefined || count === this.decodedFrames) return; this.decodedFrames = count; }
    const surface = this.surface(); if (!surface || !this.options.planeSource && video.readyState < 2) return;
    const plane = this.options.planeSource?.(frame);
    if (this.options.planeSource && (!plane || !frame || plane.rtpTimestamp !== frame.rtpTimestamp || plane.layoutEpoch !== frame.layoutEpoch || plane.viewId !== frame.viewId)) return;
    const source = plane?.image ?? video;
    const sampledAt = performance.now(), observedAt = frame?.paintedAt ?? sampledAt, observedWallTime = frame?.paintedWallTime ?? Date.now();
    this.paintCount++; this.firstPaint ??= observedAt; this.lastPaint = observedAt;
    // Inspect the first presented response while an input stimulus is pending.
    const scheduled = this.schedule.accept(observedAt);
    if (!scheduled && this.inputs.size === 0) return;
    this.readCount++; this.firstRead ??= observedAt; this.lastRead = observedAt;
    const context = this.canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings)!;
    try {
      const region = plane ? { x: plane.sourceRect.x, y: plane.sourceRect.y, width: MARKER_WIDTH * plane.pixelsPerDip, height: MARKER_HEIGHT * (plane.pixelsPerDipY ?? plane.pixelsPerDip) } : markerSourceRect(surface, MARKER_WIDTH, MARKER_HEIGHT);
      let started = performance.now();
      context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, MARKER_WIDTH, MARKER_HEIGHT);
      this.options.recordCost?.('markerDraw', started, performance.now() - started); started = performance.now();
      const pixels = context.getImageData(0, 0, MARKER_WIDTH, MARKER_HEIGHT);
      this.options.recordCost?.('markerReadback', started, performance.now() - started); started = performance.now();
      const marker = decodeMarker(pixels);
      this.options.recordCost?.('markerDecode', started, performance.now() - started);
      if (!marker) { this.invalid++; return; }
      if (marker.frameId === this.seenFrame) return;
      if (this.seenFrame !== undefined) { const delta = (marker.frameId - this.seenFrame) >>> 0; if (delta > 0 && delta < 100000) this.skipped += delta - 1; }
      this.seenFrame = marker.frameId;
      const processedAt = performance.now(); const sample: MarkerSample = { observedAt, sampledAt, processedAt, paintToReadMs: sampledAt - observedAt, processingMs: processedAt - sampledAt, rtpTimestamp: frame?.rtpTimestamp, layoutEpoch: frame?.layoutEpoch, frameId: marker.frameId, stimulus: marker.stimulus };
      if (this.options.sameMachineClock) { const delta = ((observedWallTime >>> 0) - marker.timestamp) >>> 0; if (delta < 60000) sample.renderToObservedMs = delta; }
      const sent = this.inputs.get(marker.stimulus); if (sent !== undefined) { sample.inputToObservedMs = observedAt - sent; this.inputs.delete(marker.stimulus); }
      this.samples.push(sample);
      if (this.samples.length >= 2000) this.stop();
    } catch { this.invalid++; }
  }
  stop() { this.running = false; this.unsubscribe?.(); this.unsubscribe = undefined; if (this.raf !== undefined) cancelAnimationFrame(this.raf); const video = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void }; if (this.callback !== undefined) video.cancelVideoFrameCallback?.(this.callback); }
  report() {
    const elapsedMs = performance.now() - this.started;
    const render = this.samples.flatMap(sample => sample.renderToObservedMs === undefined ? [] : [sample.renderToObservedMs]);
    const input = this.samples.flatMap(sample => sample.inputToObservedMs === undefined ? [] : [sample.inputToObservedMs]);
    const paintSpan = (this.lastPaint ?? 0) - (this.firstPaint ?? 0), readSpan = (this.lastRead ?? 0) - (this.firstRead ?? 0);
    return { kind: 'received-video-marker', parameters: this.options.parameters, presentationClock: this.options.subscribeFrame ? 'selected-video-compositor-observation' : 'raw-video-callback', clock: this.options.sameMachineClock ? 'same-machine-wall-clock' : 'client-stimulus-only', elapsedMs, displayFps: paintSpan > 0 ? (this.paintCount - 1) * 1000 / paintSpan : null, paintCount: this.paintCount, markerTargetHz: this.schedule.hz, markerSampleHz: readSpan > 0 ? (this.readCount - 1) * 1000 / readSpan : null, markerReadCount: this.readCount, inputSampling: 'every-presented-frame-while-stimulus-pending', invalid: this.invalid, frameGapsIncludeSubsampling: true, skippedMarkerFrames: this.skipped, pendingStimuli: this.inputs.size, renderToObservedMs: percentiles(render), inputToObservedMs: percentiles(input), samples: this.samples };
  }
}
