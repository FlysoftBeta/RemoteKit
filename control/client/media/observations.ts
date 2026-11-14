import { RetryUnit } from '../../shared/retry-unit';
import { endpointError } from '../../shared/errors';
import { ViewerAudioOutput } from './audio-output';
import { CaptureLatency } from './capture-latency';
import { ClockDomain, ClockProbe } from './clock-domain';
import {
  collectionDecoderLabel,
  collectionEndpointSample,
  collectionInputSample,
  collectionRtcSample,
  diagnosticLabel,
  diagnosticSequence,
  InboundMediaSampler,
  MediaDiagnosticsHistory,
  type InboundMediaStats,
} from './media-diagnostics';
import { MediaFeedbackSampler } from './media-feedback';
import { configureReceiverPlayout, negotiatedReceiverPlayout } from './receiver-playout';
import { type Diagnostics } from './types';

import { diagnostics } from '../media/diagnostics';
import { type Incoming } from '../rtc/protocol';

import type { AuthorizationScope } from '../auth/authorization-scope';
import type { InputPipeline } from '../input/input-pipeline';
import type { PresentationSession } from '../presentation/presentation-session';
import type { EndpointChannel } from '../rtc/endpoint-channel';
import type { RtcSession } from '../rtc/rtc-session';

export class MediaObservations {
  failures() {
    const peer = this.ports.rtc.peer;
    return [
      peer && this.statsRetries.get(peer)?.error,
      peer && this.feedbackRetries.get(peer)?.error,
      this.endpointClockProbe.failure,
      this.controlClockProbe.failure,
    ].filter((error) => !!error);
  }
  private readonly statsRetries = new WeakMap<RTCPeerConnection, RetryUnit>();
  private readonly feedbackRetries = new WeakMap<RTCPeerConnection, RetryUnit>();
  private readonly pendingFeedback = new WeakMap<
    RTCPeerConnection,
    NonNullable<ReturnType<CaptureLatency['report']>> & { displayHzEstimate?: number }
  >();
  private retryFor(units: WeakMap<RTCPeerConnection, RetryUnit>, peer: RTCPeerConnection) {
    let unit = units.get(peer);
    if (!unit) {
      unit = new RetryUnit();
      units.set(peer, unit);
    }
    return unit;
  }

  constructor(
    private readonly ports: {
      rtc: Pick<RtcSession, 'peer' | 'controlRpc' | 'attempt'>;
      authorization: Pick<AuthorizationScope, 'productLocked' | 'peerAuthEpoch'>;
      presentation: Pick<
        PresentationSession,
        | 'layout'
        | 'canInput'
        | 'selectedViewId'
        | 'presentationBackend'
        | 'presentationErrorCode'
        | 'freezeCopies'
        | 'mediaRefreshRequests'
        | 'presentationBarrierAcknowledged'
        | 'presentationBarrier'
        | 'presentation'
        | 'encodedFrameSamples'
        | 'videoTrack'
        | 'getRenderingDiagnostics'
        | 'sampleVideoWindows'
        | 'currentVideoWindows'
        | 'feedbackPlanes'
      >;
      endpoint: Pick<EndpointChannel, 'channel' | 'sendChannel'>;
      input: Pick<InputPipeline, 'inputTrace' | 'inputResults'>;
    },
  ) {}
  readonly audio = new ViewerAudioOutput(() => this.notify());

  latency = new CaptureLatency();

  endpointClockProbe = new ClockProbe(this.latency.endpointClock);

  controlClock = new ClockDomain();

  controlClockProbe = new ClockProbe(this.controlClock);

  feedbackReading = false;

  displayHzEstimate?: number;

  diagnostics: Diagnostics = { connection: '未连接', channel: '未连接' };

  readonly inboundVideo = new InboundMediaSampler();

  readonly inboundAudio = new InboundMediaSampler();

  readonly mediaDiagnosticsHistory = new MediaDiagnosticsHistory();

  mediaDiagnosticsRevision = 0;

  mediaDiagnosticsScopeAt = performance.now();

  endpointStatsAtMs?: number;

  collectionRtcSource?: {
    video?: InboundMediaStats;
    audio?: InboundMediaStats;
    pair?: RTCIceCandidatePairStats;
    sampledAtMs: number;
    getStatsWaitMs: number;
  };

  exportMediaDiagnostics() {
    return this.mediaDiagnosticsHistory.export(globalThis.navigator?.userAgent ?? '');
  }

