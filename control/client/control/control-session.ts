import { RemoteKitError } from '../../shared/errors';
import type { ProductState, RtcServerSignal, SocketMessage, SocketMethods } from '../../shared/product';
import type { AuthState } from '../../shared/security';
import { diagnostics } from '../media/diagnostics';
import { RequestTracker } from '../util/request-tracker';
import { snapshotNewer } from './product-operations';

export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'failed' | 'revoked' | 'expired';

export type ControlState =
  | { phase: 'connecting' | 'online' | 'failed' | 'revoked' | 'expired' | 'stopped' }
  | { phase: 'reconnecting'; attempt: number };
export class ControlSession {
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
    this.snapshot = Object.freeze(phase === 'reconnecting' ? { phase, attempt: this.attempts } : { phase });
    this.listeners.forEach((listener) => listener());
    this.changed(phase);
  };
  readonly lifecycle: { startedAt: number; marks: Record<string, number>; error?: string }[] = [];
  private latestState: ProductState | null = null;
  private socket?: WebSocket;
  private get stopped() {
    return ['stopped', 'revoked', 'expired'].includes(this.snapshot.phase);
  }
  private attempts = 0;
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly pending = new RequestTracker<unknown>();
  constructor(
    private state: (state: ProductState) => void,
    private changed: (status: ConnectionStatus) => void,
    private signal: (signal: RtcServerSignal) => void = () => {},
    private auth: (auth: AuthState) => void = () => {},
  ) {}
  connect() {
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
        this.attempts = 0;
        this.status('online');
        this.auth(message.auth);
      } else if (message.type === 'state') {
        if (snapshotIncarnation && message.state.serverIncarnation !== snapshotIncarnation) return;
        if (!snapshotNewer(message.state, this.latestState)) return;
        snapshotIncarnation = message.state.serverIncarnation;
        mark('firstState');
        this.attempts = 0;
        this.status('online');
        if (snapshotNewer(message.state, this.latestState)) {
          this.latestState = message.state;
          this.state(message.state);
        }
      } else if (message.type === 'lease') {
        this.status(message.reason === 'logout' ? 'expired' : 'revoked');
        this.close(true);
      } else {
        if (message.type === 'error') {
          this.pending.reject(message.id, new RemoteKitError(message.error.code, message.error.message));
          if (message.error.code === 'unauthenticated') {
            this.status('expired');
            this.close(true);
          }
        } else this.pending.resolve(message.id, message.result);
      }
    };
    ws.onclose = (event) => {
      if (ws !== this.socket) return;
      mark('closed');
      trace.error = `${event.code}`;
      this.socket = undefined;
      this.rejectPending();
      if (this.stopped) return;
      if (event.code === 4001) {
        this.status(event.reason === 'logout' ? 'expired' : 'revoked');
        this.close(true);
        return;
      }
      this.status('reconnecting');
      // A failed upgrade can mean an expired cookie. Check before retrying.
      void fetch('/api/auth/me', { credentials: 'same-origin' })
        .then((response) => {
          if (this.stopped) return;
          if (response.status === 401) {
            this.status('expired');
            this.close(true);
            return;
          }
          this.retry();
        })
        .catch((error) => {
          diagnostics.record('control-auth-check', error);
          this.retry();
        });
    };
    ws.onerror = () => {
      /* onclose owns retry and pending rejection. */
    };
  }
  private retry() {
    if (this.stopped || this.socket) return;
    if (++this.attempts > 5) {
      this.status('failed');
      return;
    }
    this.status('reconnecting');
    this.timer = setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** (this.attempts - 1)));
  }
  request<K extends keyof SocketMethods>(
    method: K,
    params: SocketMethods[K]['params'],
  ): Promise<SocketMethods[K]['result']> {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new RemoteKitError('unavailable', '连接尚未恢复，请稍后重试'));
    const id = String(++this.sequence);
    return this.pending.request(id, 20000, () => {
      this.socket!.send(JSON.stringify({ id, method, params }));
    }) as Promise<SocketMethods[K]['result']>;
  }
  restart() {
    if (this.stopped) return;
    this.attempts = 0;
    this.connect();
  }
  reconnect() {
    if (this.stopped) return;
    this.socket?.close();
  }
  close(preserveState = false) {
    if (!preserveState) {
      this.snapshot = { phase: 'stopped' };
      this.listeners.forEach((listener) => listener());
    }
    clearTimeout(this.timer);
    this.socket?.close();
    this.rejectPending();
  }
  private rejectPending() {
    this.pending.clear(new RemoteKitError('outcome_unknown', '控制连接已断开'));
  }
}
