import type { Diagnostics, VideoPlaneTiming } from './types';

const counterNames = [
  'bytesReceived',
  'jitterBufferEmittedCount',
  'jitterBufferDelay',
  'jitterBufferTargetDelay',
  'jitterBufferMinimumDelay',
  'framesDecoded',
  'totalDecodeTime',
  'totalProcessingDelay',
  'totalAssemblyTime',
  'framesAssembledFromMultiplePackets',
  'framesDropped',
  'packetsLost',
  'packetsReceived',
  'retransmittedPacketsReceived',
  'retransmittedBytesReceived',
  'nackCount',
  'pliCount',
] as const;

export interface InboundMediaStats extends RTCStats, Partial<Record<(typeof counterNames)[number], number>> {
  jitter?: number;
  decoderImplementation?: string;
  powerEfficientDecoder?: boolean;
}

export interface ReceiverBufferTiming {
  windowMs?: number;
  jitterBufferEmitted?: number;
  jitterBufferMeanMs?: number;
  jitterBufferTargetMeanMs?: number;
  jitterBufferMinimumMeanMs?: number;
}

export interface ReceiverVideoTiming extends ReceiverBufferTiming {
  decodeMeanMs?: number;
  processingMeanMs?: number;
  assemblyMeanMs?: number;
  multiPacketFrames?: number;
  packetJitterMs?: number;
  lostPackets?: number;
  receivedPackets?: number;
  receivedBytes?: number;
  retransmittedPackets?: number;
  retransmittedBytes?: number;
  receivedPacketRetransmitRatio?: number;
  receivedByteRetransmitRatio?: number;
  nackCount?: number;
  pliCount?: number;
  decoderImplementation?: string;
  powerEfficientDecoder?: boolean;
  droppedFrames?: number;
}

const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const meanMs = (seconds?: number, count?: number) =>
  seconds !== undefined && count && count > 0 ? (seconds * 1000) / count : undefined;
const retransmitRatio = (retransmitted?: number, total?: number) =>
  retransmitted !== undefined && total !== undefined && total > 0 && retransmitted <= total
    ? retransmitted / total
    : undefined;
const decoderLabel = (value: unknown) =>
  typeof value === 'string' && /^[a-z\d_ .()+,-]{1,100}$/i.test(value) ? value : undefined;

/** The report ID and timestamp are used only for counter continuity. */
export class InboundMediaSampler {
  private previous?: InboundMediaStats;

  reset() {
    this.previous = undefined;
  }

  sample(report: InboundMediaStats) {
    const previous = this.previous;
    if (previous?.id !== report.id || report.timestamp >= previous.timestamp) this.previous = report;
    const windowMs =
      previous?.id === report.id && report.timestamp > previous.timestamp
        ? finite(report.timestamp - previous.timestamp)
        : undefined;
    const delta = (name: (typeof counterNames)[number], signed = false) => {
      const before = finite(previous?.[name]),
        after = finite(report[name]);
      return windowMs && before !== undefined && after !== undefined && (signed || after >= before)
        ? after - before
        : undefined;
    };
    const jitterBufferEmitted = delta('jitterBufferEmittedCount');
    const buffer: ReceiverBufferTiming = {
      windowMs,
      jitterBufferEmitted,
      jitterBufferMeanMs: meanMs(delta('jitterBufferDelay'), jitterBufferEmitted),
      jitterBufferTargetMeanMs: meanMs(delta('jitterBufferTargetDelay'), jitterBufferEmitted),
      jitterBufferMinimumMeanMs: meanMs(delta('jitterBufferMinimumDelay'), jitterBufferEmitted),
    };
    const decoded = delta('framesDecoded'),
      bytes = delta('bytesReceived');
    const receivedPackets = delta('packetsReceived');
    const retransmittedPackets = delta('retransmittedPacketsReceived'),
      retransmittedBytes = delta('retransmittedBytesReceived');
    const multiPacketFrames = delta('framesAssembledFromMultiplePackets');
    const jitter = finite(report.jitter);
    const video: ReceiverVideoTiming = {
      ...buffer,
      decodeMeanMs: meanMs(delta('totalDecodeTime'), decoded),
      processingMeanMs: meanMs(delta('totalProcessingDelay'), decoded),
      assemblyMeanMs: meanMs(delta('totalAssemblyTime'), multiPacketFrames),
      multiPacketFrames,
      packetJitterMs: jitter === undefined ? undefined : jitter * 1000,
      // Late packets can reduce the cumulative signed RTP loss estimate.
      lostPackets: delta('packetsLost', true),
      receivedPackets,
      receivedBytes: bytes,
      retransmittedPackets,
      retransmittedBytes,
      receivedPacketRetransmitRatio: retransmitRatio(retransmittedPackets, receivedPackets),
      receivedByteRetransmitRatio: retransmitRatio(retransmittedBytes, bytes),
      nackCount: delta('nackCount'),
      pliCount: delta('pliCount'),
      decoderImplementation: decoderLabel(report.decoderImplementation),
      powerEfficientDecoder:
        typeof report.powerEfficientDecoder === 'boolean' ? report.powerEfficientDecoder : undefined,
      droppedFrames: delta('framesDropped'),
    };
    return {
      buffer,
      video,
      decodedFps: decoded !== undefined && windowMs ? (decoded * 1000) / windowMs : undefined,
      bitrateBps: bytes !== undefined && windowMs ? (bytes * 8000) / windowMs : undefined,
    };
  }
}

