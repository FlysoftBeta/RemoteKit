import type { FileRequestAnchor } from '../../shared/product';
import { projectFileInput } from '../files/file-chooser-anchor';
import { uiScale } from '../app/ui-scale';
import { PresentationDiagnostics } from '../media/presentation-diagnostics';
import { type Layout, type Surface, type VideoPresentation } from './types';
import { canonicalJson } from '../util/canonical-json';
import { freezeSnapshot } from '../util/store';
import { FrameEpochGate } from './frame-epoch';
import { planeMatchesLayout, samePlane, type PlaneIdentity, type PresentedPlaneSource } from './plane-source';
import { VideoPlane } from './video-plane';
import { barrierMatchesLayout, presentationBarrier, type PresentationBarrier } from './video-presentation';

import { RemoteKitError } from '../../shared/errors';
import { diagnostics } from '../media/diagnostics';
import { type Incoming } from '../rtc/protocol';
import { Events } from '../util/store';
import type { PlaneRenderer, VideoObservation, ViewportRegistration } from './types';

import type { AuthorizationScope } from '../auth/authorization-scope';
import type { EndpointChannel } from '../rtc/endpoint-channel';
import type { RtcSession } from '../rtc/rtc-session';
type PresentationErrorCode =
  | 'video-capability-unavailable'
  | 'video-rtp-metadata-unavailable'
  | 'video-playback-failed'
  | 'presentation-protocol-unavailable'
  | 'invalid-presentation-mode'
  | 'invalid-presentation-barrier';

export interface InputAuthority {
  surface: Surface;
  layout: Layout;
  attempt: number;
}

export type PresentationBackend =
  { phase: 'pending' } | { phase: 'video' } | { phase: 'unavailable'; reason: PresentationErrorCode };
export type BarrierState =
  | { phase: 'none' }
  | { phase: 'hiding'; key: PresentationBarrier; turn: 0 | 1 | 2 }
  | { phase: 'acknowledged'; key: PresentationBarrier };
export type ViewReadiness = { phase: 'hidden' } | { phase: 'awaitingFrame' } | { phase: 'ready' };
export interface PresentationSnapshot {
  backend: PresentationBackend;
  barrier: BarrierState;
  views: Readonly<Record<string, ViewReadiness>>;
  layout: Layout | null;
  error?: RemoteKitError;
  canRetry: boolean;
}

export class PresentationSession {
  acceptFocus(viewId: string, token: string) {
    const view = this.layout?.views.find((view) => view.id === viewId);
    if (view) {
      view.focus = token;
      this.notify();
    }
  }
  readonly observations = new Events<{ rtp: number; epoch: string; at: number; wall: number }>();
  constructor(
    private readonly ports: {
      endpoint: Pick<EndpointChannel, 'channel' | 'sendChannel'>;
      rtc: Pick<RtcSession, 'peer' | 'attempt' | 'markConnection'>;
      authorization: Pick<AuthorizationScope, 'productLocked' | 'peerAuthEpoch' | 'productReady'>;
    },
  ) {}
  freezeCopies = 0;

  recordResizeFreezeCopy() {
    this.freezeCopies++;
  }

  videoTrack?: MediaStreamTrack;

  private backendState: PresentationBackend = { phase: 'pending' };
  get presentationBackend() {
    return this.backendState.phase;
  }
  set presentationBackend(phase: PresentationBackend['phase']) {
    this.backendState =
      phase === 'unavailable' ? { phase, reason: 'presentation-protocol-unavailable' } : { phase };
  }

  get presentationErrorCode() {
    return this.backendState.phase === 'unavailable' ? this.backendState.reason : undefined;
  }
  set presentationErrorCode(reason: PresentationErrorCode | undefined) {
    if (reason) this.backendState = { phase: 'unavailable', reason };
  }

  get presentationError() {
    return this.presentationErrorCode
      ? new RemoteKitError('unavailable', '视频呈现不可用', this.presentationErrorCode)
      : undefined;
  }

  get canRetryPresentation() {
    return (
      this.presentationErrorCode === 'video-playback-failed' ||
      this.presentationErrorCode === 'presentation-protocol-unavailable'
    );
  }

  retryPresentation() {
    if (this.canRetryPresentation && this.ports.endpoint.channel?.readyState === 'open')
      this.negotiatePresentation(this.ports.endpoint.channel, true);
  }

  private presentationNegotiationTimer?: ReturnType<typeof setTimeout>;

