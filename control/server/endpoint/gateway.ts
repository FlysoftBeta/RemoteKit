import {
  RemoteKitError,
  httpStatus,
  isRemoteKitError,
  toRemoteKitError,
  type ErrorCode,
} from '../../shared/errors';
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
import type {
  Accepted,
  ActionResult,
  ClientActionEvent,
  EndpointSnapshot,
  EndpointErrorReason,
  FaceBinding,
  FaceStatusReply,
  FileAuthorization,
  LifecycleRequest,
  LogWindow,
  LogWindowRequest,
  OperationIdentity,
  PageIdentity,
  PrepareSelection,
  RtcSignal,
  ViewConfiguration,
  ViewAppInfo,
} from './types';
export class EndpointGateway {
  storageImport(tenant: string, args: ImportChunk): Promise<StorageImportJob> {
    return this.invoke('session.storage.import', tenant, args);
  }
  storageImportStatus(
    tenant: string,
    args: { job: string; browserIncarnation: string },
  ): Promise<StorageImportStatus> {
    return this.invoke('session.storage.importStatus', tenant, args);
  }
  identity(tenant: string): Promise<BrowserIdentity> {
    return this.invoke('session.identity', tenant);
  }
  readonly hibernating = new Map<string, Promise<number>>();
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
    >,
  ) {}
  isReady(tenant: string) {
    const placed = this.placement.peek(tenant);
    return placed?.state === 'active'
      ? this.nodes.get(placed.nodeId)?.state.state === 'ready'
      : this.nodes.all().some((node) => node.state.state === 'ready');
  }
  forget(tenant: string) {
    this.opened.delete(tenant);
  }
  isPlacedOn(tenant: string, nodeId: string) {
    const placement = this.placement.peek(tenant);
    return placement?.state === 'active' && placement.nodeId === nodeId;
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
    if (state.state !== 'ready') throw new RemoteKitError('unavailable', 'Placed node is offline');
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
      })
      .then(() => {
        if (node.state.state !== 'ready' || node.state.connectionEpoch !== entry.epoch)
          throw new RemoteKitError('outcome_unknown', 'Node changed during session.open');
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
      await this.hibernating.get(tenant);
      const placement = this.placement.resolve(tenant);
      const node = this.nodes.get(placement.nodeId)!;
      await this.openSession(placement);
      let reply: unknown;
      try {
        reply = await node.request(method, tenant, args as Record<string, unknown>);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'not_found')
          throw error;
        this.opened.delete(tenant);
        await this.openSession(placement);
        reply = await node.request(method, tenant, args as Record<string, unknown>);
      }
      if (reply && typeof reply === 'object' && 'accepted' in reply && reply.accepted === false)
        throw new RemoteKitError('rejected', 'Endpoint 拒绝请求');
      return reply as T;
    } catch (error) {
      throw endpointError(error);
    }
  }
  hibernate(tenant: string): Promise<number> {
    const previous = this.hibernating.get(tenant);
    if (previous) return previous;
    const pending = this.hibernateSession(tenant)
      .catch((error) => {
        throw endpointError(error);
      })
      .finally(() => {
        this.hibernating.delete(tenant);
        this.opened.delete(tenant);
      });
    this.hibernating.set(tenant, pending);
    return pending;
  }
  private async hibernateSession(tenant: string) {
    const placement = this.placement.peek(tenant);
    if (!placement || placement.state !== 'active')
      throw new RemoteKitError('conflict', 'Session is not active');
    const node = this.nodes.get(placement.nodeId)!;
    const state = node.state;
    if (state.state !== 'ready') throw new RemoteKitError('unavailable', 'Placed node is offline');
    const result = await node.request('session.hibernate', tenant, {
      placementEpoch: placement.placementEpoch,
    });
    this.opened.delete(tenant);
    if (node.state.state !== 'ready' || node.state.connectionEpoch !== state.connectionEpoch)
      throw new RemoteKitError('outcome_unknown', 'Node changed during hibernation');
    return this.placement.commitCheckpoint(placement, result.manifestId, result.objects, node.buildId!);
  }
  async snapshot(tenant: string, args: { outputDiagnostics?: boolean } = {}): Promise<EndpointSnapshot> {
    const snapshot = await this.invoke<EndpointSnapshot>('session.snapshot', tenant, args);
    if (snapshot.status) throw endpointError(snapshot.status);
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
  async replyPage(
    tenant: string,
    args: PageIdentity & { requestId: string; accept: boolean; text?: string },
  ): Promise<Accepted> {
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
  async sitePreferences(
    tenant: string,
    args: { sites: Record<string, { tabletUa: boolean }> },
  ): Promise<Accepted> {
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

function endpointError(error: unknown): RemoteKitError {
  if (isRemoteKitError(error)) return error;
  if (typeof error === 'string') return new RemoteKitError('rejected', 'Endpoint 拒绝请求', error);
  if (error && typeof error === 'object' && !(error instanceof Error)) {
    const wire = error as { code?: string; message?: string; reason?: EndpointErrorReason };
    const code: ErrorCode =
      wire.code === 'busy'
        ? 'unavailable'
        : wire.code && Object.prototype.hasOwnProperty.call(httpStatus, wire.code)
          ? (wire.code as ErrorCode)
          : 'rejected';
    const messages: Record<EndpointErrorReason, string> = {
      browser_crashed: '浏览器异常退出，正在恢复…',
      browser_restarting: '浏览器正在恢复，请稍候…',
      output_failed: '浏览器画面输出失败，请稍后重试',
    };
    const message = wire.reason && messages[wire.reason];
    if (message) {
      console.error('Endpoint status', { code, reason: wire.reason, detail: wire.message });
      return new RemoteKitError(
        code,
        code === 'outcome_unknown' ? '浏览器连接中断，操作可能已执行，请查看恢复后的页面' : message,
        wire.message,
      );
    }
    return new RemoteKitError(code, wire.message ?? 'Endpoint 拒绝请求');
  }
  return toRemoteKitError(error);
}
