type Values = (number | string | null)[];
const limit = 2400;
const push = (list: Values[], values: Values) => { list.push(values); if (list.length > limit) list.shift(); };
const summary = (list: Values[], column: number) => {
  const values = list.map(value => value[column]).filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
  return { samples: values.length, p50: values.length ? values[Math.ceil(values.length * .5) - 1] : null, p95: values.length ? values[Math.ceil(values.length * .95) - 1] : null, max: values.length ? values[values.length - 1] : null };
};
export class PresentationDiagnostics {
  startedAt = performance.now();
  rawRvfcCount = 0; clientRafCount = 0; viewportRafCallbacks = 0;
  matched = 0; missed = 0; unknownAtVideo = 0; wrongEpochAtVideo = 0; missingRtp = 0; metadataCount = 0; lateMetadataForMissed = 0;
  pending: { rtp: number; at: number; epoch: string | undefined } | undefined;
  private observed = new Map<number, { at: number; outcome: 'pending' | 'matched' | 'missed' }>();
  private arrivals = new Map<number, number>();
  private lastRvfcAt: number | undefined; private lastRafAt: number | undefined; private presentedFrames: number | undefined; private decodedFrames: number | undefined;
  private rvfc: Values[] = []; private raf: Values[] = []; private metadata: Values[] = []; private matches: Values[] = []; private misses: Values[] = [];
  private paints: Values[] = [];
  private paintCounts = new Map<string, { frames: number; redraws: number; firstAt: number; lastAt: number }>();
  private costs: Record<string, Values[]> = { videoCallbackTotal: [], frameMessageTotal: [], videoSnapshot: [], viewportDraw: [], markerDraw: [], markerReadback: [], markerDecode: [] };
  video(at: number, rtp: number | undefined, epoch: string | undefined, knownEpoch: string | undefined, info: { presentedFrames?: number; expectedDisplayTime?: number; presentationTime?: number; receiveTime?: number; decoded?: number }) {
    this.rawRvfcCount++; this.presentedFrames = info.presentedFrames; this.decodedFrames = info.decoded;
    if (this.pending && this.pending.rtp !== rtp) { const old = this.observed.get(this.pending.rtp); if (old?.outcome === 'pending') { old.outcome = 'missed'; this.missed++; push(this.misses, [at, this.pending.rtp, at - this.pending.at]); } }
    if (rtp === undefined) { this.missingRtp++; this.pending = undefined; }
    else {
      if (knownEpoch === undefined) this.unknownAtVideo++; else if (knownEpoch !== epoch) this.wrongEpochAtVideo++;
      this.pending = { rtp, at, epoch }; if (this.observed.get(rtp)?.outcome !== 'matched') this.observed.set(rtp, { at, outcome: 'pending' }); if (this.observed.size > 512) this.observed.delete(this.observed.keys().next().value!);
    }
    push(this.rvfc, [at, rtp ?? null, info.presentedFrames ?? null, info.expectedDisplayTime ?? null, info.presentationTime ?? null, info.receiveTime ?? null, info.decoded ?? null, this.lastRvfcAt === undefined ? null : at - this.lastRvfcAt]); this.lastRvfcAt = at;
  }
  frameMetadata(at: number, rtp: number, epoch: string) {
    this.metadataCount++; this.arrivals.set(rtp, at); if (this.arrivals.size > 512) this.arrivals.delete(this.arrivals.keys().next().value!);
    const observation = this.observed.get(rtp); if (observation?.outcome === 'missed') this.lateMetadataForMissed++;
    push(this.metadata, [at, rtp, epoch, observation ? at - observation.at : null]);
  }
  authorize(at: number, rtp: number, epoch: string) {
    const observed = this.observed.get(rtp); if (observed?.outcome === 'matched') return;
    if (observed) observed.outcome = 'matched'; this.matched++;
    push(this.matches, [at, rtp, epoch, observed ? at - observed.at : null, observed && this.arrivals.has(rtp) ? this.arrivals.get(rtp)! - observed.at : null]);
  }
  clientRaf(at: number) { this.viewportRafCallbacks++; if (at !== this.lastRafAt) { this.clientRafCount++; push(this.raf, [at, this.lastRafAt === undefined ? null : at - this.lastRafAt]); this.lastRafAt = at; } }
  paint(at: number, view: string, rtp: number, epoch: string, authorizedAt: number, isNewFrame: boolean) {
    const count = this.paintCounts.get(view) ?? { frames: 0, redraws: 0, firstAt: at, lastAt: at };
    if (isNewFrame) { count.frames++; count.lastAt = at; } else count.redraws++;
    this.paintCounts.set(view, count); push(this.paints, [at, view, rtp, epoch, at - authorizedAt, isNewFrame ? 1 : 0]);
  }
  paintStatistics() {
    const now = performance.now();
    return Object.fromEntries([...this.paintCounts].map(([view, count]) => {
      const recent = this.paints.filter(sample => sample[1] === view && sample[5] === 1 && Number(sample[0]) >= now - 1000);
      const fps = now - count.firstAt >= 1000 ? recent.length : count.frames >= 2 && count.lastAt > count.firstAt ? (count.frames - 1) * 1000 / (count.lastAt - count.firstAt) : undefined;
      return [view, { ...count, fps }];
    }));
  }
  paintFrameCounts() { return new Map([...this.paintCounts].map(([view, count]) => [view, count.frames])); }
  cost(name: keyof PresentationDiagnostics['costs'], at: number, durationMs: number, view: string | null = null) { if (this.costs[name]) push(this.costs[name], [at, durationMs, view]); }
  snapshot(raw = false) {
    const pending = this.pending && this.observed.get(this.pending.rtp)?.outcome === 'pending' ? { ...this.pending, ageMs: performance.now() - this.pending.at } : null;
    return { canvasPaintByView: this.paintStatistics(), authorizeToPaintMs: summary(this.paints, 4), elapsedMs: performance.now() - this.startedAt, rawRvfcCount: this.rawRvfcCount, latestPresentedFrames: this.presentedFrames, latestDecodedFrames: this.decodedFrames, clientRafCount: this.clientRafCount, viewportRafCallbacks: this.viewportRafCallbacks, epoch: { matched: this.matched, pending, missed: this.missed, unknownAtVideo: this.unknownAtVideo, wrongEpochAtVideo: this.wrongEpochAtVideo, missingRtp: this.missingRtp, metadataCount: this.metadataCount, lateMetadataForMissed: this.lateMetadataForMissed }, intervals: { rvfc: summary(this.rvfc, 7), clientRaf: summary(this.raf, 1) }, authorizeWaitMs: summary(this.matches, 3), metadataRelativeToVideoMs: summary(this.matches, 4), lateMetadataRelativeToVideoMs: summary(this.metadata, 3), costsMs: Object.fromEntries(Object.entries(this.costs).map(([name, list]) => [name, summary(list, 1)])), ...(raw ? { raw: { columns: { rvfc: ['at', 'rtp', 'presentedFrames', 'expectedDisplayTime', 'presentationTime', 'receiveTime', 'decodedFrames', 'intervalMs'], raf: ['at', 'intervalMs'], metadata: ['at', 'rtp', 'epoch', 'relativeToVideoMs'], matches: ['at', 'rtp', 'epoch', 'waitMs', 'metadataRelativeToVideoMs'], misses: ['at', 'rtp', 'waitMs'], paints: ['at', 'view', 'rtp', 'epoch', 'authorizeToPaintMs', 'newFrame'], costs: ['at', 'durationMs', 'view'] }, rvfc: this.rvfc, raf: this.raf, metadata: this.metadata, matches: this.matches, misses: this.misses, paints: this.paints, costs: this.costs } } : {}) };
  }
}
