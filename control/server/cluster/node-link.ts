import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { EndpointLog } from './endpoint-log';
import { MetricsHistory } from './metrics';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type { ConfiguredNode, NodeConfig } from '../config';
import { readyTransition, type EndpointLink, type EndpointLinkState } from '../endpoint/link';
import type { ClientActionEvent, RtcSignal } from '../endpoint/types';
import {
  decodeFrame,
  encodeBinary,
  encodeJson,
  encodeStdio,
  jsonObject,
  MAX_JSON,
  StdioDecoder,
} from './frames';
import { MAX_CIPHERTEXT, NoiseHandshake, type Transport } from './noise';
import type { NodeRelease } from './release';

export abstract class Carrier extends EventEmitter {
  abstract readonly bufferedAmount: number;
  abstract send(message: Buffer): Promise<void>;
  abstract close(): void;
}
export class WebSocketCarrier extends Carrier {
  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }
  constructor(readonly socket: WebSocket) {
    super();
    socket.on('message', (bytes, binary) => {
      if (!binary) return this.close();
      this.emit('message', Buffer.from(bytes as Buffer));
    });
    socket.on('error', () => this.close());
    socket.once('close', () => this.emit('close'));
  }
  send(message: Buffer) {
    return new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) return reject(new Error('Carrier closed'));
      this.socket.send(message, { binary: true }, (error) => (error ? reject(error) : resolve()));
    });
  }
  close() {
    this.socket.terminate();
  }
}
export class StdioCarrier extends Carrier {
  get bufferedAmount() {
    return this.child.stdin.writableLength;
  }
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    log: EndpointLog,
  ) {
    super();
    const decoder = new StdioDecoder();
    child.stdout.on('data', (bytes: Buffer) => {
      try {
        for (const frame of decoder.push(bytes)) this.emit('message', frame);
      } catch {
        this.close();
      }
    });
    child.stdout.on('end', () => {
      try {
        decoder.end();
      } catch {}
      this.close();
    });
    child.stderr.on('data', (bytes: Buffer) => log.write(bytes));
    child.stdin.on('error', () => this.close());
    child.stdout.on('error', () => this.close());
    child.on('error', () => this.emit('close'));
    child.once('exit', () => this.emit('close'));
  }
  send(message: Buffer) {
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(encodeStdio(message), (error) => (error ? reject(error) : resolve()));
    });
  }
  close() {
    this.child.kill();
  }
}

interface Connection {
  carrier: Carrier;
  transport: Transport;
  epoch: string;
}
interface Pending {
  epoch: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}
