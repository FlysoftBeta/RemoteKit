import { surfacePixelScale } from './coordinates';
import { AuthCameraChannel, type CameraBinding } from './auth-camera-channel';
import { DcFileClient } from './dc-file-client';
import { projectFileInput } from './file-chooser-anchor';
import { barrierMatchesLayout, configurePresentationVideo, presentationBarrier, videoPlaneGeometry, VideoCompositorStats, type PresentationBarrier } from './video-presentation';
import { CaptureLatency } from './capture-latency';
import { ClockDomain, ClockProbe } from './clock-domain';
import { ViewerAudioOutput, stereoOpusOffer } from './audio-output';
import { mergeTouchMoves, mergeGestureMomentum } from './touch-input';
import { request, type Diagnostics, type Layout, type Surface, type VideoPresentation } from './types';
import { FrameEpochGate } from './frame-epoch';
import { configureReceiveOffer, originalGatheredOffer, probeReceiveCapabilities, loadReceiveProfile, selectProductReceiveProfile, type ProductReceiveSelection, type ReceiveProfile } from './receive-profile';
import { ReconnectPolicy } from './reconnect';
import { PresentationDiagnostics } from './presentation-diagnostics';
import { planeMatchesLayout, samePlane, type PlaneIdentity, type PresentedPlaneSource } from './plane-source';
import { MediaFeedbackSampler } from './media-feedback';
import { configureReceiverPlayout } from './receiver-playout';
import type { FileRequestAnchor, ProductOperation, OperationReceipt, RtcServerSignal } from '../shared/product';
import { MobileEditingState } from './mobile-editing-state';

export type ControlRpc = (method: 'rtc.offer' | 'rtc.ice' | 'rtc.close' | 'clock.ping' | 'feedback', params: unknown) => Promise<unknown>;
interface InputRequest { surface: Surface; identity: string; event: Record<string, unknown> }
interface QueuedInput extends InputRequest { epoch: string; generation: string; requiresTerminalState: boolean }
export interface InputResult extends InputRequest { sequence: string; ok: boolean; error?: string; touchState?: 'accepted-pending' | 'processed' | 'terminal-invalidated' | 'terminal-unconfirmed' | 'rejected'; touchSequenceId?: string }
export interface InputDelivery extends InputRequest { phase: 'queued' | 'submitted' | 'discarded' | 'unconfirmed'; sequence?: string; reason?: string; layoutEpoch?: string; authorization?: number }
export interface TouchRetireLease { surface: Surface; identity: string; layoutEpoch: string; authorization?: number }
interface TerminalInput extends InputRequest { requiresTerminalState: boolean; pending: boolean; retries: number; timer?: ReturnType<typeof setTimeout>; retirement?: boolean }
const terminalQueryDelays = [250, 500, 1000, 2000];
function counterDelta(current: unknown, previous?: number) {
  return typeof current === 'number' && typeof previous === 'number' && Number.isFinite(current - previous) && current >= previous
    ? current - previous : undefined;
}
function tracksTerminal(event: Record<string, unknown>) {
  return event.type === 'touch' && (event.gestureMode === 'client-v1' || event.gestureMode === 'legacy') &&
    typeof event.sequenceId === 'string' && (event.action === 'end' || event.action === 'cancel');
}

interface PlaneRenderer extends PlaneIdentity { canvas: HTMLCanvasElement; ready: (ready: boolean) => void }
interface ViewportRegistration { viewId: string; canvas: HTMLCanvasElement; ready: (ready: boolean) => void; renderer?: PlaneRenderer; remove?: () => void }
interface VideoObservation { sequence: number; barrier: PresentationBarrier; peer: RTCPeerConnection; track: MediaStreamTrack; attempt: number; identity: PlaneIdentity; rtp: number; at: number; wall: number }
interface VideoPlane { video: HTMLVideoElement; track: MediaStreamTrack; clip: HTMLDivElement; observer: ResizeObserver; callback?: number; ready: boolean; rtp?: number; stats: VideoCompositorStats; observationSequence: number; pendingObservation?: VideoObservation; geometry?: number[] }

const presentationErrors = {
  'video-capability-unavailable': '浏览器缺少视频呈现所需的功能。',
  'video-rtp-metadata-unavailable': '浏览器未提供视频帧时间戳，无法安全显示远程页面。',
  'video-playback-failed': '浏览器无法播放远程视频。',
  'presentation-protocol-unavailable': '远程视频呈现协商超时。',
  'invalid-presentation-mode': '远程节点返回了不兼容的视频呈现模式。',
  'invalid-presentation-barrier': '远程节点返回了无效的视频布局信息。',
} as const;
type PresentationErrorCode = keyof typeof presentationErrors;

