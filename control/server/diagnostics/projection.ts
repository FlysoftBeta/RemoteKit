const words = (value: string) => new Set(value.trim().split(/\s+/));

const labels: Record<string, ReadonlySet<string>> = {
  browserFamily: words('chrome chromium edge safari firefox brave other'),
  platform: words('android ios windows macos linux chromeos other'),
  effectiveConnectionType: words('slow-2g 2g 3g 4g'),
  visibility: words('visible hidden'),
  peerState: words('new connecting connected disconnected failed closed'),
  iceState: words('new checking connected completed failed disconnected closed'),
  signalingState: words(
    'stable have-local-offer have-remote-offer have-local-pranswer have-remote-pranswer closed',
  ),
  channelState: words('connecting open closing closed'),
  codec: words('video/h264 video/vp8 video/vp9 video/av1'),
  state: words('frozen waiting in-progress failed succeeded'),
  kind: words('osr-renderer custom-osr video audio'),
  encoder: words('qsv nvenc none'),
  encoderSelection: words('qsv nvenc auto'),
  qsvVpp: words('async external'),
  degradationPreference: words('maintain-resolution maintain-framerate balanced disabled'),
  backend: words('pending video'),
  backendReason: words(`video-playback-failed presentation-protocol-unavailable
    video-capability-unavailable video-rtp-metadata-unavailable invalid-presentation-mode invalid-presentation-barrier`),
  phase: words('blocked sent unload unloaded restore'),
  eventType: words('pointer mouse wheel key text composition touch gesture'),
  action: words('start move end cancel down up update commit momentum momentumEnd'),
  reason: words(`channel unmatched-or-unpainted-frame stale-surface blur-pending
    stale_surface stale_layout endpoint_backpressure`),
  sourceClock: words('source arrival-fallback'),
  type: words('focus input.result'),
  clock: words('endpoint-webrtc-report browser-rtc-stats'),
  clientClock: words('browser-performance'),
  connectionTimingOrigin: words('endpoint-offer-monotonic'),
  atlasInput: words('render-slots'),
  completionTime: words('unmeasured'),
  device: words('tablet desktop'),
  close_state: words('open closing closed'),
  configuration: words('generic-desktop current-platform'),
  counterScope: words('transport'),
  profile: words(
    'native chrome89-h264-42 chrome89-h264-51 h264-level42-experimental h264-level52 h264-level51',
  ),
  probeSource: words('video-decoder media-capabilities-webrtc'),
  level52: words('supported rejected timeout error unavailable'),
  level51: words('supported rejected timeout error unavailable'),
  level42: words('supported rejected timeout error unavailable'),
};

const decoderLabels = new Set([
  ...words('ExternalDecoder FFmpeg OpenH264 libvpx dav1d'),
  ...Array.from(words('FFmpeg OpenH264 libvpx dav1d'), (name) => `${name} (software fallback)`),
  ...[
    'Unknown Video Decoder',
    ...words(`Unknown FFmpegVideoDecoder VpxVideoDecoder AomVideoDecoder MojoVideoDecoder
    Dav1dVideoDecoder MediaCodec MediaCodecVideoDecoder D3D11VideoDecoder VaapiVideoDecoder VideoDecoderBroker VDAVideoDecoder
    V4L2VideoDecoder OOPVideoDecoder VideoToolboxVideoDecoder`),
  ].map((name) => `ExternalDecoder (${name})`),
]);

const decimalCounters = words(
  'generation epoch barrierLayoutEpoch barrierOutputGeneration layoutEpoch submitted rejected lifecycle_generation sequence',
);
const environmentFields =
  words(`browserFamily browserMajorVersion browserVersion platform osVersion viewportWidth viewportHeight devicePixelRatio screenWidth screenHeight
  screenColorDepth maxTouchPoints videoFrameCallbackSupported hardwareConcurrency deviceMemoryGiB effectiveConnectionType networkRttMs networkDownlinkMbps`);
