import type { ProductState } from '../../shared/product';
import type { SocketMethods } from './socket-methods';
import type { AuthState } from '../../shared/security';
import type { AuthorizationScope } from '../auth/authorization-scope';
import { formatError } from '../util/format-error';
import { diagnostics } from '../media/diagnostics';
import type { RtcSession } from '../rtc/rtc-session';
import { Store } from '../util/store';
import type { ConnectionStatus, ControlSession } from './control-session';
import type { OperationsStore } from './operations-store';
import type { ViewportRequests } from './viewport-requests';

export interface WorkspaceSnapshot {
  auth: AuthState | null;
  localLock: string | null;
  manualLock: boolean;
  status: ConnectionStatus;
  error: string;
  idleRearmed: boolean;
}
export class WorkspaceSession extends Store<WorkspaceSnapshot> {
  private started = false;
  private endpointGeneration?: number;
  constructor(
    private readonly ports: {
      authorization: Pick<
        AuthorizationScope,
        'observePeerAuthorization' | 'setProductLocked' | 'productReady'
      >;
      operations: Pick<OperationsStore, 'acceptSnapshot' | 'getSnapshot'>;
      rtc: Pick<
        RtcSession,
        'observeEndpointGeneration' | 'connect' | 'disconnect' | 'restart' | 'confirmedAvSync' | 'getSnapshot'
      >;
      control: Pick<ControlSession, 'request' | 'reconnect' | 'connect' | 'close'>;
      viewport: Pick<ViewportRequests, 'observe' | 'reset'>;
      setAudioChannels(channels: { left: boolean; right: boolean }): void;
    },
  ) {
    super({
      auth: null,
      localLock: null,
      manualLock: false,
      status: 'connecting',
      error: '',
      idleRearmed: true,
    });
  }
  acceptState(next: ProductState) {
    const current = this.getSnapshot();
    if (current.auth?.locked !== false || current.localLock) return;
    this.ports.operations.acceptSnapshot(next);
    if (current.auth.peerEpoch > 0) this.ports.authorization.setProductLocked(false);
  }
  acceptStatus(status: ConnectionStatus) {
    const previous = this.getSnapshot();
    this.publish({ ...previous, status });
    if (status !== 'online' && previous.status === 'online') {
      this.ports.authorization.setProductLocked(true);
      this.ports.viewport.reset();
      this.publish({ ...this.getSnapshot(), auth: null, error: '' });
      this.started = false;
      this.ports.rtc.disconnect();
    }
  }
  acceptAuth(auth: AuthState) {
    const current = this.getSnapshot(),
      previous = current.auth;
    if (previous && auth.epoch < previous.epoch) return;
    if (!auth.locked && current.localLock) return;
    this.ports.authorization.observePeerAuthorization(auth.peerEpoch);
    if (auth.locked) this.ports.authorization.setProductLocked(true);
    this.publish({
      ...current,
      auth,
      error: auth.locked || auth.epoch !== previous?.epoch ? '' : current.error,
      localLock: auth.locked ? null : current.localLock,
      manualLock: auth.locked ? current.manualLock : false,
      idleRearmed: auth.locked ? current.idleRearmed : true,
    });
    if (!auth.locked && auth.peerEpoch > 0 && this.ports.operations.getSnapshot().authoritative)
      this.ports.authorization.setProductLocked(false);
    if (auth.endpointGeneration !== this.endpointGeneration) {
      this.ports.rtc.observeEndpointGeneration(auth.endpointGeneration);
      this.endpointGeneration = auth.endpointGeneration;
    }
    if (!this.started) {
      this.started = true;
      void this.ports.rtc.connect();
    }
  }
  lock = (reason: string) => {
    const current = this.getSnapshot();
    if (!current.auth || current.auth.locked || current.localLock) return;
    this.publish({
      ...current,
      localLock: reason,
      manualLock: reason === 'manual' || current.manualLock,
      error: '',
      idleRearmed: reason === 'idle' || reason === 'system' ? false : current.idleRearmed,
    });
    this.ports.authorization.setProductLocked(true);
    this.ports.viewport.reset();
    void this.ports.control.request('auth.lock', {}).catch((error) => {
      diagnostics.record('auth-lock', error);
      this.ports.control.reconnect();
    });
  };
  departureObserved = () => {
    this.publish({ ...this.getSnapshot(), manualLock: false });
  };
  report = (error: unknown) => {
    const current = this.getSnapshot();
    diagnostics.record('workspace-action', error);
    if (current.auth?.locked === false && !current.localLock)
      this.publish({ ...current, error: formatError(error) });
  };
  dismissError = () => this.publish({ ...this.getSnapshot(), error: '' });
  request = <K extends keyof SocketMethods>(method: K, params: SocketMethods[K]['params']) =>
    this.ports.control.request(method, params);
  private activity = () => {
    if (!this.getSnapshot().idleRearmed) this.publish({ ...this.getSnapshot(), idleRearmed: true });
  };
  start() {
    window.addEventListener('pointerdown', this.activity, true);
    window.addEventListener('keydown', this.activity, true);
    this.ports.control.connect();
  }
  stop() {
    window.removeEventListener('pointerdown', this.activity, true);
    window.removeEventListener('keydown', this.activity, true);
    this.ports.viewport.reset();
    this.ports.rtc.disconnect();
    this.ports.control.close();
  }
  operationsChanged = () => {
    const { state, authoritative } = this.ports.operations.getSnapshot();
    this.availabilityChanged();
    if (state) {
      this.ports.setAudioChannels(state.workspace.settings.workspace.audioChannels);
      const rtc = this.ports.rtc;
      if (
        rtc.getSnapshot().phase === 'connected' &&
        rtc.confirmedAvSync !== undefined &&
        authoritative &&
        authoritative.workspace.settings.workspace.avSync !== rtc.confirmedAvSync
      )
        rtc.restart('音视频同步设置已变更');
    }
  };
  availabilityChanged = () =>
    this.ports.viewport.observe(
      this.ports.operations.getSnapshot().state,
      this.getSnapshot().status === 'online' && this.ports.authorization.productReady,
    );
}
