import { CaptureLatency } from './capture-latency';
import { request, type Diagnostics, type Layout, type Surface, type CanvasPresentation } from './types';
import { FrameEpochGate } from './frame-epoch';
import { configureReceiveOffer, originalGatheredOffer, probeReceiveCapabilities, loadReceiveProfile, selectProductReceiveProfile, type ProductReceiveSelection, type ReceiveProfile } from './receive-profile';
import { ReconnectPolicy } from './reconnect';
import { PresentationDiagnostics } from './presentation-diagnostics';
import { planeMatchesLayout, samePlane, type PlaneIdentity, type PresentedPlaneSource, type PresentationMode, type PixelRect } from './plane-source';
import { MediaFeedbackSampler } from './media-feedback';
import { createTrackProcessor, processorRtpTimestamp, type TrackProcessor, type ProcessorVideoFrame } from './track-processor';

export type ControlRpc = (method: 'rtc.offer' | 'rtc.ice' | 'rtc.close' | 'clock.ping' | 'feedback', params: unknown) => Promise<unknown>;

interface PlaneRenderer extends PlaneIdentity { canvas: HTMLCanvasElement; ready: (ready: boolean) => void }
interface PaintedPlane { identity: PlaneIdentity; canvas: HTMLCanvasElement; source: PresentedPlaneSource }
export type FrameSource = 'video' | 'track-processor';
interface ProcessorFrameOwner { frame: VideoFrame; rtp: number; source: ProcessorSource; readAt: number; sourceTimestamp: number }
interface ProcessorSource { processor: TrackProcessor; reader: ReadableStreamDefaultReader<ProcessorVideoFrame>; peer: RTCPeerConnection; attempt: number }