const clientFields = words(`
  schema clientTimeMs clientClock browser chromiumMajor androidMajor statsAtMs endpointReceivedAtMs endpointAgeMs media rtc endpoint viewport connection layout presentation input
  availability sourceCaptureTiming nativeGpuProfileCollectedByClient sampledAtMs ageMs counterScope metadataWindowStartMs sequence
  width height x y dpr visualWidth visualHeight visualScale visibility peerState iceState signalingState channelState bufferedAmount codec
  generation epoch reconfiguring planes deviceScaleFactor mediaScaleX mediaScaleY stale ready selected
  backend backendReason barrierAcknowledged barrierLayoutEpoch barrierOutputGeneration metadata atMs rtpTimestamp layoutEpoch encodedBytes keyframe freezeCopies mediaRefreshRequests getStatsWaitMs
  frames presentedFrames expectedDisplayTimeMs presentationTimeMs receiveTimeMs processingDurationSeconds
  trace results phase eventType action reason sourceClock sampleElapsedUs type ok
  video audio playout comp sender inboundVideo inboundAudio selectedPair outbound nominated state stream clock sampleTimeUs
  bytesReceived jitterBufferEmittedCount jitterBufferDelay jitterBufferTargetDelay jitterBufferMinimumDelay framesDecoded totalDecodeTime
  totalProcessingDelay totalAssemblyTime framesAssembledFromMultiplePackets framesDropped packetsLost packetsReceived retransmittedPacketsReceived
  retransmittedBytesReceived nackCount pliCount timestamp framesReceived keyFramesDecoded frameWidth frameHeight framesPerSecond jitter firCount qpSum
  headerBytesReceived lastPacketReceivedTimestamp totalInterFrameDelay totalSquaredInterFrameDelay freezeCount totalFreezesDuration pauseCount
  totalPausesDuration jitterBufferFlushes packetsDiscarded fecPacketsReceived fecPacketsDiscarded concealedSamples silentConcealedSamples
  concealmentEvents insertedSamplesForDeceleration removedSamplesForAcceleration totalSamplesReceived totalSamplesDuration
  currentRoundTripTime totalRoundTripTime availableIncomingBitrate availableOutgoingBitrate packetsSent bytesSent packetsDiscardedOnSend
  bytesDiscardedOnSend requestsSent responsesReceived consentRequestsSent powerEfficientDecoder decoderImplementation
  windowMs jitterBufferEmitted jitterBufferMeanMs jitterBufferTargetMeanMs jitterBufferMinimumMeanMs decodeMeanMs processingMeanMs
  assemblyMeanMs multiPacketFrames packetJitterMs lostPackets receivedPackets receivedBytes retransmittedPackets retransmittedBytes
  receivedPacketRetransmitRatio receivedByteRetransmitRatio droppedFrames videoTargetMs videoLegacyHintSeconds audioTargetMs audioLegacyHintSeconds
  rtpExtensionNegotiated senderRequestedMinMs senderRequestedMaxMs decodedFps receiveBitrateBps rttMs sourceAtlasWidth sourceAtlasHeight
  gccTargetFps gccTargetBitrate lastEncodeMs feedbackDisplayHzEstimate feedbackAgeMs sourceFrameIntervalMs
  compositorFps callbackFps elementFps elementDrops receiveToSubmit submitToCallback expectedDisplayLateness processing samples p95
  totalPacketSendDelay retransmittedPacketsSent retransmittedBytesSent framesSent framesEncoded keyFramesEncoded packetRetransmitRatio packetSendMeanMs
  encodeSubmitted encodeCompleted encodeDropped encodePending encodeInflight queueFullDrops hardwareBusy pausedDrops errorDrops inactiveDrops
  cancelledDrops queueWaitUs queueWaitSamples rateUpdates keyframeRequests keyframesSubmitted keyframesEncoded requestedTargetUsage appliedTargetUsage
  appliedBitrate appliedMaxBitrate appliedFps actualLevel sourceWidth sourceHeight encodedWidth encodedHeight negotiatedReceiveLevel samplingFpsBudget
  configuredIdleIdrMs effectiveIdleIdrMs tailIdrSubmissions tailIdrCompletions lastTailAfterSourceMs atlasAllocationAlignment atlasSharedBorrows
  atlasSharedHeldSlots feedbackRafSamples encoder qsvVpp atlasReadyGateEnabled qsvLowPower mediaPolicy requested applied maxFps
  qsvRateControl lowDelayBrc maxFrameSize maxFrameSizeI maxFrameSizeP bufferSizeKb initialDelayKb
  degradationPreference queried initialized queryStatus initStatus getVideoParamStatus submitted gaps rejected idle idleEntries wakes begins
  rejectIdle rejectNotReady rejectStopped readyObserved consumedCompleted stopSent stopConfirmed activeDepth occupied retiredOccupied peakOccupied
  retiredGenerations retiredGenerationsCompleted unknownGpuRetainedGenerations unknownGpuRetentions targetFps resumeMaxFps officialMaxFps
  codecMaxFps adaptRequests adaptDrops adaptErrors adaptSizeChanges presentationRefreshPending presentationRefreshAttempts
  presentationRefreshForcedBegins presentationRefreshSuccesses
  receive profile probeSource probes level52 level51 level42 probeDurationMs
`);