  private barrierState: BarrierState = { phase: 'none' };
  get presentationBarrier() {
    return this.barrierState.phase === 'none' ? undefined : this.barrierState.key;
  }
  set presentationBarrier(key: PresentationBarrier | undefined) {
    this.barrierState = key ? { phase: 'hiding', key, turn: 0 } : { phase: 'none' };
  }
  get presentationBarrierAcknowledged() {
    return this.barrierState.phase === 'acknowledged';
  }
  set presentationBarrierAcknowledged(acknowledged: boolean) {
    const key = this.presentationBarrier;
    this.barrierState = key
      ? acknowledged
        ? { phase: 'acknowledged', key }
        : { phase: 'hiding', key, turn: 0 }
      : { phase: 'none' };
  }

  private presentationAckRaf?: number;

  private presentationAckSerial = 0;

  private pendingPresentationAction?: { channel: RTCDataChannel; action: () => void };

  private videoPlanes = new Map<PlaneRenderer, VideoPlane>();

  private presentationVisibility?: () => void;

  private videoMetadataRefreshTimer?: ReturnType<typeof setTimeout>;

  private readonly videoSupported = VideoPlane.supported();

  private renderers = new Set<PlaneRenderer>();

  private viewports = new Set<ViewportRegistration>();

  mediaRefreshRequests = 0;

  private mediaRefreshAt = -Infinity;

  private requestPresentationRefresh() {
    const channel = this.ports.endpoint.channel;
    if (
      !this.ports.rtc.peer ||
      channel?.readyState !== 'open' ||
      performance.now() - this.mediaRefreshAt < 1000
    )
      return;
    if (
      this.ports.authorization.productLocked ||
      this.ports.authorization.peerAuthEpoch === 0 ||
      this.presentationBackend !== 'video'
    )
      return;
    this.mediaRefreshAt = performance.now();
    try {
      this.ports.endpoint.sendChannel(channel, { type: 'media.refresh' });
      this.mediaRefreshRequests++;
    } catch (error) {
      diagnostics.record('media-refresh', error);
    }
  }

  getRenderingDiagnostics() {
    return {
      backend: this.presentationBackend,
      backendReason: this.presentationErrorCode,
      videoCompositorByView: Object.fromEntries(
        [...this.videoPlanes].map(([renderer, plane]) => [
          renderer.view.id,
          plane.stats.snapshot(performance.now()),
        ]),
      ),
      visibility: globalThis.document?.visibilityState,
      freezeCopies: this.freezeCopies,
      mediaRefreshRequests: this.mediaRefreshRequests,
    };
  }

  private frameGate = new FrameEpochGate();

  presentation = new PresentationDiagnostics();

  readonly encodedFrameSamples: {
    at: number;
    rtpTimestamp: number;
    layoutEpoch: string;
    encodedBytes?: number;
    keyframe?: boolean;
  }[] = [];

  get presentationDiagnostics() {
    return this.getPresentationDiagnostics();
  }

  getPresentationDiagnostics(raw = false) {
    const sizes = this.encodedFrameSamples
      .flatMap((frame) => (frame.encodedBytes === undefined ? [] : [frame.encodedBytes]))
      .sort((a, b) => a - b);
    const keyframeMeasured = this.encodedFrameSamples.filter((frame) => frame.keyframe !== undefined).length;
    return {
      rendering: this.getRenderingDiagnostics(),
      selectedViewId: this.selectedViewId,
      callbackRegistration: 'after-work',
      presentationEndpoint: 'video-compositor-observation',
      encodedFrameBytes: {
        measured: sizes.length,
        p95: sizes.length ? sizes[Math.ceil(sizes.length * 0.95) - 1] : null,
        max: sizes.length ? sizes[sizes.length - 1] : null,
        keyframeMeasured,
        keyframes: keyframeMeasured
          ? this.encodedFrameSamples.filter((frame) => frame.keyframe === true).length
          : null,
      },
      ...this.presentation.snapshot(raw),
      ...(raw ? { encodedFrameSamples: this.encodedFrameSamples } : {}),
    };
  }

  resetPresentationDiagnostics() {
    for (const plane of this.videoPlanes.values()) plane.resetStats();
    this.freezeCopies = 0;
    this.mediaRefreshRequests = 0;
    this.presentation = new PresentationDiagnostics();
    this.encodedFrameSamples.length = 0;
  }

  recordPresentationCost(name: string, at: number, durationMs: number, view: string | null = null) {
    this.presentation.cost(name, at, durationMs, view);
  }

  get displayReady() {
    return (
      this.presentationBackend === 'video' &&
      [...this.videoPlanes].some(([renderer, plane]) => plane.ready && this.rendererCurrent(renderer))
    );
  }

