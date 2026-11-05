import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { RemoteKitError } from '../../shared/errors';
import type { EndpointLink, EndpointLinkState } from './link';
import { readyTransition } from './link';
import type { ClientActionEvent, RtcSignal } from './types';

const MAX_MESSAGE = 1024 * 1024;
interface Connection {
  socket: WebSocket;
  epoch: string;
  alive: boolean;
}
interface Pending {
  epoch: string;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}
export interface RemoteNodeOptions {
  nodeId: string;
  token: string;
  tlsProxy?: boolean;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatMs?: number;
}

/** One configured compute node. Connection replacement never replays an RPC. */
export class RemoteNodeLink extends EventEmitter implements EndpointLink {
  state: EndpointLinkState = { state: 'offline' };
  readonly nodeId: string;
  private readonly tokenHash: Buffer;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE,
    perMessageDeflate: false,
  });
  private readonly pending = new Map<string, Pending>();
  private current?: Connection;
  private endpointIncarnation?: string;
  private stopped = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly options: RemoteNodeOptions) {
    super();
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(options.nodeId) || !options.token || /[\r\n]/.test(options.token))
      throw new RemoteKitError('invalid_request', 'Endpoint node ID/token 配置无效');
    this.nodeId = options.nodeId;
    this.tokenHash = createHash('sha256').update(`Bearer ${options.token}`).digest();
    this.heartbeat = setInterval(() => {
      const current = this.current;
      if (!current) return;
      if (!current.alive) {
        this.disconnect(current, 'Endpoint heartbeat 超时');
        current.socket.terminate();
        return;
      }
      current.alive = false;
      current.socket.ping();
    }, options.heartbeatMs ?? 15000);
    this.heartbeat.unref();
  }
  start() {
    /* Native initiates the connection. */
  }
  onClientAction(listener: (event: ClientActionEvent) => void) {
    this.on('client.action', listener);
    return () => {
      this.off('client.action', listener);
    };
  }
  onSignal(listener: (event: RtcSignal) => void) {
    this.on('rtc.signal', listener);
    return () => this.off('rtc.signal', listener);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/endpoint') return false;
    const reject = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (this.stopped) {
      reject(503);
      return true;
    }
    const encrypted = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true;
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
    // Forwarded headers are trusted only from an explicitly enabled local proxy.
    const proxied = this.options.tlsProxy && loopback && req.headers['x-forwarded-proto'] === 'https';
    if (!(encrypted || (this.options.tlsProxy ? proxied : loopback))) {
      reject(403);
      return true;
    }
    const authorization = req.headers.authorization ?? '';
    if (!timingSafeEqual(this.tokenHash, createHash('sha256').update(authorization).digest())) {
      reject(401);
      return true;
    }
    this.sockets.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    return true;
  }

  private accept(socket: WebSocket) {
    if (!this.current) this.state = { state: 'connecting' };
    let connection: Connection | undefined;
    const handshake = setTimeout(() => socket.terminate(), this.options.handshakeTimeoutMs ?? 5000);
    handshake.unref();
    socket.on('error', () => {
      if (connection) this.disconnect(connection, 'Endpoint 连接错误');
      socket.terminate();
    });
    socket.on('close', () => {
      clearTimeout(handshake);
      if (connection) this.disconnect(connection, 'Endpoint 已断开');
      else if (!this.current) this.state = { state: 'offline' };
    });
    socket.on('pong', () => {
      if (connection && this.current === connection) connection.alive = true;
    });
    socket.on('message', (data, binary) => {
      if (this.stopped || (connection && this.current !== connection)) return;
      try {
        if (binary) throw new RemoteKitError('invalid_request', 'binary message');
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new RemoteKitError('invalid_request', 'invalid message');
        if (!connection) {
          if (
            message.type !== 'node.hello' ||
            message.version !== 1 ||
            message.nodeId !== this.nodeId ||
            typeof message.endpointIncarnation !== 'string' ||
            !/^[a-zA-Z0-9_-]{16,128}$/.test(message.endpointIncarnation)
          )
            throw new RemoteKitError('invalid_request', 'invalid hello');
          clearTimeout(handshake);
          const previous = this.current;
          if (previous) {
            this.disconnect(previous, 'Endpoint 连接已替换');
            previous.socket.terminate();
          }
          connection = { socket, epoch: randomUUID(), alive: true };
          this.current = connection;
          socket.send(JSON.stringify({ type: 'node.ready', version: 1, connectionEpoch: connection.epoch }));
          const transition = readyTransition(
            this.endpointIncarnation,
            message.endpointIncarnation,
            connection.epoch,
          );
          this.state = transition.state;
          this.endpointIncarnation = message.endpointIncarnation;
          this.emit('ready', {
            endpointIncarnation: this.endpointIncarnation,
            processChanged: transition.processChanged,
          });
          return;
        }
        if (message.type === 'node.ping') {
          socket.send(JSON.stringify({ type: 'node.pong' }));
          return;
        }
        if (message.event === 'client.action') {
          if (typeof message.tenantId !== 'string' || typeof message.connectionId !== 'string')
            throw new RemoteKitError('invalid_request', 'invalid action');
          this.emit('client.action', message);
          return;
        }
        if (message.event === 'rtc.signal') {
          if (
            typeof message.tenantId !== 'string' ||
            typeof message.connectionId !== 'string' ||
            !message.signal ||
            typeof message.signal !== 'object'
          )
            throw new RemoteKitError('invalid_request', 'invalid signal');
          this.emit('rtc.signal', message);
          return;
        }
        if (typeof message.id !== 'string' || typeof message.ok !== 'boolean')
          throw new RemoteKitError('invalid_request', 'invalid reply');
        const pending = this.pending.get(message.id);
        if (!pending || pending.epoch !== connection.epoch) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(message.error ?? { code: 'rejected', message: 'Endpoint 操作失败' });
      } catch {
        if (connection) this.disconnect(connection, 'Endpoint 协议错误');
        socket.terminate();
      }
    });
  }

  request(method: string, tenantId: string, args: Record<string, unknown> = {}): Promise<any> {
    const connection = this.current;
    if (this.stopped || !connection || connection.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new RemoteKitError('unavailable', 'Endpoint 尚未就绪'));
    if (this.pending.size >= 256 || connection.socket.bufferedAmount > 2 * MAX_MESSAGE)
      return Promise.reject(new RemoteKitError('unavailable', 'Endpoint 请求繁忙'));
    const id = randomUUID(),
      message = JSON.stringify({ ...args, id, method, tenantId });
    if (Buffer.byteLength(message) > MAX_MESSAGE)
      return Promise.reject(new RemoteKitError('limit_exceeded', 'Endpoint 请求过大'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new RemoteKitError('outcome_unknown', 'Endpoint 请求超时', method));
        },
        Math.max(1, Math.min(20000, this.options.requestTimeoutMs ?? 20000)),
      );
      this.pending.set(id, { epoch: connection.epoch, resolve, reject, timer });
      connection.socket.send(message, (error) => {
        if (error) {
          this.disconnect(connection, 'Endpoint 发送失败');
          connection.socket.terminate();
        }
      });
    });
  }
  private disconnect(connection: Connection, reason: string) {
    if (this.current !== connection) return;
    this.current = undefined;
    this.state = { state: 'offline' };
    for (const [id, pending] of this.pending) {
      if (pending.epoch !== connection.epoch) continue;
      clearTimeout(pending.timer);
      pending.reject(new RemoteKitError('outcome_unknown', 'Endpoint 连接已断开', reason));
      this.pending.delete(id);
    }
    this.emit('offline');
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.state = { state: 'offline' };
    clearInterval(this.heartbeat);
    if (this.current) this.disconnect(this.current, 'Control 正在关闭');
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
  }
}
