type Values = (number | string | null)[];
const limit = 2400;
const push = (list: Values[], values: Values) => {
  list.push(values);
  if (list.length > limit) list.shift();
};
const summary = (list: Values[], column: number) => {
  const values = list
    .map((value) => value[column])
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  return {
    samples: values.length,
    p50: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
    p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
    max: values.length ? values[values.length - 1] : null,
  };
};
export class PresentationDiagnostics {
  startedAt = performance.now();
  rawRvfcCount = 0;
  clientRafCount = 0;
  viewportRafCallbacks = 0;
  matched = 0;
  missed = 0;
  unknownAtVideo = 0;
  wrongEpochAtVideo = 0;
  missingRtp = 0;
  metadataCount = 0;
  lateMetadataForMissed = 0;
  pending: { rtp: number; at: number; epoch: string | undefined } | undefined;
  private observed = new Map<number, { at: number; outcome: 'pending' | 'matched' | 'missed' }>();
  private arrivals = new Map<number, number>();
  private lastRvfcAt: number | undefined;
  private lastRafAt: number | undefined;
  private presentedFrames: number | undefined;
  private decodedFrames: number | undefined;
  private rvfc: Values[] = [];
  private raf: Values[] = [];
  private metadata: Values[] = [];
  private matches: Values[] = [];
  private misses: Values[] = [];
  private costs: Record<string, Values[]> = {
    videoCallbackTotal: [],
    frameMessageTotal: [],
    markerDraw: [],
    markerReadback: [],
    markerDecode: [],
  };
  video(
    at: number,
    rtp: number | undefined,
    epoch: string | undefined,
    knownEpoch: string | undefined,
    info: {
      presentedFrames?: number;
      expectedDisplayTime?: number;
      presentationTime?: number;
      receiveTime?: number;
      decoded?: number;
      processingDuration?: number;
    },
    view: string | null = null,
  ) {
    this.rawRvfcCount++;
    this.presentedFrames = info.presentedFrames;
    this.decodedFrames = info.decoded;
    if (this.pending && this.pending.rtp !== rtp) {
      const old = this.observed.get(this.pending.rtp);
      if (old?.outcome === 'pending') {
        old.outcome = 'missed';
        this.missed++;
        push(this.misses, [at, this.pending.rtp, at - this.pending.at]);
      }
    }
    if (rtp === undefined) {
      this.missingRtp++;
      this.pending = undefined;
    } else {
      if (knownEpoch === undefined) this.unknownAtVideo++;
      else if (knownEpoch !== epoch) this.wrongEpochAtVideo++;
      this.pending = { rtp, at, epoch };
      if (this.observed.get(rtp)?.outcome !== 'matched') this.observed.set(rtp, { at, outcome: 'pending' });
      if (this.observed.size > 512) this.observed.delete(this.observed.keys().next().value!);
    }
    push(this.rvfc, [
      at,
      rtp ?? null,
      info.presentedFrames ?? null,
      info.expectedDisplayTime ?? null,
      info.presentationTime ?? null,
      info.receiveTime ?? null,
      info.decoded ?? null,
      this.lastRvfcAt === undefined ? null : at - this.lastRvfcAt,
      view,
      info.processingDuration ?? null,
    ]);
    this.lastRvfcAt = at;
  }
  frameMetadata(at: number, rtp: number, epoch: string) {
    this.metadataCount++;
    this.arrivals.set(rtp, at);
    if (this.arrivals.size > 512) this.arrivals.delete(this.arrivals.keys().next().value!);
    const observation = this.observed.get(rtp);
    if (observation?.outcome === 'missed') this.lateMetadataForMissed++;
    push(this.metadata, [at, rtp, epoch, observation ? at - observation.at : null]);
  }
  authorize(at: number, rtp: number, epoch: string) {
    const observed = this.observed.get(rtp);
    if (observed?.outcome === 'matched') return;
    if (observed) observed.outcome = 'matched';
    this.matched++;
    push(this.matches, [
      at,
      rtp,
      epoch,
      observed ? at - observed.at : null,
      observed && this.arrivals.has(rtp) ? this.arrivals.get(rtp)! - observed.at : null,
    ]);
  }
  clientRaf(at: number) {
    this.viewportRafCallbacks++;
    if (at !== this.lastRafAt) {
      this.clientRafCount++;
      push(this.raf, [at, this.lastRafAt === undefined ? null : at - this.lastRafAt]);
      this.lastRafAt = at;
    }
  }
  cost(
    name: keyof PresentationDiagnostics['costs'],
    at: number,
    durationMs: number,
    view: string | null = null,
  ) {
    if (this.costs[name]) push(this.costs[name], [at, durationMs, view]);
  }
  recentVideo(sinceMs: number) {
    const number = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    return this.rvfc
      .slice(-32)
      .flatMap(
        ([
          at,
          rtp,
          presentedFrames,
          expectedDisplayTime,
          presentationTime,
          receiveTime,
          ,
          ,
          ,
          processingDuration,
        ]) => {
          const atMs = number(at);
          if (atMs === undefined || atMs < sinceMs) return [];
          return [
            {
              atMs,
              rtpTimestamp: number(rtp),
              presentedFrames: number(presentedFrames),
              expectedDisplayTimeMs: number(expectedDisplayTime),
              presentationTimeMs: number(presentationTime),
              receiveTimeMs: number(receiveTime),
              processingDurationSeconds: number(processingDuration),
            },
          ];
        },
      );
  }
  snapshot(raw = false) {
    const pending =
      this.pending && this.observed.get(this.pending.rtp)?.outcome === 'pending'
        ? { ...this.pending, ageMs: performance.now() - this.pending.at }
        : null;
    return {
      elapsedMs: performance.now() - this.startedAt,
      rawRvfcCount: this.rawRvfcCount,
      latestPresentedFrames: this.presentedFrames,
      latestDecodedFrames: this.decodedFrames,
      clientRafCount: this.clientRafCount,
      viewportRafCallbacks: this.viewportRafCallbacks,
      epoch: {
        matched: this.matched,
        pending,
        missed: this.missed,
        unknownAtVideo: this.unknownAtVideo,
        wrongEpochAtVideo: this.wrongEpochAtVideo,
        missingRtp: this.missingRtp,
        metadataCount: this.metadataCount,
        lateMetadataForMissed: this.lateMetadataForMissed,
      },
      intervals: { rvfc: summary(this.rvfc, 7), clientRaf: summary(this.raf, 1) },
      authorizeWaitMs: summary(this.matches, 3),
      metadataRelativeToVideoMs: summary(this.matches, 4),
      lateMetadataRelativeToVideoMs: summary(this.metadata, 3),
      costsMs: Object.fromEntries(Object.entries(this.costs).map(([name, list]) => [name, summary(list, 1)])),
      ...(raw
        ? {
            raw: {
              columns: {
                rvfc: [
                  'at',
                  'rtp',
                  'presentedFrames',
                  'expectedDisplayTime',
                  'presentationTime',
                  'receiveTime',
                  'decodedFrames',
                  'intervalMs',
                  'view',
                  'processingDurationSeconds',
                ],
                raf: ['at', 'intervalMs'],
                metadata: ['at', 'rtp', 'epoch', 'relativeToVideoMs'],
                matches: ['at', 'rtp', 'epoch', 'waitMs', 'metadataRelativeToVideoMs'],
                misses: ['at', 'rtp', 'waitMs'],
                costs: ['at', 'durationMs', 'view'],
              },
              rvfc: this.rvfc,
              raf: this.raf,
              metadata: this.metadata,
              matches: this.matches,
              misses: this.misses,
              costs: this.costs,
            },
          }
        : {}),
    };
  }
}