export interface RegistryOptions {
  nodes: Readonly<Record<string, ConfiguredNode>>;
  key: string;
  buildId: string;
  release?: NodeRelease;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface NodeHistory {
  connectedAt?: number;
  disconnectedAt?: number;
  rejected?: { code: string; buildId: string; at: number };
  exited?: { code: number | null; at: number };
}
export class NodeLink extends EventEmitter implements EndpointLink {
  state: EndpointLinkState = { state: 'offline' };
  private events: NodeHistory = {};
  readonly config: Readonly<NodeConfig>;
  readonly metrics: MetricsHistory;
  buildId?: string;
  diskDraining = false;
  private incoming = 0;
  private current?: Connection;
  private incarnation?: string;
  private readonly pending = new Map<string, Pending>();
  private child?: ChildProcessWithoutNullStreams;
  private retry?: NodeJS.Timeout;
  private stopped = false;
  constructor(
    readonly nodeId: string,
    readonly configured: ConfiguredNode,
    private readonly registry: NodeRegistry,
  ) {
    super();
    this.config = configured.config;
    this.metrics = new MetricsHistory(this.config.maxSessions);
  }
  onClientAction(listener: (event: ClientActionEvent) => void) {
    this.on('client.action', listener);
    return () => {
      this.off('client.action', listener);
    };
  }
  onSignal(listener: (event: RtcSignal) => void) {
    this.on('rtc.signal', listener);
    return () => {
      this.off('rtc.signal', listener);
    };
  }
  start() {
    const launch = this.configured.launch;
    if (!launch || this.stopped || this.child || this.registry.isRemoved(this.nodeId)) return;
    this.state = { state: 'connecting' };
    const child = spawn(
      launch.executable,
      ['--stdio', `--node-id=${this.nodeId}`, `--node-root=${launch.root}`],
      {
        env: { ...process.env, REMOTEKIT_CLUSTER_KEY: this.registry.options.key },
        stdio: 'pipe',
        windowsHide: true,
      },
    );
    this.child = child;
    this.registry.accept(
      new StdioCarrier(child, new EndpointLog(join(launch.root, 'logs', 'endpoint.log'))),
      this.nodeId,
    );
    let finished = false;
    const exited = (code: number | null) => {
      if (finished) return;
      finished = true;
      if (this.child === child) this.child = undefined;
      this.events = { ...this.events, exited: { code, at: Date.now() } };
      if (!this.current) this.state = { state: 'offline' };
      if (!this.stopped) this.retry = setTimeout(() => this.start(), code === 4 ? 0 : 1500);
    };
    child.once('error', () => exited(null));
    child.once('exit', exited);
  }
  attach(connection: Connection, incarnation: string) {
    if (this.stopped) {
      connection.carrier.close();
      return;
    }
    if (this.current) {
      const previous = this.current;
      this.disconnect(previous);
      previous.carrier.close();
    }
    const transition = readyTransition(this.incarnation, incarnation, connection.epoch);
    this.current = connection;
    this.incarnation = incarnation;
    this.metrics.clear();
    this.buildId = this.registry.options.buildId;
    this.state = transition.state;
    this.events = { connectedAt: Date.now() };
    this.emit('ready', { incarnation, processChanged: transition.processChanged });
  }
  receive(connection: Connection, message: Record<string, any>) {
    if (this.current !== connection) return;
    if (message.event === 'node.metrics') {
      const { event, ...metrics } = message;
      this.metrics.record(metrics as any);
      const free = this.metrics.latest()!.value.disk.free;
      if (free < this.config.diskReserveBytes) this.diskDraining = true;
      if (free >= 2 * this.config.diskReserveBytes) this.diskDraining = false;
      this.registry.emit('metrics', this.nodeId);
      return;
    }
    if (typeof message.request === 'string') {
      if (typeof message.id !== 'string' || typeof message.tenantId !== 'string')
        throw new Error('Invalid node request');
      const respond = (reply: object) => {
        if (this.current !== connection) return;
        let bytes: Buffer;
        try {
          bytes = encodeJson({ id: message.id, ...reply });
        } catch {
          bytes = encodeJson({
            id: message.id,
            ok: false,
            error: { code: 'limit_exceeded', message: 'Node reply too large' },
          });
        }
        try {
          void connection.carrier
            .send(connection.transport.send.encrypt(bytes))
            .catch(() => connection.carrier.close());
        } catch {
          connection.carrier.close();
        }
      };
      if (this.incoming >= 256 || connection.carrier.bufferedAmount > 2 * MAX_JSON) {
        respond({ ok: false, error: { code: 'unavailable', message: 'Too many node requests' } });
        return;
      }
      this.incoming++;
      let timer: NodeJS.Timeout;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RemoteKitError('outcome_unknown', 'Node request timed out')),
          Math.max(1, Math.min(20000, this.registry.options.requestTimeoutMs ?? 20000)),
        );
      });
      void Promise.race([
        Promise.resolve().then(() => {
          if (this.current !== connection) throw new RemoteKitError('unavailable', 'Node disconnected');
          return this.registry.dispatch(this, message);
        }),
        timeout,
      ])
        .then(
          (result) => respond({ ok: true, result }),
          (error) => {
            const failure = toRemoteKitError(error);
            respond({ ok: false, error: { code: failure.code, message: failure.message } });
          },
        )
        .finally(() => {
          clearTimeout(timer);
          this.incoming--;
        });
      return;
    }
    if (message.event === 'client.action' || message.event === 'rtc.signal') {
      if (
        typeof message.tenantId !== 'string' ||
        typeof message.connectionId !== 'string' ||
        (message.event === 'rtc.signal' && (!message.signal || typeof message.signal !== 'object'))
      )
        throw new Error('Invalid node event');
      this.emit(message.event, message);
      return;
    }
    if (typeof message.id !== 'string' || typeof message.ok !== 'boolean')
      throw new Error('Invalid node reply');
    const pending = this.pending.get(message.id);
    if (!pending || pending.epoch !== connection.epoch) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(message.error ?? { code: 'rejected', message: 'Node rejected request' });
  }
  request(method: string, tenantId: string, args: Record<string, unknown> = {}): Promise<any> {
    const connection = this.current;
    if (this.stopped || !connection)
      return Promise.reject(new RemoteKitError('unavailable', 'Node is offline'));
    if (this.pending.size >= 256 || connection.carrier.bufferedAmount > 2 * MAX_JSON)
      return Promise.reject(new RemoteKitError('unavailable', 'Node has too many requests'));
    const id = randomUUID();
    let message: Buffer;
    try {
      message = encodeJson({ ...args, id, method, tenantId });
    } catch {
      return Promise.reject(new RemoteKitError('limit_exceeded', 'Node request too large'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new RemoteKitError('outcome_unknown', 'Node request timed out', method));
        },
        Math.max(1, Math.min(20000, this.registry.options.requestTimeoutMs ?? 20000)),
      );
      this.pending.set(id, { epoch: connection.epoch, resolve, reject, timer });
      const failed = () => {
        this.disconnect(connection);
        connection.carrier.close();
      };
      try {
        void connection.carrier.send(connection.transport.send.encrypt(message)).catch(failed);
      } catch {
        failed();
      }
    });
  }
  disconnect(connection: Connection) {
    if (this.current !== connection) return;
    this.current = undefined;
    this.state = { state: 'offline' };
    this.events = { ...this.events, disconnectedAt: Date.now() };
    for (const [id, pending] of this.pending) {
      if (pending.epoch !== connection.epoch) continue;
      clearTimeout(pending.timer);
      pending.reject(new RemoteKitError('outcome_unknown', 'Node disconnected'));
      this.pending.delete(id);
    }
    this.emit('offline');
  }
  history(): Readonly<NodeHistory> {
    return this.events;
  }
  rejected(code: string, buildId: string) {
    this.events = { ...this.events, rejected: { code, buildId, at: Date.now() } };
  }
  evict() {
    if (this.current) {
      const connection = this.current;
      this.disconnect(connection);
      connection.carrier.close();
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retry);
    if (this.current) {
      const connection = this.current;
      this.disconnect(connection);
      connection.carrier.close();
    }
    this.child?.kill();
    this.state = { state: 'offline' };
  }
}