  get presentedFrame() {
    let latest: VideoPresentation | undefined;
    for (const viewId of this.viewPresentations.keys()) {
      const frame = this.getLastPresentation(viewId);
      if (frame && (!latest || frame.paintedAt > latest.paintedAt)) latest = frame;
    }
    return latest ? { rtpTimestamp: latest.rtpTimestamp, layoutEpoch: latest.layoutEpoch } : null;
  }

  layout: Layout | null = null;

  private frameListeners = new Set<(viewId: string) => void>();

  private presentedListeners = new Set<(frame: VideoPresentation) => void>();

  private viewPresentations = new Map<string, VideoPresentation>();

  selectedViewId: string | undefined;

  private cancelPresentationAck(preserveAction = false) {
    if (!preserveAction) this.pendingPresentationAction = undefined;
    this.presentationAckSerial++;
    if (this.presentationAckRaf !== undefined) cancelAnimationFrame(this.presentationAckRaf);
    this.presentationAckRaf = undefined;
  }

  private afterPresentationHidden(channel: RTCDataChannel, action: () => void) {
    this.cancelPresentationAck();
    this.pendingPresentationAction = { channel, action };
    const serial = this.presentationAckSerial,
      attempt = this.ports.rtc.attempt;
    const current = () =>
      this.ports.endpoint.channel === channel &&
      channel.readyState === 'open' &&
      attempt === this.ports.rtc.attempt &&
      serial === this.presentationAckSerial;
    this.presentationAckRaf = requestAnimationFrame(() => {
      if (!current()) return;
      if (this.barrierState.phase === 'hiding') this.barrierState = { ...this.barrierState, turn: 1 };
      this.presentationAckRaf = requestAnimationFrame(() => {
        this.presentationAckRaf = undefined;
        if (!current()) return;
        // A hidden document may stop rAF indefinitely. Never release the gate
        // using a timer; resume still needs two foreground compositor turns.
        if (document.visibilityState !== 'visible') {
          this.afterPresentationHidden(channel, action);
          return;
        }
        if (this.barrierState.phase === 'hiding') this.barrierState = { ...this.barrierState, turn: 2 };
        this.pendingPresentationAction = undefined;
        action();
        this.notify();
      });
    });
  }

  private preparePresentation(key: PresentationBarrier, channel: RTCDataChannel) {
    if (this.ports.endpoint.channel !== channel || channel.readyState !== 'open') return;
    const current = this.presentationBarrier;
    // Reliable duplicate prepares identify the same hide transaction. Starting
    // two new rAF turns here can starve its ACK under frequent layout retries;
    // an already acknowledged transaction must also retain its ready planes.
    if (
      current &&
      current.barrierId === key.barrierId &&
      current.outputGeneration === key.outputGeneration &&
      current.layoutEpoch === key.layoutEpoch
    )
      return;
    // The serial is monotonic within the current peer/attempt (disconnect
    // clears it). A delayed old transaction cannot replace its newer barrier.
    if (current && BigInt(key.barrierId) < BigInt(current.barrierId)) return;
    this.hideVideoPlanes();
    this.presentationBarrier = key;
    this.presentationBarrierAcknowledged = false;
    this.afterPresentationHidden(channel, () => {
      if (
        this.presentationBackend !== 'video' ||
        this.presentationBarrier !== key ||
        !barrierMatchesLayout(key, this.layout)
      )
        return;
      this.presentationBarrierAcknowledged = true;
      this.ports.endpoint.sendChannel(channel, { type: 'presentation.ready', ...key });
      this.scheduleVideoMetadataRefresh();
    });
  }

  negotiatePresentation(channel: RTCDataChannel, restart = false) {
    if (this.ports.authorization.productLocked || this.ports.authorization.peerAuthEpoch === 0) return;
    if (restart) {
      this.presentationBackend = 'pending';
      this.presentationErrorCode = undefined;
      this.hideVideoPlanes();
      this.cancelPresentationAck();
      this.presentationBarrier = undefined;
      this.presentationBarrierAcknowledged = false;
      this.notify();
    }

    if (!this.presentationVisibility) {
      this.presentationVisibility = () => {
        this.hideVideoPlanes();
        if (document.visibilityState !== 'visible') this.cancelPresentationAck(true);
        else {
          const pending = this.pendingPresentationAction;
          if (pending) this.afterPresentationHidden(pending.channel, pending.action);
          this.requestPresentationRefresh();
          this.scheduleVideoMetadataRefresh();
        }
      };
      document.addEventListener('visibilitychange', this.presentationVisibility);
    }
    if (!this.videoSupported) {
      this.failPresentation('video-capability-unavailable');
      return;
    }
    this.ports.endpoint.sendChannel(channel, {
      type: 'media.presentation',
      version: 1,
      backend: 'video',
      ...(restart ? { restart: true } : {}),
    });
    clearTimeout(this.presentationNegotiationTimer);
    this.presentationNegotiationTimer = setTimeout(() => {
      if (
        this.ports.endpoint.channel === channel &&
        !this.ports.authorization.productLocked &&
        this.presentationBackend === 'pending'
      )
        this.failPresentation('presentation-protocol-unavailable');
    }, 1500);
  }

