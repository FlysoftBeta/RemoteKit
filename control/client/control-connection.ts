import type {
  ProductState,
  SocketMessage,
  SocketMethods,
  RtcServerSignal,
} from "../shared/product";

export type ConnectionStatus =
  "connecting" | "online" | "reconnecting" | "failed" | "revoked" | "expired";
export class ControlConnection {
  readonly lifecycle: { startedAt: number; marks: Record<string, number>; error?: string }[] = [];
  private socket?: WebSocket;
  private stopped = false;
  private attempts = 0;
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private state: (state: ProductState) => void,
    private status: (status: ConnectionStatus) => void,
    private signal: (signal: RtcServerSignal) => void = () => {},
  ) {}
  connect() {
    if (
      this.stopped ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    this.status(this.attempts ? "reconnecting" : "connecting");
    const trace = { startedAt: performance.now(), marks: {} as Record<string, number>, error: undefined as string | undefined };
    this.lifecycle.push(trace); if (this.lifecycle.length > 4) this.lifecycle.shift();
    const mark = (name: string) => { if (trace.marks[name] === undefined) trace.marks[name] = performance.now() - trace.startedAt; };
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/socket`,
    );
    this.socket = ws;
    ws.onopen = () => mark('open');
    ws.onmessage = (event) => {
      if (ws !== this.socket || this.stopped) return;
      let message: SocketMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'rtc.signal') {
        this.signal(message);
      } else if (message.type === "state") {
        mark('firstState');
        this.attempts = 0;
        this.status("online");
        this.state(message.state);
      } else if (message.type === "lease") {
        this.status(message.reason === "logout" ? "expired" : "revoked");
        this.close();
      } else {
        const task = this.pending.get(message.id);
        if (!task) return;
        clearTimeout(task.timer);
        this.pending.delete(message.id);
        if (message.type === "error") {
          task.reject(new Error(message.error.message));
          if (message.error.code === 401) {
            this.status("expired");
            this.close();
          }
        } else task.resolve(message.result);
      }
    };
    ws.onclose = (event) => {
      if (ws !== this.socket) return;
      mark('closed'); trace.error = `${event.code}`;
      this.socket = undefined;
      this.rejectPending();
      if (this.stopped) return;
      if (event.code === 4001) {
        this.status(event.reason === "logout" ? "expired" : "revoked");
        this.close();
        return;
      }
      // A failed upgrade can mean an expired cookie. Check before retrying.
      void fetch("/api/auth/me", { credentials: "same-origin" })
        .then((response) => {
          if (this.stopped) return;
          if (response.status === 401) {
            this.status("expired");
            this.close();
            return;
          }
          this.retry();
        })
        .catch(() => this.retry());
    };
    ws.onerror = () => {};
  }
  private retry() {
    if (this.stopped) return;
    if (++this.attempts > 5) {
      this.status("failed");
      return;
    }
    this.status("reconnecting");
    this.timer = setTimeout(
      () => this.connect(),
      Math.min(8000, 500 * 2 ** (this.attempts - 1)),
    );
  }
  request<K extends keyof SocketMethods>(
    method: K,
    params: SocketMethods[K]["params"],
  ): Promise<SocketMethods[K]["result"]> {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("连接尚未恢复，请稍后重试"));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("请求超时，请重试"));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  restart() {
    if (this.stopped) return;
    this.attempts = 0;
    this.connect();
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.rejectPending();
  }
  private rejectPending() {
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("控制连接已断开"));
    }
    this.pending.clear();
  }
}
