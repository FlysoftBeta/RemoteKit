import { log } from '../log';
import { RemoteKitError } from '../../shared/errors';
import { RetryUnit } from '../../shared/retry-unit';
import type { AppliedMediaPolicy, PageDialog, PageFullscreen, ViewerViewport } from '../../shared/product';
import type { ViewerSecurityState } from '../auth/viewer-security';
import type { PageIdentity } from '../endpoint/types';
import { QualityState } from '../quality';
import type { Clock } from '../util/clock';
import { BackgroundReclaimViews } from '../workspace/lifecycle';
import type { InternalFileRequest } from '../workspace/page-requests';
export interface ViewerLease {
  id: string;
  authentication: { identity: string; valid: () => boolean };
  revoke: (reason: 'another-viewer' | 'logout') => void;
  viewport?: ViewerViewport;
  security: ViewerSecurityState;
}
export type FullscreenBinding = PageIdentity & { page: PageFullscreen };
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
  | { phase: 'active'; connectionId: string; leaseId: string; attemptId?: string };
export class TenantRuntime {
  reconciliation: {
    inflight?: Promise<void>;
    retry: RetryUnit;
  } = { retry: this.reconciliationRetry() };
  private reconciliationRetry() {
    return new RetryUnit({
      failed: (error) =>
        log.warn('reconciler.product_failed', {
          tenant: this.tenantId,
          code: error.code,
          errorId: error.errorId,
          err: error,
        }),
      recovered: () => log.info('reconciler.product_recovered', { tenant: this.tenantId }),
    });
  }
  viewer?: ViewerLease;
  viewerAbsentSince: number;
  lastViewport?: ViewerViewport;
  snapshotSequence = 0;
  backgroundTasks = new Map<string, import('../../shared/product').BackgroundTask>();
  lastError?: RemoteKitError;
  lastErrorKey?: 'resource_limit' | 'endpoint' | 'stopping';
  mediaGeneration?: number;
  pendingRtcCheck = false;
  started = false;
  browserIncarnation?: string;
  browserRestart?: 'ready' | 'waiting' | 'exhausted';
  rtc: {
    connection: RtcConnection;
    signal?: SignalBinding;
    disconnectedPeer?: { connectionId: string; leaseId: string; attemptId?: string; retiring?: boolean };
  } = { connection: { phase: 'idle' } };
  policy: { actualMedia?: AppliedMediaPolicy } = {};
  quality = new QualityState();
  pageRequests: {
    dialogs?: (PageDialog & PageIdentity & { requestId: string })[];
    fullscreen?: FullscreenBinding;
    files?: InternalFileRequest[];
  } = {};
  lifecycle: { transitions: Map<string, { action: string; at: number }>; background: BackgroundReclaimViews };
  constructor(
    readonly tenantId: string,
    clock: Clock,
  ) {
    this.viewerAbsentSince = clock.monotonicMs();
    this.lifecycle = { transitions: new Map(), background: new BackgroundReclaimViews(clock) };
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
    const attemptId =
      this.rtc.connection.phase !== 'idle' && this.rtc.connection.connectionId === connectionId
        ? this.rtc.connection.attemptId
        : this.rtc.disconnectedPeer?.attemptId;
    this.rtc.connection = { phase: 'active', connectionId, leaseId, attemptId };
  }
  disconnectRtc() {
    const connection = this.rtc.connection;
    if (connection.phase !== 'idle')
      this.rtc.disconnectedPeer = {
        connectionId: connection.connectionId,
        leaseId: connection.leaseId,
        attemptId: connection.attemptId,
      };
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
    this.lastErrorKey = undefined;
    return had;
  }
  resetEndpoint() {
    this.reconciliation.retry.close();
    this.reconciliation.retry = this.reconciliationRetry();
    this.closeRtc();
    this.rtc.disconnectedPeer = undefined;
    this.mediaGeneration = undefined;
    this.pendingRtcCheck = false;
    this.started = false;
    this.policy = {};
    this.lifecycle.transitions.clear();
    this.lifecycle.background.clear();
    this.pageRequests = {};
    this.browserIncarnation = undefined;
  }
  dispose() {
    this.resetEndpoint();
    this.reconciliation.retry.close();
    delete this.reconciliation.inflight;
    this.snapshotSequence = 0;
    this.viewer = undefined;
    this.lastViewport = undefined;
    this.lastError = undefined;
    this.quality.resetFeedback();
  }
}