/** All endpoint wire adaptation lives here; the UI never owns recovery state. */
export class RemoteTransport {
  private readonly authCamera = new AuthCameraChannel(() => this.notify());
  get authCameraReady() { return this.authCamera.ready; }
  get cameraDiagnostics() { return { peerAttempt: this.attempt, ...this.authCamera.diagnostics }; }
  setAuthCamera(stream?: MediaStream, binding?: CameraBinding) { this.authCamera.setSource(stream, binding); }
  recentAuthCameraFrame(challengeId: string) { return this.authCamera.hasRecentFrame(challengeId); }
  readonly mobileEditing = new MobileEditingState();
  private freezeCopies = 0;
  recordResizeFreezeCopy() { this.freezeCopies++; }
  readonly files=new DcFileClient(() => this.productLocked || this.peerAuthEpoch === 0 ? null : this.channel, () => this.peerAuthEpoch);
  private productLocked = false;
  private peerAuthEpoch?: number;
  get productReady() {
    return !this.productLocked && (this.peerAuthEpoch ?? 0) > 0 && this.channel?.readyState === 'open';
  }
  observePeerAuthorization(epoch: number) {
    if (this.peerAuthEpoch === epoch) return;
    // An authorization transition resets the native layout and edit revision.
    // Install its identity before accepting any new DataChannel messages.
    this.setProductLocked(true);
    this.peerAuthEpoch = epoch;
    this.setAuthCamera();
  }
  private sendChannel(channel: RTCDataChannel, message: object) {
    if (this.peerAuthEpoch === 0) return;
    channel.send(JSON.stringify(this.peerAuthEpoch === undefined ? message : { ...message, authEpoch: this.peerAuthEpoch }));
  }
  setProductLocked(locked: boolean) {
    if (locked === this.productLocked) return;
    this.productLocked = locked;
    this.audio.setMuted(locked);
    if (!locked) {
      if (this.channel?.readyState === 'open') this.negotiatePresentation(this.channel, true);
      return;
    }
    this.mobileEditing.reset();
    this.cancelPendingFocus(undefined, 'authorization-change');
    this.inputFocus.clear();
    this.discardQueuedInput('authorization-change');
    this.sentInput.clear();
    this.clearTerminalInput();
    this.files.disconnect();
    this.layout = null;
    this.clientGestures = false;
    this.frameGate.clear();
    this.hideVideoPlanes();
    this.cancelPresentationAck();
    this.presentationBarrier = undefined;
    this.presentationBarrierAcknowledged = false;
    clearTimeout(this.presentationNegotiationTimer);
    this.presentationNegotiationTimer = undefined;
    this.viewPresentations.clear();
    for (const entry of this.productPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error('浏览器已锁定'), { operationSent: entry.sent }));
    }
    this.productPending.clear();
    this.notify();
  }
  private productPending = new Map<string,{operation:ProductOperation;resolve:(receipt:OperationReceipt)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;sent:boolean}>();
  productAction(operation:ProductOperation):Promise<OperationReceipt> {
    if (this.productLocked) return Promise.reject(Object.assign(new Error('浏览器已锁定'), { operationSent: false }));
    if(this.productPending.size>=64)return Promise.reject(new Error('待确认操作过多，请等待同步'));
    return new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{const sent=this.productPending.get(operation.operationId)?.sent??false;this.productPending.delete(operation.operationId);reject(Object.assign(new Error(sent?'操作结果未知，正在核对；请勿重复执行':'数据通道尚未连接，操作未发送'),{operationSent:sent}));},20000);this.productPending.set(operation.operationId,{operation,resolve,reject,timer,sent:false});this.flushProductActions(); });
  }
  private flushProductActions() { const channel=this.channel;if(this.productLocked || this.peerAuthEpoch === 0 || channel?.readyState!=='open')return;for(const entry of this.productPending.values()){if(entry.sent)continue;try{this.sendChannel(channel,{type:'product.action',version:1,...entry.operation});entry.sent=true;}catch{/* Leave unsent intent pending until the bounded deadline. */}} }
  readonly audio = new ViewerAudioOutput(() => this.notify());
  readonly touchInputStats = { queued: 0, merged: 0, dropped: 0, cancelled: 0, sourceGestures: 0, arrivalFallbackGestures: 0 };
  clientGestures = false;
  private queuedInput: QueuedInput[] = [];
  private inputDrainTimer?: ReturnType<typeof setTimeout>;
  private focusTimer?: ReturnType<typeof setTimeout>;
  private inputFocus = new Map<string, { token: string; identity: string; focused: boolean }>();
  private editingSurfaces: readonly Surface[] = [];
  editingSurface(viewId: string) {
    const views = this.layout?.reconfiguring ? this.editingSurfaces : this.layout?.views;
    return views?.find(view => view.id === viewId);
  }
  inputIdentity(surface: Surface) { const known = this.inputFocus.get(surface.id); return `${this.attempt}:${surface.session}:${surface.id}:${surface.instance}:${surface.document}:${this.layout?.generation}:${this.layout?.epoch}:${known?.token === surface.focus ? known.identity : surface.focus}`; }
  editingIdentity(surface: Surface) { return `${this.attempt}:${surface.session}:${surface.id}:${surface.instance}:${surface.document}`; }
  private inputResultListeners = new Set<(result: InputResult) => void>();
  private inputDeliveryListeners = new Set<(result: InputDelivery) => void>();
  private sentInput = new Map<string, InputRequest>();
  private terminalInput = new Map<string, TerminalInput>();
  subscribeInputResults(listener: (result: InputResult) => void) { this.inputResultListeners.add(listener); return () => { this.inputResultListeners.delete(listener); }; }
  subscribeInputDelivery(listener: (delivery: InputDelivery) => void) { this.inputDeliveryListeners.add(listener); return () => { this.inputDeliveryListeners.delete(listener); }; }
  ensureInputFocus(surface: Surface) { const known = this.inputFocus.get(surface.id); if (known?.focused && known.token === surface.focus) return; this.focus(surface, true); }
  touchStartWall(sampleAt: number) { return this.latency.inputStart(sampleAt, performance.now(), Date.now()); }
  trickleIce = false;
  readonly connectionAttempts: { attemptId: string; signalingMode: string; startedAt: number; marks: Record<string, number>; error?: string }[] = [];
  private signalAttemptId?: string;
  private remoteSignalConnection?: string;
  private remoteDescriptionReady = false;
  private remoteIce: RTCIceCandidateInit[] = [];
  private localIce: RTCIceCandidateInit[] = [];
  private iceDelivery: Promise<void> = Promise.resolve();
  private localIceDelivery: Promise<void> = Promise.resolve();
  private markConnection(name: string) { const trace = this.connectionAttempts[this.connectionAttempts.length - 1]; if (trace && trace.attemptId === this.signalAttemptId && trace.marks[name] === undefined) trace.marks[name] = performance.now() - trace.startedAt; }
  receiveServerSignal(message: RtcServerSignal) {
    const peer = this.peer;
    if (!peer || message.attemptId !== this.signalAttemptId || this.connectionId && message.connectionId !== this.connectionId) return;
    if (this.remoteSignalConnection && message.connectionId !== this.remoteSignalConnection) return;
    this.remoteSignalConnection = message.connectionId;
    if (message.signal.type === 'complete') { this.markConnection('remoteGatherComplete'); return; }
    if (message.signal.type === 'error') { this.connectionFailed(message.signal.message); return; }
    if (this.remoteIce.length >= 256) { this.connectionFailed('远端 ICE 候选超过上限'); return; }
    this.markConnection('remoteFirstCandidate'); this.remoteIce.push(message.signal.candidate);
    this.flushRemoteIce(peer);
  }
  private flushRemoteIce(peer: RTCPeerConnection) {
    if (!this.remoteDescriptionReady) return;
    const attemptId = this.signalAttemptId;
    this.iceDelivery = this.iceDelivery.then(async () => {
      while (this.peer === peer && this.signalAttemptId === attemptId && this.remoteIce.length) await peer.addIceCandidate(this.remoteIce.shift()!);
    }).catch(error => { if (this.peer === peer && this.signalAttemptId === attemptId) this.connectionFailed('ICE candidate rejected: ' + String(error)); });
  }
  private flushLocalIce(peer: RTCPeerConnection) {
    const connectionId = this.connectionId, attemptId = this.signalAttemptId;
    if (!connectionId || !attemptId || this.peer !== peer) return;
    this.localIceDelivery = this.localIceDelivery.then(async () => {
      while (this.peer === peer && this.signalAttemptId === attemptId && this.localIce.length) await this.rtcRequest('rtc.ice', { connectionId, attemptId, candidate: this.localIce.shift()! });
    }).catch(error => { if (this.peer === peer && this.signalAttemptId === attemptId) this.connectionFailed('ICE candidate delivery failed: ' + String(error)); });
  }
  private controlRpc: ControlRpc | undefined;
  private diagnosticHttp = false;
  private productReceiveSelection?: ProductReceiveSelection;
  private receiveFallback?: Record<string, unknown>;
  private latency = new CaptureLatency();
  private endpointClockProbe = new ClockProbe(this.latency.endpointClock);
  private controlClock = new ClockDomain();
  private controlClockProbe = new ClockProbe(this.controlClock);
  private feedbackReading = false;
  private displayHzEstimate?: number;
  private videoTrack?: MediaStreamTrack;
  private presentationBackend: 'pending' | 'video' | 'unavailable' = 'pending';
  private presentationErrorCode?: PresentationErrorCode;
  get presentationError() { return this.presentationErrorCode ? presentationErrors[this.presentationErrorCode] : undefined; }
  get canRetryPresentation() { return this.presentationErrorCode === 'video-playback-failed' || this.presentationErrorCode === 'presentation-protocol-unavailable'; }
  retryPresentation() { if (this.canRetryPresentation && this.channel?.readyState === 'open') this.negotiatePresentation(this.channel, true); }
  private presentationNegotiationTimer?: ReturnType<typeof setTimeout>;
  private presentationBarrier?: PresentationBarrier;
  private presentationBarrierAcknowledged = false;
  private presentationAckRaf?: number;
  private presentationAckSerial = 0;
  private pendingPresentationAction?: { channel: RTCDataChannel; action: () => void };
  private videoPlanes = new Map<PlaneRenderer, VideoPlane>();
  private presentationVisibility?: () => void;
  private videoMetadataRefreshTimer?: ReturnType<typeof setTimeout>;

  setControlRpc(callback: ControlRpc) { this.observePeerAuthorization(0); this.controlRpc = callback; this.diagnosticHttp = false; }
  enableDiagnosticHttp() { this.diagnosticHttp = true; this.controlRpc = undefined; }
  private rtcRequest<T>(method: 'rtc.offer' | 'rtc.ice' | 'rtc.close' | 'clock.ping' | 'feedback', params: unknown): Promise<T> {
    if (this.controlRpc) return this.controlRpc(method, params) as Promise<T>;
    if (this.diagnosticHttp) return request<T>('/api/' + method.replace('.', '/'), params);
    return Promise.reject(new Error('Control WebSocket 未连接'));
  }
  receiveProfile: ReceiveProfile = loadReceiveProfile();
  signaling: Record<string, unknown> | undefined;
  probeReceiveCapabilities = probeReceiveCapabilities;
  private readonly capabilityVideo = this.createReceiverVideo();
  private renderers = new Set<PlaneRenderer>();
  private viewports = new Set<ViewportRegistration>();
  private mediaRefreshRequests = 0;
  private mediaRefreshAt = -Infinity;
  private requestPresentationRefresh() {
    const channel=this.channel;if(!this.peer||channel?.readyState!=='open'||performance.now()-this.mediaRefreshAt<1000)return;
    if (this.productLocked || this.peerAuthEpoch === 0 || this.presentationBackend !== 'video') return;
    this.mediaRefreshAt=performance.now();try{this.sendChannel(channel,{type:'media.refresh'});this.mediaRefreshRequests++;}catch{/* A closed peer cannot refresh this presentation. */}
  }
  private getRenderingDiagnostics() {
    return {
      backend: this.presentationBackend,
      backendReason: this.presentationErrorCode,
      videoCompositorByView: Object.fromEntries([...this.videoPlanes].map(([renderer, plane]) =>
        [renderer.view.id, plane.stats.snapshot(performance.now())])),
      visibility: globalThis.document?.visibilityState,
      freezeCopies: this.freezeCopies,
      mediaRefreshRequests: this.mediaRefreshRequests,
    };
  }
  private frameGate = new FrameEpochGate();
  private presentation = new PresentationDiagnostics();
  readonly encodedFrameSamples: { at: number; rtpTimestamp: number; layoutEpoch: string; encodedBytes?: number; keyframe?: boolean }[] = [];
  get presentationDiagnostics() { return this.getPresentationDiagnostics(); }
  getPresentationDiagnostics(raw = false) {
    const sizes = this.encodedFrameSamples.flatMap(frame => frame.encodedBytes === undefined ? [] : [frame.encodedBytes]).sort((a, b) => a - b);
    const keyframeMeasured = this.encodedFrameSamples.filter(frame => frame.keyframe !== undefined).length;
    return {
      rendering: this.getRenderingDiagnostics(), touchInput: { ...this.touchInputStats },
      selectedViewId: this.selectedViewId, callbackRegistration: 'after-work',
      presentationEndpoint: 'video-compositor-observation',
      encodedFrameBytes: {
        measured: sizes.length, p95: sizes.length ? sizes[Math.ceil(sizes.length * .95) - 1] : null,
        max: sizes.length ? sizes[sizes.length - 1] : null, keyframeMeasured,
        keyframes: keyframeMeasured ? this.encodedFrameSamples.filter(frame => frame.keyframe === true).length : null,
      },
      ...this.presentation.snapshot(raw), ...(raw ? { encodedFrameSamples: this.encodedFrameSamples } : {}),
    };
  }
  resetPresentationDiagnostics() {
    for (const plane of this.videoPlanes.values()) plane.stats = new VideoCompositorStats();
    this.freezeCopies = 0; this.mediaRefreshRequests = 0;
    this.presentation = new PresentationDiagnostics(); this.encodedFrameSamples.length = 0;
  }
  recordClientRaf(at: number) { this.presentation.clientRaf(at); }
  recordPresentationCost(name: string, at: number, durationMs: number, view: string | null = null) { this.presentation.cost(name, at, durationMs, view); }
  get displayReady() { return this.presentationBackend === 'video' && [...this.videoPlanes].some(([renderer, plane]) => plane.ready && this.rendererCurrent(renderer)); }
  get presentedFrame() {
    let latest: VideoPresentation | undefined;
    for (const viewId of this.viewPresentations.keys()) {
      const frame = this.getLastPresentation(viewId);
      if (frame && (!latest || frame.paintedAt > latest.paintedAt)) latest = frame;
    }
    return latest ? { rtpTimestamp: latest.rtpTimestamp, layoutEpoch: latest.layoutEpoch } : null;
  }
  layout: Layout | null = null;
  diagnostics: Diagnostics = { connection: '未连接', channel: '未连接' };
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private listeners = new Set<() => void>();
  private frameListeners = new Set<() => void>();
  private presentedListeners = new Set<(frame: VideoPresentation) => void>();
  private viewPresentations = new Map<string, VideoPresentation>();
  selectedViewId: string | undefined;
  private lastInboundSample: { id: string; timestamp: number; bytes: number; frames?: number; emitted?: number; jitterDelay?: number; decodeTime?: number; framesDropped?: number } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private statsReadingPeer: RTCPeerConnection | undefined;
  private networkRead: { peer: RTCPeerConnection; connectionId: string } | undefined;
  private mediaFeedback = new MediaFeedbackSampler({
    now: () => performance.now(), visible: () => document.visibilityState === 'visible',
    requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
    onVisibility: callback => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
  });
  private sequence = 0n;
  readonly inputTrace: Record<string, unknown>[] = [];
  readonly inputResults: Record<string, unknown>[] = [];
  private traceInput(phase: string, surface: Surface, event: Record<string, unknown>, reason?: string) { this.inputTrace.push({ at: performance.now(), phase, view: surface.id, eventType: event.type, action: event.action, reason, epoch: this.layout?.epoch, ...(event.type === 'touch' ? { sourceClock: event.clockMode, sampleElapsedUs: event.sampleElapsedUs, touchSequenceId: event.sequenceId } : {}) }); if (this.inputTrace.length > 128) this.inputTrace.shift(); }
  private focusSequence = 0n;
  private pendingFocus: { requestId: string; acknowledged: boolean; focused: boolean; view: string; session: string; token: string; instance: string; document: string; generation: string; epoch: string; events: QueuedInput[] } | null = null;
  private attempt = 0;
  private connectionId: string | undefined;
  private endpointGeneration: number | undefined;
  private reconnect = new ReconnectPolicy();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectingPromise: Promise<void> | undefined;
  private pendingFailure: string | undefined;
  private manualRestart = false;
  private createReceiverVideo() {
    const video = document.createElement('video');
    configurePresentationVideo(video);
    return video;
  }
  private cancelPresentationAck(preserveAction = false) {
    if (!preserveAction) this.pendingPresentationAction = undefined;
    this.presentationAckSerial++;
    if (this.presentationAckRaf !== undefined) cancelAnimationFrame(this.presentationAckRaf);
    this.presentationAckRaf = undefined;
  }
  private afterPresentationHidden(channel: RTCDataChannel, action: () => void) {
    this.cancelPresentationAck();
    this.pendingPresentationAction = { channel, action };
    const serial = this.presentationAckSerial, attempt = this.attempt;
    const current = () => this.channel === channel && channel.readyState === 'open' && attempt === this.attempt && serial === this.presentationAckSerial;
    this.presentationAckRaf = requestAnimationFrame(() => {
      if (!current()) return;
      this.presentationAckRaf = requestAnimationFrame(() => {
        this.presentationAckRaf = undefined;
        if (!current()) return;
        // A hidden document may stop rAF indefinitely. Never release the gate
        // using a timer; resume still needs two foreground compositor turns.
        if (document.visibilityState !== 'visible') { this.afterPresentationHidden(channel, action); return; }
        this.pendingPresentationAction = undefined;
        action();
      });
    });
  }
  private preparePresentation(key: PresentationBarrier, channel: RTCDataChannel) {
    if (this.channel !== channel || channel.readyState !== 'open') return;
    const current = this.presentationBarrier;
    // Reliable duplicate prepares identify the same hide transaction. Starting
    // two new rAF turns here can starve its ACK under frequent layout retries;
    // an already acknowledged transaction must also retain its ready planes.
    if (current && current.barrierId === key.barrierId && current.outputGeneration === key.outputGeneration && current.layoutEpoch === key.layoutEpoch) return;
    // The serial is monotonic within the current peer/attempt (disconnect
    // clears it). A delayed old transaction cannot replace its newer barrier.
    if (current && BigInt(key.barrierId) < BigInt(current.barrierId)) return;
    this.hideVideoPlanes(); this.presentationBarrier = key; this.presentationBarrierAcknowledged = false;
    this.afterPresentationHidden(channel, () => {
      if (this.presentationBackend !== 'video' || this.presentationBarrier !== key || !barrierMatchesLayout(key, this.layout)) return;
      this.presentationBarrierAcknowledged = true;
      this.sendChannel(channel, { type: 'presentation.ready', ...key });
      this.scheduleVideoMetadataRefresh();
    });
  }
  private negotiatePresentation(channel: RTCDataChannel, restart = false) {
    if (this.productLocked || this.peerAuthEpoch === 0) return;
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
    if (typeof this.capabilityVideo.requestVideoFrameCallback !== 'function' || typeof ResizeObserver !== 'function') {
      this.failPresentation('video-capability-unavailable'); return;
    }
    this.sendChannel(channel, { type: 'media.presentation', version: 1, backend: 'video', ...(restart ? { restart: true } : {}) });
    clearTimeout(this.presentationNegotiationTimer);
    this.presentationNegotiationTimer = setTimeout(() => {
      if (this.channel === channel && !this.productLocked && this.presentationBackend === 'pending') this.failPresentation('presentation-protocol-unavailable');
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
    for (const [renderer, plane] of this.videoPlanes) if (renderer.view.id === viewId && this.rendererCurrent(renderer)) return { renderer, plane };
    return undefined;
  }
  fileInputBounds(viewId: string, anchor: FileRequestAnchor) {
    const current = this.videoPlaneFor(viewId);
    if (!this.productReady || !this.layout || !current?.plane.ready || document.hidden ||
        current.renderer.canvas.closest('.resize-waiting')) return undefined;
    return projectFileInput(anchor, this.layout, current.renderer.view, current.renderer.canvas.getBoundingClientRect());
  }
  private hideVideoPlane(renderer: PlaneRenderer) {
    const plane = this.videoPlanes.get(renderer);
    if (!plane) return;
    plane.clip.style.opacity = '0'; plane.ready = false; plane.rtp = undefined; plane.pendingObservation = undefined; plane.observationSequence++; plane.stats.resetObservation();
    this.viewPresentations.delete(renderer.view.id); renderer.ready(false);
  }
  private hideVideoPlanes() {
    clearTimeout(this.videoMetadataRefreshTimer); this.videoMetadataRefreshTimer = undefined;
    for (const renderer of this.videoPlanes.keys()) this.hideVideoPlane(renderer);
  }
  private detachVideoPlane(renderer: PlaneRenderer) {
    const plane = this.videoPlanes.get(renderer);
    if (!plane) return;
    this.hideVideoPlane(renderer); this.videoPlanes.delete(renderer);
    plane.observer.disconnect();
    if (plane.callback !== undefined) plane.video.cancelVideoFrameCallback?.(plane.callback);
    plane.video.onerror = null;
    plane.video.pause(); plane.video.srcObject = null; plane.clip.remove();
    renderer.canvas.style.opacity = ''; renderer.canvas.removeAttribute('data-video-input');
  }
  private attachVideoPlane(renderer: PlaneRenderer) {
    if (!this.videoTrack || !this.peer || !this.rendererCurrent(renderer) || !this.layout) return;
    const existing = this.videoPlanes.get(renderer);
    if (existing?.track === this.videoTrack) return;
    if (existing) this.detachVideoPlane(renderer);
    const canvas = renderer.canvas, parent = canvas.parentElement;
    if (!parent) return;
    const video = this.createReceiverVideo(), clip = document.createElement('div');
    clip.className = 'remote-video-plane'; clip.setAttribute('aria-hidden', 'true');
    Object.assign(clip.style, { position: 'absolute', overflow: 'hidden', pointerEvents: 'none', opacity: '0' });
    Object.assign(video.style, { position: 'absolute', maxWidth: 'none', maxHeight: 'none', objectFit: 'fill', pointerEvents: 'none' });
    clip.append(video); parent.insertBefore(clip, canvas);
    canvas.width = renderer.view.width; canvas.height = renderer.view.height;
    canvas.style.opacity = '0'; canvas.setAttribute('data-video-input', 'true');
    const observer = new ResizeObserver(() => {
      if (!this.videoPlanes.has(renderer)) return;
      this.hideVideoPlane(renderer); this.positionVideoPlane(renderer); this.requestPresentationRefresh(); this.scheduleVideoMetadataRefresh();
    });
    const plane: VideoPlane = { video, track: this.videoTrack, clip, observer, ready: false, stats: new VideoCompositorStats(), observationSequence: 0 };
    this.videoPlanes.set(renderer, plane); observer.observe(canvas); observer.observe(parent); this.positionVideoPlane(renderer);
    const peer = this.peer, attempt = this.attempt;
    const current = () => this.peer === peer && this.attempt === attempt && this.videoTrack === plane.track && this.videoPlanes.get(renderer) === plane;
    const receive = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (!current()) return;
      try {
        if (this.presentationBackend === 'video' && !this.productLocked) {
          const at = performance.now();
          this.observeVideoPlane(renderer, plane, metadata);
          this.presentation.cost('videoCallbackTotal', at, performance.now() - at, renderer.view.id);
        }
      } finally {
        // Renegotiation may be pending while a retained element delivers a
        // frame from the old barrier. Keep observing without authorizing it.
        if (current()) plane.callback = video.requestVideoFrameCallback(receive);
      }
    };
    const playbackFailed = () => {
      if (!this.productLocked && current()) this.failPresentation('video-playback-failed');
    };
    plane.callback = video.requestVideoFrameCallback(receive);
    video.onerror = playbackFailed;
    video.srcObject = new MediaStream([this.videoTrack]);
    void video.play().catch(playbackFailed);
    // Static sources need one fresh frame for a newly mounted video element.
    this.requestPresentationRefresh();
    this.scheduleVideoMetadataRefresh();
  }
  private positionVideoPlane(renderer: PlaneRenderer) {
    const plane = this.videoPlanes.get(renderer), layout = this.layout, parent = renderer.canvas.parentElement;
    if (!plane || !layout || !parent || !this.rendererCurrent(renderer)) return false;
    const bounds = renderer.canvas.getBoundingClientRect(), container = parent.getBoundingClientRect();
    const geometry = videoPlaneGeometry(renderer.view, layout, bounds);
    if (!geometry) return false;
    const left = bounds.left - container.left, top = bounds.top - container.top;
    const position = [left, top, bounds.width, bounds.height, geometry.left, geometry.top, geometry.width, geometry.height];
    if (position.every((value, index) => value === plane.geometry?.[index])) return true;
    plane.geometry = position;
    Object.assign(plane.clip.style, { left: `${left}px`, top: `${top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    for (const [name, value] of Object.entries(geometry)) plane.video.style.setProperty(name, `${value}px`);
    return true;
  }
  private scheduleVideoMetadataRefresh() {
    // Narrow layouts retain mounted viewports for hidden Windows. Their old
    // receivers stay hidden, but cannot consume retries or fail current planes.
    const waitingPlanes = () => [...this.videoPlanes].filter(([renderer, plane]) => {
      const bounds = renderer.canvas.getBoundingClientRect();
      const eligible = document.visibilityState === 'visible' && this.presentationBarrierAcknowledged &&
        !!this.presentationBarrier && barrierMatchesLayout(this.presentationBarrier, this.layout) &&
        this.rendererCurrent(renderer) && !renderer.view.stale && bounds.width > 0 && bounds.height > 0;
      return eligible && !plane.ready;
    });
    if (this.presentationBackend !== 'video' || this.videoMetadataRefreshTimer || !waitingPlanes().length) return;
    const attempt = this.attempt;
    this.videoMetadataRefreshTimer = setTimeout(() => {
      this.videoMetadataRefreshTimer = undefined;
      if (attempt !== this.attempt || this.presentationBackend !== 'video') return;
      const waiting = waitingPlanes();
      if (!waiting.length) return;
      // A static source may lose its first frame or metadata. Keep requesting
      // at the shared refresh rate until the current viewport is authorized.
      this.requestPresentationRefresh();
      this.scheduleVideoMetadataRefresh();
    }, Math.max(100, 1010 - (performance.now() - this.mediaRefreshAt)));
  }
  private videoObservationCurrent(renderer: PlaneRenderer, plane: VideoPlane, observation: VideoObservation) {
    return this.presentationBackend === 'video' && this.videoPlanes.get(renderer) === plane && plane.pendingObservation === observation &&
      plane.observationSequence === observation.sequence && this.peer === observation.peer && this.attempt === observation.attempt &&
      this.videoTrack === observation.track && plane.track === observation.track && this.presentationBarrier === observation.barrier &&
      this.presentationBarrierAcknowledged && barrierMatchesLayout(observation.barrier, this.layout) &&
      document.visibilityState === 'visible' && this.rendererCurrent(renderer) && planeMatchesLayout(observation.identity, this.layout) &&
      samePlane(observation.identity.view, renderer.view) && !renderer.view.stale &&
      plane.video.videoWidth === this.layout?.width && plane.video.videoHeight === this.layout.height;
  }
  private matchPendingVideoObservations() {
    for (const [renderer, plane] of this.videoPlanes) {
      const observation = plane.pendingObservation;
      if (!observation || !this.videoObservationCurrent(renderer, plane, observation)) continue;
      const epoch = this.frameGate.epochFor(observation.rtp);
      if (epoch === undefined) continue;
      if (epoch !== observation.barrier.layoutEpoch || !this.positionVideoPlane(renderer)) { this.hideVideoPlane(renderer); continue; }
      plane.pendingObservation = undefined;
      // Endpoint's ACK barrier guarantees stable geometry for every published
      // frame in this interval. This recovers layout authorization, not the
      // autonomous element's current RTP or a new compositor observation.
      const wasReady = plane.ready;
      plane.ready = true; plane.rtp = undefined;
      if (!wasReady) {
        plane.stats.resetObservation();
        plane.clip.style.opacity = '1';
      }
      this.presentation.authorize(performance.now(), observation.rtp, epoch);
      this.latency.paint(observation.rtp, epoch, observation.at, observation.wall);
      this.reconnect.connected(); this.markConnection('firstVideoCompositor');
      if (!wasReady) renderer.ready(true);
      this.flushFocusedInput(); this.frameListeners.forEach(listener => listener());
    }
  }
  private observeVideoPlane(renderer: PlaneRenderer, plane: VideoPlane, metadata: VideoFrameCallbackMetadata) {
    const at = performance.now(), rtp = (metadata as VideoFrameCallbackMetadata & { rtpTimestamp?: number }).rtpTimestamp;
    const validRtp = Number.isInteger(rtp) && rtp! >= 0 && rtp! <= 0xffffffff;
    const epoch = validRtp ? this.frameGate.epochFor(rtp) : undefined;
    this.markConnection('firstDecodedFrame');
    this.presentation.video(at, validRtp ? rtp : undefined, this.layout?.epoch, epoch, metadata, renderer.view.id);
    plane.pendingObservation = undefined; plane.observationSequence++;
    const sameBarrier = this.presentationBarrierAcknowledged && this.presentationBarrier && barrierMatchesLayout(this.presentationBarrier, this.layout) &&
      document.visibilityState === 'visible' && this.rendererCurrent(renderer) && !renderer.view.stale &&
      plane.video.videoWidth === this.layout?.width && plane.video.videoHeight === this.layout.height;
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
        plane.stats.observe(at, metadata.presentedFrames, plane.ready, metadata); plane.rtp = undefined;
        plane.pendingObservation = { sequence: plane.observationSequence, barrier: this.presentationBarrier!, peer: this.peer!, track: plane.track, attempt: this.attempt,
          identity: { view: { ...renderer.view }, layoutEpoch: renderer.layoutEpoch, layoutGeneration: renderer.layoutGeneration }, rtp: rtp!, at, wall: Date.now() };
      }
      this.scheduleVideoMetadataRefresh();
      return;
    }
    // Exact current-RTP reports require THIS element's real callback.
    const wasReady = plane.ready;
    plane.stats.observe(at, metadata.presentedFrames, wasReady, metadata);
    plane.rtp = rtp; plane.ready = true;
    if (!wasReady) plane.clip.style.opacity = '1';
    this.presentation.authorize(at, rtp!, epoch!); this.reconnect.connected();
    this.markConnection('firstVideoCompositor');
    const old = this.viewPresentations.get(renderer.view.id);
    if (old?.rtpTimestamp !== rtp || old?.layoutEpoch !== epoch) {
      const frame: VideoPresentation = { viewId: renderer.view.id, rtpTimestamp: rtp!, layoutEpoch: epoch!, paintedAt: at, paintedWallTime: Date.now(), authorizedAt: at };
      this.viewPresentations.set(renderer.view.id, frame);
      this.latency.paint(rtp!, epoch!, at, frame.paintedWallTime);
      this.presentedListeners.forEach(listener => listener(frame));
    }
    if (!wasReady) renderer.ready(true);
    this.flushFocusedInput();
    this.frameListeners.forEach(listener => listener());
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeFrames = (listener: () => void) => { this.frameListeners.add(listener); return () => { this.frameListeners.delete(listener); }; };
  // Product viewports outlive layout messages, input tokens and document
  // identities. Only their authorization changes; the receiver keeps playing.
  registerViewport(viewId: string, canvas: HTMLCanvasElement, ready: (ready: boolean) => void) {
    const registration: ViewportRegistration = { viewId, canvas, ready };
    this.viewports.add(registration); this.syncViewports();
    return () => { this.viewports.delete(registration); registration.remove?.(); };
  }
  private syncViewports() {
    if (!this.layout) return;
    for (const registration of this.viewports) {
      const view = this.layout.views.find(view => view.id === registration.viewId);
      if (!view) {
        if (registration.renderer) this.hideVideoPlane(registration.renderer);
        registration.ready(false); continue;
      }
      const identity = { view, layoutEpoch: this.layout.epoch, layoutGeneration: this.layout.generation };
      if (!registration.renderer) {
        const mounted = this.registerPlaneRenderer(identity, registration.canvas, registration.ready);
        registration.renderer = mounted.renderer; registration.remove = mounted.remove;
      } else {
        const renderer = registration.renderer;
        if (!planeMatchesLayout(renderer, this.layout)) { this.hideVideoPlane(renderer); renderer.ready(false); }
        Object.assign(renderer, identity, { view: { ...view } });
        if (this.presentationBackend === 'video') {
          if (renderer.canvas.width !== view.width) renderer.canvas.width = view.width;
          if (renderer.canvas.height !== view.height) renderer.canvas.height = view.height;
          this.attachVideoPlane(renderer); this.positionVideoPlane(renderer);
        }
      }
    }
  }
  registerPlane(identity: PlaneIdentity, canvas: HTMLCanvasElement, ready: (ready: boolean) => void) {
    return this.registerPlaneRenderer(identity, canvas, ready).remove;
  }
  private registerPlaneRenderer(identity: PlaneIdentity, canvas: HTMLCanvasElement, ready: (ready: boolean) => void) {
    const renderer: PlaneRenderer = { ...identity, view: { ...identity.view }, canvas, ready };
    this.renderers.add(renderer);
    if (this.presentationBackend === 'video') this.attachVideoPlane(renderer);
    const remove = () => { this.detachVideoPlane(renderer); this.renderers.delete(renderer); };
    return { renderer, remove };
  }
  subscribePresentedFrames = (listener: (frame: VideoPresentation) => void) => { this.presentedListeners.add(listener); return () => { this.presentedListeners.delete(listener); }; };
  getLastPresentation(viewId: string) {
    const current = this.videoPlaneFor(viewId), frame = this.viewPresentations.get(viewId);
    return current?.plane.ready && current.plane.rtp === frame?.rtpTimestamp ? frame : undefined;
  }
  getPresentedPlane(viewId: string, rtpTimestamp: number): PresentedPlaneSource | undefined {
    const current = this.videoPlaneFor(viewId), layout = this.layout;
    if (!current || !current.plane.ready || current.plane.rtp !== rtpTimestamp || !layout) return undefined;
    const view = current.renderer.view;
    return { image: current.plane.video, sourceRect: { x: view.x, y: view.y, width: view.width, height: view.height }, kind: 'atlas', viewId,
      rtpTimestamp, layoutEpoch: layout.epoch, encodedWidth: view.width, encodedHeight: view.height, pixelsPerDip: surfacePixelScale(view), pixelsPerDipY: surfacePixelScale(view, 'y') };
  }
  private canInput(viewId: string) { return this.presentationBackend === 'video' && !!this.videoPlaneFor(viewId)?.plane.ready; }
  private notify() { this.listeners.forEach(listener => listener()); }
  private update(change: Partial<Diagnostics>) { this.diagnostics = { ...this.diagnostics, ...change }; this.notify(); }
  private configureReceiver(receiver: RTCRtpReceiver | undefined, kind: string) {
    if (!receiver || (kind !== 'video' && kind !== 'audio')) return;
    this.update({ receiverPlayout: { ...this.diagnostics.receiverPlayout, [kind]: configureReceiverPlayout(receiver) } });
  }
  setMarkerStats(report: { inputToObservedMs: { p50: number | null; p95: number | null }; renderToObservedMs: { p50: number | null; p95: number | null }; samples: unknown[]; markerSampleHz?: number | null }) {
    const input = report.inputToObservedMs; const render = report.renderToObservedMs;
    const measured = input.p50 !== null ? input : render; const kind = input.p50 !== null ? 'input' : 'render';
    this.update({ markerSampleHz: typeof report.markerSampleHz === 'number' ? report.markerSampleHz : undefined, marker: measured.p50 === null || measured.p95 === null ? undefined : { kind, p50: measured.p50, p95: measured.p95, samples: report.samples.length } });
  }
  async connect() {
    this.reconnect.start(); clearTimeout(this.retryTimer); this.retryTimer = undefined; this.pendingFailure = undefined;
    if (this.connectingPromise) {
      this.manualRestart = true; this.closeLocal(); await this.connectingPromise;
      if (!this.reconnect.wanted || !this.manualRestart) return;
      this.manualRestart = false;
    }
    await this.beginConnection();
  }
  private beginConnection(): Promise<void> {
    if (this.connectingPromise) return this.connectingPromise;
    const job = this.establish().finally(() => {
      if (this.connectingPromise === job) this.connectingPromise = undefined;
      if (this.pendingFailure && !this.manualRestart) { const reason = this.pendingFailure; this.pendingFailure = undefined; this.scheduleReconnect(reason); }
    });
    this.connectingPromise = job; return job;
  }
  private scheduleReconnect(reason: string) {
    if (!this.reconnect.wanted || this.retryTimer) return;
    if (this.connectingPromise) { this.pendingFailure = reason; return; }
    const retry = this.reconnect.schedule();
    if (!retry) { if (this.reconnect.attempt >= 3) this.update({ connection: '连接失败', error: `${reason}；自动重连已尝试 3 次，请点击重新连接。` }); return; }
    this.update({ connection: `${retry.delayMs / 1000} 秒后重连（${retry.attempt}/3）`, error: reason });
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; if (this.reconnect.beginRetry()) void this.beginConnection(); }, retry.delayMs);
  }
  private connectionFailed(reason: string) { const trace=this.connectionAttempts[this.connectionAttempts.length-1];if(trace){trace.error=reason;this.markConnection('failed');}this.closeLocal(); this.update({ connection: '连接失败', error: reason }); this.scheduleReconnect(reason); }
  observeEndpointGeneration(generation: number | undefined) {
    if (generation !== undefined && this.endpointGeneration !== undefined && this.endpointGeneration !== generation && this.reconnect.wanted && this.peer) this.connectionFailed('Endpoint 已重启，正在恢复原工作台');
  }
  private async establish() {
    this.closeLocal(); this.signaling = undefined;
    const attempt = ++this.attempt;
    this.signalAttemptId = `${Date.now()}-${attempt}`;
    this.connectionAttempts.push({ attemptId: this.signalAttemptId, signalingMode: this.trickleIce ? 'trickle' : 'full-gather-compatibility', startedAt: performance.now(), marks: {} });
    if (this.connectionAttempts.length > 4) this.connectionAttempts.shift();
    let negotiating = false;
    this.update({ connection: '正在连接', error: undefined });
    try {
      const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
      peer.onicecandidate = event => {
        if (this.peer !== peer) return;
        if (!event.candidate) { this.markConnection('localGatherComplete'); return; }
        this.markConnection('localFirstCandidate');
        if (!this.trickleIce) return;
        if (this.localIce.length >= 256) { this.connectionFailed('本地 ICE 候选超过上限'); return; }
        this.localIce.push(event.candidate.toJSON()); this.flushLocalIce(peer);
      };
      peer.oniceconnectionstatechange = () => { if (this.peer === peer && ['connected', 'completed'].includes(peer.iceConnectionState)) this.markConnection('iceConnected'); };
      this.peer = peer;
      const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
      this.configureReceiver(transceiver.receiver, 'video');
      this.configureReceiver(peer.addTransceiver('audio', { direction: 'recvonly' }).receiver, 'audio');
      const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
      if (codecs && typeof transceiver.setCodecPreferences === 'function') transceiver.setCodecPreferences([...codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264'), ...codecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/h264')]);
      peer.onconnectionstatechange = () => {
        if (this.peer !== peer) return;
        if (peer.connectionState === 'connected') { this.markConnection('connected'); clearTimeout(this.retryTimer); this.retryTimer = undefined; this.pendingFailure = undefined; }
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed' || peer.connectionState === 'disconnected') { this.connectionFailed('媒体连接已中断'); return; }
        const labels: Record<string, string> = { new: '正在连接', connecting: '正在连接', connected: '已连接', disconnected: '连接中断', failed: '连接失败', closed: '未连接' };
        this.update({ connection: labels[peer.connectionState] ?? peer.connectionState });
      };
      peer.ontrack = event => {
        if (this.peer !== peer || this.attempt !== attempt) return;
        this.configureReceiver(event.receiver, event.track.kind);
        if (event.track.kind === 'audio') { this.audio.attach(event.track); return; }
        this.markConnection('track');
        this.videoTrack = event.track;
        if (this.presentationBackend === 'video') for (const renderer of this.renderers) this.attachVideoPlane(renderer);
      };
      this.bindChannel(peer.createDataChannel('remotekit', { ordered: true }));
      if (this.controlRpc && !this.diagnosticHttp)
        this.authCamera.bind(peer.createDataChannel('remotekit-auth', { ordered: true }));
      peer.ondatachannel = event => {
        if (this.peer === peer && this.attempt === attempt && event.channel.label === 'remotekit') this.bindChannel(event.channel);
      };
      if (this.controlRpc && !this.diagnosticHttp) {
        this.markConnection('receiveProbeStart');
        if (!this.productReceiveSelection) this.productReceiveSelection = await selectProductReceiveProfile(navigator.userAgent, codecs);
        if (attempt !== this.attempt) return;
        this.receiveProfile = this.productReceiveSelection.profile;
        this.markConnection('receiveProbeEnd');
        this.update({ receiveSelection: this.productReceiveSelection });
      }
      negotiating = true;
      this.markConnection('createOfferStart');
      const originalOffer = await peer.createOffer();
      this.markConnection('createOfferEnd');
      const effectiveOffer = configureReceiveOffer(originalOffer.sdp ?? '', this.receiveProfile, navigator.userAgent, codecs);
      effectiveOffer.sdp = stereoOpusOffer(effectiveOffer.sdp);
      this.signaling = { receiveSelection: this.productReceiveSelection, previousNegotiationFailure: this.receiveFallback, receiveProfile: this.receiveProfile, originalOfferSdp: originalOffer.sdp, effectiveOfferSdp: effectiveOffer.sdp, changes: effectiveOffer.changes };
      await peer.setLocalDescription({ type: 'offer', sdp: effectiveOffer.sdp });
      this.markConnection('setLocalEnd');
      if (!this.trickleIce) await new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === 'complete') { resolve(); return; }
        const timeout = setTimeout(() => { cleanup(); reject(new Error('ICE 收集超时，请检查网络后重试。')); }, 12000);
        const changed = () => { if (peer.iceGatheringState === 'complete' || peer.signalingState === 'closed') { cleanup(); resolve(); } };
        const cleanup = () => { clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', changed); peer.removeEventListener('signalingstatechange', changed); };
        peer.addEventListener('icegatheringstatechange', changed);
        peer.addEventListener('signalingstatechange', changed);
      });
      if (attempt !== this.attempt) return;
      this.signaling = { receiveSelection: this.productReceiveSelection, previousNegotiationFailure: this.receiveFallback, receiveProfile: this.receiveProfile, originalOfferSdp: originalOffer.sdp, originalGatheredSdp: originalGatheredOffer(peer.localDescription?.sdp ?? '', originalOffer.sdp ?? ''), effectiveOfferSdp: peer.localDescription?.sdp, changes: effectiveOffer.changes };
      this.markConnection('offerSent');
      const answer = await this.rtcRequest<RTCSessionDescriptionInit & { connectionId: string; endpointGeneration?: number; signalingMode?: string; networkSimulation?: Record<string, unknown> }>('rtc.offer', { type: 'offer', sdp: peer.localDescription?.sdp, ...(this.trickleIce ? { trickle: true, attemptId: this.signalAttemptId } : {}) });
      this.markConnection('answerReceived');
      if (attempt !== this.attempt) { void this.rtcRequest('rtc.close', { connectionId: answer.connectionId }).catch(() => {}); return; }
      this.connectionId = answer.connectionId;
      if (this.remoteSignalConnection && this.remoteSignalConnection !== answer.connectionId) throw new Error('媒体协商连接身份不一致');
      this.endpointGeneration = answer.endpointGeneration;
      this.signaling.answerSdp = answer.sdp;
      this.signaling.controlNegotiationTiming = (answer as any).negotiationTiming;
      this.signaling.connectionTiming = this.connectionAttempts[this.connectionAttempts.length - 1];
      if (answer.signalingMode) this.connectionAttempts[this.connectionAttempts.length - 1].signalingMode = answer.signalingMode;
      this.update({ connectionId: answer.connectionId, networkSimulation: answer.networkSimulation });
      await peer.setRemoteDescription(answer);
      this.markConnection('setRemoteEnd'); this.remoteDescriptionReady = true;
      this.flushRemoteIce(peer); this.flushLocalIce(peer);
      negotiating = false;
      if (attempt !== this.attempt) return;
      this.mediaFeedback.start();
      this.timer = setInterval(() => { this.sampleEndpointClock(); void this.readStats(peer); }, this.controlRpc ? 1000 : 1500);
    } catch (error) {
      if (attempt !== this.attempt) return;
      const trace = this.connectionAttempts[this.connectionAttempts.length - 1]; if (trace) { trace.error = error instanceof Error ? error.message : String(error); this.markConnection('failed'); }
      if (negotiating && this.controlRpc && !this.diagnosticHttp && ['h264-level42-experimental', 'h264-level51', 'h264-level52'].includes(this.productReceiveSelection?.profile ?? '') && /codec|H264|H\.264|profile.level|SDP|sdp|VideoDecoder|setRemoteDescription|setLocalDescription/i.test(String(error)) && !/timeout|超时|ICE|断开|未就绪|不可用|cancel|取消/i.test(String(error))) {
        this.receiveFallback = { ...this.signaling, failure: error instanceof Error ? error.message : String(error) };
        this.productReceiveSelection = this.productReceiveSelection?.profile === 'h264-level52' ? { profile: 'h264-level51', reason: 'Level5.2 codec negotiation failed; trying verified level5.1: ' + String(error) } : this.productReceiveSelection?.profile === 'h264-level51' ? {profile:'h264-level42-experimental',reason:'Level5.1 codec negotiation failed; trying verified level4.2: '+String(error)} : { profile: 'native', reason: 'Level4.2 codec negotiation failed; using native compatibility offer: ' + String(error) };
      }
      this.connectionFailed(error instanceof Error ? error.message : String(error));
    }
  }
  private rendererCurrent(renderer: PlaneRenderer) { return this.renderers.has(renderer) && renderer.canvas.isConnected && planeMatchesLayout(renderer, this.layout); }
  private flushFocusedInput() {
    const pending = this.pendingFocus;
    if (!pending || !this.canInput(pending.view)) return;
    const surface = this.layout?.views.find(view => view.id === pending.view);
    if (!pending.acknowledged || !surface || surface.session !== pending.session || surface.instance !== pending.instance || surface.document !== pending.document || this.layout?.generation !== pending.generation || this.layout.epoch !== pending.epoch) return;
    if (this.inputFocus.get(pending.view)?.token !== surface.focus) {
      this.cancelPendingFocus(pending.requestId);
      return;
    }
    this.pendingFocus = null;
    if (!pending.focused) return;
    for (const item of pending.events) this.queuedInput.push({ ...item, surface: { ...surface } });
    this.drainInput();
  }
  private reportInputDelivery(request: InputRequest & { epoch?: string }, phase: InputDelivery['phase'], sequence?: string, reason?: string) {
    if (request.event.type !== 'touch' && request.event.type !== 'gesture') return;
    const delivery = { phase, surface: request.surface, identity: request.identity, event: request.event, sequence, reason, layoutEpoch: request.epoch, authorization: this.peerAuthEpoch };
    queueMicrotask(() => this.inputDeliveryListeners.forEach(listener => listener(delivery)));
  }
  private discardQueuedInput(reason: string, staleOnly = false) {
    this.queuedInput = this.queuedInput.filter(item => {
      if (staleOnly && this.queuedInputCurrent(item)) return true;
      this.touchInputStats.dropped++;
      this.reportInputDelivery(item, 'discarded', undefined, reason);
      return false;
    });
  }
  private queuedInputCurrent(item: QueuedInput) {
    const current = this.layout?.views.find(view => view.id === item.surface.id);
    if (current && samePlane(current, item.surface) && current.focus === item.surface.focus &&
        this.layout?.epoch === item.epoch && this.layout?.generation === item.generation &&
        this.inputIdentity(current) === item.identity) return current;
  }
  private cancelPendingFocus(requestId = this.pendingFocus?.requestId, reason = 'focus-changed') {
    const pending = this.pendingFocus;
    if (!pending || pending.requestId !== requestId) return false;
    clearTimeout(this.focusTimer); this.focusTimer = undefined;
    if (this.inputFocus.get(pending.view)?.identity === requestId) this.inputFocus.delete(pending.view);
    this.pendingFocus = null;
    for (const item of pending.events) this.reportInputDelivery(item, 'discarded', undefined, reason);
    return true;
  }
  private clearTerminalInput() {
    for (const entry of this.terminalInput.values()) clearTimeout(entry.timer);
    this.terminalInput.clear();
  }
  private reservedTerminalInput() {
    return this.terminalInput.size + this.queuedInput.filter(item => tracksTerminal(item.event)).length +
      (this.pendingFocus?.events.filter(item => tracksTerminal(item.event)).length ?? 0);
  }
  private pruneTerminalInput() {
    for (const [sequence, entry] of this.terminalInput) {
      if (entry.retirement) continue;
      const view = this.layout?.views.find(view => view.id === entry.surface.id);
      if (view && this.inputIdentity(view) === entry.identity) continue;
      clearTimeout(entry.timer);
      this.terminalInput.delete(sequence);
    }
  }
  private scheduleTerminalQuery(sequence: string, entry: TerminalInput) {
    if (entry.event.gestureMode !== 'client-v1') {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (this.terminalInput.get(sequence) === entry) this.reportInputDelivery(entry, 'unconfirmed', sequence, 'terminal-result-timeout');
      }, 2000);
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.terminalInput.get(sequence) !== entry) return;
      if (entry.retries === terminalQueryDelays.length) {
        this.reportInputDelivery(entry, 'unconfirmed', sequence, 'terminal-query-timeout');
        return;
      }
      const channel = this.channel;
      if (channel?.readyState === 'open' && !this.productLocked && this.peerAuthEpoch !== 0 && channel.bufferedAmount <= 256 * 1024) {
        try { this.sendChannel(channel, { type: 'input.touchStatus', clientSequence: sequence, sequenceId: entry.event.sequenceId }); }
        catch { /* The next bounded query can still recover an original result. */ }
      }
      entry.retries++;
      this.scheduleTerminalQuery(sequence, entry);
    }, terminalQueryDelays[entry.retries] ?? 1000);
  }
  retryTouchTerminal(identity: string, sequenceId: string) {
    if (this.productLocked || this.channel?.readyState !== 'open' || this.peerAuthEpoch === 0) return false;
    const entry = [...this.terminalInput.entries()].reverse().find(([, request]) => request.identity === identity && request.event.sequenceId === sequenceId);
    if (!entry || entry[1].event.gestureMode !== 'client-v1') return false;
    const [sequence, request] = entry;
    if (request.timer === undefined) {
      request.retries = 0;
      this.scheduleTerminalQuery(sequence, request);
    }
    return true;
  }
  touchRetirementCurrent(lease: TouchRetireLease) {
    return !this.productLocked && this.peerAuthEpoch !== 0 && this.peerAuthEpoch === lease.authorization &&
      lease.identity.startsWith(`${this.attempt}:`);
  }
  retireTouch(lease: TouchRetireLease, event: Record<string, unknown>) {
    const channel = this.channel;
    if (!this.touchRetirementCurrent(lease) || channel?.readyState !== 'open' || channel.bufferedAmount > 256 * 1024 ||
        !this.layout || this.layout.epoch === lease.layoutEpoch || event.type !== 'touch' ||
        event.gestureMode !== 'client-v1' || event.action !== 'cancel' || typeof event.sequenceId !== 'string' ||
        this.reservedTerminalInput() >= 64) return false;
    const { id: view, session, instance, document, focus } = lease.surface;
    const sequence = String(++this.sequence);
    try {
      this.sendChannel(channel, { type: 'input.touchRetire', view, session, instance, document, focus, layoutEpoch: lease.layoutEpoch, sequence, sequenceId: event.sequenceId });
    } catch { return false; }
    const entry = { surface: lease.surface, identity: lease.identity, event, requiresTerminalState: true, pending: false, retries: 0, retirement: true };
    this.terminalInput.set(sequence, entry);
    this.scheduleTerminalQuery(sequence, entry);
    return true;
  }
  private receiveInputResult(message: Record<string, unknown>) {
    const sequence = String(message.clientSequence);
    const terminal = this.terminalInput.get(sequence);
    const sent = terminal ?? this.sentInput.get(sequence);
    if (!sent) return;
    const ok = message.ok === true;
    const touchSequenceId = typeof message.touchSequenceId === 'string' ? message.touchSequenceId : undefined;
    const state = message.touchState;
    const touchState: InputResult['touchState'] =
      (state === 'accepted-pending' || state === 'processed') && ok ||
      (state === 'terminal-invalidated' || state === 'terminal-unconfirmed' || state === 'rejected') && !ok ? state : undefined;
    if (state !== undefined && (!touchState || sent.event.type !== 'touch' || !touchSequenceId || touchSequenceId !== sent.event.sequenceId)) return;
    if (touchState === 'accepted-pending') {
      if (!terminal || terminal.pending) return;
      terminal.pending = true;
    } else if (terminal) {
      if ((!touchState && (!ok || terminal.pending || terminal.requiresTerminalState)) ||
          (terminal.pending && touchState === 'rejected')) return;
      // An unresolved original request remains available to later status replies.
      if (touchState !== 'terminal-unconfirmed') {
        clearTimeout(terminal.timer);
        this.terminalInput.delete(sequence);
      }
    } else {
      this.sentInput.delete(sequence);
    }
    if (touchState === 'terminal-invalidated' || touchState === 'processed' && terminal?.requiresTerminalState) {
      // An exact settled sequence also retires previous timed-out attempts.
      // Their mutations are never replayed, and their timers need no more reads.
      for (const [otherSequence, request] of this.terminalInput) {
        if (request.identity !== sent.identity || request.event.sequenceId !== touchSequenceId) continue;
        clearTimeout(request.timer);
        this.terminalInput.delete(otherSequence);
      }
    }
    const error = typeof message.error === 'string' ? message.error : undefined;
    for (const listener of this.inputResultListeners) listener({ surface: sent.surface, identity: sent.identity, event: sent.event, sequence, ok, error, touchState, touchSequenceId });
    if (!ok && touchState !== 'terminal-unconfirmed') this.update({ error: error ?? '远程输入被拒绝' });
  }
  private bindChannel(channel: RTCDataChannel) {
    if (channel !== this.channel) { this.endpointClockProbe.reset(); this.latency.reset(); }
    this.channel = channel;
    channel.bufferedAmountLowThreshold = 64 * 1024;
    channel.onbufferedamountlow = () => { if (this.channel === channel) this.drainInput(); };
    channel.onopen = () => { if (this.channel === channel) { this.sampleEndpointClock(); this.flushProductActions(); this.markConnection('dataChannelOpen'); this.negotiatePresentation(channel); this.update({ channel: '已连接' }); } };
    channel.onclose = () => { if (this.channel === channel) this.connectionFailed('输入通道已关闭'); };
    channel.onerror = () => { if (this.channel === channel) this.connectionFailed('输入通道出现错误'); };
    channel.onmessage = event => {
      if (this.channel !== channel) return;
      try {
        const message = JSON.parse(String(event.data));
        if (this.peerAuthEpoch !== undefined && (this.peerAuthEpoch === 0 || message.authEpoch !== this.peerAuthEpoch)) return;
        if (message.type === 'clock.pong') { this.endpointClockProbe.pong(message, performance.now(), Date.now()); return; }
        if (this.productLocked) return;
        if (message.type === 'input.editable') {
          const pending = this.layout?.reconfiguring === true;
          if (this.mobileEditing.receive(message, pending ? this.editingSurfaces : this.layout?.views ?? [], Date.now(), pending)) this.notify();
          return;
        }
        if (message.type === 'input.capabilities') this.clientGestures = message.clientGestures === 1;
        if(this.files.handle(message))return;
        if(message.type==='product.result' && message.version===1) { const entry=this.productPending.get(message.operationId);if(entry && entry.operation.operationGeneration===message.operationGeneration) {clearTimeout(entry.timer);this.productPending.delete(message.operationId);entry.resolve(message.result ?? {operationId:message.operationId,operationGeneration:message.operationGeneration,status:'rejected',error:String(message.error??'操作被拒绝')});} }
        if (message.type === 'presentation.mode') {
          if (message.version !== 1 || message.backend !== 'video') this.failPresentation('invalid-presentation-mode');
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
          if (!key || !barrierMatchesLayout(key, this.layout)) this.failPresentation('invalid-presentation-barrier');
          else this.preparePresentation(key, channel);
        }
        if (message.type === 'layout' && Array.isArray(message.views)) {
          if (message.clientGestures !== undefined) this.clientGestures = message.clientGestures === 1;
          if(!this.layout||this.layout.epoch!==message.epoch||this.layout.generation!==message.generation) {
            this.hideVideoPlanes();
            this.presentationBarrierAcknowledged = false;
          }
          this.markConnection('firstLayout');
          const reconfiguring = message.reconfiguring === true && message.generation === '0' && !message.views.length;
          if (reconfiguring) {
            if (!this.layout?.reconfiguring) {
              this.editingSurfaces = this.layout?.views ?? [];
              this.mobileEditing.suspendLayout();
            }
          } else {
            this.editingSurfaces = [];
            this.mobileEditing.reconcile(message.views);
            if (message.reconfiguring !== undefined) delete message.reconfiguring;
          }
          this.layout = message;
          this.syncViewports();
          for (const renderer of this.renderers) if (!this.rendererCurrent(renderer)) { this.hideVideoPlane(renderer); renderer.ready(false); }
          const pending = this.pendingFocus;
          const surface = this.layout?.views.find(view => view.id === pending?.view);
          if (pending && (!surface || surface.session !== pending.session || surface.instance !== pending.instance || surface.document !== pending.document || this.layout?.generation !== pending.generation || this.layout?.epoch !== pending.epoch)) this.cancelPendingFocus(pending.requestId);
          this.discardQueuedInput('layout-changed', true);
          this.pruneTerminalInput();
          this.flushFocusedInput();
          this.notify();
        }
        if (message.type === 'frame') { this.latency.record(message.rtpTimestamp, message.layoutEpoch, message); const start = performance.now(); if (Number.isInteger(message.rtpTimestamp) && typeof message.layoutEpoch === 'string') { this.presentation.frameMetadata(start, message.rtpTimestamp, message.layoutEpoch); this.encodedFrameSamples.push({ at: start, rtpTimestamp: message.rtpTimestamp, layoutEpoch: message.layoutEpoch, encodedBytes: typeof message.encodedBytes === 'number' ? message.encodedBytes : undefined, keyframe: typeof message.keyframe === 'boolean' ? message.keyframe : undefined }); if (this.encodedFrameSamples.length > 2400) this.encodedFrameSamples.shift(); } this.frameGate.record(message.rtpTimestamp, message.layoutEpoch); this.matchPendingVideoObservations(); if (message.layoutEpoch === this.layout?.epoch) this.scheduleVideoMetadataRefresh(); this.presentation.cost('frameMessageTotal', start, performance.now() - start); }
        if (message.type === 'stats') this.update({ endpoint: message });
        if (message.type === 'input.result' || message.type === 'focus') {
          if (message.type === 'input.result') this.receiveInputResult(message);
          this.inputResults.push({ at: performance.now(), ...message }); if (this.inputResults.length > 128) this.inputResults.shift();
          if (message.type === 'focus' && this.layout) {
            const pending = this.pendingFocus, token = message.token;
            const view = pending && this.layout.views.find(view => view.id === pending.view && view.session === pending.session && view.instance === pending.instance && view.document === pending.document);
            const matches = pending && view && message.focusRequestId === pending.requestId && message.layoutEpoch === pending.epoch && this.layout.epoch === pending.epoch && this.layout.generation === pending.generation;
            if (matches && message.ok === false) { this.cancelPendingFocus(pending.requestId, 'focus-rejected'); this.update({ error: String(message.error ?? '远程焦点请求被拒绝') }); }
            if (matches && message.ok && token && token.view === pending.view && token.session === pending.session && token.instance === pending.instance && token.document === pending.document && typeof token.focus === 'string') { clearTimeout(this.focusTimer); this.focusTimer = undefined; view.focus = token.focus; const focus = this.inputFocus.get(view.id); if (focus?.identity === pending.requestId) focus.token = token.focus; pending.acknowledged = true; this.mobileEditing.reconcile(this.layout.views); this.flushFocusedInput(); this.notify(); }
          }
        }
        if (message.type === 'error') this.update({ error: String(message.message ?? 'Endpoint 返回错误') });
      } catch { this.update({ error: '收到无法识别的 Endpoint 消息。' }); }
    };
  }
  sendInput(surface: Surface, event: Record<string, unknown>, options?: { touchTerminal: boolean }) {
    if (this.productLocked || this.peerAuthEpoch === 0) return false;
    const terminalTouch = (event.type === 'touch' || event.type === 'gesture') && (event.action === 'cancel' || event.action === 'end' || event.action === 'momentumEnd');
    if (this.channel?.readyState !== 'open' || !this.layout || !terminalTouch && !this.canInput(surface.id)) { this.traceInput('blocked', surface, event, this.channel?.readyState !== 'open' ? 'channel' : 'unmatched-or-unpainted-frame'); return false; }
    const current = this.layout.views.find(view => view.id === surface.id);
    if (!current || !samePlane(current, surface)) { this.traceInput('blocked', surface, event, 'stale-surface'); return false; }
    const identity = this.inputIdentity(current);
    if ((event.type === 'touch' || event.type === 'gesture') && event.inputIdentity !== undefined && event.inputIdentity !== identity) { this.touchInputStats.dropped++; return false; }
    const pending = this.pendingFocus?.view === surface.id ? this.pendingFocus : undefined;
    if (pending && !pending.focused) { this.traceInput('blocked', surface, event, 'blur-pending'); return false; }
    if (tracksTerminal(event) || event.type === 'touch' && event.action === 'start') {
      const capacity = event.action === 'cancel' ? 64 : event.action === 'end' ? 56 : 48;
      if (this.reservedTerminalInput() >= capacity) {
        this.traceInput('blocked', surface, event, 'terminal-capacity');
        this.touchInputStats.dropped++;
        return false;
      }
    }
    if (event.type === 'touch') { if (event.action === 'start' && event.sampleElapsedUs === 0) { if (event.clockMode === 'source') this.touchInputStats.sourceGestures++; else this.touchInputStats.arrivalFallbackGestures++; } if (event.action === 'cancel') this.touchInputStats.cancelled++; }
    const queued: QueuedInput = { surface: { ...current }, identity, event, epoch: this.layout.epoch, generation: this.layout.generation, requiresTerminalState: event.gestureMode === 'client-v1' && (event.action === 'cancel' || options?.touchTerminal === true) };
    const queue = pending?.events ?? this.queuedInput;
    const previous = queue[queue.length - 1];
    const merged = previous?.identity === identity ? (mergeTouchMoves(previous.event, event) ?? mergeGestureMomentum(previous.event, event)) : undefined;
    if (merged) { previous.event = merged; this.touchInputStats.merged++; }
    else {
      // A bounded backlog reserves terminal events by discarding obsolete move
      // packets, never start/end/cancel. Recent move history remains in batches.
      if (this.queuedInput.length + (this.pendingFocus?.events.length ?? 0) >= (terminalTouch ? 128 : 112)) {
        const expendable = queue.findIndex(item => item.event.type === 'touch' && item.event.action === 'move' && item.event.gestureMode !== 'client-v1');
        if (expendable >= 0) { queue.splice(expendable, 1); this.touchInputStats.dropped++; }
        else { this.touchInputStats.dropped++; return false; }
      }
      queue.push(queued); this.touchInputStats.queued++;
    }
    this.reportInputDelivery(queued, 'queued');
    if (!pending) this.drainInput();
    return true;
  }
  private drainInput() {
    clearTimeout(this.inputDrainTimer); this.inputDrainTimer = undefined;
    const channel = this.channel;
    if (channel?.readyState !== 'open' || !this.layout || this.productLocked || this.peerAuthEpoch === 0) return;
    while (this.queuedInput.length && channel.bufferedAmount <= 256 * 1024) {
      const item = this.queuedInput[0], current = this.queuedInputCurrent(item);
      if (!current) {
        this.queuedInput.shift();
        this.touchInputStats.dropped++;
        this.reportInputDelivery(item, 'discarded', undefined, 'stale-input-identity');
        continue;
      }
      if (!this.canInput(current.id)) break;
      this.queuedInput.shift();
      const sequence = String(++this.sequence);
      try {
        this.sendChannel(channel, { type: 'input', view: current.id, session: current.session, instance: current.instance, document: current.document, focus: current.focus, outputGeneration: item.generation, layoutEpoch: item.epoch, sequence, event: item.event });
      } catch {
        this.touchInputStats.dropped++;
        this.reportInputDelivery(item, 'discarded', undefined, 'channel-send-failed');
        if (item.event.type === 'touch') {
          this.queuedInput = this.queuedInput.filter(queued => {
            if (queued.identity !== item.identity || queued.event.sequenceId !== item.event.sequenceId ||
                (queued.event.type !== 'touch' && queued.event.type !== 'gesture')) return true;
            this.touchInputStats.dropped++;
            this.reportInputDelivery(queued, 'discarded', undefined, 'touch-send-failed');
            return false;
          });
        }
        break;
      }
      if (tracksTerminal(item.event)) {
        const entry = { ...item, pending: false, retries: 0 };
        this.terminalInput.set(sequence, entry);
        this.scheduleTerminalQuery(sequence, entry);
      } else {
        this.sentInput.set(sequence, item);
        while (this.sentInput.size > 256) this.sentInput.delete(this.sentInput.keys().next().value!);
      }
      this.reportInputDelivery(item, 'submitted', sequence);
      this.traceInput('sent', current, item.event);
    }
    if (this.queuedInput.length) this.inputDrainTimer = setTimeout(() => this.drainInput(), 10);
  }
  focus(surface: Surface, focused: boolean) {
    if (this.productLocked || this.peerAuthEpoch === 0) return;
    if (!focused) { this.mobileEditing.clear(); this.notify(); }
    if (this.channel?.readyState !== 'open' || !this.layout || !this.canInput(surface.id)) return;
    const current = this.layout.views.find(view => view.id === surface.id);
    if (!current || !samePlane(current, surface)) return;
    const pending = this.pendingFocus;
    if (pending && pending.view === current.id && pending.session === current.session && pending.instance === current.instance && pending.document === current.document && pending.epoch === this.layout.epoch && pending.generation === this.layout.generation && pending.focused === focused) return;
    this.cancelPendingFocus();
    const requestId = `${this.attempt}:${++this.focusSequence}`;
    this.inputFocus.set(current.id, { token: current.focus, identity: requestId, focused });
    this.pendingFocus = { requestId, acknowledged: false, focused, view: current.id, session: current.session, token: current.focus, instance: current.instance, document: current.document, generation: this.layout.generation, epoch: this.layout.epoch, events: [] };
    this.discardQueuedInput('focus-changed', true);
    this.pruneTerminalInput();
    queueMicrotask(() => this.notify());
    this.focusTimer = setTimeout(() => {
      if (this.pendingFocus?.requestId === requestId && !this.pendingFocus.acknowledged && this.cancelPendingFocus(requestId, 'focus-timeout')) this.update({ error: '远程焦点请求超时' });
    }, 2000);
    try {
      this.sendChannel(this.channel, { type: 'focus', focusRequestId: requestId, view: current.id, session: current.session, instance: current.instance, document: current.document, focus: current.focus, layoutEpoch: this.layout.epoch, focused });
    } catch {
      this.cancelPendingFocus(requestId, 'focus-send-failed');
      this.update({ error: '远程焦点请求未发送' });
    }
  }
  private async readStats(peer: RTCPeerConnection) {
    if (peer !== this.peer || this.statsReadingPeer === peer) return;
    this.statsReadingPeer = peer;
    try {
      // Snapshot video counters at the getStats request edge. Use the same
      // polling windows for rates rather than the rolling rVFC diagnostic FPS.
      const at = performance.now();
      const videoWindows = [...this.videoPlanes].map(([renderer, plane]) => ({
        renderer, plane, counters: plane.stats, revision: plane.stats.observationRevision,
        window: plane.stats.sampleWindow(at, plane.ready && this.rendererCurrent(renderer), plane.video.getVideoPlaybackQuality?.()),
        timing: plane.stats.timing(at),
      }));
      const stats = await peer.getStats();
      if (peer !== this.peer) return;
      const update: Partial<Diagnostics> = { decodedFramesPerSecond: undefined, receiveBitrateBps: undefined, receiverVideoTiming: undefined, roundTripTime: undefined, selectedCandidates: undefined };
      let inboundCounters: { decodedFrames?: number; packetsLost?: number; framesDropped?: number } = {};
      let selectedPairId: string | undefined;
      let nominatedPair: RTCIceCandidatePairStats | undefined;
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
          inboundCounters = { decodedFrames: report.framesDecoded, packetsLost: report.packetsLost, framesDropped: report.framesDropped };
          update.framesDecoded = report.framesDecoded; update.framesPerSecond = report.framesPerSecond; update.bytesReceived = report.bytesReceived;
          if (typeof report.timestamp === 'number' && typeof report.bytesReceived === 'number') {
            const previous = this.lastInboundSample?.id === report.id ? this.lastInboundSample : undefined;
            if (previous && report.timestamp > previous.timestamp && report.bytesReceived >= previous.bytes) update.receiveBitrateBps = (report.bytesReceived - previous.bytes) * 8000 / (report.timestamp - previous.timestamp);
            if (previous?.frames !== undefined && typeof report.framesDecoded === 'number' && report.timestamp > previous.timestamp && report.framesDecoded >= previous.frames) update.decodedFramesPerSecond = (report.framesDecoded - previous.frames) * 1000 / (report.timestamp - previous.timestamp);
            if (previous && report.timestamp > previous.timestamp) {
              const decoded = counterDelta(report.framesDecoded, previous.frames);
              const emitted = counterDelta(report.jitterBufferEmittedCount, previous.emitted);
              const jitter = counterDelta(report.jitterBufferDelay, previous.jitterDelay);
              const decode = counterDelta(report.totalDecodeTime, previous.decodeTime);
              update.receiverVideoTiming = {
                jitterBufferMeanMs: emitted && jitter !== undefined ? jitter * 1000 / emitted : undefined,
                decodeMeanMs: decoded && decode !== undefined ? decode * 1000 / decoded : undefined,
                droppedFrames: counterDelta(report.framesDropped, previous.framesDropped),
              };
            }
            this.lastInboundSample = { id: report.id, timestamp: report.timestamp, bytes: report.bytesReceived, frames: report.framesDecoded,
              emitted: report.jitterBufferEmittedCount, jitterDelay: report.jitterBufferDelay, decodeTime: report.totalDecodeTime, framesDropped: report.framesDropped };
          }
          update.videoWidth = report.frameWidth;
          update.videoHeight = report.frameHeight;
          if (report.codecId) update.codec = stats.get(report.codecId)?.mimeType;
        }
        if (report.type === 'transport' && report.selectedCandidatePairId) selectedPairId = report.selectedCandidatePairId;
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) nominatedPair ??= report;
      });
      const pair = (selectedPairId ? stats.get(selectedPairId) as RTCIceCandidatePairStats | undefined : undefined) ?? nominatedPair;
      if (pair) {
        update.roundTripTime = pair.currentRoundTripTime;
        update.selectedCandidates = { pair, local: stats.get(pair.localCandidateId), remote: stats.get(pair.remoteCandidateId) };
      }
      const currentVideos = videoWindows.filter(({ renderer, plane, counters, revision }) =>
        this.videoPlanes.get(renderer) === plane && plane.ready && this.rendererCurrent(renderer) &&
        plane.stats === counters && counters.observationRevision === revision);
      const paints = Object.fromEntries(currentVideos.map(({ renderer, window }) => [renderer.view.id, window]));
      update.paintFpsByView = Object.fromEntries(Object.entries(paints).map(([id, value]) => [id, value?.fps]));
      update.videoTimingByView = Object.fromEntries(currentVideos.map(({ renderer, timing, window }) =>
        [renderer.view.id, { callbackFps: window?.callbackFps, videoElementFps: window?.videoElementFps,
          videoElementDrops: window?.videoElementDrops, ...timing }]));
      update.rendering=this.getRenderingDiagnostics();
      update.displayFramesPerSecond = this.selectedViewId ? paints[this.selectedViewId]?.fps : undefined;
      this.update(update);
      if (this.layout && this.channel?.readyState === 'open') {
        const counts = new Map([...this.videoPlanes].map(([renderer, plane]) => [renderer.view.id, plane.stats.frames]));
        const views = new Set([...this.renderers].filter(renderer => {
          if (!this.rendererCurrent(renderer)) return false;
          const rect = renderer.canvas.getBoundingClientRect(), style = getComputedStyle(renderer.canvas);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse';
        }).map(renderer => renderer.view.id));
        const feedback = this.mediaFeedback.sample({ layoutEpoch: this.layout.epoch, outputGeneration: this.layout.generation,
          ...inboundCounters,
          planes: [...views].map(view => ({ view, frames: counts.get(view) })),
          roundTripTimeMs: update.roundTripTime === undefined ? undefined : update.roundTripTime * 1000 });
        if (feedback?.displayHzEstimate) this.displayHzEstimate = feedback.displayHzEstimate;
        if (feedback && !this.productLocked && this.channel.bufferedAmount <= 65536) this.sendChannel(this.channel, feedback);
      }
      this.refreshNetworkStats(peer);
      this.productionFeedback(peer);
    } catch { /* A closed peer no longer has stats. */ }
    finally { if (this.statsReadingPeer === peer) this.statsReadingPeer = undefined; }
  }
  private productionFeedback(peer: RTCPeerConnection) {
    const rpc = this.controlRpc, attempt = this.attempt;
    if (!rpc || this.diagnosticHttp || peer !== this.peer) return;
    const now = performance.now();
    this.sampleEndpointClock();
    const wall = Date.now(), ping = this.controlClockProbe.begin(now, wall);
    if (ping) {
      void rpc('clock.ping', { clientTime: wall }).then(value => {
        if (attempt === this.attempt && peer === this.peer) this.controlClockProbe.complete(ping.requestId, performance.now(), Date.now(), (value as { serverTime: number }).serverTime);
      }).catch(() => {});
    }
    if (this.feedbackReading) return;
    const report = this.latency.report(now, Date.now(), document.visibilityState === 'visible', this.controlClock);
    if (!report) return;
    this.update({ presentationEstimate: report }); this.feedbackReading = true;
    void rpc('feedback', { ...report, displayHzEstimate: this.displayHzEstimate }).catch(() => {}).finally(() => { if (attempt === this.attempt) this.feedbackReading = false; });
  }
  private sampleEndpointClock() {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > 65536) return;
    const ping = this.endpointClockProbe.begin(performance.now(), Date.now());
    if (ping) { try { this.sendChannel(channel, ping); } catch { /* The next bounded sample retries if the channel remains open. */ } }
  }
  private refreshNetworkStats(peer: RTCPeerConnection) {
    const connectionId = this.connectionId;
    if (!this.diagnosticHttp || peer !== this.peer || !this.diagnostics.networkSimulation || !connectionId ||
        this.networkRead?.peer === peer && this.networkRead.connectionId === connectionId) return;
    const sample = { peer, connectionId }; this.networkRead = sample;
    // Relay diagnostics must not extend the native media counter window or block feedback.
    void request<Record<string, unknown>>('/api/rtc/network', { connectionId }).then(networkSimulation => {
      if (this.networkRead === sample && this.peer === peer && this.connectionId === connectionId) this.update({ networkSimulation });
    }).catch(() => { /* Keep the last relay observation while native media feedback continues. */ })
      .finally(() => { if (this.networkRead === sample) this.networkRead = undefined; });
  }
  disconnect() {
    this.reconnect.stop(); clearTimeout(this.retryTimer); this.retryTimer = undefined; this.pendingFailure = undefined; this.manualRestart = false;
    this.closeLocal();
  }
  private closeLocal() {
    this.authCamera.bind(undefined);
    if (this.peerAuthEpoch !== undefined) this.observePeerAuthorization(0);
    this.mobileEditing.reset();
    this.audio.detach();
    clearTimeout(this.videoMetadataRefreshTimer); this.videoMetadataRefreshTimer = undefined;
    clearTimeout(this.presentationNegotiationTimer); this.presentationNegotiationTimer = undefined;
    this.cancelPresentationAck(); this.hideVideoPlanes();
    for (const renderer of this.videoPlanes.keys()) this.detachVideoPlane(renderer);
    if (this.presentationVisibility) globalThis.document?.removeEventListener('visibilitychange', this.presentationVisibility);
    this.presentationVisibility = undefined; this.presentationBarrier = undefined; this.presentationBarrierAcknowledged = false;
    this.presentationErrorCode = undefined; this.presentationBackend = 'pending';
    this.mediaRefreshAt = -Infinity;
    clearTimeout(this.inputDrainTimer); this.inputDrainTimer = undefined;
    this.cancelPendingFocus(undefined, 'connection-closed');
    this.discardQueuedInput('connection-closed');
    this.inputFocus.clear();
    this.signalAttemptId = undefined; this.remoteSignalConnection = undefined; this.remoteDescriptionReady = false; this.remoteIce = []; this.localIce = []; this.iceDelivery = Promise.resolve(); this.localIceDelivery = Promise.resolve();
    this.attempt++; this.sentInput.clear(); this.clearTerminalInput(); this.latency.reset(); this.endpointClockProbe.reset(); this.controlClockProbe.reset(); this.feedbackReading = false; this.videoTrack = undefined; this.displayHzEstimate = undefined;
    this.mediaFeedback.stop(); this.statsReadingPeer = undefined; this.networkRead = undefined;
    this.frameGate.clear();
    this.lastInboundSample = undefined;
    this.viewPresentations.clear();
    for (const renderer of this.renderers) renderer.ready(false); this.renderers.clear();
    for (const registration of this.viewports) { registration.renderer = undefined; registration.remove = undefined; }
    this.endpointGeneration = undefined;
    if (this.connectionId) { void this.rtcRequest('rtc.close', { connectionId: this.connectionId }).catch(() => {}); this.connectionId = undefined; }
    clearInterval(this.timer);
    this.files.disconnect();
    const peer = this.peer; this.peer = null; this.channel = null; peer?.close();
    this.layout = null; this.clientGestures = false;
    this.pendingFocus = null;
    this.diagnostics = { connection: '未连接', channel: '未连接' }; this.notify();
  }
}
