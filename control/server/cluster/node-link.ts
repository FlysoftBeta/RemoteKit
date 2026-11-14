import {
  canonical,
  validateSessionEvent,
  validateNodeDesired,
  validateSessionObserved,
  coordinationLimits,
  type OneShotRequest,
  type SessionObserved,
  type SessionEvent,
} from '../endpoint/coordination';
import { RpcResults, rpcId } from '../endpoint/rpc-results';
import { diskFloor } from './disk';
import { RetryUnit } from '../../shared/retry-unit';
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
import {
  RemoteKitError,
  endpointError,
  toRemoteKitError,
  wireError,
  nativeWireError,
  parseWireError,
} from '../../shared/errors';
import { log } from '../log';
import { SessionFaults } from '../endpoint/session-faults';
import type { SessionTarget } from '../endpoint/coordination';
import type { ConfiguredNode, NodeConfig, NodeLimits } from '../config';
import { readyTransition, type EndpointLink, type EndpointLinkState } from '../endpoint/link';
import type { RtcSignal } from '../endpoint/types';
import {
  decodeFrame,
  encodeBinary,
  encodeJson,
  encodeStdio,
  jsonObject,
  MAX_JSON,
  StdioDecoder,
} from './frames';
import { MAX_CIPHERTEXT, MAX_HANDSHAKE_PAYLOAD, NoiseHandshake, type Transport } from './noise';
import { encodeNodeReady } from './ready';
import type { NodeRelease } from './release';

export abstract class Carrier extends EventEmitter {
  nodeId?: string;
  private closing = false;
  private closeRequested = false;
  get isClosing() {
    return this.closing;
  }
  recordClose(reason: string, detail: string) {
    if (this.closing) return false;
    this.closing = true;
    log.warn('node.link_closed', { nodeId: this.nodeId ?? null, reason, detail });
    this.emit('closing');
    return true;
  }
  closeWithCause(reason: string, detail: string) {
    this.recordClose(reason, detail);
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.close();
  }
  async write(message: Buffer) {
    try {
      await this.send(message);
    } catch (error) {
      this.closeWithCause('write_error', errorDetail(error));
      throw error;
    }
  }
  abstract readonly bufferedAmount: number;
  abstract send(message: Buffer): Promise<void>;
  abstract close(): void;
}
function errorDetail(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const value = error as { message?: unknown } | undefined;
  const message = typeof value?.message === 'string' ? value.message : String(error);
  return code ? `${code}: ${message}` : message;
}
export class WebSocketCarrier extends Carrier {
  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }
  constructor(readonly socket: WebSocket) {
    super();
    socket.on('message', (bytes, binary) => {
      if (!binary) return this.closeWithCause('protocol_violation', 'Expected binary WebSocket message');
      this.emit('message', Buffer.from(bytes as Buffer));
    });
    socket.on('error', (error) => this.closeWithCause('carrier_error', errorDetail(error)));
    socket.once('close', (code, reason) => {
      this.recordClose('carrier_closed', `WebSocket closed: ${code} ${reason.toString()}`);
      this.emit('close');
    });
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
    endpointLog: EndpointLog,
  ) {
    super();
    const decoder = new StdioDecoder();
    child.stdout.on('data', (bytes: Buffer) => {
      try {
        for (const frame of decoder.push(bytes)) this.emit('message', frame);
      } catch (error) {
        this.closeWithCause('frame_decode_error', errorDetail(error));
      }
    });
    child.stdout.on('end', () => {
      try {
        decoder.end();
      } catch (error) {
        this.closeWithCause('frame_decode_error', errorDetail(error));
        return;
      }
      this.closeWithCause('stdout_end', 'Endpoint stdout ended');
    });
    child.stderr.on('data', (bytes: Buffer) => endpointLog.write(bytes));
    child.stdin.on('error', (error) => this.closeWithCause('write_error', errorDetail(error)));
    child.stdout.on('error', (error) => this.closeWithCause('stdout_error', errorDetail(error)));
    child.on('error', (error) => {
      this.recordClose('child_error', errorDetail(error));
      this.emit('close');
    });
    child.once('exit', (code, signal) => {
      this.recordClose('child_exit', `Endpoint exited: code=${code}, signal=${signal}`);
      this.emit('close');
    });
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
  target?: SessionTarget;
  method?: string;
  opId?: string;
  delivered: boolean;
  epoch: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}
