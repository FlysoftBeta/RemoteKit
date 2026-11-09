import type { RtcServerSignal } from '../../shared/product';
import { stereoOpusOffer } from '../media/audio-output';
import {
  configureReceiveOffer,
  selectProductReceiveProfile,
  type ProductReceiveSelection,
  type ReceiveProfile,
} from '../media/receive-profile';
import { type Diagnostics } from '../media/types';

import { RemoteKitError, parseWireError, toRemoteKitError } from '../../shared/errors';
import { errorHandling, retryDelay } from '../../shared/error-policy';
import { formatError } from '../util/format-error';
import { diagnostics } from '../media/diagnostics';
import { Events } from '../util/store';
import type { ControlRpc } from './session-port';

export type RtcState =
  | { phase: 'idle' }
  | { phase: 'establishing' | 'connected'; attemptId: string }
  | { phase: 'retryWait'; attemptId: string; dueAt: number }
  | { phase: 'exhausted' | 'stopped' };
export type RtcEvent =
  | { type: 'channel' | 'authChannel'; channel: RTCDataChannel }
  | { type: 'track'; track: MediaStreamTrack }
  | { type: 'receiver'; receiver: RTCRtpReceiver; kind: string }
  | { type: 'established'; peer: RTCPeerConnection }
  | { type: 'closed' }
  | { type: 'diagnostics'; change: Partial<Diagnostics> };
export class RtcSession {
  readonly connectionAttempts: {
    attemptId: string;
    signalingMode: string;
    startedAt: number;
    marks: Record<string, number>;
    error?: string;
  }[] = [];

  private signalAttemptId?: string;

  private remoteSignalConnection?: string;

  private remoteDescriptionReady = false;

  private remoteIce: RTCIceCandidateInit[] = [];

  private localIce: RTCIceCandidateInit[] = [];

  private iceDelivery: Promise<void> = Promise.resolve();

  private localIceDelivery: Promise<void> = Promise.resolve();

  markConnection(name: string) {
    const trace = this.connectionAttempts[this.connectionAttempts.length - 1];
    if (trace && trace.attemptId === this.signalAttemptId && trace.marks[name] === undefined)
      trace.marks[name] = performance.now() - trace.startedAt;
  }

  receiveServerSignal(message: RtcServerSignal) {
    const peer = this.peer;
    if (
      !peer ||
      message.attemptId !== this.signalAttemptId ||
      (this.connectionId && message.connectionId !== this.connectionId)
    )
      return;
    if (this.remoteSignalConnection && message.connectionId !== this.remoteSignalConnection) return;
    this.remoteSignalConnection = message.connectionId;
    if (message.signal.type === 'complete') {
      this.markConnection('remoteGatherComplete');
      return;
    }
    if (message.signal.type === 'error') {
      this.connectionFailed(
        parseWireError(message.signal.error) ?? new RemoteKitError('internal', '媒体信令错误码无效'),
      );
      return;
    }
    if (this.remoteIce.length >= 256) {
      this.connectionFailed(new RemoteKitError('limit_exceeded', '远端 ICE 候选超过上限'));
      return;
    }
    this.markConnection('remoteFirstCandidate');
    this.remoteIce.push(message.signal.candidate);
    this.flushRemoteIce(peer);
  }

  private flushRemoteIce(peer: RTCPeerConnection) {
    if (!this.remoteDescriptionReady) return;
    const attemptId = this.signalAttemptId;
    this.iceDelivery = this.iceDelivery
      .then(async () => {
        while (this.currentPeer === peer && this.signalAttemptId === attemptId && this.remoteIce.length)
          await peer.addIceCandidate(this.remoteIce.shift()!);
      })
      .catch((error) => {
        if (this.currentPeer === peer && this.signalAttemptId === attemptId)
          this.connectionFailed(
            new RemoteKitError('invalid_request', 'ICE 候选无效', { detail: String(error) }),
          );
      });
  }