// Only the tenant's diagnostic subtrees enter this projection. Identity, raw
// content, connection addresses and free-form status/error text are dropped.
const nativeKey = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const excludedNativeKey =
  /(?:token|secret|credential|password|(?:^|_)id$|Id$|Incarnation$|url|title|origin$|address|candidate|sdp|handle|channel|message|detail|identifier|fingerprint|content|text|filename|username|href|navigation|input|auth|path)/i;
const nativeViewFields =
  words(`actual desired pending focused last_lifecycle close_state width height device deviceScaleFactor compositor visible
  lifecycle_uncertain canDiscard touch_code pending_page_requests loading audible crashed fullscreen recovery browserPending browserDesired`);

function project(
  value: unknown,
  allowed: (key: string) => boolean,
  truncated?: Set<string>,
  source = 'client',
) {
  let remaining = 4096;
  const mark = () => truncated?.add(`${source}-projection-limit`);
  const walk = (item: unknown, key: string, depth: number): unknown => {
    if (--remaining < 0 || depth > 8) {
      mark();
      return undefined;
    }
    if (typeof item === 'number') return Number.isFinite(item) ? item : undefined;
    if (typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (Object.prototype.hasOwnProperty.call(labels, key) && labels[key].has(item)) return item;
      if (decimalCounters.has(key) && /^\d{1,20}$/.test(item)) return item;
      if ((key === 'browserVersion' || key === 'osVersion') && /^\d{1,5}(?:\.\d{1,5}){0,4}$/.test(item))
        return item;
      if (key === 'decoderImplementation' && decoderLabels.has(item)) return item;
      return undefined;
    }
    if (!item || typeof item !== 'object') return undefined;
    if (Array.isArray(item)) {
      if (item.length > 64) mark();
      return item
        .slice(0, 64)
        .map((child) => walk(child, key, depth + 1))
        .filter((child) => child !== undefined);
    }
    const entries = Object.entries(item);
    if (entries.length > 256) mark();
    const out: Record<string, unknown> = Object.create(null);
    for (const [childKey, child] of entries.slice(0, 256)) {
      if (!allowed(childKey)) continue;
      const safe = walk(child, childKey, depth + 1);
      if (safe !== undefined) out[childKey] = safe;
    }
    return out;
  };
  return walk(value, '', 0);
}

export function diagnosticEnvironment(value: unknown): Record<string, unknown> {
  const input = record(value);
  const allowed = Object.fromEntries(
    Object.entries(input).filter(([key, entry]) => environmentFields.has(key) && typeof entry !== 'object'),
  );
  return project(allowed, (key) => environmentFields.has(key)) as Record<string, unknown>;
}

export function diagnosticClientSample(value: unknown, truncated: Set<string>) {
  return project(value, (key) => clientFields.has(key), truncated);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function diagnosticEndpointSnapshot(value: unknown, truncated: Set<string>) {
  const snapshot = record(value),
    outputDiagnostics = record(snapshot.outputDiagnostics),
    rtc = record(snapshot.rtc);
  const views = Array.isArray(snapshot.views) ? snapshot.views : [];
  if (views.length > 64) truncated.add('endpoint-view-count');
  const data = {
    running: snapshot.running,
    rtcActive: rtc.active,
    avSync: rtc.avSync,
    browserOutputAvailable: outputDiagnostics.ok === true,
    browserOutput: outputDiagnostics.ok === true ? outputDiagnostics.output : undefined,
    stats: snapshot.stats,
    recovery: snapshot.recovery,
    views: views
      .slice(0, 64)
      .map((view) =>
        Object.fromEntries(Object.entries(record(view)).filter(([key]) => nativeViewFields.has(key))),
      ),
  };
  return project(
    data,
    (key) =>
      key === 'atlasInput' ||
      key === 'connectionTimingOrigin' ||
      (nativeKey.test(key) && !excludedNativeKey.test(key)),
    truncated,
    'endpoint',
  ) as Record<string, unknown>;
}