export interface RegistryOptions {
  nodes: Readonly<Record<string, ConfiguredNode>>;
  privateKey: string;
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
  coordinationError?: import('../../shared/errors').WireError;
  launchError?: import('../../shared/errors').WireError;
}
export class NodeLink extends EventEmitter implements EndpointLink {
  state: EndpointLinkState = { state: 'offline' };
  private events: NodeHistory = {};
  readonly config: Readonly<NodeConfig>;
  readonly limits: Readonly<NodeLimits>;
  readonly metrics: MetricsHistory;
  buildId?: string;
  diskDraining = false;
  reliefRequestedAt?: number;
  allocationFailedAt?: number;
  coordination: Promise<void> = Promise.resolve();
  private fenceKey = '';
  private coordinating = false;
  private fenceRevision = 0n;
  private readonly fenceRetry = new RetryUnit({
    failed: (error) =>
      log.warn('node.coordination_failed', {
        nodeId: this.nodeId,
        code: error.code,
        errorId: error.errorId,
        err: error,
      }),
    recovered: () => log.info('node.coordination_recovered', { nodeId: this.nodeId }),
  });
  private announceReady?: () => void;
  private fenceDocument?: {
    method: 'node.desired';
    connectionEpoch: string;
    revision: string;
    sessions: ReturnType<NodeRegistry['fencing']>;
  };
  readonly observations = new Map<string, SessionObserved>();
  readonly faults = new SessionFaults();
  faultSession(target: SessionTarget, cause: unknown) {
    if (this.faults.get(target)) return;
    const error = this.faults.fault(target, cause);
    this.observations.delete(target.tenantId);
    this.registry.emit('session.fault', { nodeId: this.nodeId, target, error });
  }
  private incoming = 0;
  private current?: Connection;
  private incarnation?: string;
  private readonly pending = new Map<string, Pending>();
  private readonly timedOut = new Set<string>();
  private child?: ChildProcessWithoutNullStreams;
  private readonly launchRetry = new RetryUnit({
    failed: (error) => log.warn('node.launch_failed', { nodeId: this.nodeId, err: error }),
    recovered: () => log.info('node.launch_recovered', { nodeId: this.nodeId }),
  });
  private stopped = false;
  constructor(
    readonly nodeId: string,
    readonly configured: ConfiguredNode,
    private readonly registry: NodeRegistry,
  ) {
    super();
    this.config = configured.config;
    this.limits = configured.limits;
    this.metrics = new MetricsHistory(this.limits.maxSessions, () =>
      this.registry
        .all()
        .filter((node) => node.state.state === 'ready' && !this.registry.isRemoved(node.nodeId))
        .map((node) => node.metrics),
    );
  }
  onSignal(listener: (event: RtcSignal) => void) {
    this.on('rtc.signal', listener);
    return () => {
      this.off('rtc.signal', listener);
    };
  }
  coordinate(): Promise<void> {
    const connection = this.current;
    if (!connection) return Promise.reject(new RemoteKitError('unavailable', 'Node is offline'));
    const sessions = this.registry.fencing(this.nodeId);
    const key = canonical(sessions);
    if (key === this.fenceKey && this.coordinating) return this.coordination;
    if (!this.fenceRetry.ready(`${connection.epoch}:${key}`)) return this.coordination;
    if (key === this.fenceKey && !this.fenceRetry.error) return this.coordination;
    const reuse = key === this.fenceKey && this.fenceRetry.error?.code !== 'conflict';
    if (!reuse) {
      this.fenceDocument = {
        method: 'node.desired',
        connectionEpoch: connection.epoch,
        revision: String(++this.fenceRevision),
        sessions,
      };
    }
    this.fenceKey = key;
    const document = this.fenceDocument!;
    this.fenceRetry.cancel();
    const previous = this.coordination;
    const send = async () => {
      if (this.current !== connection) throw new RemoteKitError('unavailable', 'Node connection changed');
      validateNodeDesired(document);
      await this.exchange(document);
    };
    const pending = previous.then(send, send);
    this.coordination = pending;
    this.coordinating = true;
    void pending.then(
      () => {
        if (this.current !== connection || this.coordination !== pending) return;
        this.coordinating = false;
        this.fenceRetry.succeed();
        delete this.events.coordinationError;
        const ready = this.announceReady;
        this.announceReady = undefined;
        ready?.();
      },
      (error) => {
        if (this.current !== connection || this.coordination !== pending) return;
        this.coordinating = false;
        const failure = this.fenceRetry.fail(error);
        this.events.coordinationError = wireError(failure.error);
        if (failure.delay === undefined) return;
        this.fenceRetry.schedule(() => {
          void this.coordinate().catch((error) => {
            this.events.coordinationError = wireError(endpointError(error));
          });
        });
      },
    );
    return pending;
  }
  publish(message: object): Promise<any> {
    if ((message as { method?: string }).method === 'session.clipboard')
      return this.coordinate().then(() => this.exchange(message));
    return this.coordinate().then(
      () =>
        new Promise<void>((resolve, reject) => {
          void this.exchange(message, undefined, resolve).catch((error) => {
            reject(error);
            this.registry.emit('publication.failed', { nodeId: this.nodeId, message, error });
          });
        }),
    );
  }
  async invoke(message: OneShotRequest, timeoutMs?: number): Promise<any> {
    await this.coordinate();
    if (this.state.state !== 'ready' || this.state.incarnation !== message.endpointIncarnation)
      throw new RemoteKitError('conflict', 'RPC Endpoint target is retired');
    return this.exchange(message, timeoutMs);
  }
  start() {
    const launch = this.configured.local;
    if (
      !launch ||
      this.stopped ||
      this.child ||
      this.state.state === 'connecting' ||
      this.registry.isRemoved(this.nodeId)
    )
      return;
    if (!this.launchRetry.ready(JSON.stringify([launch, this.registry.options.buildId]))) return;
    this.state = { state: 'connecting' };
    let finished = false;
    const exited = (code: number | null, cause?: unknown) => {
      if (finished) return;
      finished = true;
      this.child = undefined;
      this.events = { ...this.events, exited: { code, at: Date.now() } };
      if (!this.current) this.state = { state: 'offline' };
      if (!this.stopped) {
        this.launchRetry.fail(
          cause ??
            new RemoteKitError(
              code === 3 ? 'rejected' : code === 4 ? 'conflict' : 'unavailable',
              `Local node exited ${code}`,
            ),
        );
        this.launchRetry.schedule(() => this.start());
      }
    };
    void (async () => {
      if (this.registry.options.buildId !== 'dev') {
        try {
          if (!launch.versionDir)
            throw new RemoteKitError('invalid_request', 'Missing local node version directory');
          await new Promise<void>((resolve, reject) => {
            const installer = spawn(
              join(launch.versionDir!, 'bin', 'remotekit_node.exe'),
              ['install', `--root=${launch.root}`, `--package=${launch.versionDir}`],
              { stdio: 'pipe', windowsHide: true },
            );
            this.child = installer;
            const log = new EndpointLog(join(launch.root, 'logs', 'endpoint.log'));
            installer.stdin.end();
            installer.stdout.on('data', (bytes: Buffer) => log.write(bytes));
            installer.stderr.on('data', (bytes: Buffer) => log.write(bytes));
            installer.once('error', reject);
            installer.once('close', (code) =>
              code === 0 ? resolve() : reject(new Error(`Local node install exited ${code}`)),
            );
          });
          this.child = undefined;
        } catch (error) {
          exited(
            null,
            error instanceof RemoteKitError
              ? error
              : new RemoteKitError('unavailable', 'Local node installation failed', { cause: error }),
          );
          return;
        }
      }
      if (this.stopped || this.registry.isRemoved(this.nodeId)) return;
      const child = spawn(launch.executable, ['--stdio', `--node-root=${launch.root}`], {
        stdio: 'pipe',
        windowsHide: true,
      });
      this.child = child;
      this.registry.accept(
        new StdioCarrier(child, new EndpointLog(join(launch.root, 'logs', 'endpoint.log'))),
        this.nodeId,
      );
      child.once('error', () => exited(null));
      child.once('exit', (code) => exited(code));
    })().catch((error) => exited(null, endpointError(error)));
  }