  private failPresentation(reason: PresentationErrorCode) {
    if (this.presentationBackend === 'unavailable') return;
    this.presentationBackend = 'unavailable';
    this.presentationErrorCode = reason;
    clearTimeout(this.presentationNegotiationTimer);
    this.presentationNegotiationTimer = undefined;
    this.cancelPresentationAck();
    this.presentationBarrier = undefined;
    this.presentationBarrierAcknowledged = false;
    for (const renderer of this.videoPlanes.keys()) this.detachVideoPlane(renderer);
    clearTimeout(this.videoMetadataRefreshTimer);
    this.videoMetadataRefreshTimer = undefined;
    this.viewPresentations.clear();
    this.notify();
  }

  private videoPlaneFor(viewId: string) {
    for (const [renderer, plane] of this.videoPlanes)
      if (renderer.view.id === viewId && this.rendererCurrent(renderer)) return { renderer, plane };
    return undefined;
  }

  fileInputBounds(viewId: string, anchor: FileRequestAnchor) {
    const current = this.videoPlaneFor(viewId);
    if (
      !this.ports.authorization.productReady ||
      !this.layout ||
      !current?.plane.ready ||
      document.hidden ||
      this.transitionBlocks.has(viewId)
    )
      return undefined;
    return projectFileInput(
      anchor,
      this.layout,
      current.renderer.view,
      current.renderer.canvas.getBoundingClientRect(),
      uiScale(),
    );
  }

  private hideVideoPlane(renderer: PlaneRenderer) {
    const plane = this.videoPlanes.get(renderer);
    if (!plane) return;
    if (plane.ready) this.presentationInvalidations.forEach((listener) => listener(renderer.view.id));
    plane.hide();
    this.viewPresentations.delete(renderer.view.id);
    renderer.ready(false);
    this.notify();
  }

  private hideVideoPlanes() {
    clearTimeout(this.videoMetadataRefreshTimer);
    this.videoMetadataRefreshTimer = undefined;
    for (const renderer of this.videoPlanes.keys()) this.hideVideoPlane(renderer);
  }

  private detachVideoPlane(renderer: PlaneRenderer) {
    const plane = this.videoPlanes.get(renderer);
    if (!plane) return;
    this.hideVideoPlane(renderer);
    this.videoPlanes.delete(renderer);
    plane.dispose();
  }

  private attachVideoPlane(renderer: PlaneRenderer) {
    if (
      !this.videoTrack ||
      !this.ports.rtc.peer ||
      !this.rendererCurrent(renderer) ||
      !this.layout ||
      !renderer.canvas.parentElement
    )
      return;
    const existing = this.videoPlanes.get(renderer);
    if (existing?.track === this.videoTrack) return;
    if (existing) this.detachVideoPlane(renderer);
    const peer = this.ports.rtc.peer,
      attempt = this.ports.rtc.attempt;
    const current = () =>
      this.ports.rtc.peer === peer &&
      this.ports.rtc.attempt === attempt &&
      this.videoPlanes.get(renderer) === plane;
    const plane = new VideoPlane(this.videoTrack, renderer, {
      resized: () => {
        if (!current()) return;
        this.hideVideoPlane(renderer);
        this.positionVideoPlane(renderer);
        this.requestPresentationRefresh();
        this.scheduleVideoMetadataRefresh();
      },
      frame: (metadata) => {
        if (current() && this.presentationBackend === 'video' && !this.ports.authorization.productLocked) {
          const at = performance.now();
          this.observeVideoPlane(renderer, plane, metadata);
          this.presentation.cost('videoCallbackTotal', at, performance.now() - at, renderer.view.id);
        }
      },
      failed: () => {
        if (current() && !this.ports.authorization.productLocked)
          this.failPresentation('video-playback-failed');
      },
    });
    this.videoPlanes.set(renderer, plane);
    this.positionVideoPlane(renderer);
    this.requestPresentationRefresh();
    this.scheduleVideoMetadataRefresh();
  }