  private flushLocalIce(peer: RTCPeerConnection) {
    const connectionId = this.connectionId,
      attemptId = this.signalAttemptId;
    if (!connectionId || !attemptId || this.peer !== peer) return;
    this.localIceDelivery = this.localIceDelivery
      .then(async () => {
        while (this.currentPeer === peer && this.signalAttemptId === attemptId && this.localIce.length)
          await this.rtcRequest('rtc.ice', { connectionId, attemptId, candidate: this.localIce.shift()! });
      })
      .catch((error) => {
        if (this.currentPeer === peer && this.signalAttemptId === attemptId) this.connectionFailed(error);
      });
  }

  controlRpc: ControlRpc | undefined;

  private productReceiveSelection?: ProductReceiveSelection;

  setControlRpc(callback: ControlRpc) {
    this.controlRpc = callback;
  }

  private rtcRequest<T>(
    method: 'rtc.offer' | 'rtc.ice' | 'rtc.close' | 'clock.ping' | 'feedback',
    params: unknown,
  ): Promise<T> {
    if (this.controlRpc) return this.controlRpc(method, params) as Promise<T>;
    return Promise.reject(new RemoteKitError('unavailable', 'Control WebSocket 未连接'));
  }

  receiveProfile: ReceiveProfile = 'native';

  signaling: Record<string, unknown> | undefined;

  private currentPeer: RTCPeerConnection | null = null;
  get peer() {
    return this.currentPeer;
  }

  private attemptNumber = 0;
  get attempt() {
    return this.attemptNumber;
  }

  private connectionId: string | undefined;
  private closing: Promise<void> = Promise.resolve();
  confirmedAvSync: boolean | undefined;

