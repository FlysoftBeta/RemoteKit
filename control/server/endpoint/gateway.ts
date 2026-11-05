import {
  RemoteKitError,
  httpStatus,
  isRemoteKitError,
  toRemoteKitError,
  type ErrorCode,
} from '../../shared/errors';
import type { Asset, SelectionState } from '../../shared/file-library';
import type { MediaPolicy } from '../../shared/product';
import type { EndpointLink } from './link';
import type {
  Accepted,
  ActionResult,
  ClientActionEvent,
  EndpointSnapshot,
  FaceBinding,
  FaceStatusReply,
  FileAuthorization,
  LifecycleRequest,
  OperationIdentity,
  PageIdentity,
  PrepareSelection,
  RtcSignal,
  ViewConfiguration,
} from './types';
export class EndpointGateway {
  constructor(private readonly link: EndpointLink) {}
  onSignal(listener: (event: RtcSignal) => void) {
    return this.link.onSignal?.(listener);
  }
  onClientAction(listener: (event: ClientActionEvent) => void) {
    return this.link.onClientAction?.(listener);
  }
  private async invoke<T>(method: string, tenant: string, args?: object): Promise<T> {
    if (this.link.state.state !== 'ready') throw new RemoteKitError('unavailable', 'Endpoint 尚未就绪');
    try {
      const reply = await this.link.request(method, tenant, args as Record<string, unknown>);
      if (reply && typeof reply === 'object' && 'accepted' in reply && reply.accepted === false)
        throw new RemoteKitError('rejected', 'Endpoint 拒绝请求');
      return reply as T;
    } catch (error) {
      if (isRemoteKitError(error)) throw error;
      if (typeof error === 'string') throw new RemoteKitError('rejected', 'Endpoint 拒绝请求', error);
      if (error && typeof error === 'object' && !(error instanceof Error)) {
        const wire = error as { code?: string; message?: string };
        const code: ErrorCode =
          wire.code === 'busy'
            ? 'unavailable'
            : wire.code && Object.prototype.hasOwnProperty.call(httpStatus, wire.code)
              ? (wire.code as ErrorCode)
              : 'rejected';
        throw new RemoteKitError(code, wire.message ?? 'Endpoint 拒绝请求');
      }
      throw toRemoteKitError(error);
    }
  }
  async snapshot(tenant: string, args: { outputDiagnostics?: boolean } = {}): Promise<EndpointSnapshot> {
    const snapshot = await this.invoke<EndpointSnapshot>('session.snapshot', tenant, args);
    return {
      ...snapshot,
      views: (snapshot.views ?? []).map((view) => {
        const { viewId, view: nativeView, id, ...fields } = view;
        return { ...fields, viewId: String(viewId ?? nativeView ?? id) };
      }),
    };
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
  async retainAssets(tenant: string, args: { assetIds: string[] }): Promise<Accepted> {
    return this.invoke<Accepted>('session.library.retain', tenant, args);
  }
  async referenceAssets(tenant: string, args: { revision: number; assetIds: string[] }): Promise<Accepted> {
    return this.invoke<Accepted>('session.library.references', tenant, args);
  }
  async prepareSelection(tenant: string, args: PrepareSelection): Promise<Accepted> {
    return this.invoke<Accepted>('session.library.prepare', tenant, args);
  }
  async selectionStatus(tenant: string, args: { selectionId: string }): Promise<{ state: SelectionState }> {
    return this.invoke<{ state: SelectionState }>('session.library.selectionStatus', tenant, args);
  }
}