  private positionVideoPlane(renderer: PlaneRenderer) {
    const plane = this.videoPlanes.get(renderer);
    return !!(plane && this.layout && this.rendererCurrent(renderer) && plane.position(this.layout));
  }

  private scheduleVideoMetadataRefresh() {
    // Narrow layouts retain mounted viewports for hidden Windows. Their old
    // receivers stay hidden, but cannot consume retries or fail current planes.
    const waitingPlanes = () =>
      [...this.videoPlanes].filter(([renderer, plane]) => {
        const bounds = renderer.canvas.getBoundingClientRect();
        const eligible =
          document.visibilityState === 'visible' &&
          this.presentationBarrierAcknowledged &&
          !!this.presentationBarrier &&
          barrierMatchesLayout(this.presentationBarrier, this.layout) &&
          this.rendererCurrent(renderer) &&
          !renderer.view.stale &&
          bounds.width > 0 &&
          bounds.height > 0;
        return eligible && !plane.ready;
      });
    if (this.presentationBackend !== 'video' || this.videoMetadataRefreshTimer || !waitingPlanes().length)
      return;
    const attempt = this.ports.rtc.attempt;
    this.videoMetadataRefreshTimer = setTimeout(
      () => {
        this.videoMetadataRefreshTimer = undefined;
        if (attempt !== this.ports.rtc.attempt || this.presentationBackend !== 'video') return;
        const waiting = waitingPlanes();
        if (!waiting.length) return;
        // A static source may lose its first frame or metadata. Keep requesting
        // at the shared refresh rate until the current viewport is authorized.
        this.requestPresentationRefresh();
        this.scheduleVideoMetadataRefresh();
      },
      Math.max(100, 1010 - (performance.now() - this.mediaRefreshAt)),
    );
  }

  private videoObservationCurrent(renderer: PlaneRenderer, plane: VideoPlane, observation: VideoObservation) {
    return (
      this.presentationBackend === 'video' &&
      this.videoPlanes.get(renderer) === plane &&
      plane.pendingObservation === observation &&
      plane.observationSequence === observation.sequence &&
      this.ports.rtc.peer === observation.peer &&
      this.ports.rtc.attempt === observation.attempt &&
      this.videoTrack === observation.track &&
      plane.track === observation.track &&
      this.presentationBarrier === observation.barrier &&
      this.presentationBarrierAcknowledged &&
      barrierMatchesLayout(observation.barrier, this.layout) &&
      document.visibilityState === 'visible' &&
      this.rendererCurrent(renderer) &&
      planeMatchesLayout(observation.identity, this.layout) &&
      samePlane(observation.identity.view, renderer.view) &&
      !renderer.view.stale &&
      plane.matchesAtlas(this.layout)
    );
  }

  private matchPendingVideoObservations() {
    for (const [renderer, plane] of this.videoPlanes) {
      const observation = plane.pendingObservation;
      if (!observation || !this.videoObservationCurrent(renderer, plane, observation)) continue;
      const epoch = this.frameGate.epochFor(observation.rtp);
      if (epoch === undefined) continue;
      if (epoch !== observation.barrier.layoutEpoch || !this.positionVideoPlane(renderer)) {
        this.hideVideoPlane(renderer);
        continue;
      }
      plane.pendingObservation = undefined;
      // Endpoint's ACK barrier guarantees stable geometry for every published
      // frame in this interval. This recovers layout authorization, not the
      // autonomous element's current RTP or a new compositor observation.
      const wasReady = plane.show(undefined, true);
      if (!wasReady) this.notify();
      this.presentation.authorize(performance.now(), observation.rtp, epoch);
      this.observations.emit({ rtp: observation.rtp, epoch, at: observation.at, wall: observation.wall });
      this.ports.rtc.markConnection('firstVideoCompositor');
      if (!wasReady) renderer.ready(true);
      this.frameListeners.forEach((listener) => listener(renderer.view.id));
    }
  }