  attach(connection: Connection, incarnation: string) {
    connection.carrier.nodeId = this.nodeId;
    if (this.stopped) {
      connection.carrier.closeWithCause('stopped', 'Node stopped before attachment');
      return;
    }
    if (this.current) {
      const previous = this.current;
      previous.carrier.closeWithCause('replaced', `New connection epoch ${connection.epoch}`);
    }
    const transition = readyTransition(this.incarnation, incarnation, connection.epoch);
    this.current = connection;
    connection.carrier.once('closing', () => this.disconnect(connection));
    this.coordination = Promise.resolve();
    this.coordinating = false;
    this.fenceKey = '';
    this.fenceRevision = 0n;
    this.fenceDocument = undefined;
    this.observations.clear();
    this.incarnation = incarnation;
    this.metrics.clear();
    this.buildId = this.registry.options.buildId;
    this.state = transition.state;
    log.warn('node.online', { nodeId: this.nodeId });
    this.events = { connectedAt: Date.now() };
    this.announceReady = () => {
      this.launchRetry.succeed();
      this.emit('ready', { incarnation, processChanged: transition.processChanged });
    };
    void this.coordinate().catch((error) => {
      this.events.coordinationError = wireError(endpointError(error));
    });
  }
  receive(connection: Connection, message: Record<string, any>) {
    if (this.current !== connection) return;
    if (message.event === 'node.metrics') {
      const { event, ...metrics } = message;
      this.metrics.record(metrics as any);
      const sample = this.metrics.latest()!;
      const free = sample.value.disk.free;
      const floor = diskFloor(this, sample);
      if (free < floor) this.diskDraining = true;
      if (free >= 2 * floor) this.diskDraining = false;
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
          bytes = encodeJson({ id: message.id, opId: message.opId, ...reply });
        } catch {
          bytes = encodeJson({
            id: message.id,
            opId: message.opId,
            ok: false,
            error: { code: 'outcome_unknown', message: 'Node reply could not be encoded after execution' },
          });
        }
        this.sendFrame(connection, bytes);
      };
      if (
        this.incoming >= coordinationLimits.pendingRequests ||
        connection.carrier.bufferedAmount > 2 * MAX_JSON
      ) {
        respond({ ok: false, error: { code: 'busy', message: 'Too many node requests' } });
        return;
      }
      this.incoming++;
      let timer: NodeJS.Timeout;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RemoteKitError('outcome_unknown', '节点请求结果待确认', {
                detail: 'Node request timed out',
              }),
            ),
          Math.max(1, Math.min(20000, this.registry.options.requestTimeoutMs ?? 20000)),
        );
      });
      void Promise.race([
        Promise.resolve().then(() => {
          if (this.current !== connection)
            throw new RemoteKitError('unavailable', '节点连接已断开', { detail: 'Node disconnected' });
          return this.registry.dispatch(this, message);
        }),
        timeout,
      ])
        .then(
          (result) => respond({ ok: true, result }),
          (error) => {
            const failure = toRemoteKitError(error);
            respond({
              ok: false,
              error: nativeWireError(failure),
            });
          },
        )
        .finally(() => {
          clearTimeout(timer);
          this.incoming--;
        });
      return;
    }
    if (message.event === 'session.observed' || message.event === 'session.event') {
      if (
        typeof message.tenantId !== 'string' ||
        !message.tenantId ||
        typeof message.sessionId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(message.sessionId) ||
        !Number.isSafeInteger(message.placementEpoch) ||
        message.placementEpoch < 1
      )
        throw new Error('Invalid Session coordination envelope');
      const placed = this.registry.fencing(this.nodeId).find((value) => value.tenantId === message.tenantId);
      if (
        !placed ||
        placed.sessionId !== message.sessionId ||
        placed.placementEpoch !== message.placementEpoch
      )
        return;
      if (this.faults.get(placed)) return;
      try {
        if (message.connectionEpoch !== connection.epoch) throw new Error('Invalid Session connection');
        if (message.event === 'session.observed') {
          validateSessionObserved(message);
          if (message.endpointIncarnation !== this.incarnation)
            throw new Error('Invalid Endpoint incarnation');
          const previous = this.observations.get(message.tenantId);
          if (previous && BigInt(previous.seq) >= BigInt(message.seq)) return;
          this.faults.observe(placed, message.browser === 'running' && message.lastError === null);
          this.observations.set(message.tenantId, message);
        } else validateSessionEvent(message);
      } catch (error) {
        this.faultSession(
          placed,
          new RemoteKitError('internal', 'Invalid Session coordination event', { cause: error }),
        );
        return;
      }
      this.registry.emit(message.event, { nodeId: this.nodeId, message });
      this.emit(message.event, message);
      return;
    }
    if (message.event === 'rtc.signal') {
      if (
        typeof message.tenantId !== 'string' ||
        typeof message.connectionId !== 'string' ||
        (message.event === 'rtc.signal' && (!message.signal || typeof message.signal !== 'object'))
      )
        throw new Error('Invalid node event');
      this.emit(message.event, message);
      return;
    }
    if (typeof message.id !== 'string') throw new Error('Invalid node reply');
    const pending = this.pending.get(message.id);
    // A late reply to a request that timed out or was abandoned is harmless; it must not end
    // the link (for a local node that ends the Endpoint process and every Session).
    if (!pending || pending.epoch !== connection.epoch) {
      if (!this.timedOut.delete(message.id))
        log.warn('node.reply_unmatched', { nodeId: this.nodeId, id: message.id });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    let invalidReply: string | undefined;
    if (typeof message.ok !== 'boolean') invalidReply = 'Invalid node reply: missing or invalid ok';
    else if (pending.opId && message.opId !== pending.opId)
      invalidReply = 'Invalid node reply: missing or mismatched opId';
    else if (message.ok) {
      if (
        !Object.prototype.hasOwnProperty.call(message, 'result') ||
        (pending.target &&
          (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)))
      )
        invalidReply = 'Invalid node reply: invalid result';
    } else if (!parseWireError(message.error)) invalidReply = 'Invalid node reply: invalid error';
    if (invalidReply) {
      if (!pending.target) {
        pending.reject(new RemoteKitError('outcome_unknown', invalidReply));
        throw new Error(invalidReply);
      }
      const placed = this.registry
        .fencing(this.nodeId)
        .find((value) => value.tenantId === pending.target!.tenantId);
      if (
        placed &&
        placed.sessionId === pending.target.sessionId &&
        placed.placementEpoch === pending.target.placementEpoch
      )
        this.faultSession(placed, new Error('Invalid Session RPC reply'));
      pending.reject(
        new RemoteKitError('outcome_unknown', 'Invalid Session RPC reply', {
          cause: this.faults.get(pending.target),
        }),
      );
      return;
    }
    if (
      pending.target &&
      !['session.desired', 'session.clipboard'].includes(pending.method ?? '') &&
      this.faults.get(pending.target)
    ) {
      pending.reject(
        new RemoteKitError('outcome_unknown', 'Session faulted after RPC delivery', {
          cause: this.faults.get(pending.target),
        }),
      );
      return;
    }
    if (message.ok) pending.resolve(message.result);
    else {
      const error = parseWireError(message.error)
        ? message.error
        : { code: 'outcome_unknown', message: 'Node returned an invalid error envelope' };
      // Endpoint peer credentials do not authenticate the Viewer Control session.
      pending.reject(error);
    }
  }
  send(message: object) {
    const connection = this.current;
    if (!connection) return;
    this.sendFrame(connection, encodeJson(message));
  }
  private sendFrame(connection: Connection, bytes: Buffer) {
    try {
      void connection.carrier
        .write(connection.transport.send.encrypt(bytes))
        .catch((error) => connection.carrier.closeWithCause('write_failed', errorDetail(error)));
    } catch (error) {
      connection.carrier.closeWithCause('encrypt_failed', errorDetail(error));
    }
  }
  async sendBinary(header: object, bytes: Buffer, epoch: string) {
    const connection = this.current;
    if (!connection || connection.epoch !== epoch)
      throw new RemoteKitError('unavailable', '节点连接已改变', { detail: 'Node connection changed' });
    if (connection.transport.send.closed) throw new RemoteKitError('unavailable', '节点加密通道已关闭');
    let encrypted: Buffer;
    try {
      encrypted = connection.transport.send.encrypt(encodeBinary(header, bytes));
    } catch (error) {
      throw error instanceof RemoteKitError
        ? error
        : new RemoteKitError('internal', '文件数据编码失败', { detail: String(error) });
    }
    try {
      await connection.carrier.write(encrypted);
    } catch {
      throw new RemoteKitError('unavailable', '文件数据发送失败', { detail: 'Object chunk delivery failed' });
    }
  }
  request(
    method: string,
    tenantId: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
    operationId?: string,
  ): Promise<any> {
    if (this.state.state !== 'ready')
      return Promise.reject(new RemoteKitError('unavailable', 'Node is offline'));
    const identity =
      operationId ?? (typeof args.putId === 'string' ? rpcId(method, args.putId) : randomUUID());
    return this.invoke(
      {
        method,
        tenantId,
        sessionId: null,
        placementEpoch: null,
        endpointIncarnation: this.state.incarnation,
        opId: identity,
        replay: false,
        params: args,
      },
      timeoutMs,
    );
  }
  private exchange(envelope: object, timeoutMs?: number, delivered?: () => void): Promise<any> {
    const connection = this.current;
    if (this.stopped || !connection)
      return Promise.reject(new RemoteKitError('unavailable', '节点离线', { detail: 'Node is offline' }));
    if (
      this.pending.size >= coordinationLimits.pendingRequests ||
      connection.carrier.bufferedAmount > 2 * MAX_JSON
    )
      return Promise.reject(new RemoteKitError('busy', '节点请求繁忙'));
    const id = randomUUID();
    let message: Buffer;
    try {
      message = encodeJson({ ...envelope, id });
    } catch (error) {
      return Promise.reject(
        error instanceof RemoteKitError
          ? error
          : new RemoteKitError('internal', '节点请求无法编码', { detail: String(error) }),
      );
    }
    if (connection.transport.send.closed)
      return Promise.reject(new RemoteKitError('unavailable', '节点加密通道已关闭'));
    let encrypted: Buffer;
    try {
      encrypted = connection.transport.send.encrypt(message);
    } catch (error) {
      return Promise.reject(new RemoteKitError('internal', '节点请求编码失败', { detail: String(error) }));
    }
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        epoch: connection.epoch,
        method: (envelope as any).method,
        target: typeof (envelope as any).sessionId === 'string' ? (envelope as SessionTarget) : undefined,
        opId: (envelope as { opId?: string }).opId,
        delivered: false,
        resolve,
        reject,
        timer: undefined!,
      };
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          this.timedOut.add(id);
          reject(
            new RemoteKitError('outcome_unknown', '节点请求未获确认', {
              detail: String((envelope as { method?: string }).method ?? ''),
            }),
          );
        },
        timeoutMs ?? Math.max(1, Math.min(20000, this.registry.options.requestTimeoutMs ?? 20000)),
      );
      pending.timer = timer;
      this.pending.set(id, pending);
      void connection.carrier.write(encrypted).then(
        () => {
          pending.delivered = true;
          delivered?.();
        },
        () => {},
      );
    });
  }
  disconnect(connection: Connection) {
    if (this.current !== connection) return;
    this.fenceRetry.cancel();
    this.announceReady = undefined;
    this.current = undefined;
    this.timedOut.clear();
    this.faults.disconnected();
    log.warn('node.offline', { nodeId: this.nodeId });
    this.state = { state: 'offline' };
    this.events = { ...this.events, disconnectedAt: Date.now() };
    for (const [id, pending] of this.pending) {
      if (pending.epoch !== connection.epoch) continue;
      clearTimeout(pending.timer);
      pending.reject(
        new RemoteKitError(pending.delivered ? 'outcome_unknown' : 'unavailable', '节点连接已断开'),
      );
      this.pending.delete(id);
    }
    this.emit('offline');
  }
  history(): Readonly<NodeHistory> {
    return {
      ...this.events,
      ...(this.launchRetry.error ? { launchError: wireError(this.launchRetry.error) } : {}),
    };
  }
  rejected(code: string, buildId: string) {
    this.events = { ...this.events, rejected: { code, buildId, at: Date.now() } };
  }
  evict() {
    if (this.current) {
      const connection = this.current;
      connection.carrier.closeWithCause('evicted', 'Node evicted');
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.launchRetry.close();
    this.fenceRetry.close();
    if (this.current) {
      const connection = this.current;
      connection.carrier.closeWithCause('stopped', 'Node stopped');
    }
    this.child?.kill();
    this.state = { state: 'offline' };
  }
}