function playoutHint(hint: Diagnostics['receiverPlayout']) {
  const video = hint?.video,
    audio = hint?.audio;
  return {
    videoTargetMs: finite(video?.jitterBufferTarget),
    videoLegacyHintSeconds: finite(video?.playoutDelayHint),
    audioTargetMs: finite(audio?.jitterBufferTarget),
    audioLegacyHintSeconds: finite(audio?.playoutDelayHint),
  };
}

function planeSample(timing: VideoPlaneTiming | undefined, compositorFps?: number) {
  if (!timing) return;
  const percentile = (value?: { samples: number; p95: number }) =>
    value && { samples: value.samples, p95: value.p95 };
  return {
    compositorFps,
    callbackFps: timing.callbackFps,
    elementFps: timing.videoElementFps,
    elementDrops: timing.videoElementDrops,
    receiveToSubmit: percentile(timing.receiveToSubmit),
    submitToCallback: percentile(timing.submitToCallback),
    expectedDisplayLateness: percentile(timing.expectedDisplayLateness),
    processing: percentile(timing.processing),
  };
}

function bufferSample(timing: ReceiverBufferTiming) {
  return {
    windowMs: timing.windowMs,
    jitterBufferEmitted: timing.jitterBufferEmitted,
    jitterBufferMeanMs: timing.jitterBufferMeanMs,
    jitterBufferTargetMeanMs: timing.jitterBufferTargetMeanMs,
    jitterBufferMinimumMeanMs: timing.jitterBufferMinimumMeanMs,
  };
}

const senderCounterNames = [
  'packetsSent',
  'totalPacketSendDelay',
  'bytesSent',
  'retransmittedPacketsSent',
  'retransmittedBytesSent',
  'framesSent',
  'framesEncoded',
  'keyFramesEncoded',
  'nackCount',
  'pliCount',
] as const;
type SenderCounters = Partial<Record<(typeof senderCounterNames)[number], number>>;
type SenderVideoSample = SenderCounters & {
  stream?: number;
  windowMs?: number;
  packetRetransmitRatio?: number;
  packetSendMeanMs?: number;
};

function senderCounters(row: Record<string, unknown>): SenderCounters {
  const counters: SenderCounters = {};
  for (const name of senderCounterNames) {
    const value = finite(row[name]);
    if (value !== undefined && value >= 0) counters[name] = value;
  }
  return counters;
}

function compSample(endpoint: Diagnostics['endpoint']) {
  if (!endpoint) return;
  const comp = endpoint.comp as Record<string, unknown> | undefined;
  return {
    presentationRefreshAttempts: finite(comp?.presentationRefreshAttempts),
    presentationRefreshSuccesses: finite(comp?.presentationRefreshSuccesses),
    presentationRefreshForcedBegins: finite(comp?.presentationRefreshForcedBegins),
    adaptDrops: finite(comp?.adaptDrops),
    queueFullDrops: finite(endpoint.queueFullDrops),
    pausedDrops: finite(endpoint.pausedDrops),
    errorDrops: finite(endpoint.errorDrops),
    inactiveDrops: finite(endpoint.inactiveDrops),
    cancelledDrops: finite(endpoint.cancelledDrops),
  };
}