  private observeVideoPlane(
    renderer: PlaneRenderer,
    plane: VideoPlane,
    metadata: VideoFrameCallbackMetadata,
  ) {
    const at = performance.now(),
      rtp = (metadata as VideoFrameCallbackMetadata & { rtpTimestamp?: number }).rtpTimestamp;
    const validRtp = Number.isInteger(rtp) && rtp! >= 0 && rtp! <= 0xffffffff;
    const epoch = validRtp ? this.frameGate.epochFor(rtp) : undefined;
    this.ports.rtc.markConnection('firstDecodedFrame');
    this.presentation.video(
      at,
      validRtp ? rtp : undefined,
      this.layout?.epoch,
      epoch,
      metadata,
      renderer.view.id,
    );
    plane.pendingObservation = undefined;
    plane.observationSequence++;
    const sameBarrier =
      this.presentationBarrierAcknowledged &&
      this.presentationBarrier &&
      barrierMatchesLayout(this.presentationBarrier, this.layout) &&
      document.visibilityState === 'visible' &&
      this.rendererCurrent(renderer) &&
      !renderer.view.stale &&
      plane.matchesAtlas(this.layout);
    if (!sameBarrier || !validRtp || !this.positionVideoPlane(renderer)) {
      this.hideVideoPlane(renderer);
      if (sameBarrier && !validRtp) this.failPresentation('video-rtp-metadata-unavailable');
      return;
    }
    if (epoch !== this.layout?.epoch) {
      // The Endpoint gate prevents a different layout entering this stable
      // barrier. Retain an already authorized view when only signaling is late,
      // but don't attach a stale RTP identity to the autonomous video's pixels.
      if (epoch !== undefined) this.hideVideoPlane(renderer);
      else {
        plane.stats.observe(at, metadata.presentedFrames, plane.ready, metadata);
        plane.rtp = undefined;
        plane.pendingObservation = {
          sequence: plane.observationSequence,
          barrier: this.presentationBarrier!,
          peer: this.ports.rtc.peer!,
          track: plane.track,
          attempt: this.ports.rtc.attempt,
          identity: {
            view: { ...renderer.view },
            layoutEpoch: renderer.layoutEpoch,
            layoutGeneration: renderer.layoutGeneration,
          },
          rtp: rtp!,
          at,
          wall: Date.now(),
        };
      }
      this.scheduleVideoMetadataRefresh();
      return;
    }
    // Exact current-RTP reports require THIS element's real callback.
    const wasReady = plane.ready;
    plane.stats.observe(at, metadata.presentedFrames, wasReady, metadata);
    plane.show(rtp);
    this.presentation.authorize(at, rtp!, epoch!);
    this.ports.rtc.markConnection('firstVideoCompositor');
    const old = this.viewPresentations.get(renderer.view.id);
    if (old?.rtpTimestamp !== rtp || old?.layoutEpoch !== epoch) {
      const frame: VideoPresentation = {
        viewId: renderer.view.id,
        rtpTimestamp: rtp!,
        layoutEpoch: epoch!,
        paintedAt: at,
        paintedWallTime: Date.now(),
        authorizedAt: at,
      };
      this.viewPresentations.set(renderer.view.id, frame);
      this.observations.emit({ rtp: rtp!, epoch: epoch!, at, wall: frame.paintedWallTime });
      this.presentedListeners.forEach((listener) => listener(frame));
    }
    if (!wasReady) renderer.ready(true);
    if (!wasReady) this.notify();
    this.frameListeners.forEach((listener) => listener(renderer.view.id));
  }

  subscribeFrames = (listener: (viewId: string) => void, viewId?: string) => {
    const callback =
      viewId === undefined
        ? listener
        : (id: string) => {
            if (id === viewId) listener(id);
          };
    this.frameListeners.add(callback);
    return () => {
      this.frameListeners.delete(callback);
    };
  };

  registerViewport(viewId: string, canvas: HTMLCanvasElement, ready: (ready: boolean) => void) {
    const registration: ViewportRegistration = { viewId, canvas, ready };
    this.viewports.add(registration);
    this.syncViewports();
    return () => {
      this.viewports.delete(registration);
      registration.remove?.();
    };
  }

  private syncViewports() {
    if (!this.layout) return;
    for (const registration of this.viewports) {
      const view = this.layout.views.find((view) => view.id === registration.viewId);
      if (!view) {
        if (registration.renderer) this.hideVideoPlane(registration.renderer);
        registration.ready(false);
        continue;
      }
      const identity = { view, layoutEpoch: this.layout.epoch, layoutGeneration: this.layout.generation };
      if (!registration.renderer) {
        const mounted = this.registerPlaneRenderer(identity, registration.canvas, registration.ready);
        registration.renderer = mounted.renderer;
        registration.remove = mounted.remove;
      } else {
        const renderer = registration.renderer;
        if (!planeMatchesLayout(renderer, this.layout)) {
          this.hideVideoPlane(renderer);
          renderer.ready(false);
        }
        Object.assign(renderer, identity, { view: { ...view } });
        if (this.presentationBackend === 'video') {
          this.attachVideoPlane(renderer);
          this.videoPlanes.get(renderer)?.resizeInput();
          this.positionVideoPlane(renderer);
        }
      }
    }
  }

