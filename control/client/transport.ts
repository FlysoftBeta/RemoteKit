import { DcFileClient } from './dc-file-client';
import { barrierMatchesLayout, configurePresentationVideo, presentationBarrier, videoPlaneGeometry, VideoCompositorStats, type PresentationBarrier } from './video-presentation';
import { CaptureLatency } from './capture-latency';
import { ClockDomain, ClockProbe } from './clock-domain';
import { ViewerAudioOutput, stereoOpusOffer } from './audio-output';
import { mergeTouchMoves, mergeGestureMomentum } from './touch-input';
import { request, type Diagnostics, type Layout, type Surface, type CanvasPresentation } from './types';
import { FrameEpochGate } from './frame-epoch';
import { configureReceiveOffer, originalGatheredOffer, probeReceiveCapabilities, loadReceiveProfile, selectProductReceiveProfile, type ProductReceiveSelection, type ReceiveProfile } from './receive-profile';
import { ReconnectPolicy } from './reconnect';
import { PresentationDiagnostics } from './presentation-diagnostics';
import { planeMatchesLayout, samePlane, type PlaneIdentity, type PresentedPlaneSource, type PresentationMode, type PixelRect } from './plane-source';
import { MediaFeedbackSampler } from './media-feedback';
import { createTrackProcessor, processorRtpTimestamp, type TrackProcessor, type ProcessorVideoFrame } from './track-processor';
import type { ProductOperation, OperationReceipt, RtcServerSignal } from '../shared/product';
import { SharedPlaneRenderer, type SharedFrame, type SharedPlaneResult } from './shared-plane-renderer';
import { MobileEditingState } from './mobile-editing-state';

export type ControlRpc = (method: 'rtc.offer' | 'rtc.ice' | 'rtc.close' | 'clock.ping' | 'feedback', params: unknown) => Promise<unknown>;
export interface InputResult { sequence: string; surface: Surface; identity: string; event: Record<string, unknown>; ok: boolean; error?: string; touchState?: 'processed' | 'terminal-invalidated'; touchSequenceId?: string }

interface PlaneRenderer extends PlaneIdentity { canvas: HTMLCanvasElement; ready: (ready: boolean) => void }
interface ViewportRegistration { viewId: string; canvas: HTMLCanvasElement; ready: (ready: boolean) => void; renderer?: PlaneRenderer; remove?: () => void }
interface VideoObservation { sequence: number; barrier: PresentationBarrier; peer: RTCPeerConnection; track: MediaStreamTrack; attempt: number; identity: PlaneIdentity; rtp: number; at: number; wall: number }
interface VideoPlane { video: HTMLVideoElement; track: MediaStreamTrack; clip: HTMLDivElement; observer: ResizeObserver; callback?: number; ready: boolean; rtp?: number; stats: VideoCompositorStats; metadataRetries: number; observationSequence: number; pendingObservation?: VideoObservation }
interface PaintedPlane { identity: PlaneIdentity; canvas: HTMLCanvasElement; source: PresentedPlaneSource; shared?: boolean }
export type FrameSource = 'video' | 'track-processor';
interface ProcessorFrameOwner { frame: VideoFrame; rtp: number; source: ProcessorSource; readAt: number; sourceTimestamp: number }
interface ProcessorSource { processor: TrackProcessor; reader: ReadableStreamDefaultReader<ProcessorVideoFrame>; peer: RTCPeerConnection; attempt: number }

