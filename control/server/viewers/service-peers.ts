import { randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { DomainContext, DomainServices } from '../application';
import type { NodeLink } from '../cluster/node-link';
import type { FaceBinding, FaceStatusReply, RtcSignal } from '../endpoint/types';
import { KeyedSerialQueue } from '../util/serial-queue';

interface ServiceConnection {
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
  private readonly connections = new Map<string, ServiceConnection>();
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
      this.connections.get(connection.tenant) === connection &&
      connection.node.state.state === 'ready' &&
      !this.context.endpoint.nodes.isRemoved(connection.node.nodeId) &&
      connection.node.state.connectionEpoch === connection.nodeEpoch &&
      this.context.tenants.get(connection.tenant).viewer?.id === connection.lease
    );
  }

  private changed(connection: ServiceConnection) {
    const viewer = this.context.tenants.get(connection.tenant).viewer;
    if (!viewer || viewer.id !== connection.lease) return;
    this.context.events.emit(
      'auth',
      connection.tenant,
      connection.lease,
      this.services.viewers.authState(connection.tenant, viewer.security),
    );
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
    this.services.viewers.assertViewer(tenant, lease);
    if (
      params.type !== 'offer' ||
      typeof params.sdp !== 'string' ||
      !params.sdp.startsWith('v=0') ||
      params.sdp.length > 900000 ||
      /(?:^|\r?\n)m=(?:audio|video) /.test(params.sdp) ||
      typeof params.attemptId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(params.attemptId)
    )
      throw new RemoteKitError('invalid_request', '无效文件服务协商');
    return this.queue.run(tenant, async () => {
      this.services.viewers.assertViewer(tenant, lease);
      await this.close(tenant);
      const node = this.chooseNode(tenant);
      if (!node) throw new RemoteKitError('unavailable', '没有可用节点提供文件和人脸服务');
      if (node.state.state !== 'ready') throw new RemoteKitError('unavailable', '文件服务节点离线');
      const viewer = this.context.tenants.get(tenant).viewer!;
      const connectionId = randomUUID();
      const connection: ServiceConnection = {
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
      void answer.catch(() => {});
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
    connection.lockEpoch = viewer.security.epoch;
    const epoch = ++connection.peer.epoch;
    connection.peer.appliedEpoch = 0;
    await connection.node.request('service.authorize', connection.tenant, {
      connectionId: connection.connectionId,
      leaseId: connection.lease,
      epoch,
      unlocked: !viewer.security.locked,
    });
    if (this.current(connection) && connection.peer.epoch === epoch) {
      connection.peer.appliedEpoch = epoch;
      this.changed(connection);
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
    this.connections.delete(tenant);
    clearTimeout(connection.answer?.timer);
    connection.answer?.reject(new RemoteKitError('unavailable', '文件服务已中断'));
    const viewer = this.context.tenants.get(tenant).viewer;
    if (viewer?.security.servicePeer === connection.peer) {
      this.services.security.forgetServicePeer(tenant, viewer.security);
      this.changed(connection);
    }
    await connection.node
      .request('service.close', tenant, { connectionId: connection.connectionId, leaseId: connection.lease })
      .catch(() => {});
    return { closed: true };
  }

  async tick() {
    for (const [tenant, connection] of this.connections) {
      const placement = this.context.endpoint.placement.peek(tenant);
      const preferred = placement?.runState === 'running' ? this.chooseNode(tenant) : undefined;
      if (!this.current(connection) || (preferred && preferred.nodeId !== connection.node.nodeId)) {
        this.context.events.emit('rtc.signal', tenant, connection.lease, {
          type: 'rtc.signal',
          connectionId: connection.connectionId,
          attemptId: connection.attemptId,
          signal: { type: 'error', error: { code: 'unavailable', message: '文件服务节点离线' } },
        });
        await this.close(tenant);
      } else await this.authorize(tenant).catch(() => {});
    }
  }
  private face(tenant: string, method: string, params: object = {}) {
    const connection = this.require(tenant, (params as { connectionId?: string }).connectionId);
    return connection.node.request(method, tenant, {
      ...params,
      connectionId: connection.connectionId,
      leaseId: connection.lease,
    });
  }
  describeAsset(
    tenant: string,
    params: { assetId: string },
  ): Promise<import('../../shared/file-library').Asset> {
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
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    await Promise.all([...this.connections.keys()].map((tenant) => this.close(tenant)));
    await this.queue.drain();
  }
}