function diagnosticSample(diagnostics: Diagnostics, selectedViewId?: string) {
  const endpoint = diagnostics.endpoint;
  const video = diagnostics.receiverVideoTiming,
    audio = diagnostics.receiverAudioTiming;
  const requested = endpoint?.rtcPlayoutDelayRequested as { minMs?: unknown; maxMs?: unknown } | undefined;
  const selectedPair = (
    endpoint?.senderRtcStats as { selectedPair?: { availableOutgoingBitrate?: unknown } } | undefined
  )?.selectedPair;
  const rtt = finite(diagnostics.roundTripTime);
  return {
    video: video && {
      ...bufferSample(video),
      decodeMeanMs: video.decodeMeanMs,
      processingMeanMs: video.processingMeanMs,
      assemblyMeanMs: video.assemblyMeanMs,
      multiPacketFrames: video.multiPacketFrames,
      packetJitterMs: video.packetJitterMs,
      lostPackets: video.lostPackets,
      retransmittedPackets: video.retransmittedPackets,
      receivedPackets: video.receivedPackets,
      receivedBytes: video.receivedBytes,
      retransmittedBytes: video.retransmittedBytes,
      receivedPacketRetransmitRatio: video.receivedPacketRetransmitRatio,
      receivedByteRetransmitRatio: video.receivedByteRetransmitRatio,
      nackCount: video.nackCount,
      pliCount: video.pliCount,
      droppedFrames: video.droppedFrames,
      decoderImplementation: decoderLabel(video.decoderImplementation),
      powerEfficientDecoder: video.powerEfficientDecoder,
    },
    audio: audio && bufferSample(audio),
    playout: {
      ...playoutHint(diagnostics.receiverPlayout),
      rtpExtensionNegotiated: diagnostics.receiverVideoPlayoutExtensionNegotiated,
      senderRequestedMinMs: finite(requested?.minMs),
      senderRequestedMaxMs: finite(requested?.maxMs),
    },
    media: {
      decodedFps: diagnostics.decodedFramesPerSecond,
      receiveBitrateBps: diagnostics.receiveBitrateBps,
      rttMs: rtt === undefined ? undefined : rtt * 1000,
      width: diagnostics.videoWidth,
      height: diagnostics.videoHeight,
      sourceAtlasWidth: finite(endpoint?.sourceAtlasWidth),
      sourceAtlasHeight: finite(endpoint?.sourceAtlasHeight),
      gccTargetFps: finite(endpoint?.gccTargetFps),
      gccTargetBitrate: finite(endpoint?.gccTargetBitrate),
      lastEncodeMs: finite(endpoint?.lastEncodeMs),
      availableOutgoingBitrate: finite(selectedPair?.availableOutgoingBitrate),
      feedbackDisplayHzEstimate: finite(endpoint?.feedbackDisplayHzEstimate),
      feedbackAgeMs: finite(endpoint?.feedbackAgeMs),
      sourceFrameIntervalMs: finite(endpoint?.sourceFrameIntervalMs),
    },
    comp: compSample(endpoint),
    presentation:
      selectedViewId === undefined
        ? undefined
        : planeSample(
            diagnostics.videoTimingByView?.[selectedViewId],
            diagnostics.paintFpsByView?.[selectedViewId],
          ),
  };
}

/** Retain only projected media measurements. Time is local to the first exported poll. */
export class MediaDiagnosticsHistory {
  private samples: {
    at: number;
    sample: ReturnType<typeof diagnosticSample>;
    sender: ReturnType<MediaDiagnosticsHistory['sampleSender']>;
  }[] = [];
  private senderBaseline?: number;
  private waitForFreshSender = false;
  private previousSenderTime?: number;
  private nextStream = 0;
  private senderStreams = new Map<string, SenderVideoSample>();

  clear() {
    this.samples = [];
    this.senderBaseline = undefined;
    // A new Endpoint stats message can still carry its last cached RTC report.
    // Require a new sender report before retaining counters for the new scope.
    this.waitForFreshSender = true;
    this.previousSenderTime = undefined;
    this.nextStream = 0;
    this.senderStreams.clear();
  }