/** All endpoint wire adaptation lives here; the UI never owns recovery state. */
export class RemoteTransport {
  private controlRpc: ControlRpc | undefined;
  private diagnosticHttp = false;
  private productReceiveSelection?: ProductReceiveSelection;
  private receiveFallback?: Record<string, unknown>;
  private latency = new CaptureLatency();
  private clockReading = false;
  private clockAt = -Infinity;
  private feedbackReading = false;
  private processorFallback = false;
  private displayHzEstimate?: number;
  private processorTrack?: MediaStreamTrack;
  setControlRpc(callback: ControlRpc) { this.controlRpc = callback; this.diagnosticHttp = false; this.processorFallback = true; this.processorScheduler = 'fifo2'; this.frameSource = typeof (globalThis as any).MediaStreamTrackProcessor === 'function' && !/Chrome\/89\./.test(navigator.userAgent) ? 'track-processor' : 'video'; }
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
  private paintedPlanes = new Map<string, PaintedPlane>();
  private routing = { directFrames: 0, snapshotFrames: 0, retainedPlaneRedraws: 0, fallback: {} as Record<string, number>, skippedRenderer: {} as Record<string, number> };
  private frameGate = new FrameEpochGate();
  private displayedRtp: number | undefined;
  private displayedEpoch: string | undefined;
  private frameCallback: number | undefined;
  private frameIssue: string | undefined;
  private presentation = new PresentationDiagnostics();
  readonly encodedFrameSamples: { at: number; rtpTimestamp: number; layoutEpoch: string; encodedBytes?: number; keyframe?: boolean }[] = [];
  get presentationDiagnostics() { return this.getPresentationDiagnostics(); }
  getPresentationDiagnostics(raw = false) { const sizes = this.encodedFrameSamples.flatMap(frame => frame.encodedBytes === undefined ? [] : [frame.encodedBytes]).sort((a, b) => a - b); return { paintVersion: 'plane-source-v3', frameSource: this.activeFrameSource, processor: this.getProcessorDiagnostics(), presentationRouting: { mode: this.presentationMode, ...this.routing, fallback: { ...this.routing.fallback }, skippedRenderer: { ...this.routing.skippedRenderer } }, selectedViewId: this.selectedViewId, callbackRegistration: this.activeFrameSource === 'video' ? 'after-work' : 'not-applicable', encodedFrameBytes: { measured: sizes.length, p95: sizes.length ? sizes[Math.ceil(sizes.length * .95) - 1] : null, max: sizes.length ? sizes[sizes.length - 1] : null, keyframeMeasured: this.encodedFrameSamples.filter(frame => frame.keyframe !== undefined).length, keyframes: this.encodedFrameSamples.some(frame => frame.keyframe !== undefined) ? this.encodedFrameSamples.filter(frame => frame.keyframe === true).length : null }, ...this.presentation.snapshot(raw), ...(raw ? { encodedFrameSamples: this.encodedFrameSamples, processorProfile: this.processorProfileSnapshot() } : {}) }; }
  resetPresentationDiagnostics() { this.processorEvents = []; this.processorEventCursor = 0; this.processorEventCount = 0; this.processorCounts = { total: undefined, discarded: undefined, read: 0, invalid: 0, closed: 0, stale: 0, authorized: 0, rafCallbacks: 0, rafAdmitted: 0, replaced: 0, ownerClosed: 0, canvas: 0, width: this.processorCounts.width, height: this.processorCounts.height }; this.presentation = new PresentationDiagnostics(); this.encodedFrameSamples.length = 0; this.routing = { directFrames: 0, snapshotFrames: 0, retainedPlaneRedraws: 0, fallback: {}, skippedRenderer: {} }; }
  recordClientRaf(at: number) { this.presentation.clientRaf(at); }
  recordPresentationCost(name: string, at: number, durationMs: number, view: string | null = null) { this.presentation.cost(name, at, durationMs, view); }
  get displayReady() { return this.frameGate.ready && this.displayedRtp === this.frameGate.rtpTimestamp && this.displayedEpoch === this.layout?.epoch; }
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
  private traceInput(phase: string, surface: Surface, event: Record<string, unknown>, reason?: string) { this.inputTrace.push({ at: performance.now(), phase, view: surface.id, eventType: event.type, action: event.action, reason, epoch: this.layout?.epoch }); if (this.inputTrace.length > 128) this.inputTrace.shift(); }
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
    video.autoplay = true; video.muted = true; video.playsInline = true;
    return video;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeFrames = (listener: () => void) => { this.frameListeners.add(listener); return () => { this.frameListeners.delete(listener); }; };
  registerPlane(identity: PlaneIdentity, canvas: HTMLCanvasElement, ready: (ready: boolean) => void) {
    const renderer: PlaneRenderer = { ...identity, view: { ...identity.view }, canvas, ready };
    this.renderers.add(renderer);
    const cached = this.paintedPlanes.get(identity.view.id);
    if (this.rendererCurrent(renderer) && this.displayReady) {
      if (this.activeFrameSource === 'track-processor' && this.latestProcessorFrame) this.paintPlane(renderer, this.latestProcessorFrame.frame, identity.view, 'plane-frame');
      else if (this.displayFrame) this.paintPlane(renderer, this.displayFrame, identity.view, 'atlas');
      else if (cached && planeMatchesLayout(cached.identity, this.layout) && cached.source.rtpTimestamp === this.displayedRtp) {
        // Retain the existing plane bitmap across a static same-layout remount.
        const copiesBitmap = cached.canvas !== canvas;
        if (this.paintPlane(renderer, cached.canvas, { x: 0, y: 0, width: identity.view.width, height: identity.view.height }, 'plane') && copiesBitmap) this.routing.retainedPlaneRedraws++;
      }
    }
    return () => { this.renderers.delete(renderer); };
  }
  subscribePresentedFrames = (listener: (frame: CanvasPresentation) => void) => { this.presentedListeners.add(listener); return () => { this.presentedListeners.delete(listener); }; };
  getLastPresentation(viewId: string) { const frame = this.viewPresentations.get(viewId), plane = this.paintedPlanes.get(viewId); return frame?.layoutEpoch === this.layout?.epoch && plane && planeMatchesLayout(plane.identity, this.layout) ? frame : undefined; }
  getPaintedFrame(viewId: string, rtpTimestamp: number) { const frame = this.getLastPresentation(viewId); return frame?.rtpTimestamp === rtpTimestamp && this.displayedRtp === rtpTimestamp && this.displayReady ? this.displayFrame : undefined; }
  getPresentedPlane(viewId: string, rtpTimestamp: number): PresentedPlaneSource | undefined {
    const plane = this.paintedPlanes.get(viewId), frame = this.getLastPresentation(viewId);
    return this.displayReady && this.displayedRtp === rtpTimestamp && frame?.rtpTimestamp === rtpTimestamp && plane && [...this.renderers].some(renderer => renderer.canvas === plane.canvas && renderer.view.id === viewId && this.rendererCurrent(renderer)) ? plane.source : undefined;
  }
  private reportPresented(viewId: string, rtpTimestamp: number, paintedAt: number, paintedWallTime = Date.now()) {
    if (!this.layout || !this.displayReady || this.displayedRtp !== rtpTimestamp || !this.layout.views.some(view => view.id === viewId)) return;
    const old = this.viewPresentations.get(viewId), isNewFrame = old?.rtpTimestamp !== rtpTimestamp || old.layoutEpoch !== this.layout.epoch;
    const frame = isNewFrame ? { viewId, rtpTimestamp, layoutEpoch: this.layout.epoch, paintedAt, paintedWallTime, authorizedAt: this.authorizedAt } : old!;
    if (isNewFrame) this.latency.paint(rtpTimestamp, this.layout.epoch, paintedAt, paintedWallTime);
    if (isNewFrame && this.activeFrameSource === 'track-processor') this.processorCounts.canvas++;
    this.viewPresentations.set(viewId, frame); this.presentation.paint(paintedAt, viewId, rtpTimestamp, frame.layoutEpoch, this.authorizedAt, isNewFrame);
    this.flushFocusedInput();
    if (isNewFrame) { if (this.dispatchingPaint) this.pendingPresentations.push(frame); else this.presentedListeners.forEach(listener => listener(frame)); }
  }
  private canInput(viewId: string) { return this.displayReady && this.displayedRtp !== undefined && !!this.getPresentedPlane(viewId, this.displayedRtp); }
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
  private connectionFailed(reason: string) { this.closeLocal(); this.update({ connection: '连接失败', error: reason }); this.scheduleReconnect(reason); }
  observeEndpointGeneration(generation: number | undefined) {
    if (generation !== undefined && this.endpointGeneration !== undefined && this.endpointGeneration !== generation && this.reconnect.wanted && this.peer) this.connectionFailed('Endpoint 已重启，正在恢复原工作台');
  }
  private async establish() {
    this.closeLocal(); this.signaling = undefined;
    const attempt = ++this.attempt;
    let negotiating = false;
    this.update({ connection: '正在连接', error: undefined });
    try {
      this.activeFrameSource = this.frameSource;
      if (this.activeFrameSource === 'track-processor' && this.presentationMode !== 'snapshot') throw new Error('track-processor 接收路径只支持 snapshot 呈现。');
      const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
      // Chrome89 can decode a replacement MediaStream on an old video while
      // never delivering rVFC again. Give each peer its own presentation state.
      const video = this.createReceiverVideo(); this.receiverVideo = video;
      this.peer = peer;
      const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
      const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
      if (codecs && typeof transceiver.setCodecPreferences === 'function') transceiver.setCodecPreferences([...codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264'), ...codecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/h264')]);
      peer.onconnectionstatechange = () => {
        if (this.peer !== peer) return;
        if (peer.connectionState === 'connected') { clearTimeout(this.retryTimer); this.retryTimer = undefined; this.pendingFailure = undefined; }
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed' || peer.connectionState === 'disconnected') { this.connectionFailed('媒体连接已中断'); return; }
        const labels: Record<string, string> = { new: '正在连接', connecting: '正在连接', connected: '已连接', disconnected: '连接中断', failed: '连接失败', closed: '未连接' };
        this.update({ connection: labels[peer.connectionState] ?? peer.connectionState });
      };
      peer.ontrack = event => {
        if (this.peer !== peer || this.video !== video) return;
        if (this.activeFrameSource === 'track-processor') { this.processorTrack = event.track; this.startProcessorPump(peer, event.track); return; }
        video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        this.startFramePump(peer);
        void video.play().catch(() => { if (this.peer === peer && this.video === video) this.update({ error: '视频播放被浏览器阻止，请重新连接。' }); });
      };
      this.bindChannel(peer.createDataChannel('remotekit', { ordered: true }));
      peer.ondatachannel = event => this.bindChannel(event.channel);
      if (this.controlRpc && !this.diagnosticHttp) {
        if (!this.productReceiveSelection) this.productReceiveSelection = await selectProductReceiveProfile(navigator.userAgent, codecs);
        if (attempt !== this.attempt) return;
        this.receiveProfile = this.productReceiveSelection.profile;
        this.update({ receiveSelection: this.productReceiveSelection });
      }
      negotiating = true;
      const originalOffer = await peer.createOffer();
      const effectiveOffer = configureReceiveOffer(originalOffer.sdp ?? '', this.receiveProfile, navigator.userAgent, codecs);
      this.signaling = { receiveSelection: this.productReceiveSelection, previousNegotiationFailure: this.receiveFallback, receiveProfile: this.receiveProfile, originalOfferSdp: originalOffer.sdp, effectiveOfferSdp: effectiveOffer.sdp, changes: effectiveOffer.changes };
      await peer.setLocalDescription({ type: 'offer', sdp: effectiveOffer.sdp });
      await new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === 'complete') { resolve(); return; }
        const timeout = setTimeout(() => { cleanup(); reject(new Error('ICE 收集超时，请检查网络后重试。')); }, 12000);
        const changed = () => { if (peer.iceGatheringState === 'complete' || peer.signalingState === 'closed') { cleanup(); resolve(); } };
        const cleanup = () => { clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', changed); peer.removeEventListener('signalingstatechange', changed); };
        peer.addEventListener('icegatheringstatechange', changed);
        peer.addEventListener('signalingstatechange', changed);
      });
      if (attempt !== this.attempt) return;
      this.signaling = { receiveSelection: this.productReceiveSelection, previousNegotiationFailure: this.receiveFallback, receiveProfile: this.receiveProfile, originalOfferSdp: originalOffer.sdp, originalGatheredSdp: originalGatheredOffer(peer.localDescription?.sdp ?? '', originalOffer.sdp ?? ''), effectiveOfferSdp: peer.localDescription?.sdp, changes: effectiveOffer.changes };
      const answer = await this.rtcRequest<RTCSessionDescriptionInit & { connectionId: string; endpointGeneration?: number; networkSimulation?: Record<string, unknown> }>('rtc.offer', { type: 'offer', sdp: peer.localDescription?.sdp });
      if (attempt !== this.attempt) { void this.rtcRequest('rtc.close', { connectionId: answer.connectionId }).catch(() => {}); return; }
      this.connectionId = answer.connectionId;
      this.endpointGeneration = answer.endpointGeneration;
      this.signaling.answerSdp = answer.sdp;
      this.update({ connectionId: answer.connectionId, networkSimulation: answer.networkSimulation });
      await peer.setRemoteDescription(answer);
      negotiating = false;
      if (attempt !== this.attempt) return;
      this.mediaFeedback.start();
      this.timer = setInterval(() => { void this.readStats(peer); }, this.controlRpc ? 1000 : 1500);
    } catch (error) {
      if (attempt !== this.attempt) return;
      if (negotiating && this.controlRpc && !this.diagnosticHttp && this.productReceiveSelection?.profile === 'h264-level42-experimental') {
        this.receiveFallback = { ...this.signaling, failure: error instanceof Error ? error.message : String(error) };
        this.productReceiveSelection = { profile: 'native', reason: 'Level4.2 negotiation failed; using native compatibility offer: ' + String(error) };
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
    if (!source || !this.processorCurrent(source) || this.processorRaf !== undefined || !pending || !layout || this.frameGate.epochFor(pending.rtp) !== layout.epoch || pending.frame.displayWidth !== layout.width || pending.frame.displayHeight !== layout.height) return;
    const requestedAt = performance.now();
    const id = requestAnimationFrame(timestamp => {
      if (this.processorRaf !== id) return;
      this.processorRaf = undefined;
      if (!this.processorCurrent(source)) return;
      const entryNow = performance.now();
      this.processorCounts.rafCallbacks++;
      const candidate = this.pendingProcessorFrames[0], layout = this.layout;
      this.profileProcessor('raf', { id, requestedAt, timestamp, entryNow, rtp: candidate?.rtp });
      if (this.presentationMode !== 'snapshot') { this.processorCounts.invalid++; this.processorFailed(new Error('track-processor 接收路径只支持 snapshot 呈现。')); return; }
      if (candidate && this.processorFrameAlreadyDisplayed(candidate.rtp)) { this.dropProcessorOwner(this.pendingProcessorFrames.shift()!, 'duplicate-displayed'); this.scheduleProcessorPresentation(); return; }
      if (!candidate || candidate.source !== source || !layout || this.frameGate.epochFor(candidate.rtp) !== layout.epoch || candidate.frame.displayWidth !== layout.width || candidate.frame.displayHeight !== layout.height) {
        this.profileProcessor('raf-rejected', { rtp: candidate?.rtp, reason: !candidate ? 'empty' : candidate.source !== source ? 'source' : !layout ? 'layout' : this.frameGate.epochFor(candidate.rtp) !== layout.epoch ? 'metadata-epoch' : 'dimensions' });
        return;
      }
      this.pendingProcessorFrames.shift();
      const old = this.latestProcessorFrame;
      this.latestProcessorFrame = candidate; this.retiringProcessorOwners += Number(!!old);
      try {
        this.frameGate.observe(candidate.rtp);
        this.beginAuthorizedFrame();
        this.processorCounts.rafAdmitted++; this.processorCounts.authorized++;
        // One immutable frame per refresh; fifo2 leaves the next owner for a later RAF.
        this.dispatchPaint(() => { for (const renderer of this.renderers) this.paintPlane(renderer, candidate.frame, renderer.view, 'plane-frame'); });
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
      this.video.srcObject = new MediaStream([this.processorTrack]); this.startFramePump(this.peer);
      void this.video.play().catch(() => this.connectionFailed('Video playback failed')); return;
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
              if (frame) this.processorCounts.read++;
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
      this.frameGate.observe(rtp);
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
    if (this.activeFrameSource === 'track-processor') { this.scheduleProcessorPresentation(); return; }
    if (!this.frameGate.ready || !this.layout || this.pendingSnapshotRtp !== this.frameGate.rtpTimestamp || this.pendingFrame.width !== this.layout.width || this.pendingFrame.height !== this.layout.height) return;
    if (this.displayedRtp === this.frameGate.rtpTimestamp && this.displayedEpoch === this.layout.epoch) return;
    // Swap the authorized snapshot rather than copying the atlas a second time.
    [this.authorizedFrame, this.pendingFrame] = [this.pendingFrame, this.authorizedFrame];
    this.pendingSnapshotRtp = undefined;
    this.snapshotRtp = this.frameGate.rtpTimestamp; this.snapshotEpoch = this.layout.epoch;
    this.beginAuthorizedFrame();
    this.dispatchPaint(() => { for (const renderer of this.renderers) this.paintPlane(renderer, this.authorizedFrame, renderer.view, 'atlas'); });
  }
  private beginAuthorizedFrame() {
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
  private bindChannel(channel: RTCDataChannel) {
    this.channel = channel;
    channel.onopen = () => { if (this.channel === channel) this.update({ channel: '已连接' }); };
    channel.onclose = () => { if (this.channel === channel) this.connectionFailed('输入通道已关闭'); };
    channel.onerror = () => { if (this.channel === channel) this.connectionFailed('输入通道出现错误'); };
    channel.onmessage = event => {
      if (this.channel !== channel) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'layout' && Array.isArray(message.views)) {
          if (this.activeFrameSource === 'track-processor' && this.layout && (this.layout.epoch !== message.epoch || this.layout.generation !== message.generation || this.layout.width !== message.width || this.layout.height !== message.height || this.layout.views.length !== message.views.length || this.layout.views.some(view => !message.views.some((next: Surface) => samePlane(view, next))))) { this.closePendingProcessorFrame('layout-change'); this.closeLatestProcessorFrame(); this.frameGate.observe(undefined); }
          this.layout = message;
          for (const [id, plane] of this.paintedPlanes) if (!planeMatchesLayout(plane.identity, this.layout)) { this.paintedPlanes.delete(id); this.viewPresentations.delete(id); }
          for (const renderer of this.renderers) if (!this.rendererCurrent(renderer)) renderer.ready(false);
          if (![...this.paintedPlanes.values()].some(plane => planeMatchesLayout(plane.identity, this.layout))) this.directEpochReady = undefined;
          this.frameGate.setEpoch(message.epoch);
          this.authorizeFrame();
          const pending = this.pendingFocus;
          const surface = this.layout?.views.find(view => view.id === pending?.view);
          if (pending && (!surface || surface.session !== pending.session || surface.instance !== pending.instance || surface.document !== pending.document || this.layout?.generation !== pending.generation || this.layout?.epoch !== pending.epoch)) this.pendingFocus = null;
          this.flushFocusedInput();
          this.notify();
        }
        if (message.type === 'frame') { this.latency.record(message.rtpTimestamp, message.layoutEpoch, message); const start = performance.now(); if (Number.isInteger(message.rtpTimestamp) && typeof message.layoutEpoch === 'string') { this.presentation.frameMetadata(start, message.rtpTimestamp, message.layoutEpoch); this.encodedFrameSamples.push({ at: start, rtpTimestamp: message.rtpTimestamp, layoutEpoch: message.layoutEpoch, encodedBytes: typeof message.encodedBytes === 'number' ? message.encodedBytes : undefined, keyframe: typeof message.keyframe === 'boolean' ? message.keyframe : undefined }); if (this.encodedFrameSamples.length > 2400) this.encodedFrameSamples.shift(); } this.frameGate.record(message.rtpTimestamp, message.layoutEpoch); if (this.activeFrameSource === 'track-processor') this.profileProcessor('metadata', { rtp: message.rtpTimestamp, epoch: message.layoutEpoch }); this.authorizeFrame(); this.presentation.cost('frameMessageTotal', start, performance.now() - start); }
        if (message.type === 'stats') this.update({ endpoint: message });
        if (message.type === 'input.result' || message.type === 'focus') {
          this.inputResults.push({ at: performance.now(), ...message }); if (this.inputResults.length > 128) this.inputResults.shift();
          if (message.type === 'input.result' && message.ok === false) this.update({ error: String(message.error ?? '远程输入被拒绝') });
          if (message.type === 'focus' && this.layout) {
            const pending = this.pendingFocus, token = message.token;
            const view = pending && this.layout.views.find(view => view.id === pending.view && view.session === pending.session && view.instance === pending.instance && view.document === pending.document);
            const matches = pending && view && message.focusRequestId === pending.requestId && message.layoutEpoch === pending.epoch && this.layout.epoch === pending.epoch && this.layout.generation === pending.generation;
            if (matches && message.ok === false) { this.pendingFocus = null; this.update({ error: String(message.error ?? '远程焦点请求被拒绝') }); }
            if (matches && message.ok && token && token.view === pending.view && token.session === pending.session && token.instance === pending.instance && token.document === pending.document && typeof token.focus === 'string') { view.focus = token.focus; pending.acknowledged = true; this.flushFocusedInput(); }
          }
        }
        if (message.type === 'error') this.update({ error: String(message.message ?? 'Endpoint 返回错误') });
      } catch { this.update({ error: '收到无法识别的 Endpoint 消息。' }); }
    };
  }
  sendInput(surface: Surface, event: Record<string, unknown>) {
    if (this.channel?.readyState !== 'open' || !this.layout || !this.canInput(surface.id)) { this.traceInput('blocked', surface, event, this.channel?.readyState !== 'open' ? 'channel' : 'unmatched-or-unpainted-frame'); return false; }
    if (this.pendingFocus?.view === surface.id) { if (!this.pendingFocus.focused) { this.traceInput('blocked', surface, event, 'blur-pending'); return false; } if (this.pendingFocus.events.length < 64) { this.pendingFocus.events.push(event); this.traceInput('queued-focus', surface, event); return true; } this.traceInput('blocked', surface, event, 'focus-queue-full'); return false; }
    if (this.channel.bufferedAmount > 256 * 1024) { this.update({ error: '输入通道拥塞，请稍后重试。' }); return; }
    const current = this.layout.views.find(view => view.id === surface.id);
    if (!current || !samePlane(current, surface)) { this.traceInput('blocked', surface, event, 'stale-surface'); return false; }
    this.channel.send(JSON.stringify({ type: 'input', view: current.id, session: current.session, instance: current.instance, document: current.document, focus: current.focus, outputGeneration: this.layout.generation, layoutEpoch: this.layout.epoch, sequence: String(++this.sequence), event }));
    this.traceInput('sent', surface, event); return true;
  }
  focus(surface: Surface, focused: boolean) {
    if (this.channel?.readyState !== 'open' || !this.layout || !this.canInput(surface.id)) return;
    const current = this.layout.views.find(view => view.id === surface.id);
    if (!current || !samePlane(current, surface)) return;
    const pending = this.pendingFocus;
    if (pending && pending.view === current.id && pending.session === current.session && pending.instance === current.instance && pending.document === current.document && pending.epoch === this.layout.epoch && pending.generation === this.layout.generation && pending.focused === focused) return;
    const requestId = `${this.attempt}:${++this.focusSequence}`;
    this.pendingFocus = { requestId, acknowledged: false, focused, view: current.id, session: current.session, token: current.focus, instance: current.instance, document: current.document, generation: this.layout.generation, epoch: this.layout.epoch, events: [] };
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
      const paints = this.presentation.paintStatistics(); update.paintFpsByView = Object.fromEntries(Object.entries(paints).map(([id, value]) => [id, value.fps]));
      update.displayFramesPerSecond = this.selectedViewId ? paints[this.selectedViewId]?.fps : undefined;
      this.update(update);
      if (this.layout && this.channel?.readyState === 'open') {
        const counts = this.presentation.paintFrameCounts();
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
    if (!this.clockReading && now - this.clockAt > 5000) {
      this.clockReading = true; this.clockAt = now; const wall = Date.now();
      void rpc('clock.ping', { clientTime: wall }).then(value => {
        if (attempt === this.attempt && peer === this.peer) this.latency.calibrate(now, wall, performance.now(), Date.now(), (value as { serverTime: number }).serverTime);
      }).catch(() => {}).finally(() => { if (attempt === this.attempt) this.clockReading = false; });
    }
    if (this.feedbackReading) return;
    const report = this.latency.report(now, Date.now(), document.visibilityState === 'visible');
    if (!report) return;
    this.update({ presentationEstimate: report }); this.feedbackReading = true;
    void rpc('feedback', { ...report, displayHzEstimate: this.displayHzEstimate }).catch(() => {}).finally(() => { if (attempt === this.attempt) this.feedbackReading = false; });
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
    this.attempt++; this.latency.reset(); this.clockReading = false; this.clockAt = -Infinity; this.feedbackReading = false; this.processorTrack = undefined; this.displayHzEstimate = undefined;
    this.stopProcessorPump();
    this.mediaFeedback.stop(); this.statsReadingPeer = undefined; this.networkRead = undefined; this.videoPresentedFrames = undefined;
    if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback?.(this.frameCallback);
    this.frameCallback = undefined; this.frameGate.clear(); this.displayedRtp = undefined; this.displayedEpoch = undefined; this.frameIssue = undefined;
    this.lastInboundSample = undefined;
    this.viewPresentations.clear(); this.pendingPresentations = []; this.dispatchingPaint = false;
    this.pendingSnapshotRtp = undefined; this.snapshotRtp = undefined; this.snapshotEpoch = undefined; this.directEpochReady = undefined;
    this.paintedPlanes.clear(); for (const renderer of this.renderers) renderer.ready(false); this.renderers.clear();
    this.endpointGeneration = undefined;
    if (this.connectionId) { void this.rtcRequest('rtc.close', { connectionId: this.connectionId }).catch(() => {}); this.connectionId = undefined; }
    clearInterval(this.timer);
    const peer = this.peer; this.peer = null; this.channel = null; peer?.close();
    this.video.pause(); this.video.srcObject = null; this.video.remove?.(); this.layout = null;
    this.pendingFocus = null;
    this.diagnostics = { connection: '未连接', channel: '未连接' }; this.notify();
  }
}