  private endpointGeneration: number | undefined;

  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  async connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryCount = 0;
    await this.establish();
  }

  restart(reason: string) {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    diagnostics.record('rtc-restart', reason);
    void this.establish();
  }

  private retryCount = 0;

  private scheduleReconnect(error: RemoteKitError, attemptId: string) {
    if (this.state.phase === 'stopped' || this.state.phase === 'retryWait') return;
    const handling = errorHandling(error.code);
    if (retryDelay(error, this.retryCount) === undefined && handling !== 'reconcile') {
      this.transition({ phase: 'exhausted' });
      this.observe({ connection: '连接失败', error: formatError(error) });
      return;
    }
    if (this.retryCount === 3) {
      this.transition({ phase: 'exhausted' });
      this.observe({ connection: '连接失败', error: formatError(error) });
      return;
    }
    const delay = retryDelay(error, this.retryCount++) ?? 1000;
    this.transition({ phase: 'retryWait', attemptId, dueAt: Date.now() + delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.state.phase === 'retryWait') void this.establish();
    }, delay);
  }

  connectionFailed(error: unknown) {
    const failure =
      typeof error === 'string'
        ? new RemoteKitError('unavailable', error)
        : error instanceof DOMException
          ? new RemoteKitError(
              error.name === 'AbortError'
                ? 'canceled'
                : ['NotAllowedError', 'SecurityError'].includes(error.name)
                  ? 'forbidden'
                  : error.name === 'NotSupportedError'
                    ? 'rejected'
                    : 'internal',
              '媒体连接建立失败',
              { detail: error.message },
            )
          : toRemoteKitError(error);
    if (errorHandling(failure.code) === 'canceled') {
      this.closeLocal();
      this.transition({ phase: 'idle' });
      this.observe({ connection: '未连接', error: undefined });
      return;
    }
    const reason = formatError(failure);
    const attemptId = this.signalAttemptId ?? String(this.attempt);
    const trace = this.connectionAttempts[this.connectionAttempts.length - 1];
    if (trace) {
      trace.error = reason;
      this.markConnection('failed');
    }
    this.closeLocal();
    this.observe({ connection: '连接失败', error: reason });
    this.scheduleReconnect(failure, attemptId);
  }

  observeEndpointGeneration(generation: number | undefined) {
    if (
      generation !== undefined &&
      this.endpointGeneration !== undefined &&
      this.endpointGeneration !== generation &&
      this.state.phase !== 'stopped' &&
      this.peer
    )
      this.connectionFailed('Endpoint 已重启，正在恢复原工作台');
  }

  private async establish() {
    this.closeLocal();
    this.signaling = undefined;
    const attempt = ++this.attemptNumber;
    this.signalAttemptId = `${Date.now()}-${attempt}`;
    this.transition({ phase: 'establishing', attemptId: this.signalAttemptId });
    this.connectionAttempts.push({
      attemptId: this.signalAttemptId,
      signalingMode: 'trickle',
      startedAt: performance.now(),
      marks: {},
    });
    if (this.connectionAttempts.length > 4) this.connectionAttempts.shift();
    this.observe({ connection: '正在连接', error: undefined });
    try {
      await this.closing;
      if (attempt !== this.attempt) return;
      const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
      peer.onicecandidate = (event) => {
        if (this.peer !== peer) return;
        if (!event.candidate) {
          this.markConnection('localGatherComplete');
          return;
        }
        this.markConnection('localFirstCandidate');
        if (this.localIce.length >= 256) {
          this.connectionFailed(new RemoteKitError('limit_exceeded', '本地 ICE 候选超过上限'));
          return;
        }
        this.localIce.push(event.candidate.toJSON());
        this.flushLocalIce(peer);
      };
      peer.oniceconnectionstatechange = () => {
        if (this.currentPeer === peer && ['connected', 'completed'].includes(peer.iceConnectionState))
          this.markConnection('iceConnected');
      };
      this.currentPeer = peer;
      const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
      this.events.emit({ type: 'receiver', receiver: transceiver.receiver, kind: 'video' });
      this.events.emit({
        type: 'receiver',
        receiver: peer.addTransceiver('audio', { direction: 'recvonly' }).receiver,
        kind: 'audio',
      });
      const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
      if (codecs && typeof transceiver.setCodecPreferences === 'function')
        transceiver.setCodecPreferences([
          ...codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/h264'),
          ...codecs.filter((codec) => codec.mimeType.toLowerCase() !== 'video/h264'),
        ]);
      peer.onconnectionstatechange = () => {
        if (this.peer !== peer) return;
        if (peer.connectionState === 'connected') {
          this.markConnection('connected');
          clearTimeout(this.retryTimer);
          this.retryTimer = undefined;
          this.retryCount = 0;
          this.transition({ phase: 'connected', attemptId: this.signalAttemptId! });
        }
        if (
          peer.connectionState === 'failed' ||
          peer.connectionState === 'closed' ||
          peer.connectionState === 'disconnected'
        ) {
          this.connectionFailed('媒体连接已中断');
          return;
        }
        const labels: Record<string, string> = {
          new: '正在连接',
          connecting: '正在连接',
          connected: '已连接',
          disconnected: '连接中断',
          failed: '连接失败',
          closed: '未连接',
        };
        this.observe({ connection: labels[peer.connectionState] ?? peer.connectionState });
      };
      peer.ontrack = (event) => {
        if (this.peer !== peer || this.attempt !== attempt) return;
        this.events.emit({ type: 'receiver', receiver: event.receiver, kind: event.track.kind });
        this.events.emit({ type: 'track', track: event.track });
      };
      this.events.emit({ type: 'channel', channel: peer.createDataChannel('remotekit', { ordered: true }) });
      this.events.emit({
        type: 'authChannel',
        channel: peer.createDataChannel('remotekit-auth', { ordered: true }),
      });
      peer.ondatachannel = (event) => {
        if (this.currentPeer === peer && this.attempt === attempt && event.channel.label === 'remotekit')
          this.events.emit({ type: 'channel', channel: event.channel });
      };
      if (this.controlRpc) {
        this.markConnection('receiveProbeStart');
        if (!this.productReceiveSelection)
          this.productReceiveSelection = await selectProductReceiveProfile(codecs);
        if (attempt !== this.attempt) return;
        this.receiveProfile = this.productReceiveSelection.profile;
        this.markConnection('receiveProbeEnd');
        this.observe({ receiveSelection: this.productReceiveSelection });
      }
      this.markConnection('createOfferStart');
      const originalOffer = await peer.createOffer();
      if (attempt !== this.attempt) return;
      this.markConnection('createOfferEnd');
      const effectiveOffer = configureReceiveOffer(originalOffer.sdp ?? '', this.receiveProfile, codecs);
      effectiveOffer.sdp = stereoOpusOffer(effectiveOffer.sdp);
      this.signaling = {
        receiveSelection: this.productReceiveSelection,
        receiveProfile: this.receiveProfile,
        originalOfferSdp: originalOffer.sdp,
        effectiveOfferSdp: effectiveOffer.sdp,
        changes: effectiveOffer.changes,
      };
      await peer.setLocalDescription({ type: 'offer', sdp: effectiveOffer.sdp });
      if (attempt !== this.attempt) return;
      this.markConnection('setLocalEnd');
      this.signaling = {
        receiveSelection: this.productReceiveSelection,
        receiveProfile: this.receiveProfile,
        originalOfferSdp: originalOffer.sdp,
        effectiveOfferSdp: peer.localDescription?.sdp,
        changes: effectiveOffer.changes,
      };
      this.markConnection('offerSent');
      const answer = await this.rtcRequest<
        RTCSessionDescriptionInit & {
          connectionId: string;
          avSync: boolean;
          endpointGeneration?: number;
          signalingMode?: string;
        }
      >('rtc.offer', {
        type: 'offer',
        sdp: peer.localDescription?.sdp,
        attemptId: this.signalAttemptId,
      });
      if (attempt !== this.attempt) {
        void this.rtcRequest('rtc.close', { connectionId: answer.connectionId }).catch((error) =>
          diagnostics.record('rtc-close', error),
        );
        return;
      }
      this.markConnection('answerReceived');
      this.connectionId = answer.connectionId;
      this.confirmedAvSync = answer.avSync;
      if (this.remoteSignalConnection && this.remoteSignalConnection !== answer.connectionId)
        throw new RemoteKitError('internal', '媒体协商连接身份不一致');
      this.endpointGeneration = answer.endpointGeneration;
      this.signaling.answerSdp = answer.sdp;
      this.signaling.controlNegotiationTiming = (answer as any).negotiationTiming;
      this.signaling.connectionTiming = this.connectionAttempts[this.connectionAttempts.length - 1];
      if (answer.signalingMode)
        this.connectionAttempts[this.connectionAttempts.length - 1].signalingMode = answer.signalingMode;
      this.observe({ connectionId: answer.connectionId });
      await peer.setRemoteDescription(answer);
      if (attempt !== this.attempt) return;
      this.markConnection('setRemoteEnd');
      this.remoteDescriptionReady = true;
      this.flushRemoteIce(peer);
      this.flushLocalIce(peer);
      if (attempt !== this.attempt) return;
      this.events.emit({ type: 'established', peer });
    } catch (error) {
      if (attempt !== this.attempt) return;
      const trace = this.connectionAttempts[this.connectionAttempts.length - 1];
      if (trace) {
        trace.error = error instanceof Error ? error.message : String(error);
        this.markConnection('failed');
      }
      this.connectionFailed(error);
    }
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.transition({ phase: 'stopped' });
    this.closeLocal();
  }

  private closeLocal() {
    this.events.emit({ type: 'closed' });
    this.confirmedAvSync = undefined;
    const connectionId = this.connectionId ?? this.remoteSignalConnection;
    this.signalAttemptId = undefined;
    this.remoteSignalConnection = undefined;
    this.remoteDescriptionReady = false;
    this.remoteIce = [];
    this.localIce = [];
    this.iceDelivery = Promise.resolve();
    this.localIceDelivery = Promise.resolve();
    this.attemptNumber++;
    this.endpointGeneration = undefined;
    if (connectionId) {
      // Local disposal ends this attempt. A failed cleanup must not poison the
      // next offer; the server reconciles the old connection by attempt/lease.
      this.closing = this.rtcRequest('rtc.close', { connectionId }).then(
        () => {},
        (error) => diagnostics.record('rtc-close', error),
      );
      this.connectionId = undefined;
    }
    const peer = this.peer;
    this.currentPeer = null;
    peer?.close();
    this.notify();
  }

  readonly events = new Events<RtcEvent>();

  private observe(change: Partial<Diagnostics>) {
    this.events.emit({ type: 'diagnostics', change });
    this.notify();
  }

  private transition(state: RtcState) {
    this.state = Object.freeze(state);
    this.notify();
  }

  private state: RtcState = { phase: 'idle' };

  private notify() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();

  private revision = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RtcState => this.state;
  onChannel = (event: import('./endpoint-channel').ChannelEvent) => {
    if (event.type === 'closed') this.connectionFailed('输入通道已关闭');
  };
}