  private sampleSender(endpoint: Diagnostics['endpoint']) {
    const report = endpoint?.senderRtcStats as { sampleTimeUs?: unknown; outbound?: unknown } | undefined;
    const sampleTimeUs = finite(report?.sampleTimeUs);
    if (sampleTimeUs === undefined || !Array.isArray(report?.outbound)) return;
    if (this.waitForFreshSender) {
      this.senderBaseline ??= sampleTimeUs;
      if (sampleTimeUs <= this.senderBaseline) return;
      this.waitForFreshSender = false;
    }
    const streams = new Map<string, SenderVideoSample>();
    const outbound: SenderVideoSample[] = [];
    const previousTime = this.previousSenderTime ?? sampleTimeUs;
    for (const row of report.outbound.slice(0, 4)) {
      if (!row || typeof row !== 'object' || row.kind !== 'video') continue;
      const counters = senderCounters(row);
      if (typeof row.id !== 'string') {
        outbound.push(counters);
        continue;
      }
      const previous = this.senderStreams.get(row.id);
      const reset =
        sampleTimeUs < previousTime ||
        senderCounterNames.some((name) => (counters[name] ?? Infinity) < (previous?.[name] ?? 0));
      const stream = reset || !previous ? ++this.nextStream : previous.stream;
      const sample = { ...counters, stream };
      streams.set(row.id, sample);
      if (!previous || reset || sampleTimeUs <= previousTime) {
        outbound.push(sample);
        continue;
      }
      const delta = (name: (typeof senderCounterNames)[number]) => {
        const current = counters[name],
          before = previous[name];
        return current === undefined || before === undefined ? undefined : current - before;
      };
      const packets = delta('packetsSent');
      outbound.push({
        ...sample,
        windowMs: (sampleTimeUs - previousTime) / 1000,
        packetRetransmitRatio: retransmitRatio(delta('retransmittedPacketsSent'), packets),
        packetSendMeanMs: meanMs(delta('totalPacketSendDelay'), packets),
      });
    }
    this.previousSenderTime = sampleTimeUs;
    this.senderStreams = streams;
    // The WebRTC timestamp belongs to Endpoint. Use it only for sender-to-sender deltas.
    return { sampleTimeUs, clock: 'endpoint-webrtc-report' as const, outbound };
  }

  record(at: number, diagnostics: Diagnostics, selectedViewId?: string) {
    this.samples.push({
      at,
      sample: diagnosticSample(diagnostics, selectedViewId),
      sender: this.sampleSender(diagnostics.endpoint),
    });
    if (this.samples.length > 30) this.samples.shift();
  }

  export(userAgent: string) {
    const origin = this.samples[0]?.at ?? 0;
    return {
      schema: 1 as const,
      userAgent,
      samples: this.samples.map(({ at, sample, sender }) => ({ elapsedMs: at - origin, ...sample, sender })),
    };
  }

  latest() {
    const latest = this.samples[this.samples.length - 1];
    return latest && { statsAtMs: latest.at, ...latest.sample, sender: latest.sender };
  }
}

