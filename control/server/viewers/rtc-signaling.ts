import { randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';

import type { DomainContext, DomainServices } from '../application';
import type { RtcSignal } from '../endpoint/types';

export class RtcSignaling {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'pageRequests' | 'policy' | 'reconciler' | 'security' | 'viewers'
    >,
  ) {}
  receiveSignal(event: RtcSignal) {
    const binding = this.context.tenants.forConnection(event.connectionId)?.rtc.signal;
    if (
      !binding ||
      binding.tenant !== event.tenantId ||
      this.context.tenants.get(event.tenantId).connectionId !== event.connectionId
    )
      return;
    try {
      this.services.viewers.assertViewer(binding.tenant, binding.lease);
    } catch {
      this.clearSignal(event.connectionId);
      return;
    }
    if (event.signal.type === 'answer') {
      binding.answered = true;
      clearTimeout(binding.timer);
      binding.resolve(event.signal.sdp);
    } else if (event.signal.type === 'error' && !binding.answered)
      binding.reject(new RemoteKitError('rejected', event.signal.message));
    else
      this.context.events.emit('rtc.signal', event.tenantId, binding.lease, {
        type: 'rtc.signal',
        connectionId: event.connectionId,
        attemptId: binding.attemptId,
        signal: event.signal,
      });
  }
  clearSignal(connectionId: string) {
    this.context.tenants.forConnection(connectionId)?.clearSignal();
  }
  clearSignals() {
    for (const id of this.context.tenants
      .values()
      .flatMap((runtime) => (runtime.connectionId ? [runtime.connectionId] : [])))
      this.clearSignal(id);
  }
  async checkReconnectedRtc(tenant: string) {
    const snapshot = await this.context.endpoint.snapshot(tenant);
    const runtime = this.context.tenants.get(tenant);
    const connectionId = runtime.connectionId ?? runtime.rtc.disconnectedPeer?.connectionId;
    if (connectionId && (snapshot?.rtc?.active !== true || snapshot.rtc.connectionId !== connectionId)) {
      this.clearSignal(connectionId);
      this.context.tenants.get(tenant).closeRtc();
      const security = this.context.tenants.get(tenant).viewer?.security;
      if (security) this.services.security.forgetPeer(tenant, security);
      this.context.tenants.get(tenant).mediaGeneration = this.context.tenants.mediaGeneration(tenant) + 1;
      const lease = this.context.tenants.get(tenant).viewer?.id;
      if (security && lease)
        this.context.events.emit('auth', tenant, lease, this.services.viewers.authState(tenant, security));
      this.services.viewers.push(tenant);
      // A mismatching peer is not authorized by the surviving Viewer lease.
      if (snapshot?.rtc?.active === true && typeof snapshot.rtc.connectionId === 'string')
        await this.context.endpoint.closeRtc(tenant, { connectionId: snapshot.rtc.connectionId });
    }
    const disconnected = runtime.rtc.disconnectedPeer;
    if (
      disconnected &&
      snapshot.rtc?.active &&
      snapshot.rtc.connectionId === disconnected.connectionId &&
      runtime.viewer?.id === disconnected.leaseId
    )
      runtime.activateRtc(disconnected.connectionId, disconnected.leaseId);
    runtime.rtc.disconnectedPeer = undefined;
    const security = this.context.tenants.get(tenant).viewer?.security;
    if (security) await this.services.security.restore(tenant, security);
    this.context.tenants.get(tenant).pendingRtcCheck = false;
  }
  async offer(tenant: string, body: any, lease: string) {
    const runtime = this.context.tenants.get(tenant);
    if (
      body.type !== 'offer' ||
      typeof body.sdp !== 'string' ||
      body.sdp.length > 900000 ||
      !body.sdp.startsWith('v=0')
    )
      throw new RemoteKitError('invalid_request', '无效的 SDP offer');
    const receivedAt = this.context.clock.monotonicMs();
    return this.context.tenants.serial(tenant, async () => {
      const timings: Record<string, number> = { queueMs: this.context.clock.monotonicMs() - receivedAt };
      this.services.viewers.assertViewer(tenant, lease);
      this.services.policy.qualityState(tenant).resetFeedback();
      await this.services.reconciler.reconcileProduct(tenant);
      timings.reconcileEndMs = this.context.clock.monotonicMs() - receivedAt;
      const security = runtime.viewer!.security;
      const previous = runtime.connectionId;
      if (previous) {
        this.clearSignal(previous);
        try {
          await this.context.endpoint.closeRtc(tenant, { connectionId: previous });
        } finally {
          runtime.closeRtc();
        }
      }
      this.services.security.forgetPeer(tenant, security);
      const connectionId = randomUUID();
      try {
        if (typeof body.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.attemptId))
          throw new RemoteKitError('invalid_request', '无效媒体连接尝试');
        runtime.beginRtc(connectionId, body.attemptId, lease);
        let resolve!: (sdp: string) => void, reject!: (error: Error) => void;
        const pending = new Promise<string>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        // Observe rejection immediately, including cancellation while the acceptance RPC is pending.
        void pending.catch(() => {});
        const timer = setTimeout(
          () => reject(new RemoteKitError('outcome_unknown', 'RTC answer 等待超时')),
          15000,
        );
        runtime.rtc.signal = {
          tenant,
          lease: lease,
          attemptId: body.attemptId,
          resolve,
          reject,
          timer,
          answered: false,
        };
        const accepted = await this.context.endpoint.offer(tenant, {
          connectionId,
          sdp: body.sdp,
          avSync: this.context.store.workspaces.workspace(tenant).settings.avSync,
        });
        timings.endpointAcceptedMs = this.context.clock.monotonicMs() - receivedAt;
        if (
          accepted?.accepted !== true ||
          accepted.connectionId !== connectionId ||
          typeof accepted.avSync !== 'boolean'
        )
          throw new RemoteKitError('rejected', 'Endpoint未接受媒体协商');
        const answer = { sdp: await pending };
        timings.answerReadyMs = this.context.clock.monotonicMs() - receivedAt;
        this.services.viewers.assertViewer(tenant, lease);

        if (typeof answer?.sdp !== 'string' || !answer.sdp.startsWith('v=0'))
          throw new RemoteKitError('rejected', 'Endpoint 未返回有效 answer');
        runtime.beginRtc(connectionId, body.attemptId, lease);
        await this.services.security.bind(tenant, security, connectionId);
        this.services.viewers.assertViewer(tenant, lease);
        runtime.activateRtc(connectionId, lease);
        this.services.pageRequests.clearAuthorization(tenant);
        this.services.pageRequests.authorizeFiles(tenant);
        return {
          type: 'answer',
          avSync: accepted.avSync,
          sdp: answer.sdp,
          connectionId,
          endpointGeneration: this.context.tenants.mediaGeneration(tenant),
          negotiationTiming: timings,
          signalingMode: 'trickle',
        };
      } catch (error) {
        this.services.security.forgetPeer(tenant, security);
        this.clearSignal(connectionId);
        if (runtime.connectionId === connectionId) runtime.closeRtc();
        await this.context.endpoint.closeRtc(tenant, { connectionId }).catch(() => {});
        throw error;
      }
    });
  }
  async ice(tenant: string, body: any) {
    if (!body.connectionId || this.context.tenants.get(tenant).connectionId !== body.connectionId)
      throw new RemoteKitError('forbidden', '连接不属于当前会话');
    const binding = this.context.tenants.forConnection(body.connectionId)?.rtc.signal;
    if (binding && body.attemptId !== binding.attemptId)
      throw new RemoteKitError('forbidden', '媒体连接尝试已失效');
    if (
      !body.candidate ||
      typeof body.candidate.candidate !== 'string' ||
      body.candidate.candidate.length > 16384 ||
      typeof body.candidate.sdpMid !== 'string' ||
      !Number.isInteger(body.candidate.sdpMLineIndex)
    )
      throw new RemoteKitError('invalid_request', '无效 ICE candidate');
    return this.context.endpoint.ice(tenant, {
      connectionId: body.connectionId,
      candidate: body.candidate,
    });
  }
  async closeRtc(tenant: string, body: any, lease: string) {
    const runtime = this.context.tenants.get(tenant);
    this.services.viewers.assertViewer(tenant, lease);
    const owned = runtime.connectionId === body.connectionId;
    if (owned) this.clearSignal(body.connectionId);
    return this.context.tenants.serial(tenant, async () => {
      this.services.viewers.assertViewer(tenant, lease);
      if (runtime.connectionId !== body.connectionId) {
        if (owned) return { closed: true };
        throw new RemoteKitError('forbidden', '连接不属于当前会话');
      }
      this.clearSignal(body.connectionId);
      const security = runtime.viewer?.security;
      if (security) {
        this.services.security.forgetPeer(tenant, security);
        this.context.events.emit('auth', tenant, lease, this.services.viewers.authState(tenant, security));
        void this.services.security.capabilities(tenant, security);
      }
      try {
        await this.context.endpoint.closeRtc(tenant, { connectionId: body.connectionId });
      } finally {
        runtime.closeRtc();
      }
      return { closed: true };
    });
  }
  async closeMedia(tenant: string) {
    const runtime = this.context.tenants.get(tenant);
    const previous = runtime.connectionId;
    if (!previous) return;
    this.clearSignal(previous);
    try {
      await this.context.endpoint.closeRtc(tenant, { connectionId: previous });
    } catch {
    } finally {
      runtime.closeRtc();
    }
  }
  endpointOffline() {
    for (const runtime of this.context.tenants.values()) runtime.disconnectRtc();
    for (const [tenant, viewer] of this.context.tenants.withViewers())
      if (viewer.security) {
        viewer.security.face = { available: false };
        void this.services.security.lock(tenant, viewer.security, false, false);
      }
  }
}
