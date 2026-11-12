import { observedSession } from './coordination-fixture';
import { RpcResults } from '../server/endpoint/rpc-results';
import type { SessionDesired } from '../server/endpoint/coordination';
import { nodePrivateKey } from './node-fixture';
import { EventEmitter, once } from 'node:events';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { NodeMetrics } from '../server/cluster/metrics';
import { RemoteKitError } from '../shared/errors';
import { WebSocket } from 'ws';
import { NoiseHandshake, publicKey, type Transport } from '../server/cluster/noise';
import { decodeFrame, encodeJson, jsonObject } from '../server/cluster/frames';

export class FakeNode extends EventEmitter {
  readonly requests: Record<string, any>[] = [];
  incarnation = randomBytes(16).toString('hex');
  socket!: WebSocket;
  transport!: Transport;
  helloReply!: Record<string, any>;
  metrics: NodeMetrics = fakeMetrics();
  readonly observations = new Map<string, ReturnType<typeof observedSession>>();
  readonly results = new RpcResults();
  fenceGate?: Promise<void>;
  desiredHandler?: (
    document: SessionDesired,
    value: ReturnType<typeof observedSession>,
  ) => void | Promise<void>;
  private nodeRevision = '0';
  private sequence = 0n;
  readonly sessions = new Map<string, Record<string, any>>();
  readonly objects = new Map<
    string,
    {
      tenantId?: string;
      id: string;
      size: number;
      storedSize: number;
      storedSha256: string;
      derivedFrom?: string;
      kind?: 'thumbnail' | 'document';
    }
  >();
  fetchObject?: (id: string) => FakeNode['objects'] extends Map<string, infer T> ? T | undefined : never;
  private readonly puts = new Map<string, { tenant: string; chunks: Buffer[]; size: number }>();
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
  >();
  async handle(message: Record<string, any>): Promise<unknown> {
    if (message.method === 'object.put.begin') {
      if (this.puts.size >= 4) throw { code: 'busy', message: 'Too many puts' };
      this.puts.set(message.putId, { tenant: message.tenantId, chunks: [], size: 0 });
      return { accepted: true };
    }
    if (message.method === 'object.put.cancel') {
      this.puts.delete(message.putId);
      return { cancelled: true };
    }
    if (message.method === 'object.put.end') {
      const put = this.puts.get(message.putId);
      if (!put) throw { code: 'not_found', message: 'Put missing' };
      this.puts.delete(message.putId);
      const bytes = Buffer.concat(put.chunks);
      const id = createHmac('sha256', Buffer.from(this.helloReply.objectIdKey, 'base64'))
        .update(bytes)
        .digest('hex');
      const metadata = {
        size: bytes.length,
        storedSize: bytes.length + 40,
        storedSha256: createHash('sha256').update(bytes).digest('hex'),
      };
      this.objects.set(id, { id, ...metadata });
      await this.request('object.committed', put.tenant, { putId: message.putId, objectId: id, ...metadata });
      return { objectId: id, ...metadata };
    }
    if (message.method === 'object.inventory')
      return {
        objects: [...this.objects.values()].map(({ tenantId, id, storedSize, storedSha256 }) => ({
          tenantId,
          id,
          storedSize,
          storedSha256,
        })),
        next: null,
      };
    if (message.method === 'object.delete') for (const id of message.ids) this.objects.delete(id);
    if (message.method === 'object.fetch') {
      for (const id of message.ids) {
        const object = this.fetchObject?.(id);
        if (!object) throw { code: 'not_found', message: 'Object missing' };
        this.objects.set(id, object);
        const { id: objectId, tenantId, derivedFrom, kind, ...metadata } = object;
        await this.request('object.committed', '', { objectId, ...metadata });
      }
    }
    return {};
  }
  private async dispatch(message: Record<string, any>): Promise<unknown> {
    if (message.method === 'node.desired') {
      await this.fenceGate;
      this.nodeRevision = message.revision;
      const wanted = new Set(message.sessions.map((value: any) => value.tenantId));
      for (const tenant of this.sessions.keys()) if (!wanted.has(tenant)) this.sessions.delete(tenant);
      for (const target of message.sessions) {
        let desired = this.sessions.get(target.tenantId) as SessionDesired | undefined;
        if (
          desired &&
          (desired.sessionId !== target.sessionId || desired.placementEpoch !== target.placementEpoch)
        ) {
          this.sessions.delete(target.tenantId);
          desired = undefined;
        }
        const prior = this.observations.get(target.tenantId);
        const value =
          prior && prior.sessionId === target.sessionId && prior.placementEpoch === target.placementEpoch
            ? { ...prior, connectionEpoch: this.helloReply.connectionEpoch }
            : observedSession(target, this.helloReply.connectionEpoch, this.incarnation, desired);
        value.nodeRevision = this.nodeRevision;
        value.seq = String(++this.sequence);
        this.observations.set(target.tenantId, value);
        this.send(value);
      }
      return { accepted: true, revision: message.revision };
    }
    if (message.method === 'session.desired') {
      this.sessions.set(message.tenantId, message);
      const value = observedSession(
        message as SessionDesired,
        this.helloReply.connectionEpoch,
        this.incarnation,
        message as SessionDesired,
      );
      if (message.commit) {
        const ids = [...this.objects.values()]
          .filter((object) => object.tenantId === message.tenantId)
          .map((object) => object.id);
        if (ids.length)
          Object.assign(value, {
            checkpoint: { manifestId: ids[ids.length - 1], objects: ids, buildId: 'dev' },
            data: {
              state: 'clean',
              base: ids[ids.length - 1],
              stoppedCleanly: true,
              changesAt: 0,
              committed: { requestId: message.commit, manifestId: ids[ids.length - 1] },
            },
          });
      }
      value.library.descriptions = await Promise.all(
        message.library.describe.map(async (assetId: string) => ({
          assetId,
          asset: await this.handler({ method: 'fixture.describe', tenantId: message.tenantId, assetId }),
        })),
      );
      await this.desiredHandler?.(message as SessionDesired, value);
      value.nodeRevision = this.nodeRevision;
      value.seq = String(++this.sequence);
      this.observations.set(message.tenantId, value);
      this.send(value);
      this.publishMetrics();
      return { accepted: true, revision: message.revision };
    }
    if (message.method === 'session.events.ack') return { accepted: true, upTo: message.upTo };
    if (
      message.endpointIncarnation !== this.incarnation ||
      !message.params ||
      typeof message.replay !== 'boolean'
    )
      throw { code: 'invalid_request', message: 'Invalid RPC envelope' };
    return this.results.execute(message, () =>
      this.handler({ ...message.params, id: message.id, method: message.method, tenantId: message.tenantId }),
    );
  }
  handler: (message: Record<string, any>) => unknown = (message) => this.handle(message);
  async connect(
    url: string,
    key: Buffer,
    hello: Record<string, unknown> = {},
    privateKey = nodePrivateKey(String(hello.nodeId ?? 'alpha')),
  ) {
    if (typeof hello.incarnation === 'string') this.incarnation = hello.incarnation;
    this.socket = new WebSocket(url);
    this.socket.on('error', () => {});
    await once(this.socket, 'open');
    const handshake = new NoiseHandshake('initiator', privateKey, publicKey(key));
    const queued: [Buffer, boolean][] = [];
    let receivedHello = false;
    const collect = (data: unknown, binary: boolean) => {
      if (receivedHello) queued.push([Buffer.from(data as Buffer), binary]);
      else receivedHello = true;
    };
    this.socket.on('message', collect);
    const deadline = setTimeout(() => this.socket.terminate(), 5000);
    try {
      const reply = new Promise<Buffer>((resolve, reject) => {
        this.socket.once('message', (bytes) => resolve(Buffer.from(bytes as Buffer)));
        this.socket.once('close', () => reject(new Error('Handshake closed')));
      });
      this.socket.send(
        handshake.writeMessage(
          Buffer.from(
            JSON.stringify({
              type: 'node.hello',
              role: 'endpoint',
              nodeId: 'alpha',
              buildId: 'dev',
              incarnation: this.incarnation,
              ...hello,
            }),
          ),
        ),
      );
      this.helloReply = jsonObject(handshake.readMessage(await reply));
      this.transport = handshake.split();
      this.socket.off('message', collect);
      const receive = (data: Buffer, binary: boolean) => {
        try {
          if (!binary) throw new Error('Text frame');
          const frame = decodeFrame(this.transport.receive.decrypt(Buffer.from(data as Buffer)));
          this.emit('frame', frame);
          if (frame.kind === 'binary') {
            if (typeof frame.header.putId !== 'string') return;
            const put = this.puts.get(frame.header.putId);
            if (!put || frame.header.offset !== put.size || frame.bytes.length > 1024 * 1024)
              throw Error('Invalid put chunk');
            put.chunks.push(frame.bytes);
            put.size += frame.bytes.length;
            return;
          }
          if (!frame.message.id) return;
          const message = frame.message;
          if (typeof message.ok === 'boolean') {
            const pending = this.pending.get(message.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(message.id);
              if (message.ok) pending.resolve(message.result);
              else pending.reject(message.error);
            }
            return;
          }
          this.requests.push(message);
          this.emit('request', message);
          void this.dispatch(message).then(
            (result) => {
              if (result !== undefined) this.send({ id: message.id, opId: message.opId, ok: true, result });
            },
            (error) => this.send({ id: message.id, opId: message.opId, ok: false, error }),
          );
        } catch {
          this.socket.terminate();
        }
      };
      this.socket.on('message', receive);
      for (const [data, binary] of queued) receive(data, binary);
      this.socket.once('close', () => {
        this.puts.clear();
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new RemoteKitError('outcome_unknown', 'Node disconnected'));
        }
        this.pending.clear();
      });
      if (this.helloReply.type === 'node.ready') {
        this.publishMetrics();
        await this.barrier();
      }
      return this.helloReply;
    } finally {
      clearTimeout(deadline);
    }
  }
  async barrier() {
    const pong = new Promise<void>((resolve) => {
      const listener = (frame: any) => {
        if (frame.message?.type === 'node.pong') {
          this.off('frame', listener);
          resolve();
        }
      };
      this.on('frame', listener);
    });
    this.send({ type: 'node.ping' });
    await pong;
  }
  observe(tenant: string, patch: Partial<ReturnType<typeof observedSession>>) {
    const value = this.observations.get(tenant)!;
    Object.assign(value, patch, { seq: String(++this.sequence) });
    this.send(value);
  }
  event(tenant: string, seq: string, type: string, body: object) {
    const target = this.sessions.get(tenant)!;
    this.send({
      event: 'session.event',
      connectionEpoch: this.helloReply.connectionEpoch,
      endpointIncarnation: this.incarnation,
      tenantId: tenant,
      sessionId: target.sessionId,
      placementEpoch: target.placementEpoch,
      streamId: 'fixture-stream',
      seq,
      eventId: 'event-' + seq,
      browserIncarnation: 'browser-1',
      type,
      body,
    });
  }
  publishMetrics() {
    this.metrics.sessions = [...this.sessions.values()].filter((value) => value.run === 'running').length;
    this.send({ event: 'node.metrics', ...this.metrics });
  }
  request(request: string, tenantId: string, args: object = {}): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Fake node request timeout'));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({
        id,
        request,
        tenantId,
        sessionId: null,
        placementEpoch: null,
        endpointIncarnation: this.incarnation,
        opId: id,
        replay: false,
        params: args,
      });
    });
  }
  send(message: object) {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(this.transport.send.encrypt(encodeJson(message)));
  }
  close() {
    this.socket?.terminate();
  }
}

export function fakeMetrics(overrides: Partial<NodeMetrics> = {}): NodeMetrics {
  return {
    cpu: 0.1,
    memory: { total: 32 * 1024 ** 3, available: 30 * 1024 ** 3 },
    gpus: [],
    disk: { total: 100 * 1024 ** 3, free: 90 * 1024 ** 3 },
    sessions: 0,
    objectBytes: 0,
    ...overrides,
  };
}