const rtcInboundFields = [
  ...counterNames,
  'timestamp',
  'framesReceived',
  'keyFramesDecoded',
  'frameWidth',
  'frameHeight',
  'framesPerSecond',
  'jitter',
  'firCount',
  'qpSum',
  'headerBytesReceived',
  'lastPacketReceivedTimestamp',
  'totalInterFrameDelay',
  'totalSquaredInterFrameDelay',
  'freezeCount',
  'totalFreezesDuration',
  'pauseCount',
  'totalPausesDuration',
  'jitterBufferFlushes',
  'packetsDiscarded',
  'fecPacketsReceived',
  'fecPacketsDiscarded',
  'concealedSamples',
  'silentConcealedSamples',
  'concealmentEvents',
  'insertedSamplesForDeceleration',
  'removedSamplesForAcceleration',
  'totalSamplesReceived',
  'totalSamplesDuration',
] as const;
const rtcPairFields = [
  'timestamp',
  'currentRoundTripTime',
  'totalRoundTripTime',
  'availableIncomingBitrate',
  'availableOutgoingBitrate',
  'packetsSent',
  'packetsReceived',
  'bytesSent',
  'bytesReceived',
  'packetsDiscardedOnSend',
  'bytesDiscardedOnSend',
  'requestsSent',
  'responsesReceived',
  'consentRequestsSent',
] as const;
const endpointFields = [
  'encodeSubmitted',
  'encodeCompleted',
  'encodeDropped',
  'encodePending',
  'encodeInflight',
  'encodedBytes',
  'queueFullDrops',
  'hardwareBusy',
  'pausedDrops',
  'errorDrops',
  'inactiveDrops',
  'cancelledDrops',
  'queueWaitUs',
  'queueWaitSamples',
  'rateUpdates',
  'keyframeRequests',
  'keyframesSubmitted',
  'keyframesEncoded',
  'lastEncodeMs',
  'gccTargetBitrate',
  'gccTargetFps',
  'requestedTargetUsage',
  'appliedTargetUsage',
  'appliedBitrate',
  'appliedMaxBitrate',
  'appliedFps',
  'actualLevel',
  'sourceWidth',
  'sourceHeight',
  'encodedWidth',
  'encodedHeight',
  'sourceAtlasWidth',
  'sourceAtlasHeight',
  'negotiatedReceiveLevel',
  'samplingFpsBudget',
  'mediaScaleX',
  'mediaScaleY',
  'configuredIdleIdrMs',
  'effectiveIdleIdrMs',
  'tailIdrSubmissions',
  'tailIdrCompletions',
  'lastTailAfterSourceMs',
  'sourceFrameIntervalMs',
  'atlasAllocationAlignment',
  'atlasSharedBorrows',
  'atlasSharedHeldSlots',
  'feedbackDisplayHzEstimate',
  'feedbackAgeMs',
  'feedbackRafSamples',
] as const;
const compFields = [
  'idleEntries',
  'wakes',
  'begins',
  'rejectIdle',
  'rejectNotReady',
  'rejectStopped',
  'readyObserved',
  'consumedCompleted',
  'stopSent',
  'stopConfirmed',
  'activeDepth',
  'occupied',
  'retiredOccupied',
  'peakOccupied',
  'retiredGenerations',
  'retiredGenerationsCompleted',
  'unknownGpuRetainedGenerations',
  'unknownGpuRetentions',
  'targetFps',
  'resumeMaxFps',
  'officialMaxFps',
  'codecMaxFps',
  'adaptRequests',
  'adaptDrops',
  'adaptErrors',
  'adaptSizeChanges',
  'presentationRefreshAttempts',
  'presentationRefreshForcedBegins',
  'presentationRefreshSuccesses',
] as const;

export const diagnosticLabel = <T extends string>(value: unknown, labels: readonly T[]) =>
  typeof value === 'string' ? labels.find((label) => label === value) : undefined;

export const diagnosticSequence = (value: unknown) =>
  typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : undefined;

const diagnosticBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
const externalDecoderNames = [
  'Unknown',
  'Unknown Video Decoder',
  'FFmpegVideoDecoder',
  'VpxVideoDecoder',
  'AomVideoDecoder',
  'MojoVideoDecoder',
  'Dav1dVideoDecoder',
  'MediaCodec',
  'MediaCodecVideoDecoder',
  'D3D11VideoDecoder',
  'VaapiVideoDecoder',
  'VideoDecoderBroker',
  'VDAVideoDecoder',
  'V4L2VideoDecoder',
  'OOPVideoDecoder',
  'VideoToolboxVideoDecoder',
] as const;
const collectionDecoderNames = [
  'ExternalDecoder',
  'FFmpeg',
  'OpenH264',
  'libvpx',
  'dav1d',
  ...externalDecoderNames.map((name) => `ExternalDecoder (${name})`),
];
export function collectionDecoderLabel(value: unknown) {
  const direct = diagnosticLabel(value, collectionDecoderNames);
  if (direct !== undefined) return direct;
  if (typeof value !== 'string') return;
  const fallback = /^(FFmpeg|OpenH264|libvpx|dav1d) \(fallback from: /.exec(value);
  if (fallback) return `${fallback[1]} (software fallback)`;
}

function numericFields<const T extends string>(value: unknown, names: readonly T[]) {
  if (!value || typeof value !== 'object') return;
  const result: Partial<Record<T, number>> = {};
  const source = value as Record<T, unknown>;
  for (const name of names) {
    const number = finite(source[name]);
    if (number !== undefined) result[name] = number;
  }
  return result;
}

export function collectionRtcSample(
  video?: InboundMediaStats,
  audio?: InboundMediaStats,
  pair?: RTCIceCandidatePairStats,
) {
  return {
    clock: 'browser-rtc-stats' as const,
    inboundVideo: video && {
      ...numericFields(video, rtcInboundFields),
      decoderImplementation: collectionDecoderLabel(video.decoderImplementation),
      powerEfficientDecoder: diagnosticBoolean(video.powerEfficientDecoder),
    },
    inboundAudio: numericFields(audio, rtcInboundFields),
    selectedPair: pair && {
      ...numericFields(pair, rtcPairFields),
      nominated: diagnosticBoolean(pair.nominated),
      state: diagnosticLabel(pair.state, ['frozen', 'waiting', 'in-progress', 'failed', 'succeeded']),
    },
  };
}

export function collectionEndpointSample(endpoint: Diagnostics['endpoint']) {
  if (!endpoint) return;
  const comp = endpoint.comp as Record<string, unknown> | undefined;
  const policy = endpoint.mediaPolicy as Record<string, unknown> | undefined;
  const policySample = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    return {
      ...numericFields(value, ['maxFps']),
      degradationPreference: diagnosticLabel((value as Record<string, unknown>).degradationPreference, [
        'maintain-resolution',
        'maintain-framerate',
        'balanced',
        'disabled',
      ]),
    };
  };
  return {
    ...numericFields(endpoint, endpointFields),
    encoder: diagnosticLabel(endpoint.encoder, ['qsv', 'nvenc', 'none']),
    qsvVpp: diagnosticLabel(endpoint.qsvVpp, ['async', 'external']),
    atlasReadyGateEnabled: diagnosticBoolean(endpoint.atlasReadyGateEnabled),
    comp: comp && {
      ...numericFields(comp, compFields),
      idle: diagnosticBoolean(comp.idle),
      presentationRefreshPending: diagnosticBoolean(comp.presentationRefreshPending),
    },
    qsvLowPower: numericFields(endpoint.qsvLowPower, [
      'requested',
      'queried',
      'initialized',
      'queryStatus',
      'initStatus',
      'getVideoParamStatus',
    ]),
    mediaPolicy: policy && {
      requested: policySample(policy.requested),
      applied: policySample(policy.applied),
    },
    audio: numericFields(endpoint.audio, ['submitted', 'gaps', 'rejected']),
  };
}

export function collectionInputSample(
  trace: Record<string, unknown>[],
  results: Record<string, unknown>[],
  since: number,
) {
  return {
    trace: trace
      .slice(-24)
      .filter((row) => (finite(row.at) ?? -1) >= since)
      .map((row) => ({
        atMs: finite(row.at),
        phase: diagnosticLabel(row.phase, ['blocked', 'sent']),
        eventType: diagnosticLabel(row.eventType, [
          'pointer',
          'mouse',
          'wheel',
          'key',
          'text',
          'composition',
          'touch',
          'gesture',
        ]),
        action: diagnosticLabel(row.action, [
          'start',
          'move',
          'end',
          'cancel',
          'down',
          'up',
          'update',
          'commit',
          'momentum',
          'momentumEnd',
        ]),
        reason: diagnosticLabel(row.reason, [
          'channel',
          'unmatched-or-unpainted-frame',
          'stale-surface',
          'blur-pending',
          'terminal-capacity',
        ]),
        sourceClock: diagnosticLabel(row.sourceClock, ['source', 'arrival-fallback']),
        sampleElapsedUs: finite(row.sampleElapsedUs),
        sequence: diagnosticSequence(row.sequence),
      })),
    results: results
      .slice(-24)
      .filter((row) => (finite(row.at) ?? -1) >= since)
      .map((row) => ({
        atMs: finite(row.at),
        type: diagnosticLabel(row.type, ['focus', 'input.result']),
        sequence: row.type === 'input.result' ? diagnosticSequence(row.clientSequence) : undefined,
        ok: diagnosticBoolean(row.ok),
        touchState: diagnosticLabel(row.touchState, [
          'accepted-pending',
          'processed',
          'terminal-invalidated',
          'terminal-unconfirmed',
          'rejected',
        ]),
        reason: diagnosticLabel(row.error, [
          'unknown_touch_terminal',
          'stale_surface',
          'stale_layout',
          'endpoint_backpressure',
        ]),
      })),
  };
}
