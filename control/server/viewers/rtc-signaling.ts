import { RetryUnit } from '../../shared/retry-unit';
import { OfferResults } from './offer-results';
import type { SocketMethods } from '../../shared/product';
import { requireBrowser } from '../workspace/browser-availability';
import { KeyedSerialQueue } from '../util/serial-queue';
import { log, reportError } from '../log';
import { endpointError } from '../endpoint/gateway';
import { wireError } from '../../shared/errors';
import { randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';

import type { DomainContext, DomainServices } from '../application';
import type { RtcSignal } from '../endpoint/types';

export class RtcSignaling {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    const release = () => this.pending.delete(work);
    void work.then(release, release);
    return work;
  }
  async close() {
    this.closed = true;
    this.clearSignals();
    await this.queue.drain();
    await Promise.allSettled(this.pending);
    await Promise.all(this.context.tenants.values().map((runtime) => this.releaseMedia(runtime.tenantId)));
    for (const unit of [...this.reconnectRetries.values(), ...this.retirementRetries.values()]) unit.close();
  }
  private readonly reconnectRetries = new Map<string, RetryUnit>();
  private readonly retirementRetries = new Map<string, RetryUnit>();

  private readonly offers = new OfferResults<SocketMethods['rtc.offer']['result']>();
  offerStatus(tenant: string, attemptId: string, lease: string) {
    this.services.viewers.assertViewer(tenant, lease);
    return this.offers.status(tenant, lease, attemptId);
  }

  private readonly queue = new KeyedSerialQueue();
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'pageRequests' | 'policy' | 'reconciler' | 'security' | 'viewers'
    >,
  ) {}
  receiveSignal(event: RtcSignal) {
    if (this.closed) return;
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
      binding.reject(endpointError(event.signal.error));
    else
      this.context.events.emit('rtc.signal', event.tenantId, binding.lease, {
        type: 'rtc.signal',
        connectionId: event.connectionId,
        attemptId: binding.attemptId,
        signal:
          event.signal.type === 'error'
            ? {
                type: 'error',
                error: wireError(
                  reportError(endpointError(event.signal.error), 'rtc.signal_failed', {
                    tenant: event.tenantId,
                    operation: event.connectionId,
                  }),
                ),
              }
            : event.signal,
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
  checkReconnectedRtc(tenant: string) {
    if (this.closed) return Promise.resolve();
    return this.track(this.checkReconnection(tenant));
  }
  private async checkReconnection(tenant: string) {
    let unit = this.reconnectRetries.get(tenant);
    if (!unit) {
      unit = new RetryUnit({
        failed: (error) =>
          log.warn('rtc.reconnect_failed', { tenant, code: error.code, errorId: error.errorId, err: error }),
        recovered: () => log.info('rtc.reconnect_recovered', { tenant }),
      });
      this.reconnectRetries.set(tenant, unit);
    }
    const input = JSON.stringify([
      this.context.endpoint.placement.peek(tenant),
      this.context.endpoint.observation(tenant)?.connectionEpoch,
      this.context.tenants.get(tenant).viewer?.id,
    ]);
    const previous = unit.error;
    if (!unit.ready(input)) return;
    try {
      await this.reconcileRtc(tenant);
      unit.succeed();
      const runtime = this.context.tenants.get(tenant);
      if (previous && runtime.lastError === previous) runtime.clearError();
    } catch (cause) {
      const failure = unit.fail(endpointError(cause));
      this.context.tenants.get(tenant).lastError = failure.error;
      throw cause;
    }
  }
  private async reconcileRtc(tenant: string) {
    const snapshot = await this.context.endpoint.snapshot(tenant);
    const runtime = this.context.tenants.get(tenant);
    const retiring = runtime.rtc.disconnectedPeer;
    if (retiring?.retiring) {
      await this.retirePeer(tenant, retiring.connectionId);
    }
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
  offer(tenant: string, body: any, lease: string) {
    if (this.closed) return Promise.reject(new RemoteKitError('canceled', 'RTC signaling closed'));
    return this.offers.execute(tenant, lease, body, () => this.applyOffer(tenant, body, lease));
  }
  private async applyOffer(tenant: string, body: any, lease: string) {
    const runtime = this.context.tenants.get(tenant);
    if (body.type !== 'offer' || typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0'))
      throw new RemoteKitError('invalid_request', '无效的 SDP offer');
    if (body.sdp.length > 900000) throw new RemoteKitError('limit_exceeded', 'SDP 超出大小限制');
    const receivedAt = this.context.clock.monotonicMs();
    return this.queue.run(tenant, async () => {
      const timings: Record<string, number> = { queueMs: this.context.clock.monotonicMs() - receivedAt };
      this.services.viewers.assertViewer(tenant, lease);
      this.services.policy.qualityState(tenant).resetFeedback();
      requireBrowser(this.context, tenant, true);
      await this.context.endpoint.published(tenant);
      timings.reconcileEndMs = this.context.clock.monotonicMs() - receivedAt;
      this.services.viewers.assertViewer(tenant, lease);
      const security = runtime.viewer!.security;
      const previous = runtime.connectionId ?? runtime.rtc.disconnectedPeer?.connectionId;
      if (previous) {
        try {
          await this.retirePeer(tenant, previous);
        } catch (cause) {
          throw new RemoteKitError('unavailable', '正在关闭先前的媒体连接', { cause });
        }
      }
      this.services.viewers.assertViewer(tenant, lease);
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
        void pending.catch((error) => {
          runtime.lastError = endpointError(error);
        });
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
          leaseId: lease,
          sdp: body.sdp,
          avSync: this.context.store.workspaces.workspace(tenant).settings.workspace.avSync,
        });
        timings.endpointAcceptedMs = this.context.clock.monotonicMs() - receivedAt;
        if (
          accepted?.accepted !== true ||
          accepted.connectionId !== connectionId ||
          typeof accepted.avSync !== 'boolean'
        )
          throw new RemoteKitError('outcome_unknown', '媒体协商结果未知');
        const answer = { sdp: await pending };
        timings.answerReadyMs = this.context.clock.monotonicMs() - receivedAt;
        this.services.viewers.assertViewer(tenant, lease);

        if (typeof answer?.sdp !== 'string' || !answer.sdp.startsWith('v=0'))
          throw new RemoteKitError('outcome_unknown', '媒体协商回复无效');
        runtime.beginRtc(connectionId, body.attemptId, lease);
        await this.services.security.bind(tenant, security, connectionId);
        this.services.viewers.assertViewer(tenant, lease);
        runtime.activateRtc(connectionId, lease);
        this.context.endpoint.invalidate(tenant);
        return {
          type: 'answer' as const,
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
        await this.context.endpoint.closeRtc(tenant, { connectionId }).then(
          () => this.offers.retire(tenant, lease, body.attemptId),
          () => {
            runtime.rtc.disconnectedPeer = {
              connectionId,
              leaseId: lease,
              attemptId: body.attemptId,
              retiring: true,
            };
            runtime.pendingRtcCheck = true;
          },
        );
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
    const owned =
      runtime.connectionId === body.connectionId ||
      runtime.rtc.disconnectedPeer?.connectionId === body.connectionId;
    if (owned) this.clearSignal(body.connectionId);
    return this.queue.run(tenant, async () => {
      this.services.viewers.assertViewer(tenant, lease);
      if (
        runtime.connectionId !== body.connectionId &&
        runtime.rtc.disconnectedPeer?.connectionId !== body.connectionId
      ) {
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
      await this.retirePeer(tenant, body.connectionId);
      return { closed: true };
    });
  }
  async closeMedia(tenant: string) {
    if (this.closed) return;
    return this.track(this.releaseMedia(tenant));
  }
  private async releaseMedia(tenant: string) {
    const runtime = this.context.tenants.get(tenant);
    const previous = runtime.connectionId ?? runtime.rtc.disconnectedPeer?.connectionId;
    if (!previous) return;
    try {
      await this.retirePeer(tenant, previous);
    } catch (err) {
      runtime.lastError = endpointError(err);
    }
  }
  private async retirePeer(tenant: string, connectionId: string) {
    const runtime = this.context.tenants.get(tenant);
    const current = runtime.rtc.connection;
    const retained =
      current.phase !== 'idle' && current.connectionId === connectionId
        ? { connectionId, leaseId: current.leaseId, attemptId: current.attemptId, retiring: true }
        : runtime.rtc.disconnectedPeer;
    if (retained) runtime.rtc.disconnectedPeer = { ...retained, retiring: true };
    this.clearSignal(connectionId);
    if (runtime.connectionId === connectionId) runtime.closeRtc();
    runtime.pendingRtcCheck = true;
    let unit = this.retirementRetries.get(connectionId);
    if (!unit) {
      unit = new RetryUnit({
        failed: (error) =>
          log.warn('rtc.close_failed', {
            tenant,
            connectionId,
            code: error.code,
            errorId: error.errorId,
            err: error,
          }),
        recovered: () => log.info('rtc.close_recovered', { tenant, connectionId }),
      });
      this.retirementRetries.set(connectionId, unit);
    }
    const input = JSON.stringify([
      this.context.endpoint.placement.peek(tenant),
      this.context.endpoint.observation(tenant)?.connectionEpoch,
      this.context.store.buildId,
    ]);
    const previous = unit.error;
    if (!unit.ready(input)) throw unit.error;
    try {
      await this.context.endpoint.closeRtc(tenant, { connectionId });
      unit.succeed();
      if (previous && runtime.lastError === previous) runtime.clearError();
      this.retirementRetries.delete(connectionId);
    } catch (cause) {
      runtime.lastError = unit.fail(endpointError(cause)).error;
      throw runtime.lastError;
    }
    if (retained?.attemptId) this.offers.retire(tenant, retained.leaseId, retained.attemptId);
    if (runtime.rtc.disconnectedPeer?.connectionId === connectionId) runtime.rtc.disconnectedPeer = undefined;
  }
  endpointOffline(nodeId?: string) {
    if (this.closed) return;
    for (const runtime of this.context.tenants.values())
      if (!nodeId || this.context.endpoint.isPlacedOn(runtime.tenantId, nodeId)) runtime.disconnectRtc();
    for (const [tenant, viewer] of this.context.tenants.withViewers())
      if (viewer.security && (!nodeId || this.context.endpoint.isPlacedOn(tenant, nodeId))) {
        this.services.security.forgetPeer(tenant, viewer.security);
        this.context.events.emit(
          'auth',
          tenant,
          viewer.id,
          this.services.viewers.authState(tenant, viewer.security),
        );
        this.services.viewers.push(tenant);
      }
  }
}