  private registerPlaneRenderer(
    identity: PlaneIdentity,
    canvas: HTMLCanvasElement,
    ready: (ready: boolean) => void,
  ) {
    const renderer: PlaneRenderer = { ...identity, view: { ...identity.view }, canvas, ready };
    this.renderers.add(renderer);
    if (this.presentationBackend === 'video') this.attachVideoPlane(renderer);
    const remove = () => {
      this.detachVideoPlane(renderer);
      this.renderers.delete(renderer);
    };
    return { renderer, remove };
  }

  subscribePresentedFrames = (listener: (frame: VideoPresentation) => void) => {
    this.presentedListeners.add(listener);
    return () => {
      this.presentedListeners.delete(listener);
    };
  };

  private presentationInvalidations = new Set<(viewId: string) => void>();

  subscribePresentationInvalidation(listener: (viewId: string) => void) {
    this.presentationInvalidations.add(listener);
    return () => {
      this.presentationInvalidations.delete(listener);
    };
  }

  getLastPresentation(viewId: string) {
    const current = this.videoPlaneFor(viewId),
      frame = this.viewPresentations.get(viewId);
    return current?.plane.ready && current.plane.rtp === frame?.rtpTimestamp ? frame : undefined;
  }

  getPresentedPlane(viewId: string, rtpTimestamp: number): PresentedPlaneSource | undefined {
    const current = this.videoPlaneFor(viewId),
      layout = this.layout;
    if (!current || !current.plane.ready || current.plane.rtp !== rtpTimestamp || !layout) return undefined;
    return current.plane.presentedSource(layout, rtpTimestamp);
  }

  canInput(viewId: string): InputAuthority | null {
    const frame = this.videoPlaneFor(viewId)?.plane.ready;
    const surface = this.layout?.views.find((view) => view.id === viewId);
    return frame && surface && !this.ports.authorization.productLocked && !this.transitionBlocks.has(viewId)
      ? { surface, layout: this.layout!, attempt: this.ports.rtc.attempt }
      : null;
  }

  private rendererCurrent(renderer: PlaneRenderer) {
    return (
      this.renderers.has(renderer) && renderer.canvas.isConnected && planeMatchesLayout(renderer, this.layout)
    );
  }

  handle(message: Incoming) {
    const channel = this.ports.endpoint.channel!;
    if (message.type === 'presentation.mode') {
      if (message.version !== 1 || message.backend !== 'video')
        this.failPresentation('invalid-presentation-mode');
      else if (this.presentationBackend === 'pending') {
        clearTimeout(this.presentationNegotiationTimer);
        this.presentationNegotiationTimer = undefined;
        this.presentationBackend = 'video';
        for (const renderer of this.renderers) this.attachVideoPlane(renderer);
        this.notify();
      }
    }
    if (message.type === 'presentation.prepare' && this.presentationBackend === 'video') {
      const key = presentationBarrier(message);
      if (!key || !barrierMatchesLayout(key, this.layout))
        this.failPresentation('invalid-presentation-barrier');
      else this.preparePresentation(key, channel);
    }
    if (message.type === 'layout' && Array.isArray(message.views)) {
      if (
        !this.layout ||
        this.layout.epoch !== message.epoch ||
        this.layout.generation !== message.generation
      ) {
        this.hideVideoPlanes();
        this.presentationBarrierAcknowledged = false;
      }

      this.layout = message;
      this.syncViewports();
      for (const renderer of this.renderers)
        if (!this.rendererCurrent(renderer)) {
          this.hideVideoPlane(renderer);
          renderer.ready(false);
        }
      this.notify();
    }
    if (message.type === 'frame') {
      const start = performance.now();
      if (Number.isInteger(message.rtpTimestamp) && typeof message.layoutEpoch === 'string') {
        this.presentation.frameMetadata(start, message.rtpTimestamp, message.layoutEpoch);
        this.encodedFrameSamples.push({
          at: start,
          rtpTimestamp: message.rtpTimestamp,
          layoutEpoch: message.layoutEpoch,
          encodedBytes: typeof message.encodedBytes === 'number' ? message.encodedBytes : undefined,
          keyframe: typeof message.keyframe === 'boolean' ? message.keyframe : undefined,
        });
        if (this.encodedFrameSamples.length > 2400) this.encodedFrameSamples.shift();
      }
      this.frameGate.record(message.rtpTimestamp, message.layoutEpoch);
      this.matchPendingVideoObservations();
      if (message.layoutEpoch === this.layout?.epoch) this.scheduleVideoMetadataRefresh();
      this.presentation.cost('frameMessageTotal', start, performance.now() - start);
    }
  }