export class NodeRegistry extends EventEmitter {
  isRemoved: (nodeId: string) => boolean = () => false;
  fencing: (nodeId: string) => { tenantId: string; sessionId: string; placementEpoch: number }[] = () => [];
  readonly handlers = new Map<string, (node: NodeLink, message: Record<string, any>) => unknown>();
  dispatch(node: NodeLink, message: Record<string, any>) {
    const handler = this.handlers.get(message.request);
    if (!handler) throw new RemoteKitError('invalid_request', 'Unknown node request');
    return handler(node, message);
  }
  private readonly links = new Map<string, NodeLink>();
  private readonly carriers = new Set<Carrier>();
  private stopped = false;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CIPHERTEXT,
    perMessageDeflate: false,
  });
  constructor(readonly options: RegistryOptions) {
    super();
    for (const [nodeId, configured] of Object.entries(options.nodes)) {
      const link = new NodeLink(nodeId, configured, this);
      this.links.set(nodeId, link);
      link.on('ready', (identity) => this.emit('ready', { ...identity, nodeId }));
      link.on('offline', () => this.emit('offline', nodeId));
    }
  }
  get(nodeId: string) {
    return this.links.get(nodeId);
  }
  all() {
    return [...this.links.values()];
  }
  start() {
    for (const link of this.links.values()) link.start();
  }
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/node') return false;
    if (this.stopped)
      socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else this.sockets.handleUpgrade(req, socket, head, (ws) => this.accept(new WebSocketCarrier(ws)));
    return true;
  }
  accept(carrier: Carrier, expectedNodeId?: string) {
    if (this.stopped) {
      carrier.close();
      return;
    }
    this.carriers.add(carrier);
    const handshake = new NoiseHandshake('responder', Buffer.from(this.options.key, 'base64'));
    let connection: Connection | undefined;
    let link: NodeLink | undefined;
    let role: 'endpoint' | 'updater' | undefined;
    let handshaking = false;
    let downloading = false;
    let lastReceived = Date.now();
    const deadline = setTimeout(() => carrier.close(), this.options.handshakeTimeoutMs ?? 5000);
    deadline.unref();
    const heartbeat = setInterval(
      () => {
        if (Date.now() - lastReceived >= (this.options.heartbeatTimeoutMs ?? 45000)) carrier.close();
      },
      Math.min(1000, this.options.heartbeatTimeoutMs ?? 45000),
    );
    heartbeat.unref();
    carrier.once('close', () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      this.carriers.delete(carrier);
      if (connection) link?.disconnect(connection);
    });
    carrier.on('message', (bytes: Buffer) => {
      try {
        lastReceived = Date.now();
        if (!connection) {
          if (handshaking) throw new Error('Unexpected handshake message');
          handshaking = true;
          const hello = jsonObject(handshake.readMessage(bytes));
          if (
            hello.type !== 'node.hello' ||
            !['endpoint', 'updater'].includes(hello.role) ||
            typeof hello.nodeId !== 'string' ||
            typeof hello.buildId !== 'string' ||
            (hello.role === 'endpoint' &&
              (typeof hello.incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(hello.incarnation)))
          )
            throw new Error('Invalid node hello');
          role = hello.role;
          link = this.links.get(hello.nodeId);
          let reject: string | undefined;
          if (
            !link ||
            this.isRemoved(hello.nodeId) ||
            (expectedNodeId && expectedNodeId !== hello.nodeId) ||
            (!expectedNodeId && link.configured.launch)
          )
            reject = 'unknown_node';
          // Updaters connect with their installed build to fetch its replacement.
          else if (role === 'endpoint' && hello.buildId !== this.options.buildId) reject = 'build_mismatch';
          else if (role === 'updater' && !this.options.release) reject = 'no_release';
          const epoch = randomUUID();
          const reply = reject
            ? { type: 'node.reject', code: reject, message: reject, buildId: this.options.buildId }
            : role === 'updater'
              ? { type: 'node.release', release: this.options.release!.descriptor }
              : {
                  type: 'node.ready',
                  sessions: this.fencing(hello.nodeId),
                  connectionEpoch: epoch,
                  buildId: this.options.buildId,
                  config: link!.config,
                  configHash: link!.configured.configHash,
                };
          const response = handshake.writeMessage(Buffer.from(JSON.stringify(reply)));
          if (reject) {
            link?.rejected(reject, hello.buildId);
            void carrier
              .send(response)
              .finally(() => carrier.close())
              .catch(() => {});
            return;
          }
          connection = { carrier, transport: handshake.split(), epoch };
          void carrier.send(response).catch(() => carrier.close());
          clearTimeout(deadline);
          if (role === 'endpoint') link!.attach(connection, hello.incarnation);
          return;
        }
        const frame = decodeFrame(connection.transport.receive.decrypt(bytes));
        if (frame.kind !== 'json') throw new Error('Unexpected binary message');
        const message = frame.message;
        if (message.type === 'node.ping') {
          void carrier
            .send(connection.transport.send.encrypt(encodeJson({ type: 'node.pong' })))
            .catch(() => carrier.close());
        } else if (message.type === 'node.pong') {
          return;
        } else if (role === 'updater') {
          const release = this.options.release!;
          if (
            downloading ||
            message.type !== 'package.get' ||
            message.buildId !== release.descriptor.buildId ||
            !Number.isSafeInteger(message.offset) ||
            message.offset < 0 ||
            message.offset > release.descriptor.size
          )
            throw new Error('Invalid package request');
          downloading = true;
          void this.sendPackage(connection, message.offset)
            .catch(() => carrier.close())
            .finally(() => {
              downloading = false;
            });
        } else link!.receive(connection, message);
      } catch {
        carrier.close();
      }
    });
  }
  private async sendPackage(connection: Connection, offset: number) {
    const release = this.options.release!;
    const file = await open(release.archive, 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      while (offset < release.descriptor.size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, release.descriptor.size - offset),
          offset,
        );
        if (!bytesRead) throw new Error('Truncated package');
        await connection.carrier.send(
          connection.transport.send.encrypt(
            encodeBinary({ type: 'package.chunk', offset }, buffer.subarray(0, bytesRead)),
          ),
        );
        offset += bytesRead;
      }
      await connection.carrier.send(
        connection.transport.send.encrypt(encodeJson({ type: 'package.end', size: release.descriptor.size })),
      );
    } finally {
      await file.close();
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const link of this.links.values()) link.stop();
    for (const carrier of this.carriers) carrier.close();
    this.sockets.close();
  }
}
