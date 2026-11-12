import { log } from '../log';
import { RemoteKitError, isRemoteKitError, endpointError as convertEndpointError } from '../../shared/errors';
import type { Asset, SelectionState } from '../../shared/file-library';
import type { MediaPolicy } from '../../shared/product';
import type {
  BrowserIdentity,
  ImportChunk,
  StorageImportJob,
  StorageImportStatus,
} from '../../shared/session-import';
import type { NodeRegistry } from '../cluster/node-link';
import type { Placement, SessionPlacement } from '../cluster/placement';
import type { ClipboardValue } from '../persistence/clipboards';
import type {
  Accepted,
  ActionResult,
  ClientActionEvent,
  ClipboardChangedEvent,
  EndpointSnapshot,
  FaceBinding,
  FaceStatusReply,
  FileAuthorization,
  LifecycleRequest,
  LogWindow,
  LogWindowRequest,
  OperationIdentity,
  PageIdentity,
  PageReplyRequest,
  PrepareSelection,
  RtcSignal,
  SessionSitePreferencesRequest,
  ViewConfiguration,
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
      retryAfterMs: error.retryAfterMs,
      errorId: error.errorId,
      cause: error,
    });
  }
}
export class EndpointGateway {
  private clipboardSource: (tenant: string) => ClipboardValue | undefined = () => undefined;
  setClipboardSource(source: (tenant: string) => ClipboardValue | undefined) {
    this.clipboardSource = source;
  }
  private clipboardParams(tenant: string) {
    const clipboard = this.clipboardSource(tenant);
    return clipboard ? { clipboard } : {};
  }
  onClipboardChanged(listener: (event: ClipboardChangedEvent) => void) {
    const unsubscribe = this.nodes.all().map((node) =>
      node.onClipboardChanged((event) => {
        if (
          this.isPlacedOn(event.tenantId, node.nodeId) &&
          this.placement.peek(event.tenantId)?.sessionId === event.sessionId
        )
          listener(event);
      }),
    );
    return () => unsubscribe.forEach((fn) => fn());
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
  readonly stopping = new Map<string, Promise<number>>();
  private readonly opened = new Map<
    string,
    { epoch: string; placementEpoch: number; promise: Promise<void> }
  >();
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
      | 'discard'
      | 'reconcileStop'
    >,
  ) {
    placement.reconcileStop = (tenant) => this.stop(tenant);
    nodes.on('copies', ({ nodeId, sessions }: { nodeId: string; sessions: any[] }) => {
      for (const reported of sessions) {
        const current = placement.peek(reported.tenantId);
        if (
          !current ||
          current.nodeId !== nodeId ||
          current.sessionId !== reported.sessionId ||
          current.placementEpoch !== reported.placementEpoch ||
          reported.copy?.state !== 'clean' ||
          !reported.copy.lastCommit ||
          typeof reported.copy.lastCommit.requestId !== 'string' ||
          !reported.copy.lastCommit.requestId ||
          reported.copy.lastCommit.manifestId !== reported.copy.base
        )
          continue;
        try {
          placement.commitCheckpoint(
            { ...current, pendingCommit: null },
            reported.copy.base,
            reported.checkpoint?.objects,
            reported.checkpoint?.buildId,
          );
          this.opened.delete(current.tenant);
        } catch (err) {
          log.warn('session.shutdown_commit_failed', { tenant: current.tenant, err });
          throw err;
        }
      }
    });
  }
  isReady(tenant: string) {
    const placed = this.placement.peek(tenant);
    return placed?.dataState === 'dirty'
      ? this.nodes.get(placed.nodeId)?.state.state === 'ready'
      : this.nodes.all().some((node) => node.state.state === 'ready');
  }
  forget(tenant: string) {
    this.opened.delete(tenant);
  }
  isPlacedOn(tenant: string, nodeId: string) {
    const placement = this.placement.peek(tenant);
    return placement !== undefined && placement.dataState === 'dirty' && placement.nodeId === nodeId;
  }
  onSignal(listener: (event: RtcSignal) => void) {
    const unsubscribe = this.nodes.all().map((node) =>
      node.onSignal?.((event) => {
        if (this.isPlacedOn(event.tenantId, node.nodeId)) listener(event);
      }),
    );
    return () => unsubscribe.forEach((fn) => fn?.());
  }
  onClientAction(listener: (event: ClientActionEvent) => void) {
    const unsubscribe = this.nodes.all().map((node) =>
      node.onClientAction?.((event) => {
        if (this.isPlacedOn(event.tenantId, node.nodeId)) listener(event);
      }),
    );
    return () => unsubscribe.forEach((fn) => fn?.());
  }
  private async openSession(placement: SessionPlacement) {
    const node = this.nodes.get(placement.nodeId)!;
    const state = node.state;
    if (state.state !== 'ready')
      throw new RemoteKitError('unavailable', '会话节点离线', { detail: 'Placed node is offline' });
    const previous = this.opened.get(placement.tenant);
    if (previous?.epoch === state.connectionEpoch && previous.placementEpoch === placement.placementEpoch)
      return previous.promise;
    const entry = {
      epoch: state.connectionEpoch,
      placementEpoch: placement.placementEpoch,
      promise: Promise.resolve(),
    };
    entry.promise = node
      .request('session.open', placement.tenant, {
        sessionId: placement.sessionId,
        placementEpoch: placement.placementEpoch,
        ...this.placement.keys(placement),
        checkpoint: placement.checkpoint,
        ...this.clipboardParams(placement.tenant),
      })
      .then(() => {
        if (node.state.state !== 'ready' || node.state.connectionEpoch !== entry.epoch)
          throw new RemoteKitError('outcome_unknown', '会话启动结果待确认', {
            detail: 'Node changed during session.open',
          });
        this.placement.markWarm(placement);
      })
      .catch((error) => {
        if (this.opened.get(placement.tenant) === entry) this.opened.delete(placement.tenant);
        throw error;
      });
    this.opened.set(placement.tenant, entry);
    return entry.promise;
  }
  private async invoke<T>(method: string, tenant: string, args?: object): Promise<T> {
    try {
      const prior = this.placement.peek(tenant);
      if (prior?.dataState === 'dirty') {
        const owner = this.nodes.get(prior.nodeId);
        if (owner?.state.state === 'ready') await owner.readyCopies;
      }
      const placement = this.placement.resolve(tenant);
      const node = this.nodes.get(placement.nodeId)!;
      try {
        await this.openSession(placement);
      } catch (error) {
        const failure = endpointError(error);
        throw new RemoteKitError('unavailable', '浏览器会话尚未就绪', {
          detail: failure.detail ?? failure.message,
          reason: failure.reason,
          retryAfterMs: failure.retryAfterMs,
          errorId: failure.errorId,
          cause: error,
        });
      }
      const reply = await node.request(method, tenant, {
        ...args,
        ...(method === 'session.ensure' ? this.clipboardParams(tenant) : {}),
      });
      if (reply && typeof reply === 'object' && 'accepted' in reply && reply.accepted === false)
        throw new RemoteKitError('outcome_unknown', '节点未返回有效确认');
      return reply as T;
    } catch (error) {
      throw endpointError(error);
    }
  }
  writeClipboard(tenant: string, clipboard: ClipboardValue): Promise<Accepted> {
    return this.invoke('clipboard.write', tenant, clipboard);
  }
  stop(tenant: string): Promise<number> {
    const previous = this.stopping.get(tenant);
    if (previous) return previous;
    const pending = this.stopSession(tenant)
      .catch((error) => {
        throw endpointError(error);
      })
      .finally(() => {
        this.stopping.delete(tenant);
      });
    this.stopping.set(tenant, pending);
    return pending;
  }
  private async stopSession(tenant: string) {
    const previous = this.placement.peek(tenant);
    const owner = previous && this.nodes.get(previous.nodeId);
    if (owner?.state.state === 'ready') await owner.readyCopies;
    const current = this.placement.peek(tenant);
    if (current?.runState === 'stopped' && current.dataState === 'clean') return current.checkpointId ?? 0;
    const reconciling = !!current?.pendingCommit;
    const placement = this.placement.beginStop(tenant);
    try {
      await this.opened.get(tenant)?.promise;
    } catch (error) {
      if (!reconciling) this.placement.cancelStop(placement);
      throw error;
    }
    const node = this.nodes.get(placement.nodeId);
    if (node?.state.state !== 'ready') {
      if (!reconciling) this.placement.cancelStop(placement);
      throw new RemoteKitError('unavailable', '会话节点离线');
    }
    const state = node.state;
    let result;
    try {
      result = await node.request(
        'session.stop',
        tenant,
        {
          placementEpoch: placement.placementEpoch,
          commit: placement.pendingCommit,
        },
        180000,
      );
    } catch (error) {
      const failure = endpointError(error);
      if (failure.code === 'conflict' || (!reconciling && ['unavailable', 'busy'].includes(failure.code))) {
        this.placement.cancelStop(placement);
        throw failure;
      }
      throw new RemoteKitError('outcome_unknown', failure.message, {
        reason: failure.reason,
        cause: failure,
      });
    }
    this.opened.delete(tenant);
    if (node.state.state !== 'ready' || node.state.connectionEpoch !== state.connectionEpoch)
      throw new RemoteKitError('outcome_unknown', '会话提交结果待确认');
    try {
      if (
        result?.state !== 'clean' ||
        typeof result.base !== 'string' ||
        (result.committed !== null &&
          (result.committed?.requestId !== placement.pendingCommit ||
            result.committed?.manifestId !== result.base))
      )
        throw new RemoteKitError('outcome_unknown', '节点未确认提交');
      return this.placement.commitCheckpoint(placement, result.base, result.objects, result.buildId);
    } catch (error) {
      const failure = endpointError(error);
      throw new RemoteKitError('outcome_unknown', '会话检查点提交结果待确认', {
        detail: failure.detail ?? failure.message,
        cause: error,
      });
    }
  }
  async snapshot(tenant: string, args: { outputDiagnostics?: boolean } = {}): Promise<EndpointSnapshot> {
    const snapshot = await this.invoke<EndpointSnapshot>('session.snapshot', tenant, args);
    if (snapshot.status) {
      const error = endpointError(snapshot.status);
      throw new EndpointSnapshotError(error, snapshot.browserRestart);
    }
    return {
      ...snapshot,
      views: (snapshot.views ?? []).map((view) => {
        const { viewId, view: nativeView, id, ...fields } = view;
        return { ...fields, viewId: String(viewId ?? nativeView ?? id) };
      }),
    };
  }
  readLog(tenant: string, request: LogWindowRequest): Promise<LogWindow> {
    return this.invoke<LogWindow>('session.logs.read', tenant, request);
  }
  async ensureSession(tenant: string): Promise<{ browserPid?: number; [key: string]: unknown }> {
    return this.invoke<{ browserPid?: number; [key: string]: unknown }>('session.ensure', tenant);
  }
  async offer(
    tenant: string,
    args: { connectionId: string; sdp: string; avSync: boolean },
  ): Promise<Accepted & { avSync: boolean }> {
    return this.invoke<Accepted & { avSync: boolean }>('rtc.offer', tenant, { ...args, trickle: true });
  }
  async ice(tenant: string, args: { connectionId: string; candidate: unknown }): Promise<Accepted> {
    return this.invoke<Accepted>('rtc.ice', tenant, args);
  }
  async closeRtc(tenant: string, args: { connectionId: string }): Promise<Accepted> {
    return this.invoke<Accepted>('rtc.close', tenant, args);
  }
  async authorizeRtc(
    tenant: string,
    args: { connectionId: string; epoch: number; unlocked: boolean },
  ): Promise<Accepted> {
    return this.invoke<Accepted>('rtc.authorize', tenant, args);
  }
  async actionResult(tenant: string, args: ActionResult): Promise<Accepted> {
    return this.invoke<Accepted>('rtc.actionResult', tenant, args);
  }
  async navigate(
    tenant: string,
    args: OperationIdentity & { viewId: string; url: string },
  ): Promise<Accepted> {
    return this.invoke<Accepted>('view.navigate', tenant, args);
  }
  async ensureView(
    tenant: string,
    args: Partial<ViewConfiguration> & OperationIdentity & { viewId: string; url: string },
  ): Promise<Accepted> {
    return this.invoke<Accepted>('view.ensure', tenant, args);
  }
  async configureView(tenant: string, args: ViewConfiguration): Promise<Accepted> {
    return this.invoke<Accepted>('view.configure', tenant, args);
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
  async adoptView(
    tenant: string,
    args: ViewConfiguration & { url: string; provisionalId: string },
  ): Promise<Accepted> {
    return this.invoke<Accepted>('view.adopt', tenant, args);
  }
  async mediaPolicy(tenant: string, args: MediaPolicy): Promise<Accepted> {
    return this.invoke<Accepted>('session.mediaPolicy', tenant, args);
  }
  async sitePreferences(tenant: string, args: SessionSitePreferencesRequest): Promise<Accepted> {
    return this.invoke<Accepted>('session.sitePreferences', tenant, args);
  }
  async authorizeFiles(tenant: string, args: FileAuthorization): Promise<Accepted> {
    return this.invoke<Accepted>('session.files.authorize', tenant, args);
  }
  async ackEvents(tenant: string, args: { eventIds: string[] }): Promise<Accepted> {
    return this.invoke<Accepted>('session.events.ack', tenant, args);
  }
  async faceCapabilities(tenant: string): Promise<{ available: boolean; modelVersion?: string }> {
    return this.invoke<{ available: boolean; modelVersion?: string }>('auth.face.capabilities', tenant);
  }
  async cancelFace(tenant: string, args: FaceBinding): Promise<Accepted> {
    return this.invoke<Accepted>('auth.face.cancel', tenant, args);
  }
  async beginFace(
    tenant: string,
    args: FaceBinding & { purpose: string; timeoutMs: number; template?: number[] },
  ): Promise<Accepted> {
    return this.invoke<Accepted>('auth.face.begin', tenant, args);
  }
  async faceStatus(tenant: string, args: FaceBinding): Promise<FaceStatusReply> {
    return this.invoke<FaceStatusReply>('auth.face.status', tenant, args);
  }
  async describeAsset(tenant: string, args: { assetId: string }): Promise<Asset> {
    return this.invoke<Asset>('session.library.describe', tenant, args);
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