/** All endpoint wire adaptation lives here; the UI never owns recovery state. */
export class RemoteTransport {
  readonly mobileEditing = new MobileEditingState();
  private freezeCopies = 0;
  recordResizeFreezeCopy() { this.freezeCopies++; }
  readonly files=new DcFileClient(()=>this.channel);
  private productPending = new Map<string,{operation:ProductOperation;resolve:(receipt:OperationReceipt)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;sent:boolean}>();
  productAction(operation:ProductOperation):Promise<OperationReceipt> {
    if(this.productPending.size>=64)return Promise.reject(new Error('待确认操作过多，请等待同步'));
    return new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{const sent=this.productPending.get(operation.operationId)?.sent??false;this.productPending.delete(operation.operationId);reject(Object.assign(new Error(sent?'操作结果未知，正在核对；请勿重复执行':'数据通道尚未连接，操作未发送'),{operationSent:sent}));},20000);this.productPending.set(operation.operationId,{operation,resolve,reject,timer,sent:false});this.flushProductActions(); });
  }
  private flushProductActions() { const channel=this.channel;if(channel?.readyState!=='open')return;for(const entry of this.productPending.values()){if(entry.sent)continue;try{channel.send(JSON.stringify({type:'product.action',version:1,...entry.operation}));entry.sent=true;}catch{/* Leave unsent intent pending until the bounded deadline. */}} }
  readonly audio = new ViewerAudioOutput(() => this.notify());
  readonly touchInputStats = { queued: 0, merged: 0, dropped: 0, cancelled: 0, sourceGestures: 0, arrivalFallbackGestures: 0 };
  clientGestures = false;
  private queuedInput: { surface: Surface; event: Record<string, unknown>; epoch: string; generation: string }[] = [];
  private inputDrainTimer?: ReturnType<typeof setTimeout>;
  private focusTimer?: ReturnType<typeof setTimeout>;
  private inputFocus = new Map<string, { token: string; identity: string; focused: boolean }>();
  inputIdentity(surface: Surface) { const known = this.inputFocus.get(surface.id); return `${this.attempt}:${surface.session}:${surface.id}:${surface.instance}:${surface.document}:${this.layout?.generation}:${this.layout?.epoch}:${known?.token === surface.focus ? known.identity : surface.focus}`; }
  editingIdentity(surface: Surface) { return `${this.attempt}:${surface.session}:${surface.id}:${surface.instance}:${surface.document}`; }
  private inputResultListeners = new Set<(result: InputResult) => void>();
  private sentInput = new Map<string, { surface: Surface; identity: string; event: Record<string, unknown> }>();
  subscribeInputResults(listener: (result: InputResult) => void) { this.inputResultListeners.add(listener); return () => { this.inputResultListeners.delete(listener); }; }
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
  private processorFallback = false;
  private displayHzEstimate?: number;
  private processorTrack?: MediaStreamTrack;
  private preferVideoPresentation = false;
  private presentationBackend: 'pending' | 'video' | 'canvas' = 'canvas';
  private presentationFallbackReason?: string;
  private presentationNegotiationTimer?: ReturnType<typeof setTimeout>;
  private presentationBarrier?: PresentationBarrier;
  private presentationBarrierAcknowledged = false;
  private presentationAckRaf?: number;
  private presentationAckSerial = 0;
  private pendingPresentationAction?: { channel: RTCDataChannel; action: () => void };
  private videoPlanes = new Map<PlaneRenderer, VideoPlane>();
  private presentationVisibility?: () => void;
  private videoMetadataRefreshTimer?: ReturnType<typeof setTimeout>;

  setControlRpc(callback: ControlRpc) { this.controlRpc = callback; this.diagnosticHttp = false; this.processorFallback = true; this.processorScheduler = 'fifo2'; this.frameSource = 'video'; this.preferVideoPresentation = true; }
  enableDiagnosticHttp() { this.processorFallback = false; this.diagnosticHttp = true; this.controlRpc = undefined; }
  private rtcRequest<T>(method: 'rtc.offer' | 'rtc.ice' | 'rtc.close' | 'clock.ping' | 'feedback', params: unknown): Promise<T> {
    if (this.controlRpc) return this.controlRpc(method, params) as Promise<T>;
    if (this.diagnosticHttp) return request<T>('/api/' + method.replace('.', '/'), params);
    return Promise.reject(new Error('Control WebSocket 未连接'));
  }
  frameSource: FrameSource = 'video';
  private activeFrameSource: FrameSource = 'video';
  private processorSource: ProcessorSource | undefined;
  private processorRaf: number | undefined;
  // Test-harness-only policy, captured at processor start; no product UI.
  processorScheduler: 'latest1' | 'fifo2' = 'latest1';
  processorProfile = false;
  private activeProcessorScheduler: 'latest1' | 'fifo2' = 'latest1';
  private pendingProcessorFrames: ProcessorFrameOwner[] = [];
  private processorEvents: Record<string, unknown>[] = [];
  private processorEventCursor = 0;
  private processorEventCount = 0;
  private readonly processorEventLimit = 16384;
  private latestProcessorFrame: ProcessorFrameOwner | undefined;
  private retiringProcessorOwners = 0;
  private processorCounts = { total: undefined as number | undefined, discarded: undefined as number | undefined, read: 0, invalid: 0, closed: 0, stale: 0, authorized: 0, rafCallbacks: 0, rafAdmitted: 0, replaced: 0, ownerClosed: 0, canvas: 0, width: 0, height: 0 };
  receiveProfile: ReceiveProfile = loadReceiveProfile();
  signaling: Record<string, unknown> | undefined;
  probeReceiveCapabilities = probeReceiveCapabilities;
  private receiverVideo = this.createReceiverVideo();
  get video() { return this.receiverVideo; }
  private authorizedFrame = document.createElement('canvas');
  // A direct plane is never exposed as a full atlas through this legacy getter.
  get displayFrame() { return this.displayReady && this.snapshotRtp === this.displayedRtp && this.snapshotEpoch === this.displayedEpoch ? this.authorizedFrame : undefined; }
  private pendingFrame = document.createElement('canvas');
  private pendingSnapshotRtp: number | undefined;
  private snapshotRtp: number | undefined;
  private snapshotEpoch: string | undefined;
  private directEpochReady: string | undefined;
  presentationMode: PresentationMode = 'snapshot';
  private renderers = new Set<PlaneRenderer>();
  private viewports = new Set<ViewportRegistration>();
  private paintedPlanes = new Map<string, PaintedPlane>();
  private sharedRenderer?: SharedPlaneRenderer;
  private plane2dDraws = 0;
  private mediaRefreshRequests = 0;
  private mediaRefreshAt = -Infinity;
  private presentationFlow = { metadataMissingAtRead:0, metadataBlockedSchedules:0, drops:{} as Record<string,number>, readToAuthorize:[] as number[], rafWait:[] as number[] };
  private sharedFrameCurrent(frame:SharedFrame) { return this.displayReady && this.displayedRtp===frame.rtpTimestamp && this.layout?.epoch===frame.layout.epoch && this.layout?.generation===frame.layout.generation; }
  private requestPresentationRefresh() {
    const channel=this.channel;if(!this.peer||channel?.readyState!=='open'||performance.now()-this.mediaRefreshAt<1000)return;
    this.mediaRefreshAt=performance.now();try{channel.send(JSON.stringify({type:'media.refresh'}));this.mediaRefreshRequests++;}catch{/* A closed peer cannot refresh this presentation. */}
  }
  private redrawCurrentPresentation() {
    if(!this.displayReady)return false;
    const image=this.activeFrameSource==='track-processor'?this.latestProcessorFrame?.frame:this.displayFrame;
    if(!image)return false;
    this.dispatchPaint(()=>this.paintAuthorizedPlanes(image,this.activeFrameSource==='track-processor'?'plane-frame':'atlas'));return true;
  }
  private sharedFallback() {
    for(const [id,plane]of this.paintedPlanes)if(plane.shared)this.paintedPlanes.delete(id);
    if(!this.redrawCurrentPresentation())this.requestPresentationRefresh();
  }
  private commitShared(result:SharedPlaneResult) {
    if(!this.sharedFrameCurrent(result.frame)||!this.sharedRenderer?.isVisible(result.canvas))return;
    const paintedAt=performance.now(),wall=Date.now();
    for(const renderer of this.renderers){const rect=result.regions.get(renderer.view.id);if(!rect||!this.rendererCurrent(renderer)||renderer.view.stale)continue;
      const view=renderer.view;
      const scale=view.deviceScaleFactor*(view.mediaScale??1);
      const source:PresentedPlaneSource={image:result.canvas,sourceRect:rect,kind:'plane',viewId:view.id,rtpTimestamp:result.frame.rtpTimestamp,layoutEpoch:result.frame.layout.epoch,encodedWidth:view.width,encodedHeight:view.height,pixelsPerDip:scale*rect.width/view.width,pixelsPerDipY:scale*rect.height/view.height};
      this.paintedPlanes.set(view.id,{identity:{view:{...view},layoutEpoch:result.frame.layout.epoch,layoutGeneration:result.frame.layout.generation},canvas:renderer.canvas,source,shared:true});
      this.reportPresented(view.id,result.frame.rtpTimestamp,paintedAt,wall);renderer.ready(true);
    }
    this.presentation.cost('sharedUpload',paintedAt,result.uploadMs);this.presentation.cost('sharedDraw',paintedAt,result.drawMs);
  }
  private paintAuthorizedPlanes(image:HTMLCanvasElement|VideoFrame,kind:'plane-frame'|'atlas') {
    const eligible=[...this.renderers].filter(r=>this.rendererCurrent(r)&&!r.view.stale);
    if(eligible.length>=2&&new Set(eligible.map(r=>r.view.id)).size===eligible.length&&typeof WebGL2RenderingContext==='function'&&!/(?:Chrome|Chromium)\/89\./.test(navigator.userAgent)&&this.layout&&this.displayedRtp!==undefined){
      this.sharedRenderer??=new SharedPlaneRenderer({isCurrent:frame=>this.sharedFrameCurrent(frame),onRedraw:result=>this.dispatchPaint(()=>this.commitShared(result)),onFailure:()=>this.sharedFallback(),onResume:()=>{if(!this.redrawCurrentPresentation())this.requestPresentationRefresh();}});
      const result=this.sharedRenderer.render(image,{rtpTimestamp:this.displayedRtp,layout:this.layout},eligible);
      if(result){this.commitShared(result);return;}
      this.sharedRenderer.clear();
    }else this.sharedRenderer?.clear();
    for(const renderer of this.renderers)this.paintPlane(renderer,image,renderer.view,kind);
  }
  private getRenderingDiagnostics() {
    const percentile=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,p50:sorted.length?sorted[Math.ceil(sorted.length*.5)-1]:null,p95:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null};};
    const eligible=[...this.renderers].filter(r=>this.rendererCurrent(r)&&!r.view.stale);
    const backendReason=this.sharedRenderer?.backend==='shared-webgl'?'multiple-planes':eligible.length<2?'single-or-no-eligible-plane':/(?:Chrome|Chromium)\/89\./.test(navigator.userAgent)?'chrome89-compatible-2d':typeof WebGL2RenderingContext!=='function'?'webgl2-unavailable':new Set(eligible.map(r=>r.view.id)).size!==eligible.length?'duplicate-plane':this.sharedRenderer?.counts.fallbackReason??'waiting-for-shared-frame';
    return {backend:this.presentationBackend === 'video' ? 'video' : this.presentationBackend === 'pending' ? 'video-negotiating' : this.sharedRenderer?.backend??'canvas-2d',backendReason:this.presentationFallbackReason ?? (this.presentationBackend === 'video' ? 'negotiated-video' : backendReason),videoCompositorByView:Object.fromEntries([...this.videoPlanes].map(([renderer, plane])=>[renderer.view.id,plane.stats.snapshot(performance.now())])),frameSource:this.activeFrameSource,frameSourceFallbackReason:this.signaling?.processorFallbackReason as string|undefined,visibility:globalThis.document?.visibilityState,shared:{...this.sharedRenderer?.counts},plane2dDraws:this.plane2dDraws,freezeCopies:this.freezeCopies,atlasSnapshotCopies:this.routing.snapshotFrames,mediaRefreshRequests:this.mediaRefreshRequests,scheduling:{metadataMissingAtRead:this.presentationFlow.metadataMissingAtRead,metadataBlockedSchedules:this.presentationFlow.metadataBlockedSchedules,drops:{...this.presentationFlow.drops},readToAuthorizeMs:percentile(this.presentationFlow.readToAuthorize),rafWaitMs:percentile(this.presentationFlow.rafWait)}};
  }
  private routing = { directFrames: 0, snapshotFrames: 0, retainedPlaneRedraws: 0, fallback: {} as Record<string, number>, skippedRenderer: {} as Record<string, number> };
  private frameGate = new FrameEpochGate();
  private displayedRtp: number | undefined;
  private displayedEpoch: string | undefined;
  private frameCallback: number | undefined;
  private frameIssue: string | undefined;
  private presentation = new PresentationDiagnostics();
  readonly encodedFrameSamples: { at: number; rtpTimestamp: number; layoutEpoch: string; encodedBytes?: number; keyframe?: boolean }[] = [];
  get presentationDiagnostics() { return this.getPresentationDiagnostics(); }
  getPresentationDiagnostics(raw = false) { const sizes = this.encodedFrameSamples.flatMap(frame => frame.encodedBytes === undefined ? [] : [frame.encodedBytes]).sort((a, b) => a - b); return { rendering:this.getRenderingDiagnostics(), touchInput:{...this.touchInputStats}, paintVersion: 'plane-source-v3', frameSource: this.activeFrameSource, processor: this.getProcessorDiagnostics(), presentationRouting: { mode: this.presentationMode, ...this.routing, fallback: { ...this.routing.fallback }, skippedRenderer: { ...this.routing.skippedRenderer } }, selectedViewId: this.selectedViewId, callbackRegistration: this.activeFrameSource === 'video' ? 'after-work' : 'not-applicable', presentationEndpoint: this.presentationBackend === 'video' ? 'video-compositor-observation' : 'canvas-js-submit', encodedFrameBytes: { measured: sizes.length, p95: sizes.length ? sizes[Math.ceil(sizes.length * .95) - 1] : null, max: sizes.length ? sizes[sizes.length - 1] : null, keyframeMeasured: this.encodedFrameSamples.filter(frame => frame.keyframe !== undefined).length, keyframes: this.encodedFrameSamples.some(frame => frame.keyframe !== undefined) ? this.encodedFrameSamples.filter(frame => frame.keyframe === true).length : null }, ...this.presentation.snapshot(raw), ...(raw ? { encodedFrameSamples: this.encodedFrameSamples, processorProfile: this.processorProfileSnapshot() } : {}) }; }
  resetPresentationDiagnostics() { for (const plane of this.videoPlanes.values()) plane.stats = new VideoCompositorStats(); this.sharedRenderer?.resetDiagnostics();this.presentationFlow={metadataMissingAtRead:0,metadataBlockedSchedules:0,drops:{},readToAuthorize:[],rafWait:[]};this.plane2dDraws=0;this.freezeCopies=0;this.mediaRefreshRequests=0;this.processorEvents = []; this.processorEventCursor = 0; this.processorEventCount = 0; this.processorCounts = { total: undefined, discarded: undefined, read: 0, invalid: 0, closed: 0, stale: 0, authorized: 0, rafCallbacks: 0, rafAdmitted: 0, replaced: 0, ownerClosed: 0, canvas: 0, width: this.processorCounts.width, height: this.processorCounts.height }; this.presentation = new PresentationDiagnostics(); this.encodedFrameSamples.length = 0; this.routing = { directFrames: 0, snapshotFrames: 0, retainedPlaneRedraws: 0, fallback: {}, skippedRenderer: {} }; }
  recordClientRaf(at: number) { this.presentation.clientRaf(at); }
  recordPresentationCost(name: string, at: number, durationMs: number, view: string | null = null) { this.presentation.cost(name, at, durationMs, view); }
  get displayReady() { if (this.presentationBackend === 'video') return [...this.videoPlanes].some(([renderer, plane]) => plane.ready && this.rendererCurrent(renderer)); if (this.presentationBackend === 'pending') return false; return this.frameGate.ready && this.displayedRtp === this.frameGate.rtpTimestamp && this.displayedEpoch === this.layout?.epoch; }
  get presentedFrame() { return this.displayReady ? { rtpTimestamp: this.displayedRtp, layoutEpoch: this.displayedEpoch } : null; }
  layout: Layout | null = null;
  diagnostics: Diagnostics = { connection: '未连接', channel: '未连接' };
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private listeners = new Set<() => void>();
  private frameListeners = new Set<() => void>();
  private presentedListeners = new Set<(frame: CanvasPresentation) => void>();
  private viewPresentations = new Map<string, CanvasPresentation>();
  private pendingPresentations: CanvasPresentation[] = [];
  private dispatchingPaint = false;
  private authorizedAt = 0;
  selectedViewId: string | undefined;
  private lastInboundSample: { timestamp: number; bytes: number; frames?: number } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private statsReadingPeer: RTCPeerConnection | undefined;
  private networkRead: { peer: RTCPeerConnection; connectionId: string } | undefined;
  private videoPresentedFrames: number | undefined;
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
  private pendingFocus: { requestId: string; acknowledged: boolean; focused: boolean; view: string; session: string; token: string; instance: string; document: string; generation: string; epoch: string; events: Record<string, unknown>[] } | null = null;
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
    this.hideVideoPlanes(); for (const plane of this.videoPlanes.values()) plane.metadataRetries = 0; this.presentationBarrier = key; this.presentationBarrierAcknowledged = false;
    this.afterPresentationHidden(channel, () => {
      if (this.presentationBackend === 'canvas' || this.presentationBarrier !== key || !barrierMatchesLayout(key, this.layout)) return;
      this.presentationBarrierAcknowledged = true;
      channel.send(JSON.stringify({ type: 'presentation.ready', ...key }));
    });
  }
  private negotiatePresentation(channel: RTCDataChannel) {
    if (!this.preferVideoPresentation) return;
    if (!this.presentationVisibility) {
      this.presentationVisibility = () => {
        this.hideVideoPlanes();
        if (document.visibilityState !== 'visible') this.cancelPresentationAck(true);
        else {
          const pending = this.pendingPresentationAction;
          if (pending) this.afterPresentationHidden(pending.channel, pending.action);
          else if (this.presentationBarrier && !this.presentationBarrierAcknowledged) this.preparePresentation(this.presentationBarrier, channel);
          this.requestPresentationRefresh();
        }
      };
      document.addEventListener('visibilitychange', this.presentationVisibility);
    }
    if (typeof this.video.requestVideoFrameCallback !== 'function' || typeof ResizeObserver !== 'function') {
      this.fallbackPresentation('video-capability-unavailable'); return;
    }
    channel.send(JSON.stringify({ type: 'media.presentation', version: 1, backend: 'video' }));
    this.presentationNegotiationTimer = setTimeout(() => {
      if (this.channel === channel && this.presentationBackend === 'pending') this.fallbackPresentation('presentation-protocol-unavailable');
    }, 1500);
  }
  private fallbackPresentation(reason: string) {
    this.hideVideoPlanes(); clearTimeout(this.presentationNegotiationTimer);
    this.presentationFallbackReason = reason; this.presentationBarrier = undefined; this.presentationBarrierAcknowledged = false;
    this.presentationBackend = 'canvas';
    this.frameGate.observe(undefined); this.displayedRtp = undefined; this.displayedEpoch = undefined;
    this.viewPresentations.clear(); this.paintedPlanes.clear();
    for (const renderer of this.videoPlanes.keys()) this.detachVideoPlane(renderer);
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') return;
    this.afterPresentationHidden(channel, () => {
      channel.send(JSON.stringify({ type: 'media.presentation', version: 1, backend: 'canvas' }));
      const peer = this.peer, track = this.processorTrack;
      if (peer && track) {
        this.activeFrameSource = typeof (globalThis as any).MediaStreamTrackProcessor === 'function' && !/Chrome\/89\./.test(navigator.userAgent) ? 'track-processor' : 'video';
        if (this.activeFrameSource === 'track-processor') this.startProcessorPump(peer, track);
        else {
          const video = this.video, attempt = this.attempt;
          video.srcObject = new MediaStream([track]); this.startFramePump(peer);
          void video.play().catch(() => {
            if (this.peer === peer && this.attempt === attempt && this.video === video) this.connectionFailed('Video playback failed');
          });
        }
      }
      this.notify();
    });
  }
  private videoPlaneFor(viewId: string) {
    for (const [renderer, plane] of this.videoPlanes) if (renderer.view.id === viewId && this.rendererCurrent(renderer)) return { renderer, plane };
    return undefined;
  }
  private hideVideoPlane(renderer: PlaneRenderer) {
    const plane = this.videoPlanes.get(renderer);
    if (!plane) return;
    plane.clip.style.opacity = '0'; plane.ready = false; plane.rtp = undefined; plane.pendingObservation = undefined; plane.observationSequence++; plane.stats.resetObservation();
    this.viewPresentations.delete(renderer.view.id); renderer.ready(false);
  }
  private hideVideoPlanes() {
    for (const renderer of this.videoPlanes.keys()) this.hideVideoPlane(renderer);
    this.queuedInput = []; this.cancelPendingFocus();
  }
  private detachVideoPlane(renderer: PlaneRenderer) {
    const plane = this.videoPlanes.get(renderer);
    if (!plane) return;
    this.hideVideoPlane(renderer); this.videoPlanes.delete(renderer);
    plane.observer.disconnect();
    if (plane.callback !== undefined) plane.video.cancelVideoFrameCallback?.(plane.callback);
    plane.video.pause(); plane.video.srcObject = null; plane.clip.remove();
    renderer.canvas.style.opacity = ''; renderer.canvas.removeAttribute('data-video-input');
  }
  private attachVideoPlane(renderer: PlaneRenderer) {
    if (!this.processorTrack || !this.peer || !this.rendererCurrent(renderer) || !this.layout) return;
    const existing = this.videoPlanes.get(renderer);
    if (existing?.track === this.processorTrack) return;
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
      this.hideVideoPlane(renderer); this.positionVideoPlane(renderer); this.requestPresentationRefresh();
    });
    const plane: VideoPlane = { video, track: this.processorTrack, clip, observer, ready: false, stats: new VideoCompositorStats(), metadataRetries: 0, observationSequence: 0 };
    this.videoPlanes.set(renderer, plane); observer.observe(canvas); observer.observe(parent); this.positionVideoPlane(renderer);
    const peer = this.peer, attempt = this.attempt;
    const receive = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (this.peer !== peer || this.attempt !== attempt || this.videoPlanes.get(renderer) !== plane || this.presentationBackend !== 'video') return;
      try { this.observeVideoPlane(renderer, plane, metadata); }
      finally { if (this.peer === peer && this.videoPlanes.get(renderer) === plane && this.presentationBackend === 'video') plane.callback = video.requestVideoFrameCallback(receive); }
    };
    plane.callback = video.requestVideoFrameCallback(receive);
    video.srcObject = new MediaStream([this.processorTrack]);
    void video.play().catch(() => { if (this.videoPlanes.get(renderer) === plane) this.fallbackPresentation('video-playback-failed'); });
    // Static sources need one fresh frame for a newly mounted video element.
    this.requestPresentationRefresh();
  }
  private positionVideoPlane(renderer: PlaneRenderer) {
    const plane = this.videoPlanes.get(renderer), layout = this.layout, parent = renderer.canvas.parentElement;
    if (!plane || !layout || !parent || !this.rendererCurrent(renderer)) return false;
    const bounds = renderer.canvas.getBoundingClientRect(), container = parent.getBoundingClientRect();
    const geometry = videoPlaneGeometry(renderer.view, layout, bounds);
    if (!geometry) return false;
    Object.assign(plane.clip.style, { left: `${bounds.left - container.left}px`, top: `${bounds.top - container.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    for (const [name, value] of Object.entries(geometry)) plane.video.style.setProperty(name, `${value}px`);
    return true;
  }
  private scheduleVideoMetadataRefresh() {
    // Narrow layouts retain mounted viewports for hidden Windows. Their old
    // receivers stay hidden, but cannot consume retries or fail current planes.
    const waitingPlanes = () => [...this.videoPlanes].filter(([renderer, plane]) =>
      this.rendererCurrent(renderer) && !renderer.view.stale && !plane.ready).map(([, plane]) => plane);
    if (this.presentationBackend !== 'video' || this.videoMetadataRefreshTimer || !waitingPlanes().length) return;
    const attempt = this.attempt;
    this.videoMetadataRefreshTimer = setTimeout(() => {
      this.videoMetadataRefreshTimer = undefined;
      if (attempt !== this.attempt || this.presentationBackend !== 'video') return;
      const waiting = waitingPlanes();
      if (!waiting.length) return;
      if (waiting.some(plane => plane.metadataRetries >= 3)) { this.fallbackPresentation('video-frame-metadata-timeout'); return; }
      for (const plane of waiting) plane.metadataRetries++;
      this.requestPresentationRefresh();
      this.scheduleVideoMetadataRefresh();
    }, Math.max(100, 1010 - (performance.now() - this.mediaRefreshAt)));
  }
  private videoObservationCurrent(renderer: PlaneRenderer, plane: VideoPlane, observation: VideoObservation) {
    return this.presentationBackend === 'video' && this.videoPlanes.get(renderer) === plane && plane.pendingObservation === observation &&
      plane.observationSequence === observation.sequence && this.peer === observation.peer && this.attempt === observation.attempt &&
      this.processorTrack === observation.track && plane.track === observation.track && this.presentationBarrier === observation.barrier &&
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
      plane.pendingObservation = undefined; plane.metadataRetries = 0;
      // Endpoint's ACK barrier guarantees stable geometry for every published
      // frame in this interval. This recovers layout authorization, not the
      // autonomous element's current RTP or a new compositor observation.
      plane.ready = true; plane.rtp = undefined; plane.clip.style.opacity = '1';
      this.latency.paint(observation.rtp, epoch, observation.at, observation.wall);
      this.reconnect.connected(); this.markConnection('firstVideoCompositor');
      renderer.ready(true); this.flushFocusedInput(); this.frameListeners.forEach(listener => listener());
    }
  }
  private observeVideoPlane(renderer: PlaneRenderer, plane: VideoPlane, metadata: VideoFrameCallbackMetadata) {
    const at = performance.now(), rtp = (metadata as VideoFrameCallbackMetadata & { rtpTimestamp?: number }).rtpTimestamp;
    const validRtp = Number.isInteger(rtp) && rtp! >= 0 && rtp! <= 0xffffffff;
    const epoch = validRtp ? this.frameGate.epochFor(rtp) : undefined;
    this.markConnection('firstDecodedFrame');
    this.presentation.video(at, validRtp ? rtp : undefined, this.layout?.epoch, epoch, metadata);
    plane.pendingObservation = undefined; plane.observationSequence++;
    const sameBarrier = this.presentationBarrierAcknowledged && this.presentationBarrier && barrierMatchesLayout(this.presentationBarrier, this.layout) &&
      document.visibilityState === 'visible' && this.rendererCurrent(renderer) && !renderer.view.stale &&
      plane.video.videoWidth === this.layout?.width && plane.video.videoHeight === this.layout.height;
    if (!sameBarrier || !validRtp || !this.positionVideoPlane(renderer)) {
      this.hideVideoPlane(renderer);
      if (!validRtp) this.fallbackPresentation('video-rtp-metadata-unavailable');
      return;
    }
    if (epoch !== this.layout?.epoch) {
      // The Endpoint gate prevents a different layout entering this stable
      // barrier. Retain an already authorized view when only signaling is late,
      // but don't attach a stale RTP identity to the autonomous video's pixels.
      if (epoch !== undefined) this.hideVideoPlane(renderer);
      else {
        plane.stats.observe(at, metadata.presentedFrames, plane.ready); plane.rtp = undefined;
        plane.pendingObservation = { sequence: plane.observationSequence, barrier: this.presentationBarrier!, peer: this.peer!, track: plane.track, attempt: this.attempt,
          identity: { view: { ...renderer.view }, layoutEpoch: renderer.layoutEpoch, layoutGeneration: renderer.layoutGeneration }, rtp: rtp!, at, wall: Date.now() };
      }
      this.scheduleVideoMetadataRefresh();
      return;
    }
    // Exact current-RTP reports require THIS element's real callback.
    plane.stats.observe(at, metadata.presentedFrames, plane.ready);
    plane.metadataRetries = 0; plane.rtp = rtp; plane.ready = true; plane.clip.style.opacity = '1';
    this.frameGate.observe(rtp); this.displayedRtp = rtp; this.displayedEpoch = epoch;
    this.authorizedAt = at; this.presentation.authorize(at, rtp!, epoch!); this.reconnect.connected();
    this.markConnection('firstVideoCompositor');
    const old = this.viewPresentations.get(renderer.view.id);
    if (old?.rtpTimestamp !== rtp || old?.layoutEpoch !== epoch) {
      const frame: CanvasPresentation = { viewId: renderer.view.id, rtpTimestamp: rtp!, layoutEpoch: epoch!, paintedAt: at, paintedWallTime: Date.now(), authorizedAt: at };
      this.viewPresentations.set(renderer.view.id, frame);
      this.latency.paint(rtp!, epoch!, at, frame.paintedWallTime);
      this.presentedListeners.forEach(listener => listener(frame));
    }
    renderer.ready(true); this.flushFocusedInput();
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
    const cached = this.paintedPlanes.get(identity.view.id);
    if (this.presentationBackend === 'canvas' && this.rendererCurrent(renderer) && this.displayReady) {
      if (this.sharedRenderer?.backend==='shared-webgl')this.redrawCurrentPresentation();
      else if (this.activeFrameSource === 'track-processor' && this.latestProcessorFrame) this.paintPlane(renderer,this.latestProcessorFrame.frame,identity.view,'plane-frame');
      else if (this.displayFrame) this.paintPlane(renderer,this.displayFrame,identity.view,'atlas');
      else if (cached && planeMatchesLayout(cached.identity, this.layout) && cached.source.rtpTimestamp === this.displayedRtp) {
        // Retain the existing plane bitmap across a static same-layout remount.
        const copiesBitmap = cached.canvas !== canvas;
        if (this.paintPlane(renderer, cached.canvas, { x: 0, y: 0, width: identity.view.width, height: identity.view.height }, 'plane') && copiesBitmap) this.routing.retainedPlaneRedraws++;
      }
    }
    const remove = () => { this.detachVideoPlane(renderer); this.renderers.delete(renderer);if(this.sharedRenderer?.backend==='shared-webgl'){this.sharedRenderer.clear();if(!this.redrawCurrentPresentation())this.requestPresentationRefresh();} };
    return { renderer, remove };
  }
  subscribePresentedFrames = (listener: (frame: CanvasPresentation) => void) => { this.presentedListeners.add(listener); return () => { this.presentedListeners.delete(listener); }; };
  getLastPresentation(viewId: string) { if (this.presentationBackend === 'video') return this.videoPlaneFor(viewId)?.plane.ready && this.videoPlaneFor(viewId)?.plane.rtp === this.viewPresentations.get(viewId)?.rtpTimestamp ? this.viewPresentations.get(viewId) : undefined; const frame = this.viewPresentations.get(viewId), plane = this.paintedPlanes.get(viewId); return frame?.layoutEpoch === this.layout?.epoch && plane && planeMatchesLayout(plane.identity, this.layout) ? frame : undefined; }
  getPaintedFrame(viewId: string, rtpTimestamp: number) { const frame = this.getLastPresentation(viewId); return frame?.rtpTimestamp === rtpTimestamp && this.displayedRtp === rtpTimestamp && this.displayReady ? this.displayFrame : undefined; }
  getPresentedPlane(viewId: string, rtpTimestamp: number): PresentedPlaneSource | undefined {
    if (this.presentationBackend === 'video') {
      const current = this.videoPlaneFor(viewId), layout = this.layout;
      if (!current || !current.plane.ready || current.plane.rtp !== rtpTimestamp || !layout) return undefined;
      const view = current.renderer.view;
      return { image: current.plane.video, sourceRect: { x: view.x, y: view.y, width: view.width, height: view.height }, kind: 'atlas', viewId,
        rtpTimestamp, layoutEpoch: layout.epoch, encodedWidth: view.width, encodedHeight: view.height, pixelsPerDip: view.deviceScaleFactor * (view.mediaScale ?? 1) };
    }
    const plane = this.paintedPlanes.get(viewId), frame = this.getLastPresentation(viewId);
    return this.displayReady && this.displayedRtp === rtpTimestamp && frame?.rtpTimestamp === rtpTimestamp && plane && (!plane.shared||this.sharedRenderer?.isVisible(plane.source.image as HTMLCanvasElement)) && [...this.renderers].some(renderer => renderer.canvas === plane.canvas && renderer.view.id === viewId && this.rendererCurrent(renderer)) ? plane.source : undefined;
  }
  private reportPresented(viewId: string, rtpTimestamp: number, paintedAt: number, paintedWallTime = Date.now()) {
    if (!this.layout || !this.displayReady || this.displayedRtp !== rtpTimestamp || !this.layout.views.some(view => view.id === viewId)) return;
    this.markConnection('firstCanvasPaint');
    const old = this.viewPresentations.get(viewId), isNewFrame = old?.rtpTimestamp !== rtpTimestamp || old.layoutEpoch !== this.layout.epoch;
    const frame = isNewFrame ? { viewId, rtpTimestamp, layoutEpoch: this.layout.epoch, paintedAt, paintedWallTime, authorizedAt: this.authorizedAt } : old!;
    if (isNewFrame) this.latency.paint(rtpTimestamp, this.layout.epoch, paintedAt, paintedWallTime);
    if (isNewFrame && this.activeFrameSource === 'track-processor') this.processorCounts.canvas++;
    this.viewPresentations.set(viewId, frame); this.presentation.paint(paintedAt, viewId, rtpTimestamp, frame.layoutEpoch, this.authorizedAt, isNewFrame);
    this.flushFocusedInput();
    if (isNewFrame) { if (this.dispatchingPaint) this.pendingPresentations.push(frame); else this.presentedListeners.forEach(listener => listener(frame)); }
  }
  private canInput(viewId: string) { if (this.presentationBackend === 'pending') return false; if (this.presentationBackend === 'video') return !!this.videoPlaneFor(viewId)?.plane.ready; return this.displayReady && this.displayedRtp !== undefined && !!this.getPresentedPlane(viewId, this.displayedRtp); }
  private notify() { this.listeners.forEach(listener => listener()); }
  private update(change: Partial<Diagnostics>) { this.diagnostics = { ...this.diagnostics, ...change }; this.notify(); }
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
      this.presentationBackend = this.preferVideoPresentation ? 'pending' : 'canvas';
      this.activeFrameSource = this.preferVideoPresentation ? 'video' : this.frameSource;
      if (this.activeFrameSource === 'track-processor' && this.presentationMode !== 'snapshot') throw new Error('track-processor 接收路径只支持 snapshot 呈现。');
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
      // Chrome89 can decode a replacement MediaStream on an old video while
      // never delivering rVFC again. Give each peer its own presentation state.
      const video = this.createReceiverVideo(); this.receiverVideo = video;
      this.peer = peer;
      const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
      peer.addTransceiver('audio', { direction: 'recvonly' });
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
        if (this.peer !== peer || this.video !== video) return;
        if (event.track.kind === 'audio') { this.audio.attach(event.track); return; }
        this.markConnection('track');
        if (this.activeFrameSource === 'track-processor') { this.processorTrack = event.track; this.startProcessorPump(peer, event.track); return; }
        this.processorTrack = event.track;
        if (this.presentationBackend === 'video') { for (const renderer of this.renderers) this.attachVideoPlane(renderer); return; }
        if (this.presentationBackend === 'pending') return;
        video.srcObject = new MediaStream([event.track]);
        this.startFramePump(peer);
        void video.play().catch(() => { if (this.peer === peer && this.video === video) this.update({ error: '视频播放被浏览器阻止，请重新连接。' }); });
      };
      this.bindChannel(peer.createDataChannel('remotekit', { ordered: true }));
      peer.ondatachannel = event => { if (this.peer === peer && this.attempt === attempt) this.bindChannel(event.channel); };
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
  private getProcessorDiagnostics() {
    const processor = this.processorSource?.processor;
    return { ...this.processorCounts, drawing: this.activeFrameSource === 'track-processor' ? 'immutable-frame-planes' : 'inactive', atlasSnapshotCopies: 0, scheduler: this.activeFrameSource === 'track-processor' ? this.activeProcessorScheduler : 'inactive', scheduling: this.activeFrameSource === 'track-processor' ? 'requestAnimationFrame' : 'inactive', profileEnabled: this.processorProfile, ownersHeld: this.pendingProcessorFrames.length + Number(!!this.latestProcessorFrame) + this.retiringProcessorOwners, pendingOwners: this.pendingProcessorFrames.length, displayedOwners: Number(!!this.latestProcessorFrame), retiringOwners: this.retiringProcessorOwners, total: processor?.totalFrames ?? this.processorCounts.total, discarded: processor?.discardedFrames ?? this.processorCounts.discarded };
  }
  private processorCurrent(source: ProcessorSource) { return this.peer === source.peer && this.attempt === source.attempt && this.processorSource === source; }
  private profileProcessor(event: string, values: Record<string, unknown> = {}) {
    if(event==='read'&&values.epoch!==values.layoutEpoch)this.presentationFlow.metadataMissingAtRead++;
    if(event==='drop'||event==='drop-read'||event==='raf-rejected'){const reason=String(values.reason??event);this.presentationFlow.drops[reason]=(this.presentationFlow.drops[reason]??0)+1;}
    if (!this.processorProfile) return;
    const entry = { event, at: performance.now(), queueDepth: this.pendingProcessorFrames.length, ...values };
    if (this.processorEvents.length < this.processorEventLimit) this.processorEvents.push(entry);
    else { this.processorEvents[this.processorEventCursor] = entry; this.processorEventCursor = (this.processorEventCursor + 1) % this.processorEventLimit; }
    this.processorEventCount++;
  }
  private processorProfileSnapshot() {
    return { enabled: this.processorProfile, capacity: this.processorEventLimit, total: this.processorEventCount, overwritten: Math.max(0, this.processorEventCount - this.processorEvents.length), events: [...this.processorEvents.slice(this.processorEventCursor), ...this.processorEvents.slice(0, this.processorEventCursor)] };
  }
  private dropProcessorOwner(owner: ProcessorFrameOwner, reason: string) {
    this.profileProcessor('drop', { rtp: owner.rtp, readAt: owner.readAt, reason, metadataEpoch: this.frameGate.epochFor(owner.rtp) ?? null, layoutEpoch: this.layout?.epoch, rafPending: this.processorRaf !== undefined });
    owner.frame.close(); this.processorCounts.ownerClosed++;
  }
  private closePendingProcessorFrame(reason = 'reset') {
    const pending = this.pendingProcessorFrames.splice(0);
    for (const owner of pending) this.dropProcessorOwner(owner, reason);
  }
  private processorFrameAlreadyDisplayed(rtp: number) { return !!this.latestProcessorFrame && this.latestProcessorFrame.rtp === rtp && this.displayedRtp === rtp && this.displayedEpoch === this.layout?.epoch && this.displayReady; }
  private closeLatestProcessorFrame() {
    const latest = this.latestProcessorFrame; this.latestProcessorFrame = undefined;
    if (latest) { this.profileProcessor('close-latest', { rtp: latest.rtp }); latest.frame.close(); this.processorCounts.ownerClosed++; }
  }
  private scheduleProcessorPresentation() {
    const source = this.processorSource, layout = this.layout;
    while (this.pendingProcessorFrames[0] && this.processorFrameAlreadyDisplayed(this.pendingProcessorFrames[0].rtp)) this.dropProcessorOwner(this.pendingProcessorFrames.shift()!, 'duplicate-displayed');
    const pending = this.pendingProcessorFrames[0];
    if(pending&&layout&&this.frameGate.epochFor(pending.rtp)!==layout.epoch)this.presentationFlow.metadataBlockedSchedules++;
    if (!source || !this.processorCurrent(source) || this.processorRaf !== undefined || !pending || !layout || this.frameGate.epochFor(pending.rtp) !== layout.epoch || pending.frame.displayWidth !== layout.width || pending.frame.displayHeight !== layout.height) return;
    const requestedAt = performance.now();
    const id = requestAnimationFrame(timestamp => {
      if (this.processorRaf !== id) return;
      this.processorRaf = undefined;
      if (!this.processorCurrent(source)) return;
      const entryNow = performance.now();
      this.processorCounts.rafCallbacks++;
      const candidate = this.pendingProcessorFrames[0], layout = this.layout;
      this.presentationFlow.rafWait.push(entryNow-requestedAt);if(this.presentationFlow.rafWait.length>2400)this.presentationFlow.rafWait.shift();
      this.profileProcessor('raf', { id, requestedAt, timestamp, entryNow, rtp: candidate?.rtp });
      if (this.presentationMode !== 'snapshot') { this.processorCounts.invalid++; this.processorFailed(new Error('track-processor 接收路径只支持 snapshot 呈现。')); return; }
      if (candidate && this.processorFrameAlreadyDisplayed(candidate.rtp)) { this.dropProcessorOwner(this.pendingProcessorFrames.shift()!, 'duplicate-displayed'); this.scheduleProcessorPresentation(); return; }
      if (!candidate || candidate.source !== source || !layout || this.frameGate.epochFor(candidate.rtp) !== layout.epoch || candidate.frame.displayWidth !== layout.width || candidate.frame.displayHeight !== layout.height) {
        this.profileProcessor('raf-rejected', { rtp: candidate?.rtp, reason: !candidate ? 'empty' : candidate.source !== source ? 'source' : !layout ? 'layout' : this.frameGate.epochFor(candidate.rtp) !== layout.epoch ? 'metadata-epoch' : 'dimensions' });
        return;
      }
      this.pendingProcessorFrames.shift();
      this.presentationFlow.readToAuthorize.push(performance.now()-candidate.readAt);if(this.presentationFlow.readToAuthorize.length>2400)this.presentationFlow.readToAuthorize.shift();
      const old = this.latestProcessorFrame;
      this.latestProcessorFrame = candidate; this.retiringProcessorOwners += Number(!!old);
      try {
        this.frameGate.observe(candidate.rtp);
        this.beginAuthorizedFrame();
        this.processorCounts.rafAdmitted++; this.processorCounts.authorized++;
        // One immutable frame per refresh; fifo2 leaves the next owner for a later RAF.
        this.dispatchPaint(() => this.paintAuthorizedPlanes(candidate.frame, 'plane-frame'));
      } catch (error) {
        this.processorCounts.invalid++; this.processorFailed(error);
      } finally {
        if (old) { old.frame.close(); this.processorCounts.ownerClosed++; this.retiringProcessorOwners--; }
        this.scheduleProcessorPresentation();
      }
    });
    this.processorRaf = id;
    this.profileProcessor('raf-request', { id, requestedAt, rtp: pending.rtp });
  }
  private stopProcessorPump() {
    if (this.processorRaf !== undefined) cancelAnimationFrame(this.processorRaf);
    this.processorRaf = undefined; this.closePendingProcessorFrame('stop'); this.closeLatestProcessorFrame();
    const source = this.processorSource;
    if (!source) return;
    this.processorCounts.total = source.processor.totalFrames;
    this.processorCounts.discarded = source.processor.discardedFrames;
    this.processorSource = undefined;
    // The read loop releases the lock after its outstanding read settles.
    void source.reader.cancel().catch(() => {});
  }
  private processorFailed(error: unknown) {
    if (this.processorFallback && this.peer && this.processorTrack) {
      if (this.signaling) this.signaling.processorFallbackReason = error instanceof Error ? error.message : String(error);
      this.stopProcessorPump(); this.activeFrameSource = 'video'; this.frameGate.observe(undefined);
      this.displayedRtp = undefined; this.displayedEpoch = undefined;
      const video = this.video, peer = this.peer, attempt = this.attempt, track = this.processorTrack;
      video.srcObject = new MediaStream([track]); this.startFramePump(peer);
      void video.play().catch(() => {
        if (this.peer === peer && this.attempt === attempt && this.video === video && this.processorTrack === track && this.activeFrameSource === 'video') this.connectionFailed('Video playback failed');
      }); return;
    }
    this.profileProcessor('error', { reason: error instanceof Error ? error.message : String(error) });
    this.frameGate.observe(undefined); this.pendingSnapshotRtp = undefined;
    for (const renderer of this.renderers) renderer.ready(false);
    this.stopProcessorPump();
    this.frameIssue = 'processor';
    this.update({ error: error instanceof Error ? error.message : String(error) });
  }
  private startProcessorPump(peer: RTCPeerConnection, track: MediaStreamTrack) {
    this.stopProcessorPump();
    // A replacement track cannot authorize a retained snapshot from the old source.
    this.frameGate.observe(undefined); this.pendingSnapshotRtp = undefined;
    this.displayedRtp = undefined; this.displayedEpoch = undefined;
    this.snapshotRtp = undefined; this.snapshotEpoch = undefined;
    this.viewPresentations.clear(); this.paintedPlanes.clear();
    for (const renderer of this.renderers) renderer.ready(false);
    const attempt = this.attempt;
    try {
      if (this.presentationMode !== 'snapshot') throw new Error('track-processor 接收路径只支持 snapshot 呈现。');
      if (this.processorScheduler !== 'latest1' && this.processorScheduler !== 'fifo2') throw new Error('Unsupported processor scheduler');
      this.activeProcessorScheduler = this.processorScheduler;
      const processor = createTrackProcessor(track), reader = processor.readable.getReader();
      const source: ProcessorSource = { processor, reader, peer, attempt }; this.processorSource = source;
      const current = () => this.processorCurrent(source);
      void (async () => {
        try {
          while (current()) {
            const result = await reader.read();
            const frame = result.value, readAt = performance.now();
            try {
              if (frame) { this.markConnection('firstDecodedFrame'); this.processorCounts.read++; }
              if (!current()) { if (frame) this.processorCounts.stale++; return; }
              if (result.done) throw new Error('track-processor 视频帧流已结束，画面与输入已暂停。');
              if (!frame) throw new Error('track-processor 未返回 VideoFrame。');
              if (this.presentationMode !== 'snapshot') throw new Error('track-processor 接收路径只支持 snapshot 呈现。');
              const rtp = processorRtpTimestamp(frame);
              // Pending receive does not revoke the last successfully painted plane.
              const width = frame.displayWidth, height = frame.displayHeight;
              if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('track-processor 返回无效的视频尺寸。');
              this.processorCounts.width = width; this.processorCounts.height = height;
              this.diagnostics.videoWidth = width; this.diagnostics.videoHeight = height;
              const sourceTimestamp = frame.timestamp;
              this.profileProcessor('read', { rtp, readAt, sourceTimestamp, epoch: this.frameGate.epochFor(rtp) ?? null, layoutEpoch: this.layout?.epoch });
              if (this.processorFrameAlreadyDisplayed(rtp) || this.pendingProcessorFrames.some(owner => owner.rtp === rtp)) { this.profileProcessor('drop-read', { rtp, reason: 'duplicate' }); continue; }
              const owner = frame.clone();
              const capacity = this.activeProcessorScheduler === 'fifo2' ? 2 : 1;
              while (this.pendingProcessorFrames.length >= capacity) { this.dropProcessorOwner(this.pendingProcessorFrames.shift()!, capacity === 2 ? 'fifo-overflow-oldest' : 'latest-replaced'); this.processorCounts.replaced++; }
              this.pendingSnapshotRtp = undefined;
              this.pendingProcessorFrames.push({ frame: owner, rtp, source, readAt, sourceTimestamp });
              this.scheduleProcessorPresentation();
            } finally {
              if (frame) { frame.close(); this.processorCounts.closed++; }
            }
          }
        } catch (error) {
          if (current()) { this.processorCounts.invalid++; this.processorFailed(error); }
        } finally {
          reader.releaseLock();
        }
      })();
    } catch (error) { this.processorCounts.invalid++; this.processorFailed(error); }
  }
  private startFramePump(peer: RTCPeerConnection) {
    const attempt = this.attempt, video = this.video;
    if (this.frameCallback !== undefined) video.cancelVideoFrameCallback?.(this.frameCallback);
    if (typeof video.requestVideoFrameCallback !== 'function') { this.update({ error: '浏览器缺少视频帧时间戳回调，无法安全匹配布局；画面与输入已暂停。' }); return; }
    const receive = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (this.peer !== peer || attempt !== this.attempt || this.video !== video) return;
      const callbackStarted = performance.now();
      try {
      const rtp = (metadata as VideoFrameCallbackMetadata & { rtpTimestamp?: number }).rtpTimestamp;
      this.markConnection('firstDecodedFrame'); this.frameGate.observe(rtp);
      const at = performance.now();
      this.videoPresentedFrames = metadata.presentedFrames;
      this.presentation.video(at, this.frameGate.rtpTimestamp, this.layout?.epoch, this.frameGate.epochFor(this.frameGate.rtpTimestamp), { ...metadata, decoded: (video as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount });
      if (this.frameGate.rtpTimestamp === undefined) {
        if (this.frameIssue !== 'missing-rtp') { this.frameIssue = 'missing-rtp'; this.update({ error: '视频帧缺少 rtpTimestamp，无法安全匹配布局；画面与输入已暂停。' }); }
      } else {
        const width = video.videoWidth, height = video.videoHeight;
        if (width > 0 && height > 0) {
          if (this.tryDirectFrame(width, height)) return;
          if (this.pendingFrame.width !== width || this.pendingFrame.height !== height) { this.pendingFrame.width = width; this.pendingFrame.height = height; }
          const context = this.pendingFrame.getContext('2d', { alpha: false });
          if (!context) return;
          const start = performance.now(); context.drawImage(video, 0, 0); this.presentation.cost('videoSnapshot', start, performance.now() - start);
          this.pendingSnapshotRtp = this.frameGate.rtpTimestamp;
          this.routing.snapshotFrames++;
          this.authorizeFrame();
        }
      }
      } finally {
        if (this.peer === peer && attempt === this.attempt && this.video === video) this.frameCallback = video.requestVideoFrameCallback(receive);
        this.presentation.cost('videoCallbackTotal', callbackStarted, performance.now() - callbackStarted);
      }
    };
    this.frameCallback = video.requestVideoFrameCallback(receive);
  }
  private authorizeFrame() {
    if (this.presentationBackend !== 'canvas') return;
    if (this.activeFrameSource === 'track-processor') { this.scheduleProcessorPresentation(); return; }
    if (!this.frameGate.ready || !this.layout || this.pendingSnapshotRtp !== this.frameGate.rtpTimestamp || this.pendingFrame.width !== this.layout.width || this.pendingFrame.height !== this.layout.height) return;
    if (this.displayedRtp === this.frameGate.rtpTimestamp && this.displayedEpoch === this.layout.epoch) return;
    // Swap the authorized snapshot rather than copying the atlas a second time.
    [this.authorizedFrame, this.pendingFrame] = [this.pendingFrame, this.authorizedFrame];
    this.pendingSnapshotRtp = undefined;
    this.snapshotRtp = this.frameGate.rtpTimestamp; this.snapshotEpoch = this.layout.epoch;
    this.beginAuthorizedFrame();
    this.dispatchPaint(() => this.paintAuthorizedPlanes(this.authorizedFrame, 'atlas'));
  }
  private beginAuthorizedFrame() {
    this.markConnection('firstAuthorized');
    this.displayedRtp = this.frameGate.rtpTimestamp; this.displayedEpoch = this.layout!.epoch;
    this.authorizedAt = performance.now(); this.presentation.authorize(this.authorizedAt, this.displayedRtp!, this.displayedEpoch);
    this.reconnect.connected();
    if (this.frameIssue === 'missing-rtp' || this.frameIssue === 'processor') { this.frameIssue = undefined; this.update({ error: undefined }); }
  }
  private dispatchPaint(paint: () => void) {
    this.dispatchingPaint = true;
    try { paint(); }
    finally { this.dispatchingPaint = false; const frames = this.pendingPresentations.splice(0); for (const frame of frames) this.presentedListeners.forEach(listener => listener(frame)); }
    this.flushFocusedInput();
    this.frameListeners.forEach(listener => listener());
  }
  private countReason(bucket: Record<string, number>, reason: string) { bucket[reason] = (bucket[reason] ?? 0) + 1; }
  private rendererCurrent(renderer: PlaneRenderer) { return this.renderers.has(renderer) && renderer.canvas.isConnected && planeMatchesLayout(renderer, this.layout); }
  private tryDirectFrame(width: number, height: number) {
    if (this.presentationMode !== 'single-plane-direct') return false;
    let reason: string | undefined;
    const layout = this.layout, renderer = [...this.renderers][0];
    if (!layout || layout.views.length !== 1) reason = 'plane-count';
    else if (layout.views[0].stale) reason = 'plane-not-ready';
    else if (!this.frameGate.ready) reason = 'metadata-unmatched';
    else if (width !== layout.width || height !== layout.height) reason = 'video-dimensions';
    else if (this.directEpochReady !== layout.epoch) reason = 'layout-transition';
    else if (this.renderers.size !== 1) reason = 'renderer-count';
    else if (!renderer || !this.rendererCurrent(renderer)) reason = 'renderer-stale';
    if (reason) { this.countReason(this.routing.fallback, reason); return false; }
    this.pendingSnapshotRtp = undefined;
    this.snapshotRtp = undefined; this.snapshotEpoch = undefined;
    this.beginAuthorizedFrame();
    // Exactly one video read. As in the snapshot path, rVFC metadata and this
    // first draw are separate browser operations, not an atomic frame handle.
    this.dispatchPaint(() => { if (this.paintPlane(renderer!, this.video, renderer!.view, 'plane')) this.routing.directFrames++; });
    return true;
  }
  private paintPlane(renderer: PlaneRenderer, image: HTMLCanvasElement | HTMLVideoElement | VideoFrame, rect: PixelRect, kind: 'atlas' | 'plane' | 'plane-frame') {
    if (!this.rendererCurrent(renderer)) { this.countReason(this.routing.skippedRenderer, 'identity-epoch-geometry'); renderer.ready(false); return false; }
    if (!this.displayReady || this.displayedRtp === undefined || !this.layout) { renderer.ready(false); return false; }
    if (renderer.view.stale) { this.countReason(this.routing.skippedRenderer, 'source-not-ready'); renderer.ready(false); return false; }
    const view = renderer.view, node = renderer.canvas, context = node.getContext('2d', { alpha: false });
    const imageWidth = 'displayWidth' in image ? image.displayWidth : 'videoWidth' in image ? image.videoWidth : image.width, imageHeight = 'displayHeight' in image ? image.displayHeight : 'videoHeight' in image ? image.videoHeight : image.height;
    if (!context || rect.x < 0 || rect.y < 0 || rect.width !== view.width || rect.height !== view.height || rect.x + rect.width > imageWidth || rect.y + rect.height > imageHeight) { this.countReason(this.routing.skippedRenderer, 'source-dimensions'); renderer.ready(false); return false; }
    const start = performance.now();
    if (node.width !== view.width || node.height !== view.height) { node.width = view.width; node.height = view.height; }
    try { if (image !== node) context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, node.width, node.height); }
    catch (error) { if (kind !== 'plane-frame') throw error; this.countReason(this.routing.skippedRenderer, 'draw-failed'); this.profileProcessor('paint-failed', { rtp: this.displayedRtp, view: view.id, paintStartedAt: start, reason: 'draw-failed' }); renderer.ready(false); return false; }
    const paintedAt = performance.now(), paintedWallTime = Date.now();
    this.plane2dDraws++;
    if (kind === 'plane-frame') this.profileProcessor('paint', { rtp: this.displayedRtp, epoch: this.layout.epoch, view: view.id, paintStartedAt: start, paintEndedAt: paintedAt });
    this.presentation.cost('viewportDraw', start, paintedAt - start, view.id);
    const source: PresentedPlaneSource = { image: kind === 'atlas' ? image : node, sourceRect: kind === 'atlas' ? { x: view.x, y: view.y, width: view.width, height: view.height } : { x: 0, y: 0, width: view.width, height: view.height }, kind: kind === 'plane-frame' ? 'plane' : kind, viewId: view.id, rtpTimestamp: this.displayedRtp, layoutEpoch: this.layout.epoch, encodedWidth: view.width, encodedHeight: view.height, pixelsPerDip: view.deviceScaleFactor * (view.mediaScale ?? 1) };
    this.paintedPlanes.set(view.id, { identity: { view: { ...view }, layoutEpoch: this.layout.epoch, layoutGeneration: this.layout.generation }, canvas: node, source });
    if (kind === 'atlas') this.directEpochReady = this.layout.epoch;
    this.reportPresented(view.id, this.displayedRtp, paintedAt, paintedWallTime);
    renderer.ready(true);
    return true;
  }
  private flushFocusedInput() {
    const pending = this.pendingFocus;
    if (!pending || !this.canInput(pending.view)) return;
    const surface = this.layout?.views.find(view => view.id === pending.view);
    if (pending.acknowledged && surface && surface.session === pending.session && surface.instance === pending.instance && surface.document === pending.document && this.layout?.generation === pending.generation && this.layout.epoch === pending.epoch) { this.pendingFocus = null; if (pending.focused) for (const event of pending.events) this.sendInput(surface, event); }
  }
  private cancelPendingFocus(requestId = this.pendingFocus?.requestId) {
    const pending = this.pendingFocus;
    if (!pending || pending.requestId !== requestId) return false;
    clearTimeout(this.focusTimer); this.focusTimer = undefined;
    if (this.inputFocus.get(pending.view)?.identity === requestId) this.inputFocus.delete(pending.view);
    this.pendingFocus = null;
    return true;
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
        if (message.type === 'input.editable') { if (this.mobileEditing.receive(message, this.layout?.views ?? [])) this.notify(); return; }
        if (message.type === 'input.capabilities') this.clientGestures = message.clientGestures === 1;
        if (message.type === 'clock.pong') { this.endpointClockProbe.pong(message, performance.now(), Date.now()); return; }
        if(this.files.handle(message))return;
        if(message.type==='product.result' && message.version===1) { const entry=this.productPending.get(message.operationId);if(entry && entry.operation.operationGeneration===message.operationGeneration) {clearTimeout(entry.timer);this.productPending.delete(message.operationId);entry.resolve(message.result ?? {operationId:message.operationId,operationGeneration:message.operationGeneration,status:'rejected',error:String(message.error??'操作被拒绝')});} }
        if (message.type === 'presentation.mode') {
          if (message.version !== 1 || !['video', 'canvas'].includes(message.backend)) this.fallbackPresentation('invalid-presentation-mode');
          else if (this.presentationBackend === 'pending' && message.backend === 'video') {
            clearTimeout(this.presentationNegotiationTimer); this.presentationBackend = 'video';
            for (const renderer of this.renderers) this.attachVideoPlane(renderer);
            this.notify();
          } else if (message.backend === 'canvas' && this.presentationBackend !== 'canvas') this.fallbackPresentation('endpoint-canvas-mode');
        }
        if (message.type === 'presentation.prepare' && this.presentationBackend !== 'canvas') {
          const key = presentationBarrier(message);
          if (!key || !barrierMatchesLayout(key, this.layout)) this.fallbackPresentation('invalid-presentation-barrier');
          else this.preparePresentation(key, channel);
        }
        if (message.type === 'layout' && Array.isArray(message.views)) {
          if (message.clientGestures !== undefined) this.clientGestures = message.clientGestures === 1;
          if(!this.layout||this.layout.epoch!==message.epoch||this.layout.generation!==message.generation) {
            this.sharedRenderer?.clear(); this.hideVideoPlanes();
            this.presentationBarrierAcknowledged = false;
          }
          this.markConnection('firstLayout');
          if (this.activeFrameSource === 'track-processor' && this.layout && (this.layout.epoch !== message.epoch || this.layout.generation !== message.generation || this.layout.width !== message.width || this.layout.height !== message.height || this.layout.views.length !== message.views.length || this.layout.views.some(view => !message.views.some((next: Surface) => samePlane(view, next))))) { this.closePendingProcessorFrame('layout-change'); this.closeLatestProcessorFrame(); this.frameGate.observe(undefined); }
          this.layout = message; this.mobileEditing.reconcile(this.layout!.views);
          this.syncViewports();
          for (const [id, plane] of this.paintedPlanes) if (!planeMatchesLayout(plane.identity, this.layout)) { this.paintedPlanes.delete(id); this.viewPresentations.delete(id); }
          for (const renderer of this.renderers) if (!this.rendererCurrent(renderer)) { this.hideVideoPlane(renderer); renderer.ready(false); }
          if (![...this.paintedPlanes.values()].some(plane => planeMatchesLayout(plane.identity, this.layout))) this.directEpochReady = undefined;
          this.frameGate.setEpoch(message.epoch);
          this.authorizeFrame();
          const pending = this.pendingFocus;
          const surface = this.layout?.views.find(view => view.id === pending?.view);
          if (pending && (!surface || surface.session !== pending.session || surface.instance !== pending.instance || surface.document !== pending.document || this.layout?.generation !== pending.generation || this.layout?.epoch !== pending.epoch)) this.cancelPendingFocus(pending.requestId);
          this.flushFocusedInput();
          this.notify();
        }
        if (message.type === 'frame') { this.latency.record(message.rtpTimestamp, message.layoutEpoch, message); const start = performance.now(); if (Number.isInteger(message.rtpTimestamp) && typeof message.layoutEpoch === 'string') { this.presentation.frameMetadata(start, message.rtpTimestamp, message.layoutEpoch); this.encodedFrameSamples.push({ at: start, rtpTimestamp: message.rtpTimestamp, layoutEpoch: message.layoutEpoch, encodedBytes: typeof message.encodedBytes === 'number' ? message.encodedBytes : undefined, keyframe: typeof message.keyframe === 'boolean' ? message.keyframe : undefined }); if (this.encodedFrameSamples.length > 2400) this.encodedFrameSamples.shift(); } this.frameGate.record(message.rtpTimestamp, message.layoutEpoch); this.matchPendingVideoObservations(); if (message.layoutEpoch === this.layout?.epoch) this.scheduleVideoMetadataRefresh(); if (this.activeFrameSource === 'track-processor') this.profileProcessor('metadata', { rtp: message.rtpTimestamp, epoch: message.layoutEpoch }); this.authorizeFrame(); this.presentation.cost('frameMessageTotal', start, performance.now() - start); }
        if (message.type === 'stats') this.update({ endpoint: message });
        if (message.type === 'input.result' || message.type === 'focus') {
          if (message.type === 'input.result') {
            const sequence = String(message.clientSequence), sent = this.sentInput.get(sequence);
            this.sentInput.delete(sequence);
            if (sent) for (const listener of this.inputResultListeners) listener({ ...sent, sequence, ok: message.ok === true, error: message.error, touchState: message.touchState === 'processed' || message.touchState === 'terminal-invalidated' ? message.touchState : undefined, touchSequenceId: typeof message.touchSequenceId === 'string' ? message.touchSequenceId : undefined });
          }
          this.inputResults.push({ at: performance.now(), ...message }); if (this.inputResults.length > 128) this.inputResults.shift();
          if (message.type === 'input.result' && message.ok === false) this.update({ error: String(message.error ?? '远程输入被拒绝') });
          if (message.type === 'focus' && this.layout) {
            const pending = this.pendingFocus, token = message.token;
            const view = pending && this.layout.views.find(view => view.id === pending.view && view.session === pending.session && view.instance === pending.instance && view.document === pending.document);
            const matches = pending && view && message.focusRequestId === pending.requestId && message.layoutEpoch === pending.epoch && this.layout.epoch === pending.epoch && this.layout.generation === pending.generation;
            if (matches && message.ok === false) { this.cancelPendingFocus(pending.requestId); this.update({ error: String(message.error ?? '远程焦点请求被拒绝') }); }
            if (matches && message.ok && token && token.view === pending.view && token.session === pending.session && token.instance === pending.instance && token.document === pending.document && typeof token.focus === 'string') { clearTimeout(this.focusTimer); this.focusTimer = undefined; view.focus = token.focus; const focus = this.inputFocus.get(view.id); if (focus?.identity === pending.requestId) focus.token = token.focus; pending.acknowledged = true; this.mobileEditing.reconcile(this.layout.views); this.flushFocusedInput(); this.notify(); }
          }
        }
        if (message.type === 'error') this.update({ error: String(message.message ?? 'Endpoint 返回错误') });
      } catch { this.update({ error: '收到无法识别的 Endpoint 消息。' }); }
    };
  }
  sendInput(surface: Surface, event: Record<string, unknown>) {
    const terminalTouch = (event.type === 'touch' || event.type === 'gesture') && (event.action === 'cancel' || event.action === 'end' || event.action === 'momentumEnd');
    if ((event.type === 'touch' || event.type === 'gesture') && event.inputIdentity !== undefined && event.inputIdentity !== this.inputIdentity(surface)) { this.touchInputStats.dropped++; return false; }
    if (this.channel?.readyState !== 'open' || !this.layout || !terminalTouch && !this.canInput(surface.id)) { this.traceInput('blocked', surface, event, this.channel?.readyState !== 'open' ? 'channel' : 'unmatched-or-unpainted-frame'); return false; }
    if (this.pendingFocus?.view === surface.id) { if (!this.pendingFocus.focused) { this.traceInput('blocked', surface, event, 'blur-pending'); return false; } const events = this.pendingFocus.events, merged = events.length ? (mergeTouchMoves(events[events.length - 1], event) ?? mergeGestureMomentum(events[events.length - 1], event)) : undefined; if (merged) { events[events.length - 1] = merged; this.touchInputStats.merged++; return true; } if (events.length < (terminalTouch ? 128 : 112)) { events.push(event); this.traceInput('queued-focus', surface, event); return true; } this.traceInput('blocked', surface, event, 'focus-queue-full'); this.touchInputStats.dropped++; return false; }
    const current = this.layout.views.find(view => view.id === surface.id);
    if (!current || !samePlane(current, surface)) { this.traceInput('blocked', surface, event, 'stale-surface'); return false; }
    if (event.type === 'touch') { if (event.action === 'start' && event.sampleElapsedUs === 0) { if (event.clockMode === 'source') this.touchInputStats.sourceGestures++; else this.touchInputStats.arrivalFallbackGestures++; } if (event.action === 'cancel') this.touchInputStats.cancelled++; }
    const queued = { surface: { ...current }, event, epoch: this.layout.epoch, generation: this.layout.generation };
    const previous = this.queuedInput[this.queuedInput.length - 1];
    const merged = previous && previous.surface.id === current.id && previous.surface.focus === current.focus && previous.epoch === queued.epoch && previous.generation === queued.generation ? (mergeTouchMoves(previous.event, event) ?? mergeGestureMomentum(previous.event, event)) : undefined;
    if (merged) { previous.event = merged; this.touchInputStats.merged++; }
    else {
      // A bounded backlog reserves terminal events by discarding obsolete move
      // packets, never start/end/cancel. Recent move history remains in batches.
      if (this.queuedInput.length >= (terminalTouch ? 128 : 112)) {
        const expendable = this.queuedInput.findIndex(item => item.event.type === 'touch' && item.event.action === 'move' && item.event.gestureMode !== 'client-v1');
        if (expendable >= 0) { this.queuedInput.splice(expendable, 1); this.touchInputStats.dropped++; }
        else { this.touchInputStats.dropped++; return false; }
      }
      this.queuedInput.push(queued); this.touchInputStats.queued++;
    }
    this.drainInput(); return true;
  }
  private drainInput() {
    clearTimeout(this.inputDrainTimer); this.inputDrainTimer = undefined;
    if (this.channel?.readyState !== 'open' || !this.layout) return;
    while (this.queuedInput.length && this.channel.bufferedAmount <= 256 * 1024) {
      const item = this.queuedInput[0], current = this.layout.views.find(view => view.id === item.surface.id);
      if (!current || !samePlane(current, item.surface) || current.focus !== item.surface.focus || this.layout.epoch !== item.epoch || this.layout.generation !== item.generation) { this.queuedInput.shift(); this.touchInputStats.dropped++; continue; }
      if (!this.canInput(current.id)) break;
      this.queuedInput.shift();
      const sequence = String(++this.sequence);
      this.sentInput.set(sequence, { surface: { ...current }, identity: this.inputIdentity(current), event: item.event });
      while (this.sentInput.size > 256) this.sentInput.delete(this.sentInput.keys().next().value!);
      this.channel.send(JSON.stringify({ type: 'input', view: current.id, session: current.session, instance: current.instance, document: current.document, focus: current.focus, outputGeneration: item.generation, layoutEpoch: item.epoch, sequence, event: item.event }));
      this.traceInput('sent', current, item.event);
    }
    if (this.queuedInput.length) this.inputDrainTimer = setTimeout(() => this.drainInput(), 10);
  }
  focus(surface: Surface, focused: boolean) {
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
    this.focusTimer = setTimeout(() => { if (this.pendingFocus?.requestId === requestId && !this.pendingFocus.acknowledged && this.cancelPendingFocus(requestId)) this.update({ error: '远程焦点请求超时' }); }, 2000);
    this.channel.send(JSON.stringify({ type: 'focus', focusRequestId: requestId, view: current.id, session: current.session, instance: current.instance, document: current.document, focus: current.focus, layoutEpoch: this.layout.epoch, focused }));
  }
  private async readStats(peer: RTCPeerConnection) {
    if (peer !== this.peer || this.statsReadingPeer === peer) return;
    this.statsReadingPeer = peer;
    try {
      const stats = await peer.getStats();
      if (peer !== this.peer) return;
      const update: Partial<Diagnostics> = {};
      let inboundCounters: { decodedFrames?: number; packetsLost?: number; framesDropped?: number } = {};
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
          inboundCounters = { decodedFrames: report.framesDecoded, packetsLost: report.packetsLost, framesDropped: report.framesDropped };
          update.framesDecoded = report.framesDecoded; update.framesPerSecond = report.framesPerSecond; update.bytesReceived = report.bytesReceived;
          if (typeof report.timestamp === 'number' && typeof report.bytesReceived === 'number') {
            const previous = this.lastInboundSample;
            if (previous && report.timestamp > previous.timestamp && report.bytesReceived >= previous.bytes) update.receiveBitrateBps = (report.bytesReceived - previous.bytes) * 8000 / (report.timestamp - previous.timestamp);
            if (previous?.frames !== undefined && typeof report.framesDecoded === 'number' && report.timestamp > previous.timestamp && report.framesDecoded >= previous.frames) update.decodedFramesPerSecond = (report.framesDecoded - previous.frames) * 1000 / (report.timestamp - previous.timestamp);
            else if (typeof report.framesPerSecond === 'number') update.decodedFramesPerSecond = report.framesPerSecond;
            this.lastInboundSample = { timestamp: report.timestamp, bytes: report.bytesReceived, frames: report.framesDecoded };
          }
          update.videoWidth = this.activeFrameSource === 'track-processor' ? this.processorCounts.width || undefined : report.frameWidth;
          update.videoHeight = this.activeFrameSource === 'track-processor' ? this.processorCounts.height || undefined : report.frameHeight;
          if (report.codecId) update.codec = stats.get(report.codecId)?.mimeType;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) { update.roundTripTime = report.currentRoundTripTime; update.selectedCandidates = { pair: report, local: stats.get(report.localCandidateId), remote: stats.get(report.remoteCandidateId) }; }
      });
      const paints = this.presentationBackend === 'video' ? Object.fromEntries([...this.videoPlanes].map(([renderer, plane])=>[renderer.view.id,plane.stats.snapshot(performance.now())])) : this.presentation.paintStatistics(); update.paintFpsByView = Object.fromEntries(Object.entries(paints).map(([id, value]) => [id, value.fps]));
      update.rendering=this.getRenderingDiagnostics();
      update.displayFramesPerSecond = this.selectedViewId ? paints[this.selectedViewId]?.fps : undefined;
      this.update(update);
      if (this.layout && this.channel?.readyState === 'open') {
        const counts = this.presentationBackend === 'video' ? new Map([...this.videoPlanes].map(([renderer, plane])=>[renderer.view.id,plane.stats.frames])) : this.presentation.paintFrameCounts();
        const views = new Set([...this.renderers].filter(renderer => {
          if (!this.rendererCurrent(renderer)) return false;
          const rect = renderer.canvas.getBoundingClientRect(), style = getComputedStyle(renderer.canvas);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse';
        }).map(renderer => renderer.view.id));
        const feedback = this.mediaFeedback.sample({ layoutEpoch: this.layout.epoch, outputGeneration: this.layout.generation,
          ...inboundCounters, ...(this.activeFrameSource === 'video' ? { videoFrames: this.videoPresentedFrames } : {}),
          planes: [...views].map(view => ({ view, frames: counts.get(view) })),
          roundTripTimeMs: update.roundTripTime === undefined ? undefined : update.roundTripTime * 1000 });
        if (feedback?.displayHzEstimate) this.displayHzEstimate = feedback.displayHzEstimate;
        if (feedback && this.channel.bufferedAmount <= 65536) this.channel.send(JSON.stringify(feedback));
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
    if (ping) { try { channel.send(JSON.stringify(ping)); } catch { /* The next bounded sample retries if the channel remains open. */ } }
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
    this.mobileEditing.reset();
    this.audio.detach();
    clearTimeout(this.videoMetadataRefreshTimer); this.videoMetadataRefreshTimer = undefined;
    clearTimeout(this.presentationNegotiationTimer); this.presentationNegotiationTimer = undefined;
    this.cancelPresentationAck(); this.hideVideoPlanes();
    for (const renderer of this.videoPlanes.keys()) this.detachVideoPlane(renderer);
    if (this.presentationVisibility) document.removeEventListener('visibilitychange', this.presentationVisibility);
    this.presentationVisibility = undefined; this.presentationBarrier = undefined; this.presentationBarrierAcknowledged = false;
    this.presentationFallbackReason = undefined; this.presentationBackend = 'canvas';
    this.sharedRenderer?.dispose();this.sharedRenderer=undefined;this.mediaRefreshAt=-Infinity;
    clearTimeout(this.inputDrainTimer); this.inputDrainTimer = undefined; this.queuedInput = []; this.inputFocus.clear();
    this.signalAttemptId = undefined; this.remoteSignalConnection = undefined; this.remoteDescriptionReady = false; this.remoteIce = []; this.localIce = []; this.iceDelivery = Promise.resolve(); this.localIceDelivery = Promise.resolve();
    this.attempt++; this.sentInput.clear(); this.latency.reset(); this.endpointClockProbe.reset(); this.controlClockProbe.reset(); this.feedbackReading = false; this.processorTrack = undefined; this.displayHzEstimate = undefined;
    this.stopProcessorPump();
    this.mediaFeedback.stop(); this.statsReadingPeer = undefined; this.networkRead = undefined; this.videoPresentedFrames = undefined;
    if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback?.(this.frameCallback);
    this.frameCallback = undefined; this.frameGate.clear(); this.displayedRtp = undefined; this.displayedEpoch = undefined; this.frameIssue = undefined;
    this.lastInboundSample = undefined;
    this.viewPresentations.clear(); this.pendingPresentations = []; this.dispatchingPaint = false;
    this.pendingSnapshotRtp = undefined; this.snapshotRtp = undefined; this.snapshotEpoch = undefined; this.directEpochReady = undefined;
    this.paintedPlanes.clear(); for (const renderer of this.renderers) renderer.ready(false); this.renderers.clear();
    for (const registration of this.viewports) { registration.renderer = undefined; registration.remove = undefined; }
    this.endpointGeneration = undefined;
    if (this.connectionId) { void this.rtcRequest('rtc.close', { connectionId: this.connectionId }).catch(() => {}); this.connectionId = undefined; }
    clearInterval(this.timer);
    this.files.disconnect();
    const peer = this.peer; this.peer = null; this.channel = null; peer?.close();
    this.video.pause(); this.video.srcObject = null; this.video.remove?.(); this.layout = null; this.clientGestures = false;
    this.pendingFocus = null;
    this.diagnostics = { connection: '未连接', channel: '未连接' }; this.notify();
  }
}