  getDiagnosticCollectionSample(sinceMs = 0) {
    const peer = this.ports.rtc.peer;
    if (!peer || this.ports.authorization.productLocked || this.ports.authorization.peerAuthEpoch === 0)
      return;
    const now = performance.now(),
      since = Math.max(sinceMs, this.mediaDiagnosticsScopeAt, now - 2500);
    const layout = this.ports.presentation.layout,
      viewport = globalThis.visualViewport;
    const rtc = this.collectionRtcSource;
    const media = this.mediaDiagnosticsHistory.latest();
    const ua = globalThis.navigator?.userAgent ?? '';
    const chromiumMajor = /\b(?:Chromium|Chrome)\/(\d{1,4})\./.exec(ua)?.[1];
    const androidMajor = /\bAndroid (\d{1,3})\b/.exec(ua)?.[1];
    const channel = this.ports.endpoint.channel;
    const planes = layout?.views.slice(0, 4).map((view) => ({
      x: view.x,
      y: view.y,
      width: view.width,
      height: view.height,
      deviceScaleFactor: view.deviceScaleFactor,
      mediaScaleX: view.mediaScaleX ?? view.mediaScale,
      mediaScaleY: view.mediaScaleY ?? view.mediaScale,
      stale: view.stale === true,
      ready: !!this.ports.presentation.canInput(view.id),
      selected: this.ports.presentation.selectedViewId === view.id,
    }));
    return {
      schema: 1,
      clientTimeMs: now,
      clientClock: 'browser-performance' as const,
      availability: { sourceCaptureTiming: false, nativeGpuProfileCollectedByClient: false },
      browser: {
        chromiumMajor: chromiumMajor === undefined ? undefined : Number(chromiumMajor),
        androidMajor: androidMajor === undefined ? undefined : Number(androidMajor),
      },
      media: media && {
        ...media,
        video: media.video && {
          ...media.video,
          decoderImplementation: collectionDecoderLabel(media.video.decoderImplementation),
        },
      },
      rtc: rtc && {
        ...collectionRtcSample(rtc.video, rtc.audio, rtc.pair),
        sampledAtMs: rtc.sampledAtMs,
        ageMs: now - rtc.sampledAtMs,
        getStatsWaitMs: rtc.getStatsWaitMs,
      },
      endpoint: collectionEndpointSample(this.diagnostics.endpoint),
      receive: this.diagnostics.receiveSelection && {
        profile: this.diagnostics.receiveSelection.profile,
        probeSource: this.diagnostics.receiveSelection.probeSource,
        probes: this.diagnostics.receiveSelection.probes,
        required: this.diagnostics.receiveSelection.required,
        probeDurationMs: this.diagnostics.receiveSelection.probeDurationMs,
      },
      endpointReceivedAtMs: this.endpointStatsAtMs,
      endpointAgeMs: this.endpointStatsAtMs === undefined ? undefined : now - this.endpointStatsAtMs,
      viewport: {
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
        dpr: globalThis.devicePixelRatio,
        visualWidth: viewport?.width,
        visualHeight: viewport?.height,
        visualScale: viewport?.scale,
        visibility: diagnosticLabel(globalThis.document?.visibilityState, ['visible', 'hidden']),
      },
      connection: {
        peerState: peer.connectionState,
        iceState: peer.iceConnectionState,
        signalingState: peer.signalingState,
        channelState: channel?.readyState,
        bufferedAmount: channel?.bufferedAmount,
        codec: diagnosticLabel(this.diagnostics.codec?.toLowerCase(), [
          'video/h264',
          'video/vp8',
          'video/vp9',
          'video/av1',
        ]),
      },
      layout: layout && {
        width: layout.width,
        height: layout.height,
        generation: diagnosticSequence(layout.generation),
        epoch: diagnosticSequence(layout.epoch),
        reconfiguring: layout.reconfiguring === true,
        planes,
      },
      presentation: {
        backend: this.ports.presentation.presentationBackend,
        backendReason: this.ports.presentation.presentationErrorCode,
        counterScope: 'transport' as const,
        metadataWindowStartMs: since,
        freezeCopies: this.ports.presentation.freezeCopies,
        mediaRefreshRequests: this.ports.presentation.mediaRefreshRequests,
        barrierAcknowledged: this.ports.presentation.presentationBarrierAcknowledged,
        barrierLayoutEpoch: diagnosticSequence(this.ports.presentation.presentationBarrier?.layoutEpoch),
        barrierOutputGeneration: diagnosticSequence(
          this.ports.presentation.presentationBarrier?.outputGeneration,
        ),
        frames: this.ports.presentation.presentation.recentVideo(since),
        metadata: this.ports.presentation.encodedFrameSamples
          .slice(-64)
          .filter((frame) => frame.at >= since)
          .map((frame) => ({
            atMs: frame.at,
            rtpTimestamp: frame.rtpTimestamp,
            layoutEpoch: diagnosticSequence(frame.layoutEpoch),
            encodedBytes: frame.encodedBytes,
            keyframe: frame.keyframe,
          })),
      },
      input: collectionInputSample(this.ports.input.inputTrace, this.ports.input.inputResults, since),
    };
  }

