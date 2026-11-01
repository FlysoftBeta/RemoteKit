export interface CaptureTiming { captureWallTimeMs: number; captureMonotonicMs: number; captureClockUncertaintyMs: number; sourceCaptureId: string }
/** Client wall is mapped to Control/Endpoint wall using bounded ping samples. */
export class CaptureLatency {
  private clock?: { offset: number; uncertainty: number; at: number; wall: number };
  private frames = new Map<string, CaptureTiming>();
  private seen = new Set<string>();
  private samples: { ms: number; uncertainty: number; id: string; at: number }[] = [];
  private previous?: CaptureTiming;
  private since = 0;
  // Feedback identity belongs to this object, not to a clock calibration window.
  private sequence = 0;
  reset() { this.clock = undefined; this.frames.clear(); this.samples = []; this.previous = undefined; this.since = 0; }
  calibrate(start: number, startWall: number, end: number, endWall: number, server: number) {
    if (![start, startWall, end, endWall, server].every(Number.isFinite) || end < start || Math.abs(endWall - startWall - (end - start)) > 5) { this.reset(); return; }
    const uncertainty = (end - start) / 2 + 1;
    if (uncertainty > 25) return;
    const offset = server - (startWall + endWall) / 2;
    if (this.clock && Math.abs(offset - this.clock.offset) > uncertainty + this.clock.uncertainty + 5) { this.reset(); return; }
    this.clock = { offset, uncertainty, at: end, wall: endWall };
  }
  record(rtp: number, epoch: string, value: Partial<CaptureTiming>) {
    if (![value.captureWallTimeMs, value.captureMonotonicMs, value.captureClockUncertaintyMs].every(v => typeof v === 'number' && Number.isFinite(v)) || typeof value.sourceCaptureId !== 'string' || !/^\d+$/.test(value.sourceCaptureId) || value.captureClockUncertaintyMs! < 0) return;
    this.frames.set(`${epoch}:${rtp}`, value as CaptureTiming);
    while (this.frames.size > 256) this.frames.delete(this.frames.keys().next().value!);
  }
  paint(rtp: number, epoch: string, now: number, wall: number) {
    const clock = this.clock, frame = this.frames.get(`${epoch}:${rtp}`);
    if (!clock || !frame || this.seen.has(frame.sourceCaptureId)) return;
    if (now - clock.at > 15000 || now < clock.at || Math.abs(wall - clock.wall - (now - clock.at)) > 5) { this.reset(); return; }
    this.seen.add(frame.sourceCaptureId); while (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    const previous = this.previous; if (previous && frame.captureMonotonicMs < previous.captureMonotonicMs) return; this.previous = frame;
    if (previous && Math.abs((frame.captureWallTimeMs - previous.captureWallTimeMs) - (frame.captureMonotonicMs - previous.captureMonotonicMs)) > 5) { this.reset(); return; }
    const uncertainty = clock.uncertainty + frame.captureClockUncertaintyMs;
    const ms = wall + clock.offset - frame.captureWallTimeMs;
    if (uncertainty > 25 || ms < 0 || ms > 10000) return;
    this.samples.push({ ms, uncertainty, id: frame.sourceCaptureId, at: now });
    if (this.samples.length > 2048) this.samples.shift();
    if (!this.since) this.since = now;
  }
  report(now: number, wall: number, visible: boolean) {
    if (!visible) { this.samples = []; this.since = 0; return; }
    if (!this.since || now - this.since < 2000) return;
    const samples = this.samples.splice(0), windowMs = now - this.since; this.since = now;
    if (!samples.length || now - samples[samples.length-1].at > 2500 || !this.clock || now - this.clock.at > 15000 || Math.abs(wall - this.clock.wall - (now - this.clock.at)) > 5) return;
    const sorted = samples.map(s => s.ms).sort((a,b) => a-b);
    return { presentationLatencyMs: sorted[Math.ceil(sorted.length * .95)-1], latencySource: 'capture-end-to-paint' as const, clockUncertaintyMs: Math.max(...samples.map(s => s.uncertainty)), sampleCount: samples.length, windowMs, sequence: ++this.sequence, sourceCaptureId: samples[samples.length-1].id, sampledAtServerMs: wall + this.clock.offset, visible };
  }
}
