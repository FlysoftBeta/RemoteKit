import { randomUUID } from 'node:crypto';
import { RetryUnit } from '../../shared/retry-unit';
import {
  canonical,
  validateDesired,
  validateClipboard,
  type SessionClipboard,
  type SessionDesired,
  type SessionObserved,
  type EventsAck,
  type OneShotRequest,
} from './coordination';
import { rpcId } from './rpc-results';
import { log } from '../log';
import { RemoteKitError, isRemoteKitError, endpointError as convertEndpointError } from '../../shared/errors';
import type { SelectionState } from '../../shared/file-library';
import type {
  BrowserIdentity,
  ImportChunk,
  StorageImportJob,
  StorageImportStatus,
} from '../../shared/session-import';
import type { NodeRegistry } from '../cluster/node-link';
import type { Placement } from '../cluster/placement';
import type {
  Accepted,
  EndpointSnapshot,
  LifecycleRequest,
  LogWindow,
  LogWindowRequest,
  OperationIdentity,
  PageIdentity,
  PageReplyRequest,
  PrepareSelection,
  RtcSignal,
  ViewAppInfo,
} from './types';
export class EndpointSnapshotError extends RemoteKitError {
  constructor(
    error: RemoteKitError,
    readonly browserRestart: EndpointSnapshot['browserRestart'],
  ) {
    super(error.code, error.message, {
      detail: error.detail,
      reason: error.reason,
      capacity: error.capacity,
      retryAfterMs: error.retryAfterMs,
      errorId: error.errorId,
      cause: error,
    });
  }
}
export class EndpointGateway {
  private desiredSource?: (tenant: string) => SessionDesired;
  private clipboardSource?: (tenant: string) => SessionClipboard['value'] & { revision: string };
  private readonly sent = new Map<string, string>();
  private readonly clipboardSent = new Map<string, string>();
  private readonly stale = new Set<string>();
  private readonly publishing = new Map<string, Promise<SessionDesired | undefined>>();
  private readonly publicationRetries = new Map<string, RetryUnit>();
  private scheduled = false;
  private publicationRetry(tenant: string) {
    let unit = this.publicationRetries.get(tenant);
    if (!unit) {
      unit = new RetryUnit({
        failed: (error) =>
          log.warn('session.publication_failed', {
            tenant,
            code: error.code,
            errorId: error.errorId,
            err: error,
          }),
        recovered: () => log.info('session.publication_recovered', { tenant }),
      });
      this.publicationRetries.set(tenant, unit);
    }
    return unit;
  }
  constructor(
    readonly nodes: NodeRegistry,
    readonly placement: Pick<
      Placement,
      | 'peek'
      | 'resolve'
      | 'keys'
      | 'commitCheckpoint'
      | 'underPressure'
      | 'markWarm'
      | 'activeSessions'
      | 'evacuate'
      | 'activeTenants'
      | 'forgetTenant'
      | 'checkpoints'
      | 'beginStop'
      | 'cancelStop'
      | 'transfer'
      | 'newestComplete'
    >,
  ) {
    nodes.on('stopped', () => this.setDesiredSource());
    nodes.on(
      'publication.failed',
      ({ message, error }: { message: Partial<SessionDesired>; error: unknown }) => {
        if (
          this.desiredSource &&
          ['session.desired', 'session.clipboard'].includes(message.method ?? '') &&
          message.tenantId
        ) {
          this.sent.delete(message.tenantId);
          this.clipboardSent.delete(message.tenantId);
          this.publicationFailed(message.tenantId, error);
        }
      },
    );
    nodes.on('ready', ({ nodeId }: { nodeId: string }) => {
      for (const target of nodes.fencing(nodeId)) this.invalidate(target.tenantId);
    });
    nodes.on('session.observed', ({ nodeId, message }: { nodeId: string; message: SessionObserved }) => {
      const placed = placement.peek(message.tenantId);
      if (
        !placed ||
        placed.nodeId !== nodeId ||
        placed.sessionId !== message.sessionId ||
        placed.placementEpoch !== message.placementEpoch
      )
        return;
      const copy = message.data;
      if (
        message.checkpoint?.kind === 'running' &&
        copy?.state === 'dirty' &&
        message.browser === 'running' &&
        copy.lastVersion?.manifestId === message.checkpoint.manifestId &&
        copy.lastVersion.takenAt === message.checkpoint.takenAt
      ) {
        placement.commitCheckpoint(
          placed,
          message.checkpoint.manifestId,
          message.checkpoint.objects,
          message.checkpoint.buildId,
          message.checkpoint,
        );
      }
      if (
        message.checkpoint?.kind === 'stopped' &&
        placed.dataState === 'dirty' &&
        copy?.state === 'clean' &&
        copy.committed &&
        copy.base === copy.committed.manifestId &&
        (!placed.pendingCommit ||
          placed.pendingCommit === copy.committed.requestId ||
          copy.committed.requestId.startsWith('node-'))
      ) {
        placement.commitCheckpoint(
          placed,
          copy.base,
          message.checkpoint!.objects,
          message.checkpoint!.buildId,
          message.checkpoint!,
        );
      }
    });
  }
  faultSession(tenant: string, cause: unknown) {
    const placed = this.placement.peek(tenant);
    if (placed) this.nodes.get(placed.nodeId)?.faultSession({ ...placed, tenantId: tenant }, cause);
  }
  sessionFault(tenant: string) {
    const placed = this.placement.peek(tenant);
    return placed && this.nodes.get(placed.nodeId)?.faults.get({ ...placed, tenantId: tenant });
  }
  attachViewer(tenant: string) {
    const placed = this.placement.peek(tenant);
    if (placed && this.nodes.get(placed.nodeId)?.faults.attach({ ...placed, tenantId: tenant })) {
      this.forget(tenant);
      this.invalidate(tenant);
    }
  }
  setDesiredSource(
    source?: (tenant: string) => SessionDesired,
    clipboardSource?: (tenant: string) => SessionClipboard['value'] & { revision: string },
  ) {
    this.desiredSource = source;
    this.clipboardSource = clipboardSource;
    if (!source) {
      for (const unit of this.publicationRetries.values()) unit.close();
      this.publicationRetries.clear();
      this.stale.clear();
    }
  }
  async close() {
    this.setDesiredSource();
    await Promise.allSettled(this.publishing.values());
  }
  observation(tenant: string): SessionObserved | undefined {
    const placed = this.placement.peek(tenant);
    const node = placed && this.nodes.get(placed.nodeId);
    const value = node?.observations.get(tenant);
    return value &&
      node?.state.state === 'ready' &&
      value.sessionId === placed?.sessionId &&
      value?.placementEpoch === placed?.placementEpoch &&
      value.connectionEpoch === node.state.connectionEpoch
      ? value
      : undefined;
  }
  invalidate(tenant: string): void {
    if (!this.desiredSource) return;
    this.stale.add(tenant);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const tenant of this.stale) void this.publishTenant(tenant);
    });
  }
  private unavailable(tenant: string) {
    const fault = this.sessionFault(tenant);
    if (fault) return fault;
    const placed = this.placement.peek(tenant);
    return new RemoteKitError('unavailable', 'Session node is offline', {
      reason: placed?.dataState === 'dirty' ? 'session_data_on_offline_node' : 'no_eligible_node',
    });
  }
  private publishTenant(tenant: string): Promise<SessionDesired | undefined> {
    const running = this.publishing.get(tenant);
    if (running) return running;
    const work = Promise.resolve()
      .then(async () => {
        let latest: SessionDesired | undefined;
        while (this.stale.has(tenant) && this.desiredSource) {
          if (!this.isReady(tenant)) return;
          let desired = this.desiredSource(tenant);
          const unit = this.publicationRetry(tenant);
          if (!unit.ready(canonical(desired))) return;
          this.stale.delete(tenant);
          const placed = this.placement.peek(tenant)!;
          const node = this.nodes.get(placed.nodeId);
          if (node?.state.state !== 'ready') {
            this.stale.add(tenant);
            return;
          }
          await node.coordinate();
          if (!this.desiredSource) return;
          desired = this.desiredSource(tenant);
          validateDesired(desired);
          const clipboardKey = canonical([
            node.nodeId,
            desired.connectionEpoch,
            desired.sessionId,
            desired.placementEpoch,
            desired.clipboard.revision,
          ]);
          if (this.clipboardSent.get(tenant) !== clipboardKey) {
            const clipboard = this.clipboardSource?.(tenant);
            if (!clipboard || clipboard.revision !== desired.clipboard.revision)
              throw new RemoteKitError('conflict', 'Clipboard changed before publication');
            const document: SessionClipboard = {
              method: 'session.clipboard',
              tenantId: tenant,
              sessionId: desired.sessionId,
              placementEpoch: desired.placementEpoch,
              connectionEpoch: desired.connectionEpoch,
              revision: clipboard.revision,
              value: { text: clipboard.text, html: clipboard.html },
            };
            validateClipboard(document);
            await node.publish(document);
            this.clipboardSent.set(tenant, clipboardKey);
          }
          const key = canonical([
            node.nodeId,
            desired.connectionEpoch,
            desired.sessionId,
            desired.placementEpoch,
            desired.revision,
          ]);
          if (this.sent.get(tenant) !== key) {
            await node.publish(desired);
            this.sent.set(tenant, key);
          }
          unit.succeed();
          latest = desired;
        }
        return latest;
      })
      .catch((err) => {
        if (this.desiredSource) this.publicationFailed(tenant, err);
        return undefined;
      })
      .finally(() => {
        this.publishing.delete(tenant);
        if (
          this.desiredSource &&
          this.publicationRetry(tenant).state.phase === 'idle' &&
          this.stale.has(tenant) &&
          this.isReady(tenant)
        )
          this.invalidate(tenant);
      });
    this.publishing.set(tenant, work);
    return work;
  }
  private publicationFailed(tenant: string, err: unknown) {
    this.stale.add(tenant);
    const unit = this.publicationRetry(tenant);
    unit.fail(convertEndpointError(err));
    unit.schedule(() => {
      if (this.desiredSource) void this.publishTenant(tenant);
    });
  }
  async published(tenant: string, timeoutMs = 20000): Promise<SessionDesired> {
    this.invalidate(tenant);
    let timer: NodeJS.Timeout | undefined;
    try {
      const desired = await Promise.race([
        this.publishTenant(tenant),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RemoteKitError('unavailable', 'Desired publication timed out')),
            timeoutMs,
          );
        }),
      ]);
      if (!desired) throw this.publicationRetry(tenant).error ?? this.unavailable(tenant);
      return desired;
    } finally {
      clearTimeout(timer);
    }
  }
  async waitObserved(
    tenant: string,
    predicate: (value: SessionObserved) => boolean,
    timeoutMs = 20000,
  ): Promise<SessionObserved> {
    const placed = this.placement.peek(tenant);
    const node = placed && this.nodes.get(placed.nodeId);
    if (!node || node.state.state !== 'ready' || this.sessionFault(tenant)) throw this.unavailable(tenant);
    const epoch = node.state.connectionEpoch;
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, value?: SessionObserved) => {
        clearTimeout(timer);
        node.off('session.observed', check);
        node.off('offline', offline);
        this.nodes.off('session.fault', faulted);
        if (error) reject(error);
        else resolve(value!);
      };
      const offline = () => finish(this.unavailable(tenant));
      const faulted = ({ target }: { target: { tenantId: string } }) => {
        if (target.tenantId === tenant) finish(this.unavailable(tenant));
      };
      const check = () => {
        const value = this.observation(tenant);
        if (value?.connectionEpoch === epoch && predicate(value)) finish(undefined, value);
      };
      const timer = setTimeout(
        () => finish(new RemoteKitError('outcome_unknown', 'Session convergence has not been observed')),
        timeoutMs,
      );
      node.on('session.observed', check);
      node.on('offline', offline);
      this.nodes.on('session.fault', faulted);
      check();
    });
  }
  isReady(tenant: string) {
    const placed = this.placement.peek(tenant);
    return placed?.dataState === 'dirty'
      ? this.nodes.get(placed.nodeId)?.state.state === 'ready'
      : this.nodes.all().some((node) => node.state.state === 'ready');
  }
  forget(tenant: string) {
    this.sent.delete(tenant);
    this.clipboardSent.delete(tenant);
  }
  isPlacedOn(tenant: string, nodeId: string) {
    return this.placement.peek(tenant)?.nodeId === nodeId;
  }
  onSignal(listener: (event: RtcSignal) => void) {
    const subscriptions = this.nodes.all().map((node) =>
      node.onSignal((event) => {
        if (this.isPlacedOn(event.tenantId, node.nodeId)) listener(event);
      }),
    );
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }
  private async invoke<T>(method: string, tenant: string, args: object = {}): Promise<T> {
    try {
      const placed = this.placement.peek(tenant) ?? this.placement.resolve(tenant);
      const node = this.nodes.get(placed.nodeId);
      if (!node || node.state.state !== 'ready')
        throw new RemoteKitError('unavailable', 'Session node is offline');
      const target = {
        sessionId: placed.sessionId,
        placementEpoch: placed.placementEpoch,
        endpointIncarnation: node.state.incarnation,
      };
      const params = { ...args } as Record<string, unknown>;
      if (
        method.startsWith('view.') ||
        method.startsWith('session.storage.') ||
        method === 'session.identity'
      ) {
        if (!params.browserIncarnation)
          params.browserIncarnation = this.observation(tenant)?.browserIncarnation;
        if (!params.browserIncarnation)
          throw new RemoteKitError('unavailable', 'Session Browser has not been observed');
      }
      let identity: unknown[] | undefined;
      if (params.operationId) identity = [params.operationGeneration, params.operationId];
      else if (method === 'session.library.prepare') identity = [params.selectionId];
      else if (method === 'session.storage.import') identity = [params.importId];
      else if (method === 'view.lifecycle' && params.lifecycleGeneration !== undefined)
        identity = [params.browserIncarnation, params.viewId, params.lifecycleGeneration, params.action];
      else if (method === 'rtc.offer' || method === 'rtc.close') identity = [params.connectionId];
      const opId = identity ? rpcId(method, target, ...identity) : randomUUID();
      const request: OneShotRequest = { method, tenantId: tenant, ...target, opId, replay: false, params };
      return (await node.invoke(request)) as T;
    } catch (error) {
      throw endpointError(error);
    }
  }
  storageImport(tenant: string, args: ImportChunk & StorageImportJob): Promise<StorageImportStatus> {
    return this.invoke('session.storage.import', tenant, args);
  }
  storageImportStatus(tenant: string, args: StorageImportJob): Promise<StorageImportStatus> {
    return this.invoke('session.storage.importStatus', tenant, args);
  }
  identity(tenant: string): Promise<BrowserIdentity> {
    return this.invoke('session.identity', tenant);
  }
  async transfer(tenant: string, nodeId?: string) {
    const source = this.placement.peek(tenant);
    if (!source) throw new RemoteKitError('not_found', '用户没有 Session');
    if (this.nodes.get(source.nodeId)?.state.state === 'ready') {
      const target = this.nodes
        .all()
        .some(
          (node) =>
            node.nodeId !== source.nodeId &&
            (nodeId === undefined || node.nodeId === nodeId) &&
            node.state.state === 'ready',
        );
      if (!target) throw new RemoteKitError('unavailable', '没有可接收的在线节点');
      await this.stop(tenant);
    }
    const placed = this.placement.transfer(tenant, nodeId);
    this.forget(tenant);
    await Promise.all(
      this.nodes
        .all()
        .filter((node) => node.state.state === 'ready')
        .map((node) => node.coordinate()),
    );
    return placed;
  }
  async stop(tenant: string): Promise<number> {
    const current = this.placement.peek(tenant);
    if (current?.runState === 'stopped' && current.dataState === 'clean') return current.checkpointId ?? 0;
    const fault = this.sessionFault(tenant);
    if (fault) throw fault;
    const placed = this.placement.beginStop(tenant);
    this.invalidate(tenant);
    const observed = await this.waitObserved(
      tenant,
      (value) =>
        value.lastError !== null ||
        (value.browser === 'stopped' &&
          value.data?.state === 'clean' &&
          value.data.base !== null &&
          (value.data.committed === null || value.data.committed.requestId === placed.pendingCommit)),
      180000,
    );
    if (observed.lastError) throw endpointError(observed.lastError);
    return this.placement.peek(tenant)?.checkpointId ?? 0;
  }
  async snapshot(tenant: string, args: { outputDiagnostics?: boolean } = {}): Promise<EndpointSnapshot> {
    if (args.outputDiagnostics) return this.invoke('session.snapshot', tenant, args);
    const snapshot = this.current(tenant);
    if (snapshot.status)
      throw new EndpointSnapshotError(endpointError(snapshot.status), snapshot.browserRestart);
    return snapshot;
  }
  current(tenant: string): EndpointSnapshot {
    const value = this.observation(tenant);
    if (!value) throw new RemoteKitError('unavailable', 'Session has not been observed');
    const node = this.nodes.get(this.placement.peek(tenant)!.nodeId);
    if (node && value.lastError?.code === 'unavailable' && value.stats.allocationPressure === true)
      node.allocationFailedAt ??= Date.now();
    return {
      running: value.browser === 'running',
      browserIncarnation: value.browserIncarnation ?? undefined,
      browserPid: value.browserPid,
      browserRestart: value.browserRestart,
      views: value.views,
      pendingPopups: value.pendingPopups,
      recovery: value.recovery,
      rtc: { ...value.rtc, connectionId: value.rtc.connectionId ?? undefined },
      stats: value.stats,
      stopBlockers: value.blockers,
      status: value.lastError,
    };
  }
  async acknowledge(event: EventsAck): Promise<void> {
    const placed = this.placement.peek(event.tenantId);
    if (!placed || placed.sessionId !== event.sessionId || placed.placementEpoch !== event.placementEpoch)
      return;
    const node = this.nodes.get(placed.nodeId);
    if (
      node?.state.state !== 'ready' ||
      node.state.connectionEpoch !== event.connectionEpoch ||
      this.sessionFault(event.tenantId)
    )
      return;
    await node.publish(event);
  }
  readLog(tenant: string, request: LogWindowRequest): Promise<LogWindow> {
    return this.invoke<LogWindow>('session.logs.read', tenant, request);
  }
  async offer(
    tenant: string,
    args: { connectionId: string; leaseId: string; sdp: string; avSync: boolean },
  ): Promise<Accepted & { avSync: boolean }> {
    return this.invoke<Accepted & { avSync: boolean }>('rtc.offer', tenant, { ...args, trickle: true });
  }
  async ice(tenant: string, args: { connectionId: string; candidate: unknown }): Promise<Accepted> {
    return this.invoke<Accepted>('rtc.ice', tenant, args);
  }
  async closeRtc(tenant: string, args: { connectionId: string }): Promise<Accepted> {
    return this.invoke<Accepted>('rtc.close', tenant, args);
  }
  async navigate(
    tenant: string,
    args: OperationIdentity & { viewId: string; url: string },
  ): Promise<Accepted> {
    return this.invoke<Accepted>('view.navigate', tenant, args);
  }
  appInfo(tenant: string, args: { viewId: string }): Promise<ViewAppInfo> {
    return this.invoke<ViewAppInfo>('view.appInfo', tenant, args);
  }
  async command(
    tenant: string,
    args: OperationIdentity & { viewId: string; command: string },
  ): Promise<Accepted> {
    return this.invoke<Accepted>('view.command', tenant, args);
  }
  async closeView(
    tenant: string,
    args: { viewId: string; force?: boolean; orphan?: boolean; [key: string]: unknown },
  ): Promise<Accepted> {
    return this.invoke<Accepted>('view.close', tenant, args);
  }
  async replyClose(
    tenant: string,
    args: PageIdentity & { requestId: string; accept: boolean },
  ): Promise<Accepted> {
    return this.invoke<Accepted>('view.close.reply', tenant, args);
  }
  async replyPage(tenant: string, args: PageReplyRequest): Promise<Accepted> {
    return this.invoke<Accepted>('view.page.reply', tenant, args);
  }
  async exitFullscreen(tenant: string, args: PageIdentity): Promise<Accepted> {
    return this.invoke<Accepted>('view.page.exitFullscreen', tenant, args);
  }
  async ackNavigation(tenant: string, args: OperationIdentity & { viewId: string }): Promise<Accepted> {
    return this.invoke<Accepted>('view.navigation.ack', tenant, args);
  }
  async lifecycle(tenant: string, args: LifecycleRequest): Promise<Accepted> {
    return this.invoke<Accepted>('view.lifecycle', tenant, args);
  }
  async prepareSelection(tenant: string, args: PrepareSelection): Promise<Accepted> {
    return this.invoke<Accepted>('session.library.prepare', tenant, args);
  }
  async selectionStatus(tenant: string, args: { selectionId: string }): Promise<{ state: SelectionState }> {
    return this.invoke<{ state: SelectionState }>('session.library.selectionStatus', tenant, args);
  }
}

export function endpointError(error: unknown): RemoteKitError {
  if (isRemoteKitError(error) || error instanceof Error) return convertEndpointError(error);
  const converted = convertEndpointError(error);
  log.error('endpoint.failed', {
    errorId: converted.errorId,
    err: converted,
    code: converted.code,
    reason: converted.reason,
    detail: converted.detail,
  });
  return converted;
}