  resetMediaDiagnostics() {
    this.mediaDiagnosticsRevision++;
    this.mediaDiagnosticsScopeAt = performance.now();
    this.endpointStatsAtMs = undefined;
    this.collectionRtcSource = undefined;
    this.mediaDiagnosticsHistory.clear();
    this.inboundVideo.reset();
    this.inboundAudio.reset();
    this.diagnostics = {
      ...this.diagnostics,
      endpoint: undefined,
      receiverVideoTiming: undefined,
      receiverAudioTiming: undefined,
    };
    this.notify();
  }

  timer: ReturnType<typeof setInterval> | undefined;

  statsReadingPeer: RTCPeerConnection | undefined;

  mediaFeedback = new MediaFeedbackSampler({
    now: () => performance.now(),
    visible: () => document.visibilityState === 'visible',
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    onVisibility: (callback) => {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
  });

  update(change: Partial<Diagnostics>) {
    this.diagnostics = { ...this.diagnostics, ...change };
    this.notify();
  }

  configureReceiver(receiver: RTCRtpReceiver | undefined, kind: string) {
    if (!receiver || (kind !== 'video' && kind !== 'audio')) return;
    this.update({
      receiverPlayout: { ...this.diagnostics.receiverPlayout, [kind]: configureReceiverPlayout(receiver) },
    });
  }

  setMarkerStats(report: {
    inputToObservedMs: { p50: number | null; p95: number | null };
    renderToObservedMs: { p50: number | null; p95: number | null };
    samples: unknown[];
    markerSampleHz?: number | null;
  }) {
    const input = report.inputToObservedMs;
    const render = report.renderToObservedMs;
    const measured = input.p50 !== null ? input : render;
    const kind = input.p50 !== null ? 'input' : 'render';
    this.update({
      markerSampleHz: typeof report.markerSampleHz === 'number' ? report.markerSampleHz : undefined,
      marker:
        measured.p50 === null || measured.p95 === null
          ? undefined
          : { kind, p50: measured.p50, p95: measured.p95, samples: report.samples.length },
    });
  }

  async readStats(peer: RTCPeerConnection) {
    if (peer !== this.ports.rtc.peer || this.statsReadingPeer === peer) return;
    const retry = this.retryFor(this.statsRetries, peer);
    if (!retry.ready()) return;
    this.statsReadingPeer = peer;
    const mediaRevision = this.mediaDiagnosticsRevision;
    try {
      // Snapshot video counters at the getStats request edge. Use the same
      // polling windows for rates rather than the rolling rVFC diagnostic FPS.
      const at = performance.now();
      const videoWindows = this.ports.presentation.sampleVideoWindows(at);
      const stats = await peer.getStats();
      const getStatsWaitMs = performance.now() - at;
      if (peer !== this.ports.rtc.peer || mediaRevision !== this.mediaDiagnosticsRevision) return;
      const videoReceiver = peer
        .getReceivers?.()
        .find((receiver) => receiver.track === this.ports.presentation.videoTrack);
      const update: Partial<Diagnostics> = {
        decodedFramesPerSecond: undefined,
        receiveBitrateBps: undefined,
        receiverVideoTiming: undefined,
        receiverAudioTiming: undefined,
        receiverVideoPlayoutExtensionNegotiated: negotiatedReceiverPlayout(videoReceiver),
        roundTripTime: undefined,
        selectedCandidates: undefined,
        videoWidth: undefined,
        videoHeight: undefined,
      };
      let inboundCounters: { decodedFrames?: number; packetsLost?: number; framesDropped?: number } = {};
      let videoReport:
        | (InboundMediaStats & {
            framesPerSecond?: number;
            frameWidth?: number;
            frameHeight?: number;
            codecId?: string;
          })
        | undefined;
      let audioReport: InboundMediaStats | undefined;
      let selectedPairId: string | undefined;
      let nominatedPair: RTCIceCandidatePairStats | undefined;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp') {
          const kind = report.kind ?? report.mediaType;
          if (kind === 'video') videoReport = report;
          if (kind === 'audio') audioReport = report;
        }
        if (report.type === 'transport' && report.selectedCandidatePairId)
          selectedPairId = report.selectedCandidatePairId;
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated)
          nominatedPair ??= report;
      });
      if (videoReport) {
        const { video, decodedFps, bitrateBps } = this.inboundVideo.sample(videoReport);
        inboundCounters = {
          decodedFrames: videoReport.framesDecoded,
          packetsLost: videoReport.packetsLost,
          framesDropped: videoReport.framesDropped,
        };
        update.framesDecoded = videoReport.framesDecoded;
        update.framesPerSecond = videoReport.framesPerSecond;
        update.bytesReceived = videoReport.bytesReceived;
        update.videoWidth = videoReport.frameWidth;
        update.videoHeight = videoReport.frameHeight;
        update.decodedFramesPerSecond = decodedFps;
        update.receiveBitrateBps = bitrateBps;
        if (Object.values(video).some((value) => value !== undefined)) update.receiverVideoTiming = video;
        if (videoReport.codecId) update.codec = stats.get(videoReport.codecId)?.mimeType;
      } else this.inboundVideo.reset();
      if (audioReport) update.receiverAudioTiming = this.inboundAudio.sample(audioReport).buffer;
      else this.inboundAudio.reset();
      const pair =
        (selectedPairId ? (stats.get(selectedPairId) as RTCIceCandidatePairStats | undefined) : undefined) ??
        nominatedPair;
      if (pair) {
        update.roundTripTime = pair.currentRoundTripTime;
        update.selectedCandidates = {
          pair,
          local: stats.get(pair.localCandidateId),
          remote: stats.get(pair.remoteCandidateId),
        };
      }
      const currentVideos = this.ports.presentation.currentVideoWindows(videoWindows);
      const paints = Object.fromEntries(currentVideos.map(({ viewId, window }) => [viewId, window]));
      update.paintFpsByView = Object.fromEntries(
        Object.entries(paints).map(([id, value]) => [id, value?.fps]),
      );
      update.videoTimingByView = Object.fromEntries(
        currentVideos.map(({ viewId, timing, window }) => [
          viewId,
          {
            callbackFps: window?.callbackFps,
            videoElementFps: window?.videoElementFps,
            videoElementDrops: window?.videoElementDrops,
            ...timing,
          },
        ]),
      );
      update.rendering = this.ports.presentation.getRenderingDiagnostics();
      update.displayFramesPerSecond = this.ports.presentation.selectedViewId
        ? paints[this.ports.presentation.selectedViewId]?.fps
        : undefined;
      if (!this.ports.authorization.productLocked && this.ports.authorization.peerAuthEpoch !== 0) {
        this.collectionRtcSource = {
          video: videoReport,
          audio: audioReport,
          pair,
          sampledAtMs: at,
          getStatsWaitMs,
        };
        this.mediaDiagnosticsHistory.record(
          at,
          { ...this.diagnostics, ...update },
          this.ports.presentation.selectedViewId,
        );
      }
      this.update(update);
      if (this.ports.presentation.layout && this.ports.endpoint.channel?.readyState === 'open') {
        const feedback = this.mediaFeedback.sample({
          layoutEpoch: this.ports.presentation.layout.epoch,
          outputGeneration: this.ports.presentation.layout.generation,
          ...inboundCounters,
          planes: this.ports.presentation.feedbackPlanes(),
          roundTripTimeMs: update.roundTripTime === undefined ? undefined : update.roundTripTime * 1000,
        });
        if (feedback?.displayHzEstimate) this.displayHzEstimate = feedback.displayHzEstimate;
        if (
          feedback &&
          !this.ports.authorization.productLocked &&
          this.ports.endpoint.channel.bufferedAmount <= 65536
        )
          this.ports.endpoint.sendChannel(this.ports.endpoint.channel, feedback);
      }
      retry.succeed();
      this.productionFeedback(peer);
    } catch (error) {
      if (peer === this.ports.rtc.peer && mediaRevision === this.mediaDiagnosticsRevision) retry.fail(error);
    } finally {
      if (this.statsReadingPeer === peer) this.statsReadingPeer = undefined;
    }
  }

  productionFeedback(peer: RTCPeerConnection) {
    const rpc = this.ports.rtc.controlRpc,
      attempt = this.ports.rtc.attempt;
    if (!rpc || peer !== this.ports.rtc.peer) return;
    const now = performance.now();
    this.sampleEndpointClock();
    const wall = Date.now(),
      ping = this.controlClockProbe.begin(now, wall);
    if (ping) {
      void rpc('clock.ping', { clientTime: wall })
        .then((value) => {
          if (attempt === this.ports.rtc.attempt && peer === this.ports.rtc.peer)
            this.controlClockProbe.complete(
              ping.requestId,
              performance.now(),
              Date.now(),
              (value as { serverTime: number }).serverTime,
            );
        })
        .catch((error) => this.controlClockProbe.fail(ping.requestId, error));
    }
    const retry = this.retryFor(this.feedbackRetries, peer);
    if (this.feedbackReading || !retry.ready()) return;
    const retained = retry.error?.code === 'outcome_unknown' ? this.pendingFeedback.get(peer) : undefined;
    const report =
      retained ??
      this.latency.report(now, Date.now(), document.visibilityState === 'visible', this.controlClock);
    if (!report) return;
    this.update({ presentationEstimate: report });
    this.feedbackReading = true;
    const payload = retained ?? { ...report, displayHzEstimate: this.displayHzEstimate };
    this.pendingFeedback.set(peer, payload);
    void rpc('feedback', payload)
      .then(() => {
        if (attempt !== this.ports.rtc.attempt || peer !== this.ports.rtc.peer) return;
        this.pendingFeedback.delete(peer);
        retry.succeed();
      })
      .catch((error) => {
        if (attempt !== this.ports.rtc.attempt || peer !== this.ports.rtc.peer) return;
        retry.fail(error);
      })
      .finally(() => {
        if (attempt === this.ports.rtc.attempt) this.feedbackReading = false;
      });
  }

  sampleEndpointClock() {
    const channel = this.ports.endpoint.channel;
    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > 65536) return;
    const ping = this.endpointClockProbe.begin(performance.now(), Date.now());
    if (ping) {
      try {
        this.ports.endpoint.sendChannel(channel, ping);
      } catch (error) {
        this.endpointClockProbe.fail(ping.requestId, error);
      }
    }
  }

  handle(message: Incoming) {
    if (message.type === 'frame') this.latency.record(message.rtpTimestamp, message.layoutEpoch, message);
    const channel = this.ports.endpoint.channel!;
    if (message.type === 'clock.pong') {
      this.endpointClockProbe.pong(message, performance.now(), Date.now());
      return;
    }
    if (message.type === 'stats') {
      this.endpointStatsAtMs = performance.now();
      this.update({ endpoint: message });
    }
    if (message.type === 'error') this.update({ error: endpointError(message.error).message });
  }

  reset() {
    clearInterval(this.timer);
    this.latency.reset();
    this.endpointClockProbe.reset();
    this.controlClockProbe.reset();
    this.feedbackReading = false;
    this.displayHzEstimate = undefined;
    this.mediaFeedback.stop();
    this.statsReadingPeer = undefined;
    this.resetMediaDiagnostics();
    this.audio.detach();
    this.diagnostics = { connection: '未连接', channel: '未连接' };
    this.notify();
  }

  channelChanged() {
    this.endpointClockProbe.reset();
    this.latency.reset();
  }

  start(peer: RTCPeerConnection) {
    clearInterval(this.timer);
    this.mediaFeedback.start();
    this.timer = setInterval(() => {
      this.sampleEndpointClock();
      void this.readStats(peer);
    }, 1000);
  }

  notify() {
    this.snapshot = Object.freeze({ ...this.diagnostics });
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();

  private snapshot: Diagnostics = { connection: '未连接', channel: '未连接' };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  onPresentation = (frame: { rtp: number; epoch: string; at: number; wall: number }) =>
    this.latency.paint(frame.rtp, frame.epoch, frame.at, frame.wall);
  onRtc = (event: import('../rtc/rtc-session').RtcEvent) => {
    switch (event.type) {
      case 'receiver':
        this.configureReceiver(event.receiver, event.kind);
        break;
      case 'track':
        if (event.track.kind === 'audio') this.audio.attach(event.track);
        break;
      case 'established':
        this.start(event.peer);
        break;
      case 'diagnostics':
        this.update(event.change);
        break;
      case 'closed':
        this.reset();
        break;
    }
  };
  onChannel = (event: import('../rtc/endpoint-channel').ChannelEvent) => {
    if (event.type === 'bound') this.channelChanged();
    else if (event.type === 'open') {
      this.sampleEndpointClock();
      this.update({ channel: '已连接' });
    }
  };
  onAuthorization = () => this.audio.setMuted(this.ports.authorization.productLocked);
}
