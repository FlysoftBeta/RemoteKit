import { ClockDomain } from './clock-domain';
export interface CaptureTiming {
  captureWallTimeMs: number;
  captureMonotonicMs: number;
  captureClockUncertaintyMs: number;
  sourceCaptureId: string;
}
/** Capture and input timestamps belong exclusively to the current Endpoint. */
export class CaptureLatency {
  readonly endpointClock = new ClockDomain();
  private clockRevision = 0;
  private syncClock() {
    if (this.clockRevision !== this.endpointClock.revision) {
      this.samples = [];
      this.previous = undefined;
      this.since = 0;
      this.clockRevision = this.endpointClock.revision;
    }
  }
  private frames = new Map<string, CaptureTiming>();
  private seen = new Set<string>();
  private samples: { ms: number; uncertainty: number; id: string; at: number }[] = [];
  private previous?: CaptureTiming;
  private since = 0;
  // Feedback identity belongs to this object, not to a clock calibration window.
  private sequence = 0;
  reset() {
    this.endpointClock.reset();
    this.frames.clear();
    this.samples = [];
    this.previous = undefined;
    this.since = 0;
  }
  calibrate(start: number, startWall: number, end: number, endWall: number, endpoint: number, mono?: number) {
    if (!this.endpointClock.calibrate(start, startWall, end, endWall, endpoint, mono)) this.reset();
  }
  /** Conservative server-wall time for a captured input sample. Freeze once per gesture. */
  inputStart(sampleAt: number, now: number, wall: number): number | undefined {
    const clock = this.endpointClock.mapping(now, wall);
    if (
      !clock ||
      ![sampleAt, now, wall].every(Number.isFinite) ||
      sampleAt > now + 1 ||
      now - sampleAt > 5000
    )
      return;
    return Math.floor((clock.wall - (now - sampleAt) - clock.uncertainty) * 1000);
  }
  record(rtp: number, epoch: string, value: Partial<CaptureTiming>) {
    if (
      ![value.captureWallTimeMs, value.captureMonotonicMs, value.captureClockUncertaintyMs].every(
        (v) => typeof v === 'number' && Number.isFinite(v),
      ) ||
      typeof value.sourceCaptureId !== 'string' ||
      !/^\d+$/.test(value.sourceCaptureId) ||
      value.captureClockUncertaintyMs! < 0
    )
      return;
    this.frames.set(`${epoch}:${rtp}`, value as CaptureTiming);
    while (this.frames.size > 256) this.frames.delete(this.frames.keys().next().value!);
  }
  paint(rtp: number, epoch: string, now: number, wall: number) {
    const clock = this.endpointClock.mapping(now, wall, true),
      frame = this.frames.get(`${epoch}:${rtp}`);
    this.syncClock();
    if (!clock || !frame || this.seen.has(frame.sourceCaptureId)) return;
    if (
      !this.endpointClock.remoteConsistent(
        frame.captureWallTimeMs,
        frame.captureMonotonicMs,
        frame.captureClockUncertaintyMs,
      )
    ) {
      this.reset();
      return;
    }
    this.seen.add(frame.sourceCaptureId);
    while (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    const previous = this.previous;
    if (previous && frame.captureMonotonicMs < previous.captureMonotonicMs) return;
    this.previous = frame;
    if (
      previous &&
      Math.abs(
        frame.captureWallTimeMs -
          previous.captureWallTimeMs -
          (frame.captureMonotonicMs - previous.captureMonotonicMs),
      ) > 5
    ) {
      this.reset();
      return;
    }
    const uncertainty = clock.uncertainty + frame.captureClockUncertaintyMs;
    const ms = clock.wall - frame.captureWallTimeMs;
    if (uncertainty > 25 || ms < 0 || ms > 10000) return;
    this.samples.push({ ms, uncertainty, id: frame.sourceCaptureId, at: now });
    if (this.samples.length > 2048) this.samples.shift();
    if (!this.since) this.since = now;
  }
  report(now: number, wall: number, visible: boolean, controlClock?: ClockDomain) {
    this.syncClock();
    if (!visible) {
      this.samples = [];
      this.since = 0;
      return;
    }
    if (!this.since || now - this.since < 2000) return;
    const samples = this.samples.splice(0),
      windowMs = now - this.since;
    this.since = now;
    const control = controlClock?.mapping(now, wall);
    if (
      !samples.length ||
      now - samples[samples.length - 1].at > 2500 ||
      !this.endpointClock.mapping(now, wall) ||
      !control
    )
      return;
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    return {
      presentationLatencyMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
      latencySource: 'capture-end-to-paint' as const,
      clockUncertaintyMs: Math.max(...samples.map((s) => s.uncertainty)),
      sampleCount: samples.length,
      windowMs,
      sequence: ++this.sequence,
      sourceCaptureId: samples[samples.length - 1].id,
      sampledAtControlMs: control.wall,
      sampledAtServerMs: control.wall,
      visible,
    };
  }
}