export class NodeRegistry extends EventEmitter {
  unknownIdentityRejection?: NonNullable<NodeHistory['rejected']>;
  isRemoved: (nodeId: string) => boolean = () => false;
  objectKeys?: { objectKey: string; objectIdKey: string };
  fencing: (
    nodeId: string,
  ) => { tenantId: string; sessionId: string; placementEpoch: number; dataState: 'clean' | 'dirty' }[] =
    () => [];
  readonly handlers = new Map<string, (node: NodeLink, message: Record<string, any>) => unknown>();
  dispatch(node: NodeLink, message: Record<string, any>) {
    const handler = this.handlers.get(message.request);
    if (!handler)
      throw new RemoteKitError('invalid_request', '不支持的节点请求', { detail: 'Unknown node request' });
    if (
      typeof message.opId !== 'string' ||
      typeof message.replay !== 'boolean' ||
      !message.params ||
      typeof message.params !== 'object' ||
      message.endpointIncarnation !== (node.state.state === 'ready' ? node.state.incarnation : undefined)
    )
      throw new RemoteKitError('invalid_request', 'Invalid node RPC envelope');
    const key = canonical([node.nodeId, message.endpointIncarnation, message.tenantId]);
    let results = this.results.get(key);
    if (!results) this.results.set(key, (results = new RpcResults()));
    return results.execute(message, () =>
      handler(node, { ...message.params, request: message.request, tenantId: message.tenantId }),
    );
  }
  private readonly links = new Map<string, NodeLink>();
  private readonly results = new Map<string, RpcResults>();
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
    carrier.nodeId = expectedNodeId;
    if (this.stopped) {
      carrier.closeWithCause('stopped', 'Registry stopped');
      return;
    }
    this.carriers.add(carrier);
    const handshake = new NoiseHandshake('responder', Buffer.from(this.options.privateKey, 'base64'));
    let connection: Connection | undefined;
    let link: NodeLink | undefined;
    let role: 'endpoint' | 'updater' | undefined;
    let handshaking = false;
    let downloading = false;
    let lastReceived = Date.now();
    const deadline = setTimeout(
      () => carrier.closeWithCause('handshake_timeout', 'Node hello not completed before handshake deadline'),
      this.options.handshakeTimeoutMs ?? 5000,
    );
    deadline.unref();
    const heartbeat = setInterval(
      () => {
        if (Date.now() - lastReceived < (this.options.heartbeatTimeoutMs ?? 45000)) return;
        log.warn('node.heartbeat_timeout', {
          nodeId: link?.nodeId ?? null,
          silentMs: Date.now() - lastReceived,
        });
        carrier.closeWithCause('heartbeat_timeout', `No message for ${Date.now() - lastReceived} ms`);
      },
      Math.min(1000, this.options.heartbeatTimeoutMs ?? 45000),
    );
    heartbeat.unref();
    carrier.once('closing', () => clearInterval(heartbeat));
    carrier.once('close', () => {
      clearTimeout(deadline);
      this.carriers.delete(carrier);
      carrier.recordClose('carrier_closed', 'Carrier closed');
    });
    carrier.on('message', (bytes: Buffer) => {
      if (carrier.isClosing) return;
      let failureReason = connection ? 'protocol_violation' : 'handshake_failed';
      try {
        lastReceived = Date.now();
        if (!connection) {
          if (handshaking) throw new Error('Unexpected handshake message');
          handshaking = true;
          const hello = jsonObject(handshake.readMessage(bytes));
          if (typeof hello.nodeId === 'string') carrier.nodeId = expectedNodeId ?? hello.nodeId;
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
          let identityFailure: string | undefined;
          if (!link) identityFailure = 'unknown node ID';
          else if (this.isRemoved(hello.nodeId)) identityFailure = 'node removed';
          else if (expectedNodeId && expectedNodeId !== hello.nodeId)
            identityFailure = `expected stdio node ${expectedNodeId}, received ${hello.nodeId}`;
          else if (!expectedNodeId && link.configured.local) identityFailure = 'local node on remote carrier';
          else if (!handshake.remotePublicKey.equals(Buffer.from(link.configured.publicKey, 'base64')))
            identityFailure = 'public key mismatch';
          if (identityFailure) {
            if (expectedNodeId) this.links.get(expectedNodeId)?.rejected('identity_mismatch', hello.buildId);
            else {
              this.unknownIdentityRejection = {
                code: 'identity_mismatch',
                buildId: hello.buildId,
                at: Date.now(),
              };
              log.warn('node.unknown_identity_rejected', this.unknownIdentityRejection);
            }
            throw new Error(`Node identity mismatch: ${identityFailure}`);
          }
          let reject: string | undefined;
          if (role === 'endpoint' && hello.buildId !== this.options.buildId) reject = 'build_mismatch';
          else if (role === 'updater' && !this.options.release) reject = 'no_release';
          const epoch = randomUUID();
          const payload =
            !reject && role === 'endpoint'
              ? encodeNodeReady(
                  link!.configured,
                  this.peers(hello.nodeId),
                  this.options.buildId,
                  epoch,
                  this.objectKeys,
                )
              : Buffer.from(
                  JSON.stringify(
                    reject
                      ? { type: 'node.reject', code: reject, message: reject, buildId: this.options.buildId }
                      : { type: 'node.release', release: this.options.release!.descriptor },
                  ),
                );
          if (!reject && role === 'endpoint' && payload.length > MAX_HANDSHAKE_PAYLOAD) {
            log.warn('node.ready_oversize', {
              nodeId: link!.nodeId,
              bytes: payload.length,
              limit: MAX_HANDSHAKE_PAYLOAD,
            });
            carrier.closeWithCause(
              'ready_oversize',
              `node.ready is ${payload.length} bytes; limit ${MAX_HANDSHAKE_PAYLOAD}`,
            );
            return;
          }
          const response = handshake.writeMessage(payload);
          if (reject) {
            link?.rejected(reject, hello.buildId);
            carrier.recordClose('handshake_failed', reject);
            void carrier
              .write(response)
              .finally(() => carrier.closeWithCause('handshake_failed', reject!))
              .catch((error) => carrier.closeWithCause('write_failed', errorDetail(error)));
            return;
          }
          connection = { carrier, transport: handshake.split(), epoch };
          void carrier
            .write(response)
            .then(() => {
              if (carrier.isClosing) return;
              clearTimeout(deadline);
              if (role === 'endpoint') link!.attach(connection!, hello.incarnation);
            })
            .catch((error) => carrier.closeWithCause('write_failed', errorDetail(error)));
          return;
        }
        failureReason = 'decrypt_failed';
        const plaintext = connection.transport.receive.decrypt(bytes);
        failureReason = 'frame_decode_error';
        const frame = decodeFrame(plaintext);
        failureReason = 'protocol_violation';
        if (frame.kind !== 'json') throw new Error('Unexpected binary message');
        const message = frame.message;
        if (message.type === 'node.ping') {
          void carrier
            .write(connection.transport.send.encrypt(encodeJson({ type: 'node.pong' })))
            .catch((error) => carrier.closeWithCause('write_failed', errorDetail(error)));
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
          ) {
            const error = new RemoteKitError(
              downloading
                ? 'busy'
                : message.buildId !== release.descriptor.buildId
                  ? 'not_found'
                  : 'invalid_request',
              downloading ? 'Package transfer is active' : 'Release request cannot be served',
            );
            void carrier
              .write(
                connection.transport.send.encrypt(
                  encodeJson({ type: 'package.error', error: wireError(error) }),
                ),
              )
              .catch((error) => carrier.closeWithCause('write_failed', errorDetail(error)));
            return;
          }
          downloading = true;
          void this.sendPackage(connection, message.offset)
            .catch(async (error) => {
              const failure =
                error instanceof RemoteKitError
                  ? error
                  : new RemoteKitError('unavailable', '无法读取发布包', { detail: String(error) });
              await carrier
                .write(
                  connection!.transport.send.encrypt(
                    encodeJson({ type: 'package.error', error: wireError(failure) }),
                  ),
                )
                .catch((error) => carrier.closeWithCause('write_failed', errorDetail(error)));
            })
            .finally(() => {
              downloading = false;
            });
        } else link!.receive(connection, message);
      } catch (error) {
        carrier.closeWithCause(failureReason, errorDetail(error));
      }
    });
  }
  peers(receiver: string) {
    return this.all()
      .filter((node) => node.nodeId !== receiver && !this.isRemoved(node.nodeId))
      .map((node) => ({
        nodeId: node.nodeId,
        address: node.config.peer.address,
        publicKey: node.configured.publicKey,
      }));
  }
  publishPeers() {
    for (const node of this.all())
      if (!this.isRemoved(node.nodeId)) node.send({ type: 'node.peers', peers: this.peers(node.nodeId) });
  }
  private async sendPackage(connection: Connection, offset: number) {
    const release = this.options.release!;
    const file = await open(release.archive, 'r');
    try {
      const buffer = Buffer.alloc(coordinationLimits.objectChunkBytes);
      while (offset < release.descriptor.size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, release.descriptor.size - offset),
          offset,
        );
        if (!bytesRead)
          throw new RemoteKitError('internal', '发布包不完整', { detail: 'Release package is truncated' });
        await connection.carrier.write(
          connection.transport.send.encrypt(
            encodeBinary({ type: 'package.chunk', offset }, buffer.subarray(0, bytesRead)),
          ),
        );
        offset += bytesRead;
      }
      await connection.carrier.write(
        connection.transport.send.encrypt(encodeJson({ type: 'package.end', size: release.descriptor.size })),
      );
    } finally {
      await file.close();
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.emit('stopped');
    for (const link of this.links.values()) link.stop();
    for (const carrier of this.carriers) carrier.closeWithCause('stopped', 'Registry stopped');
    this.sockets.close();
  }
}