  setTrack(track: MediaStreamTrack) {
    this.videoTrack = track;
    if (this.presentationBackend === 'video')
      for (const renderer of this.renderers) this.attachVideoPlane(renderer);
  }

  reset() {
    clearTimeout(this.videoMetadataRefreshTimer);
    this.videoMetadataRefreshTimer = undefined;
    clearTimeout(this.presentationNegotiationTimer);
    this.presentationNegotiationTimer = undefined;
    this.cancelPresentationAck();
    this.hideVideoPlanes();
    for (const renderer of this.videoPlanes.keys()) this.detachVideoPlane(renderer);
    if (this.presentationVisibility)
      globalThis.document?.removeEventListener('visibilitychange', this.presentationVisibility);
    this.presentationVisibility = undefined;
    this.presentationBarrier = undefined;
    this.presentationBarrierAcknowledged = false;
    this.presentationErrorCode = undefined;
    this.presentationBackend = 'pending';
    this.mediaRefreshAt = -Infinity;
    this.frameGate.clear();
    this.viewPresentations.clear();
    for (const renderer of this.renderers) renderer.ready(false);
    this.renderers.clear();
    for (const registration of this.viewports) {
      registration.renderer = undefined;
      registration.remove = undefined;
    }
    this.layout = null;
    this.notify();
  }

  readonly transitionBlocks = new Set<string>();

  setTransitionBlocked(viewId: string, blocked: boolean) {
    if (blocked) this.transitionBlocks.add(viewId);
    else this.transitionBlocks.delete(viewId);
  }

  private notify() {
    const next: PresentationSnapshot = {
      error: this.presentationError,
      canRetry: this.canRetryPresentation,
      backend: this.backendState,
      barrier: this.barrierState,
      layout: this.layout && { ...this.layout, views: this.layout.views.map((view) => ({ ...view })) },
      views: Object.fromEntries(
        [...this.videoPlanes].map(([renderer, plane]) => [
          renderer.view.id,
          plane.ready
            ? { phase: 'ready' as const }
            : this.rendererCurrent(renderer) && this.presentationBarrierAcknowledged
              ? { phase: 'awaitingFrame' as const }
              : { phase: 'hidden' as const },
        ]),
      ),
    };
    if (canonicalJson(next) === canonicalJson(this.snapshot)) return;
    this.snapshot = freezeSnapshot(next);
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();

  private snapshot: PresentationSnapshot = {
    backend: { phase: 'pending' },
    barrier: { phase: 'none' },
    views: {},
    layout: null,
    canRetry: false,
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  sampleVideoWindows(at: number) {
    return [...this.videoPlanes].map(([renderer, plane]) => ({
      viewId: renderer.view.id,
      token: plane,
      counters: plane.stats,
      revision: plane.stats.observationRevision,
      window: plane.sampleWindow(at, this.rendererCurrent(renderer)),
      timing: plane.stats.timing(at),
    }));
  }
  currentVideoWindows(windows: ReturnType<PresentationSession['sampleVideoWindows']>) {
    return windows.filter((sample) =>
      [...this.videoPlanes].some(
        ([renderer, plane]) =>
          plane === sample.token &&
          plane.ready &&
          this.rendererCurrent(renderer) &&
          plane.stats === sample.counters &&
          plane.stats.observationRevision === sample.revision,
      ),
    );
  }
  feedbackPlanes() {
    return [...this.renderers]
      .filter((renderer) => this.rendererCurrent(renderer) && VideoPlane.visible(renderer.canvas))
      .map((renderer) => ({ view: renderer.view.id, frames: this.videoPlanes.get(renderer)?.stats.frames }));
  }

  onRtc = (event: import('../rtc/rtc-session').RtcEvent) => {
    if (event.type === 'track' && event.track.kind === 'video') this.setTrack(event.track);
    else if (event.type === 'closed') {
      this.videoTrack = undefined;
      this.reset();
    }
  };
  onChannel = (event: import('../rtc/endpoint-channel').ChannelEvent) => {
    if (event.type === 'open') this.negotiatePresentation(this.ports.endpoint.channel!);
  };
  onAuthorization = () => {
    if (!this.ports.authorization.productLocked && this.ports.endpoint.channel?.readyState === 'open')
      this.negotiatePresentation(this.ports.endpoint.channel, true);
  };
}
