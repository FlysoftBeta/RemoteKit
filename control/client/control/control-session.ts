import { errorHandling } from '../../shared/error-policy';
import { RetryUnit } from '../../shared/retry-unit';
import { RemoteKitError, parseWireError } from '../../shared/errors';
import type { LibrarySnapshot } from '../../shared/file-library';
import type { ProductState, RtcServerSignal, SocketMessage } from '../../shared/product';
import type { AuthState } from '../../shared/security';
import { appClipboard } from '../clipboard/app-clipboard';
import { deviceClipboard } from '../clipboard/device-clipboard';
import { operationFailure } from '../failures/operations';
import { viewerErrors } from '../failures/reporting';
import { diagnostics } from '../media/diagnostics';
import { RequestTracker } from '../util/request-tracker';
import { Events } from '../util/store';
import { request as httpRequest } from './http-request';
import { snapshotNewer } from './product-operations';
import type { SocketMethods } from './socket-methods';

const stableConnectionMs = 10_000;

export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'failed' | 'revoked' | 'expired';

export type ControlState =
  | { phase: 'connecting' | 'online' | 'failed' | 'revoked' | 'expired' | 'stopped' }
  | { phase: 'reconnecting'; attempt: number };
export class ControlSession {
  readonly library = new Events<LibrarySnapshot>();
  private snapshot: ControlState = { phase: 'connecting' };
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private status = (phase: ConnectionStatus) => {
    viewerErrors.connect(
      phase === 'online'
        ? (report) => this.socket!.send(JSON.stringify({ type: 'client.error', report }))
        : undefined,
    );
    if (phase === 'online') this.error = undefined;
    if (phase !== 'online')
      deviceClipboard.configure(undefined, false, (text) => this.request('clipboard.set', { text }));
    this.snapshot = Object.freeze(phase === 'reconnecting' ? { phase, attempt: this.attempts } : { phase });
    this.listeners.forEach((listener) => listener());
    this.changed(phase);
  };
  readonly lifecycle: { startedAt: number; marks: Record<string, number>; error?: string }[] = [];
  error?: RemoteKitError;
  private latestState: ProductState | null = null;
  private socket?: WebSocket;
  private get stopped() {
    return ['stopped', 'revoked', 'expired'].includes(this.snapshot.phase);
  }
  private attempts = 0;
  private retryInput = 0;
  private readonly retryUnit = new RetryUnit({
    failed: (error) => diagnostics.record('control_connection_failed', error),
    recovered: () => diagnostics.record('control_connection_recovered', {}),
  });
  private sequence = 0;
  private stability?: ReturnType<typeof setTimeout>;
  private readonly pending = new RequestTracker<unknown>();
  constructor(
    private state: (state: ProductState) => void,
    private changed: (status: ConnectionStatus) => void,
    private signal: (signal: RtcServerSignal) => void = () => {},
    private auth: (auth: AuthState) => void = () => {},
  ) {}
  connect() {
    if (!this.retryUnit.ready(String(this.retryInput))) return;
    if (
      this.stopped ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    this.status(this.attempts ? 'reconnecting' : 'connecting');
    const trace = {
      startedAt: performance.now(),
      marks: {} as Record<string, number>,
      error: undefined as string | undefined,
    };
    this.lifecycle.push(trace);
    if (this.lifecycle.length > 4) this.lifecycle.shift();
    const mark = (name: string) => {
      if (trace.marks[name] === undefined) trace.marks[name] = performance.now() - trace.startedAt;
    };
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/socket`,
    );
    this.socket = ws;
    const stable = () => {
      if (this.stability) return;
      this.stability = setTimeout(() => {
        this.stability = undefined;
        if (ws === this.socket && ws.readyState === WebSocket.OPEN && !this.stopped) {
          this.attempts = 0;
          this.retryUnit.succeed();
        }
      }, stableConnectionMs);
    };
    let snapshotIncarnation: string | undefined;
    ws.onopen = () => mark('open');
    ws.onmessage = (event) => {
      if (ws !== this.socket || this.stopped) return;
      let message: SocketMessage;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        diagnostics.record('control-message', error);
        return;
      }
      if (message.type === 'rtc.signal') {
        this.signal(message);
      } else if (message.type === 'auth') {
        if (message.auth.locked) this.latestState = null;
        mark('firstAuth');
        stable();
        this.status('online');
        this.auth(message.auth);
      } else if (message.type === 'state') {
        if (snapshotIncarnation && message.state.serverIncarnation !== snapshotIncarnation) return;
        if (!snapshotNewer(message.state, this.latestState)) return;
        snapshotIncarnation = message.state.serverIncarnation;
        mark('firstState');
        stable();
        this.status('online');
        if (snapshotNewer(message.state, this.latestState)) {
          this.latestState = message.state;
          this.state(message.state);
        }
      } else if (message.type === 'library') {
        this.library.emit(message.snapshot);
      } else if (message.type === 'clipboard') {
        appClipboard.receive(message);
        deviceClipboard.receive(message);
      } else if (message.type === 'lease') {
        this.status(message.outcome === 'logged_out' ? 'expired' : 'revoked');
        this.close(true);
      } else {
        if (message.type === 'error') {
          this.pending.reject(
            message.id,
            parseWireError(message.error) ?? new RemoteKitError('outcome_unknown', '控制回复错误码无效'),
          );
        } else this.pending.resolve(message.id, message.result);
      }
    };
    ws.onclose = (event) => {
      if (ws !== this.socket) return;
      clearTimeout(this.stability);
      this.stability = undefined;
      mark('closed');
      trace.error = `${event.code}`;
      this.socket = undefined;
      this.rejectPending();
      if (this.stopped) return;
      // Only a connection that stayed up counts as recovered; one the server drops right after
      // auth keeps its reconnect backoff.
      const authAt = trace.marks.firstAuth;
      if (authAt !== undefined && trace.marks.closed - authAt >= stableConnectionMs) {
        this.attempts = 0;
        this.retryUnit.succeed();
      }
      if (event.code === 4001 || event.code === 4002) {
        this.status(event.code === 4002 ? 'expired' : 'revoked');
        this.close(true);
        return;
      }
      this.status('reconnecting');
      // Browsers hide failed upgrade responses; the read probe exposes their handling code.
      void httpRequest('/api/socket/check?origin=' + encodeURIComponent(location.origin))
        .then(() => {
          if (this.stopped) return;
          this.retry();
        })
        .catch((error) => {
          const failure =
            error instanceof RemoteKitError ? error : new RemoteKitError('unavailable', '连接不可用');
          this.error = failure;
          const handling = errorHandling(failure.code);
          if (handling === 'sign-in') {
            this.retryUnit.fail(failure);
            this.status('expired');
            this.close(true);
            return;
          }
          this.retry(failure);
        });
    };
    ws.onerror = () => {
      /* onclose owns retry and pending rejection. */
    };
  }
  private retry(error = new RemoteKitError('unavailable', '连接暂不可用')) {
    if (this.stopped || this.socket) return;
    const failure = this.retryUnit.fail(error);
    if (failure.delay === undefined) {
      this.error = failure.error;
      this.status('failed');
      return;
    }
    this.attempts++;
    this.status('reconnecting');
    this.retryUnit.schedule(() => this.connect());
  }
  request<K extends keyof SocketMethods>(
    method: K,
    params: SocketMethods[K]['params'],
  ): Promise<SocketMethods[K]['result']> {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new RemoteKitError('unavailable', '连接尚未恢复，请稍后重试'));
    const id = String(++this.sequence);
    let encoded: string;
    try {
      encoded = JSON.stringify({ id, method, params });
    } catch (error) {
      return Promise.reject(new RemoteKitError('internal', '控制请求编码失败', { detail: String(error) }));
    }
    return this.pending
      .request(id, 20000, () => {
        this.socket!.send(encoded);
      })
      .catch((error) => {
        throw operationFailure(error, method, params);
      }) as Promise<SocketMethods[K]['result']>;
  }
  reconnect() {
    if (this.stopped) return;
    this.retryUnit.ready(String(++this.retryInput));
    const socket = this.socket;
    this.socket = undefined;
    clearTimeout(this.stability);
    this.stability = undefined;
    this.rejectPending();
    socket?.close();
    this.connect();
  }
  close(preserveState = false) {
    clearTimeout(this.stability);
    this.stability = undefined;
    this.retryUnit.cancel();
    viewerErrors.connect(undefined);
    deviceClipboard.configure(undefined, false, (text) => this.request('clipboard.set', { text }));
    if (!preserveState) {
      this.snapshot = { phase: 'stopped' };
      this.listeners.forEach((listener) => listener());
    }
    this.socket?.close();
    this.rejectPending();
  }
  private rejectPending() {
    this.pending.clear(new RemoteKitError('outcome_unknown', '控制连接已断开'));
  }
}
