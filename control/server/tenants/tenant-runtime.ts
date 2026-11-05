import type {
  OperationReceipt,
  ViewerViewport,
  PageDialog,
  PageFullscreen,
  AppliedMediaPolicy,
} from '../../shared/product';
import type { InternalFileRequest } from '../file-requests';
import type { ViewerSecurity } from '../viewer-auth';
import { QualityState } from '../quality';
import { BackgroundPolicy } from '../background-policy';
import type { Clock } from '../util/clock';
import { RemoteKitError } from '../../shared/errors';
export interface ViewerLease {
  id: string;
  authentication: { identity: string; valid: () => boolean };
  revoke: (reason: 'another-viewer' | 'logout') => void;
  viewport?: ViewerViewport;
  security: ViewerSecurity;
}
export type FullscreenBinding = {
  page: PageFullscreen;
  viewId: string;
  browserIncarnation: string;
  instance: string;
  document: string;
};
export type SignalBinding = {
  tenant: string;
  lease: string;
  attemptId: string;
  resolve: (sdp: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  answered: boolean;
};
export type RtcConnection =
  | { phase: 'idle' }
  | { phase: 'negotiating'; connectionId: string; attemptId: string; leaseId: string }
  | { phase: 'active'; connectionId: string; leaseId: string };
export type PolicyApplication = { encoded: string; applied: boolean; browserPid?: number };
export class TenantRuntime {
  viewer?: ViewerLease;
  lastViewport?: ViewerViewport;
  snapshotSequence = 0;
  applyingOperation?: OperationReceipt;
  lastError?: string;
  mediaGeneration?: number;
  pendingRtcCheck = false;
  started = false;
  browserIncarnation?: string;
  rtc: {
    connection: RtcConnection;
    signal?: SignalBinding;
    disconnectedPeer?: { connectionId: string; leaseId: string };
  } = { connection: { phase: 'idle' } };
  policy: {
    configurations: Map<string, string>;
    site?: PolicyApplication;
    media?: PolicyApplication;
    actualMedia?: AppliedMediaPolicy;
  } = { configurations: new Map() };
  quality = new QualityState();
  pageRequests: {
    dialogs?: (PageDialog & {
      viewId: string;
      requestId: string;
      browserIncarnation: string;
      instance: string;
      document: string;
    })[];
    fullscreen?: FullscreenBinding;
    authorization?: string;
    files?: InternalFileRequest[];
  } = {};
  lifecycle: { transitions: Map<string, { action: string; at: number }>; background: BackgroundPolicy };
  constructor(
    readonly tenantId: string,
    clock: Clock,
  ) {
    this.lifecycle = { transitions: new Map(), background: new BackgroundPolicy(clock) };
  }
  get connectionId() {
    return this.rtc.connection.phase === 'idle' ? undefined : this.rtc.connection.connectionId;
  }
  get connectionLease() {
    return this.rtc.connection.phase === 'active' ? this.rtc.connection.leaseId : undefined;
  }
  beginRtc(connectionId: string, attemptId: string, leaseId: string) {
    this.rtc.connection = { phase: 'negotiating', connectionId, attemptId, leaseId };
  }
  activateRtc(connectionId: string, leaseId: string) {
    this.rtc.connection = { phase: 'active', connectionId, leaseId };
  }
  disconnectRtc() {
    const connection = this.rtc.connection;
    if (connection.phase !== 'idle')
      this.rtc.disconnectedPeer = { connectionId: connection.connectionId, leaseId: connection.leaseId };
    this.closeRtc();
  }
  clearSignal() {
    const signal = this.rtc.signal;
    this.rtc.signal = undefined;
    if (!signal) return;
    clearTimeout(signal.timer);
    if (!signal.answered) signal.reject(new RemoteKitError('unavailable', '媒体协商已取消'));
  }
  closeRtc() {
    this.clearSignal();
    this.rtc.connection = { phase: 'idle' };
  }
  clearError() {
    const had = this.lastError !== undefined;
    this.lastError = undefined;
    return had;
  }
  resetEndpoint() {
    this.closeRtc();
    this.rtc.disconnectedPeer = undefined;
    this.mediaGeneration = undefined;
    this.pendingRtcCheck = false;
    this.started = false;
    this.policy = { configurations: new Map() };
    this.lifecycle.transitions.clear();
    this.lifecycle.background.clear();
    this.pageRequests = {};
    this.browserIncarnation = undefined;
  }
  dispose() {
    this.resetEndpoint();
    this.snapshotSequence = 0;
    this.viewer = undefined;
    this.lastViewport = undefined;
    this.applyingOperation = undefined;
    this.lastError = undefined;
    this.quality.resetFeedback();
  }
}
