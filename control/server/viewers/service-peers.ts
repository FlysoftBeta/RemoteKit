import { OfferResults } from './offer-results';
import type { SocketMethods } from '../../shared/product';
import { randomUUID } from 'node:crypto';
import limits from '../../../protocol/limits.json';
import { RemoteKitError, endpointError, wireError, type WireError } from '../../shared/errors';
import { RetryUnit } from '../../shared/retry-unit';
import { rpcId } from '../endpoint/rpc-results';
import { log } from '../log';
import type { DomainContext, DomainServices } from '../application';
import type { NodeLink } from '../cluster/node-link';
import type { FaceBinding, FaceStatusReply, RtcSignal } from '../endpoint/types';
import { KeyedSerialQueue } from '../util/serial-queue';

interface ServiceConnection {
  failure?: WireError;
  notification?: string;
  phase: 'active' | 'retiring';
  authorization: RetryUnit;
  retirement: RetryUnit;
  node: NodeLink;
  nodeEpoch: string;
  tenant: string;
  lease: string;
  connectionId: string;
  attemptId: string;
  lockEpoch: number;
  peer: { connectionId: string; epoch: number; appliedEpoch: number; requests: number };
  answer?: { resolve(sdp: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
}

export class ServicePeers {
  private closed = false;
  private readonly offers = new OfferResults<SocketMethods['service.offer']['result']>();
  offerStatus(tenant: string, attemptId: string, lease: string) {
    this.services.viewers.assertViewer(tenant, lease);
    return this.offers.status(tenant, lease, attemptId);
  }

  private readonly connections = new Map<string, ServiceConnection>();
  private readonly retirements = new Map<ServiceConnection, Promise<{ closed: boolean }>>();
  private readonly queue = new KeyedSerialQueue();
  private readonly subscriptions: (() => void)[];
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<DomainServices, 'viewers' | 'security'>,
  ) {
    this.subscriptions = context.endpoint.nodes
      .all()
      .map((node) => node.onSignal((event) => this.signal(node, event)));
  }

  chooseNode(tenant: string) {
    const nodes = this.context.endpoint.nodes;
    const placement = this.context.endpoint.placement.peek(tenant);
    const ready = nodes.all().filter((node) => node.state.state === 'ready' && !nodes.isRemoved(node.nodeId));
    return (
      (placement?.runState === 'running' && ready.find((node) => node.nodeId === placement.nodeId)) ||
      ready.sort(
        (a, b) =>
          (a.metrics.predicted(Date.now()) ?? 0) - (b.metrics.predicted(Date.now()) ?? 0) ||
          a.nodeId.localeCompare(b.nodeId),
      )[0]
    );
  }

  hasGrant(tenant: string, nodeId: string) {
    const connection = this.connections.get(tenant);
    const viewer = this.context.tenants.get(tenant).viewer;
    return (
      !!connection &&
      connection.node.nodeId === nodeId &&
      this.current(connection) &&
      viewer?.security.locked === false &&
      connection.lockEpoch === viewer.security.epoch &&
      connection.peer.appliedEpoch === connection.peer.epoch
    );
  }

  private current(connection: ServiceConnection) {
    return (
      !this.closed &&
      connection.phase === 'active' &&
      this.connections.get(connection.tenant) === connection &&
      connection.node.state.state === 'ready' &&
      !this.context.endpoint.nodes.isRemoved(connection.node.nodeId) &&
      connection.node.state.connectionEpoch === connection.nodeEpoch &&
      this.context.tenants.get(connection.tenant).viewer?.id === connection.lease
    );
  }

  private changed(connection: ServiceConnection) {
    if (this.closed || this.context.closed) return;
    const viewer = this.context.tenants.get(connection.tenant).viewer;
    if (!viewer || viewer.id !== connection.lease) return;
    this.context.events.emit(
      'auth',
      connection.tenant,
      connection.lease,
      this.services.viewers.authState(connection.tenant, viewer.security),
    );
  }
  private clearFailure(connection: ServiceConnection) {
    const viewer = this.context.tenants.get(connection.tenant).viewer;
    if (viewer?.id === connection.lease && viewer.security.face.error === connection.failure)
      delete viewer.security.face.error;
    delete connection.failure;
  }
  private setFailure(connection: ServiceConnection, cause: unknown) {
    const viewer = this.context.tenants.get(connection.tenant).viewer;
    if (viewer?.id !== connection.lease) return;
    const failure = wireError(endpointError(cause));
    if (JSON.stringify(connection.failure) === JSON.stringify(failure)) return;
    connection.failure = failure;
    viewer.security.face.error = failure;
    this.changed(connection);
  }

  private signal(node: NodeLink, event: RtcSignal) {
    const connection = this.connections.get(event.tenantId);
    if (
      !connection ||
      connection.node !== node ||
      connection.connectionId !== event.connectionId ||
      !this.current(connection)
    )
      return;
    if (event.signal.type === 'answer') {
      clearTimeout(connection.answer?.timer);
      connection.answer?.resolve(event.signal.sdp);
      connection.answer = undefined;
    } else
      this.context.events.emit('rtc.signal', event.tenantId, connection.lease, {
        type: 'rtc.signal',
        connectionId: connection.connectionId,
        attemptId: connection.attemptId,
        signal: event.signal,
      });
  }

  offer(tenant: string, params: { type: string; sdp: string; attemptId: string }, lease: string) {
    return this.offers.execute(tenant, lease, params, () => this.applyOffer(tenant, params, lease));
  }
  private applyOffer(
    tenant: string,
    params: { type: string; sdp: string; attemptId: string },
    lease: string,
  ) {
    this.services.viewers.assertViewer(tenant, lease);
    if (
      params.type !== 'offer' ||
      typeof params.sdp !== 'string' ||
      !params.sdp.startsWith('v=0') ||
      Buffer.byteLength(params.sdp) > limits.serviceOfferSdpBytes ||
      /(?:^|\r?\n)m=(?:audio|video) /.test(params.sdp) ||
      typeof params.attemptId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(params.attemptId)
    )
      throw new RemoteKitError('invalid_request', '无效文件服务协商');
    return this.queue.run(tenant, async () => {
      this.services.viewers.assertViewer(tenant, lease);
      await this.close(tenant);
      if (this.closed) throw new RemoteKitError('canceled', 'Service peers closed');
      const node = this.chooseNode(tenant);
      if (!node) throw new RemoteKitError('unavailable', '没有可用节点提供文件和人脸服务');
      if (node.state.state !== 'ready') throw new RemoteKitError('unavailable', '文件服务节点离线');
      const viewer = this.context.tenants.get(tenant).viewer!;
      const connectionId = randomUUID();
      const connection: ServiceConnection = {
        phase: 'active',
        authorization: new RetryUnit({
          failed: (error) => log.warn('service.authorize_failed', { tenant, err: error }),
          recovered: () => log.info('service.authorize_recovered', { tenant }),
        }),
        retirement: new RetryUnit({
          failed: (error) => log.warn('service.close_failed', { tenant, err: error }),
          recovered: () => log.info('service.close_recovered', { tenant }),
        }),
        node,
        nodeEpoch: node.state.connectionEpoch!,
        tenant,
        lease,
        connectionId,
        attemptId: params.attemptId,
        lockEpoch: viewer.security.epoch,
        peer: { connectionId, epoch: 1, appliedEpoch: 0, requests: 0 },
      };
      this.connections.set(tenant, connection);
      viewer.security.servicePeer = connection.peer;
      const answer = new Promise<string>((resolve, reject) => {
        connection.answer = {
          resolve,
          reject,
          timer: setTimeout(() => reject(new RemoteKitError('outcome_unknown', '文件服务协商超时')), 15000),
        };
      });
      void answer.catch((error) => log.warn('service.answer_failed', { tenant, err: error }));
      try {
        await node.request('service.offer', tenant, {
          ...params,
          connectionId,
          leaseId: lease,
          epoch: 1,
          unlocked: !viewer.security.locked,
        });
        const sdp = await answer;
        if (!this.current(connection)) throw new RemoteKitError('conflict', '文件服务连接已替换');
        connection.peer.appliedEpoch = 1;
        await this.authorizeConnection(connection);
        await this.services.security.capabilities(tenant, viewer.security);
        this.changed(connection);
        return { type: 'answer' as const, sdp, connectionId, epoch: connection.peer.appliedEpoch };
      } catch (error) {
        if (this.connections.get(tenant) === connection) await this.close(tenant);
        throw error;
      }
    });
  }

  async ice(tenant: string, params: { connectionId: string; candidate: unknown }, lease: string) {
    const connection = this.require(tenant, params.connectionId, lease);
    return connection.node.request('service.ice', tenant, { ...params, leaseId: lease });
  }

  private require(tenant: string, connectionId?: string, lease?: string) {
    const connection = this.connections.get(tenant);
    if (
      !connection ||
      !this.current(connection) ||
      (connectionId && connection.connectionId !== connectionId) ||
      (lease && connection.lease !== lease)
    )
      throw new RemoteKitError('unavailable', '文件和人脸服务正在连接');
    return connection;
  }

  authorize(tenant: string) {
    return this.queue.run(tenant, async () => {
      const connection = this.connections.get(tenant);
      if (connection && this.current(connection)) await this.authorizeConnection(connection);
    });
  }

  private async authorizeConnection(connection: ServiceConnection) {
    const viewer = this.context.tenants.get(connection.tenant).viewer!;
    if (connection.lockEpoch === viewer.security.epoch && connection.peer.appliedEpoch) return;
    const input = JSON.stringify([viewer.security.epoch, connection.node.state]);
    const changed = connection.authorization.record().input !== input;
    if (!connection.authorization.ready(input)) throw connection.authorization.error;
    if (changed) {
      connection.lockEpoch = viewer.security.epoch;
      connection.peer.epoch++;
      connection.peer.appliedEpoch = 0;
    }
    const epoch = connection.peer.epoch;
    try {
      await connection.node.request(
        'service.authorize',
        connection.tenant,
        {
          connectionId: connection.connectionId,
          leaseId: connection.lease,
          epoch,
          unlocked: !viewer.security.locked,
        },
        undefined,
        rpcId('service.authorize', connection.connectionId, epoch),
      );
      connection.authorization.succeed();
      this.clearFailure(connection);
      if (this.current(connection) && connection.peer.epoch === epoch) {
        connection.peer.appliedEpoch = epoch;
        this.changed(connection);
      }
    } catch (error) {
      connection.authorization.fail(endpointError(error));
      this.setFailure(connection, error);
      throw error;
    }
  }

  async close(tenant: string, connectionId?: string, lease?: string) {
    const connection = this.connections.get(tenant);
    if (
      !connection ||
      (connectionId && connectionId !== connection.connectionId) ||
      (lease && lease !== connection.lease)
    )
      return { closed: true };
    const current = this.retirements.get(connection);
    if (current) return current;
    const work = this.retireConnection(connection).finally(() => this.retirements.delete(connection));
    this.retirements.set(connection, work);
    return work;
  }
  private async retireConnection(connection: ServiceConnection) {
    const { tenant } = connection;
    connection.phase = 'retiring';
    clearTimeout(connection.answer?.timer);
    connection.answer?.reject(new RemoteKitError('unavailable', '文件服务已中断'));
    const viewer = this.context.tenants.get(tenant).viewer;
    if (viewer?.security.servicePeer === connection.peer) {
      this.services.security.forgetServicePeer(tenant, viewer.security);
      this.changed(connection);
    }
    const unit = connection.retirement;
    if (!unit.ready(JSON.stringify(connection.node.state))) throw unit.error;
    try {
      await connection.node.request(
        'service.close',
        tenant,
        { connectionId: connection.connectionId, leaseId: connection.lease },
        undefined,
        rpcId('service.close', connection.connectionId),
      );
      unit.succeed();
      this.clearFailure(connection);
      this.changed(connection);
      this.offers.retire(tenant, connection.lease, connection.attemptId);
      if (this.connections.get(tenant) === connection) this.connections.delete(tenant);
      connection.authorization.close();
    } catch (cause) {
      unit.fail(endpointError(cause));
      this.setFailure(connection, cause);
      throw cause;
    }
    return { closed: true };
  }

  async tick() {
    if (this.closed) return;
    for (const [tenant, connection] of this.connections) {
      // A connected service peer stays on its node (moving it would cut off transfers in flight); only
      // losing that node moves it.
      try {
        if (connection.phase === 'retiring' || !this.current(connection)) {
          const error = connection.retirement.error
            ? wireError(connection.retirement.error)
            : { code: 'unavailable' as const, message: '文件服务节点离线' };
          const notification = JSON.stringify([connection.node.state, error]);
          if (notification !== connection.notification) {
            connection.notification = notification;
            this.context.events.emit('rtc.signal', tenant, connection.lease, {
              type: 'rtc.signal',
              connectionId: connection.connectionId,
              attemptId: connection.attemptId,
              signal: { type: 'error', error },
            });
          }
          await this.close(tenant);
        } else await this.authorize(tenant);
      } catch (cause) {
        this.setFailure(connection, cause);
      }
    }
  }
  private face(tenant: string, method: string, params: object = {}) {
    const connection = this.require(tenant, (params as { connectionId?: string }).connectionId);
    return connection.node.request(
      method,
      tenant,
      {
        ...params,
        connectionId: connection.connectionId,
        leaseId: connection.lease,
      },
      undefined,
      ['service.face.begin', 'service.face.cancel'].includes(method)
        ? rpcId(method, connection.connectionId, params)
        : undefined,
    );
  }
  describeAsset(
    tenant: string,
    params: { assetId: string },
  ): Promise<import('../../shared/file-library').AssetDescription> {
    return this.face(tenant, 'service.asset.describe', params);
  }
  async faceCapabilities(tenant: string): Promise<{ available: boolean; modelVersion: string }> {
    return this.face(tenant, 'service.face.capabilities');
  }
  beginFace(
    tenant: string,
    params: FaceBinding & { purpose: string; timeoutMs: number; template?: number[] },
  ) {
    return this.face(tenant, 'service.face.begin', params);
  }
  async cancelFace(tenant: string, params: FaceBinding) {
    return this.face(tenant, 'service.face.cancel', params);
  }
  async faceStatus(tenant: string, params: FaceBinding): Promise<FaceStatusReply> {
    return this.face(tenant, 'service.face.status', params);
  }
  async dispose() {
    this.closed = true;
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    const results = await Promise.allSettled(
      [...this.connections.keys()].map((tenant) => this.close(tenant)),
    );
    await this.queue.drain();
    await Promise.allSettled(this.retirements.values());
    for (const connection of this.connections.values()) {
      connection.authorization.close();
      connection.retirement.close();
    }
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
