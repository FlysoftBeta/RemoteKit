import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { httpStatus, type ErrorCode } from '../shared/errors';
import { auditLoops } from './retry-loop-inventory';
import { creationBindings } from './retry-loop-sites';
import { FailingBoundary, observeLogs, ownerMocks, settle, type OwnerFactory } from './retry-loop-boundary';
import {
  driveBackground,
  drivePublication,
  drivePublicationKind,
  drivePurge,
  driveEventDelivery,
  driveEvents,
  driveRtcRetirement,
  driveRtcReconnection,
} from './retry-loop-drivers';
import {
  driveRecovery,
  driveThumbnails,
  driveDocument,
  driveViewport,
  driveViewportOwner,
  driveImportQueue,
  driveQueuedImport,
  driveHttpRead,
  driveClipboard,
} from './retry-loop-client-drivers';
import { driveStudy } from './retry-loop-study-drivers';
import { driveSecurity } from './retry-loop-security-drivers';
import { driveObjects } from './retry-loop-object-drivers';
import { drivePhoto, drivePhotoStage, driveCamera, driveFocus } from './retry-loop-device-drivers';
import { driveNodeCoordination } from './retry-loop-node-drivers';
import { driveReconciler } from './retry-loop-workspace-drivers';
import { driveApplication } from './retry-loop-application-drivers';
import { driveReact } from './retry-loop-react-drivers';
import {
  driveXinjiaoyu,
  driveProviderRead,
  driveLearningRead,
  driveSignIn,
  driveSignInStep,
} from './retry-loop-learning-drivers';
import { driveLaunch } from './retry-loop-launch-drivers';
import { driveImports } from './retry-loop-import-drivers';
import { driveIdle } from './retry-loop-idle-drivers';
import { driveClockProbe, driveMediaStats, driveMediaFeedback } from './retry-loop-media-drivers';
import { driveOperations } from './retry-loop-operation-drivers';
import { driveRtc } from './retry-loop-rtc-drivers';
import { driveServicePeer } from './retry-loop-service-peer-drivers';
import { driveControlSession } from './retry-loop-control-session-drivers';
import { driveLibrary, driveFileChannel } from './retry-loop-library-drivers';
import { driveDiagnosticServer, driveDiagnosticClient } from './retry-loop-diagnostic-drivers';
import { driveFileServer } from './retry-loop-file-server-drivers';
import { driveLifecycle, driveNavigationAck, driveCloseBatch } from './retry-loop-lifecycle-drivers';
import { driveUi } from './retry-loop-ui-drivers';
import { driveSessionAdmission } from './retry-loop-admission-drivers';
import { drivePresentation } from './retry-loop-presentation-drivers';
import { driveViewerServer } from './retry-loop-viewer-server-drivers';
import { drivePacedQueue, driveHandshake } from './retry-loop-one-shot-drivers';
import { driveFailureMigration } from './retry-loop-migration-drivers';
import { driveMediaClock } from './retry-loop-clock-owner-drivers';

interface Binding {
  owner: string;
  boundary: string;
  event: string | ((code: ErrorCode) => string);
  create: OwnerFactory;
  startup?: number;
  callScoped?: boolean | ((code: ErrorCode) => boolean);
  inputDelay?: number;
  presentation?: boolean;
  retryAfterMs?: Partial<Record<ErrorCode, number>>;
  identity?: (input: unknown) => unknown;
  initialAttempt?: (code: ErrorCode) => number;
  recoveryDelay?: number;
  cadence?: (code: ErrorCode) => number;
  successCalls?: number;
  stopOn?: ErrorCode[];
  dropAsResult?: boolean;
  oneShot?: boolean;
  conflict?: (previous: unknown, next: unknown) => void;
  join?: boolean;
}
export const retryLoops: Record<string, Binding> = {
  'study-material-opening-recovery': {
    owner: 'client/learning/study/study-app.tsx',
    boundary: 'StudyApp LibraryStore.refresh for selected material',
    event: 'recovery',
    create: driveUi('study-material'),
    callScoped: true,
    presentation: true,
  },
  'study-material-save-recovery': {
    owner: 'client/learning/study/study-app.tsx',
    boundary: 'StudyApp study.attachment.save for selected material',
    event: 'recovery',
    create: driveUi('study-material-save'),
    callScoped: true,
    presentation: true,
  },
  'attachment-save-recovery': {
    owner: 'client/learning/study/attachment.tsx',
    boundary: 'AttachmentRow study.attachment.save RPC',
    event: 'recovery',
    create: driveUi('attachment-save'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'session-import-user-operation': {
    owner: 'client/app/session-import.tsx',
    boundary: 'SessionImportSettings sessionImport.pairing RPC',
    event: 'recovery',
    create: driveUi('import-action'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'diagnostic-start-recovery': {
    owner: 'client/media/diagnostic-collection.ts',
    boundary: 'DiagnosticCollection diagnostics.start RPC',
    event: 'recovery',
    create: driveDiagnosticClient('start'),
    callScoped: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'viewer-security-pin-recovery': {
    owner: 'client/auth/security-settings.tsx',
    boundary: 'SecuritySettings auth.settings(pin) RPC',
    event: 'recovery',
    create: driveUi('security-pin'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'viewer-security-remove-pin-recovery': {
    owner: 'client/auth/security-settings.tsx',
    boundary: 'SecuritySettings auth.settings(pin:null) RPC',
    event: 'recovery',
    create: driveUi('security-remove-pin'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'viewer-security-policy-recovery': {
    owner: 'client/auth/security-settings.tsx',
    boundary: 'SecuritySettings auth.settings(settings) RPC',
    event: 'recovery',
    create: driveUi('security-policy'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'viewer-security-remove-face-recovery': {
    owner: 'client/auth/security-settings.tsx',
    boundary: 'SecuritySettings auth.face.remove RPC',
    event: 'recovery',
    create: driveUi('security-remove-face'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },

  'attachment-object-upload': {
    owner: 'server/learning/study-sync.ts',
    boundary: 'StudySync ObjectIndex.put consuming the real attachment stream',
    event: 'learning.attachment',
    create: driveStudy('download'),
  },
  'attachment-library-import': {
    owner: 'server/learning/study-sync.ts',
    boundary: 'StudySync FileLibrary.importFromControl after object commit',
    event: 'learning.attachment',
    create: driveStudy('import'),
  },
  'learning-login-step': {
    owner: 'server/learning/sign-in.ts',
    boundary: 'SignIn AuthClient.login after captcha policy',
    event: 'learning.step',
    create: driveSignInStep('login'),
    callScoped: true,
    stopOn: ['outcome_unknown'],
  },
  'learning-renewal-step': {
    owner: 'server/learning/sign-in.ts',
    boundary: 'SignIn ZhixueAuthClient.renew after credential login',
    event: 'learning.step',
    create: driveSignInStep('renew'),
    callScoped: true,
    stopOn: ['outcome_unknown'],
  },
  'file-chooser-operation-recovery': {
    owner: 'client/files/file-chooser-dialog.tsx',
    boundary: 'FileChooserDialog LibraryStore.cancelSelection',
    event: 'recovery',
    create: driveUi('chooser'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'document-progress-save-recovery': {
    owner: 'client/files/file-preview.tsx',
    boundary: 'FilePreview document.progress.set RPC from real reader progress callback',
    event: 'document_progress',
    create: driveUi('progress-save'),
    callScoped: true,
    presentation: true,
    startup: 800,
  },
  'selection-command-recovery': {
    owner: 'client/selection/selection-ui.tsx',
    boundary: 'SelectionUI SelectionTarget.run(copy)',
    event: 'recovery',
    create: driveUi('selection'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'study-user-operation-recovery': {
    owner: 'client/learning/study/study-app.tsx',
    boundary: 'StudyApp study.sync RPC',
    event: 'recovery',
    create: driveUi('study-action'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'announcement-read-marker-recovery': {
    owner: 'client/app/announcements.tsx',
    boundary: 'AnnouncementDialog read(id)',
    event: 'recovery',
    create: driveUi('announcement'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict'],
  },
  'viewer-login-recovery': {
    owner: 'client/app/product-dialogs.tsx',
    boundary: 'AuthView /api/auth/login HTTP',
    event: 'recovery',
    create: driveUi('login'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'viewer-unlock-recovery': {
    owner: 'client/auth/unlock-view.tsx',
    boundary: 'UnlockView auth.verify RPC',
    event: 'recovery',
    create: driveUi('unlock'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'viewer-security-change-recovery': {
    owner: 'client/auth/security-settings.tsx',
    boundary: 'SecuritySettings auth.password RPC',
    event: 'recovery',
    create: driveUi('security'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'workspace-clipboard-initialization': {
    owner: 'client/clipboard/workspace-clipboard.ts',
    boundary: 'WorkspaceView clipboard.get Control RPC',
    event: 'recovery',
    create: driveReact('clipboard'),
    callScoped: true,
    presentation: true,
  },
  'viewer-identity-read-recovery': {
    owner: 'client/auth/identity-session.ts',
    boundary: 'App identity owner /api/auth/me HTTP',
    event: 'recovery',
    create: driveReact('identity'),
    callScoped: true,
    presentation: true,
  },
  'viewer-logout-recovery': {
    owner: 'client/auth/identity-session.ts',
    boundary: 'App identity owner /api/auth/logout HTTP',
    event: 'recovery',
    create: driveReact('logout'),
    callScoped: true,
    stopOn: ['outcome_unknown', 'conflict'],
  },
  'document-viewer-open-recovery': {
    owner: 'client/documents/document-viewer.tsx',
    boundary: 'DocumentViewer DocumentSource.open',
    event: 'recovery',
    create: driveUi('document'),
    callScoped: true,
    presentation: true,
  },
  'document-page-resource-mounting': {
    owner: 'client/documents/document-viewer.tsx',
    boundary: 'DocumentViewer page DocumentSource.resource(html) with real ResourceCache and mountPage',
    event: 'recovery',
    create: driveUi('page'),
    callScoped: true,
    presentation: true,
  },
  'document-progress-read-recovery': {
    owner: 'client/files/file-preview.tsx',
    boundary: 'FilePreview document.progress.get RPC',
    event: 'recovery',
    create: driveUi('progress'),
    callScoped: true,
    presentation: true,
  },
  'clipboard-publication-per-tenant': {
    owner: 'server/endpoint/gateway.ts',
    boundary: 'NodeLink.publish(session.clipboard)',
    event: 'session.publication',
    create: drivePublicationKind('clipboard'),
  },
  'queued-import-commit-recovery': {
    owner: 'client/files/import-queue.ts',
    boundary: 'ImportQueue library.import RPC after sealed upload',
    event: 'retry_unit',
    create: driveQueuedImport('commit'),
    callScoped: true,
  },
  'photo-upload-recovery': {
    owner: 'client/files/photo-job-store.ts',
    boundary: 'PhotoJobStore FileChannel.uploadAsset',
    event: 'retry_unit',
    create: drivePhotoStage('upload'),
    callScoped: true,
  },
  'photo-commit-recovery': {
    owner: 'client/files/photo-job-store.ts',
    boundary: 'PhotoJobStore library.import RPC after capture and processing',
    event: 'retry_unit',
    create: drivePhotoStage('commit'),
    callScoped: true,
  },
  'control-clock-probe-recovery': {
    owner: 'client/media/observations.ts',
    boundary: 'MediaObservations clock.ping Control RPC',
    event: 'retry_unit',
    create: driveMediaClock('control'),
    identity: () => ({ method: 'clock.ping' }),
  },
  'endpoint-clock-probe-recovery': {
    owner: 'client/media/observations.ts',
    boundary: 'MediaObservations clock.ping data channel',
    event: 'retry_unit',
    create: driveMediaClock('endpoint'),
  },
  'launcher-query-recovery': {
    owner: 'client/app/launcher.tsx',
    boundary: 'Launcher launcher.get RPC',
    event: 'recovery',
    create: driveUi('launcher'),
    callScoped: true,
    presentation: true,
  },
  'app-inspection-recovery': {
    owner: 'client/app/app-editor.tsx',
    boundary: 'InstallDialog app.inspect RPC',
    event: 'recovery',
    create: driveUi('inspect'),
    callScoped: true,
    presentation: true,
  },
  'image-read-recovery': {
    owner: 'client/files/file-image-preview.tsx',
    boundary: 'FileImagePreview FileChannel.readPhoto',
    event: 'recovery',
    create: driveUi('image'),
    callScoped: true,
    presentation: true,
  },
  'snippet-read-recovery': {
    owner: 'client/files/document-tab.tsx',
    boundary: 'DocumentTab LibraryStore.snippet',
    event: 'recovery',
    create: driveUi('snippet'),
    callScoped: true,
    presentation: true,
  },
  'asset-media-read-recovery': {
    owner: 'client/files/file-preview.tsx',
    boundary: 'FilePreview FileChannel.readAsset',
    event: 'recovery',
    create: driveUi('media'),
    callScoped: true,
    presentation: true,
  },
  'attachment-opening-recovery': {
    owner: 'client/learning/study/attachment.tsx',
    boundary: 'AttachmentRow LibraryStore.refresh for saved attachment',
    event: 'recovery',
    create: driveUi('attachment'),
    callScoped: true,
    presentation: true,
  },
  'durable-render-failure-migration': {
    owner: 'server/persistence/migrations.ts',
    boundary: 'SQLite stored render failure rows during migrate()',
    event: 'migration',
    create: driveFailureMigration,
    oneShot: true,
    callScoped: true,
  },
  'product-admission-readiness': {
    owner: 'client/control/operations-store.ts',
    boundary: 'OperationsPort.ready before action submission',
    event: 'retry_unit',
    create: driveOperations('readiness'),
    callScoped: true,
  },
  'handshake-deadline-and-link-liveness': {
    owner: 'server/cluster/node-link.ts',
    boundary: 'Carrier.send authenticated handshake reply',
    event: 'node.handshake',
    create: driveHandshake,
    oneShot: true,
    presentation: true,
    callScoped: true,
  },
  'paced-upstream-work-queue': {
    owner: 'server/learning/providers/xinjiaoyu/rate-limiter.ts',
    boundary: 'RateLimiter scheduled provider work',
    event: 'paced_queue',
    create: drivePacedQueue,
    oneShot: true,
    callScoped: true,
  },
  'viewer-heartbeat-authentication': {
    owner: 'server/http/viewer-socket.ts',
    boundary: 'Accounts.identity during connected WS heartbeat',
    event: 'viewer.authentication',
    create: driveViewerServer('heartbeat'),
  },
  'viewer-face-poll-dispatch': {
    owner: 'server/http/viewer-socket.ts',
    boundary: 'ViewerHub.pollFaceAuth from attached socket server',
    event: 'viewer.face_poll',
    create: driveViewerServer('face'),
  },
  'presentation-negotiation-and-missing-frame-metadata': {
    owner: 'client/presentation/presentation-session.ts',
    boundary: 'EndpointChannel.sendChannel(media.presentation) and native mode reply',
    event: 'presentation',
    create: drivePresentation('negotiation'),
    identity: (input) => {
      const { restart: _restart, ...identity } = input as Record<string, unknown>;
      return identity;
    },
  },
  'presentation-metadata-recovery': {
    owner: 'client/presentation/presentation-session.ts',
    boundary: 'EndpointChannel.sendChannel(media.refresh) from visibility recovery',
    event: 'presentation_metadata',
    create: drivePresentation('metadata'),
  },
  'tab-window-space-app-close-batch': {
    owner: 'server/workspace/page-requests.ts',
    boundary: 'EndpointGateway.closeView second item after first closed',
    event: 'page.close_batch',
    create: driveCloseBatch,
  },
  'viewport-reset-publication': {
    owner: 'client/control/viewport-requests.ts',
    boundary: 'viewport RPC after owner reset',
    event: 'viewport',
    create: driveViewportOwner(true),
    startup: 100,
  },
  'durable-download-dispatch': {
    owner: 'server/workspace/session-events.ts',
    boundary: 'CoordinationRepository.pendingDownloads',
    event: 'session.download_dispatch',
    create: driveEvents('dispatch'),
  },
  'durable-download-import': {
    owner: 'server/workspace/session-events.ts',
    boundary: 'FileLibrary.consumeDownload durable inbox entry',
    event: 'session.download',
    create: driveEvents('download'),
  },
  'faulted-session-admission': {
    owner: 'server/endpoint/session-faults.ts',
    boundary: 'Endpoint admission result through SessionFaults attach/fault/observe',
    event: 'session.protocol',
    create: driveSessionAdmission,
  },
  'identity-setup-login-logout-unlock-security-changes': {
    owner: 'client/app/product-dialogs.tsx',
    boundary: 'AuthView setup HTTP read',
    event: 'recovery',
    create: driveUi('identity'),
    callScoped: true,
    presentation: true,
  },
  'user-operation-wrappers': {
    owner: 'client/app/admin/shared.tsx',
    boundary: 'ConfirmDialog onConfirm identified operation',
    event: 'recovery',
    create: driveUi('operation'),
    callScoped: true,
    presentation: true,
    stopOn: ['conflict'],
  },
  'clipboard-initialization-read-markers-window-state-asset-progress-io': {
    owner: 'client/app/window-state.ts',
    boundary: 'useWindowState Action(window.state)',
    event: 'recovery',
    create: driveUi('window'),
    startup: 500,
    callScoped: true,
    stopOn: ['conflict', 'outcome_unknown'],
  },
  'camera-acquisition-and-attachment-opening': {
    owner: 'client/files/photo-library-capture.tsx',
    boundary: 'PhotoCapture navigator.mediaDevices.getUserMedia',
    event: 'recovery',
    create: driveUi('camera'),
    callScoped: true,
    presentation: true,
  },
  'session-import-settings-polling': {
    owner: 'client/app/session-import.tsx',
    boundary: 'SessionImportSettings sessionImport.state RPC',
    event: 'retry_unit',
    create: driveUi('imports'),
    callScoped: true,
    presentation: true,
  },
  'navigation-terminal-result-acknowledgment': {
    owner: 'server/workspace/navigation.ts',
    boundary: 'EndpointGateway.ackNavigation terminal result',
    event: 'navigation.ack',
    create: driveNavigationAck,
  },
  'pressure-relief-across-offline-tenants': {
    owner: 'server/workspace/lifecycle.ts',
    boundary: 'EndpointGateway.snapshot offline relief candidate',
    event: 'stop.candidate',
    create: driveLifecycle('pressure'),
  },
  'idle-relief-session-stop': {
    owner: 'server/workspace/lifecycle.ts',
    boundary: 'EndpointGateway.stop eligible idle tenant',
    event: 'stop.session',
    create: driveLifecycle('idle'),
  },
  'restore-freeze-discard-ordinary-views': {
    owner: 'server/workspace/lifecycle.ts',
    boundary: 'EndpointGateway.lifecycle ordinary restore',
    event: 'lifecycle.view',
    create: driveLifecycle('ordinary'),
  },
  'uncertain-lifecycle-recovery': {
    owner: 'server/workspace/lifecycle.ts',
    boundary: 'EndpointGateway.lifecycle uncertain unload',
    event: 'lifecycle.recovery',
    create: driveLifecycle('uncertain'),
  },
  'object-maintenance-dispatch': {
    owner: 'server/cluster/objects.ts',
    boundary: 'SQLite checkpoint pruning in maintenance and GC',
    event: 'objects.background',
    create: driveObjects('maintenance'),
    successCalls: 2,
  },
  'availability-projection-after-object-changes': {
    owner: 'server/files/library.ts',
    boundary: 'ObjectIndex.available for a real persisted library entry',
    event: 'library.availability',
    create: driveFileServer('availability'),
    startup: 250,
    inputDelay: 250,
  },
  'selection-preparation-status-reconciliation': {
    owner: 'server/files/library.ts',
    boundary: 'EndpointGateway.selectionStatus for a real prepared selection',
    event: 'library.selection_status',
    create: driveFileServer('selection'),
    dropAsResult: true,
    callScoped: (code) => code === 'not_found',
  },
  'study-global-dispatch': {
    owner: 'server/learning/study-sync.ts',
    boundary: 'LearningAccounts.signedInTenants',
    event: 'learning.dispatch',
    create: driveStudy('global'),
  },
  'study-tenant-dispatch': {
    owner: 'server/learning/study-sync.ts',
    boundary: 'SQLite learning settings read',
    event: 'learning.tenant_dispatch',
    create: driveStudy('tenant'),
  },
  'control-endpoint-diagnostic-samples': {
    owner: 'server/diagnostics/sessions.ts',
    boundary: 'control snapshot source on native sample timer',
    event: 'diagnostics.control_sample',
    create: driveDiagnosticServer('control'),
    callScoped: true,
    cadence: () => 2000,
  },
  'endpoint-diagnostic-samples': {
    owner: 'server/diagnostics/sessions.ts',
    boundary: 'Endpoint snapshot source on native sample timer',
    event: 'diagnostics.endpoint_sample',
    create: driveDiagnosticServer('endpoint'),
    callScoped: true,
    cadence: () => 2000,
  },
  'diagnostic-finalization-log-collection-archive': {
    owner: 'server/diagnostics/sessions.ts',
    boundary: 'fs.promises.mkdir archive directory',
    event: 'diagnostics.finalization',
    create: driveDiagnosticServer('archive'),
    callScoped: true,
    join: true,
  },
  'diagnostic-start-sample-finalization': {
    owner: 'client/media/diagnostic-collection.ts',
    boundary: 'diagnostics.stop/status RPC',
    event: 'retry_unit',
    create: driveDiagnosticClient('finish'),
    identity: (input) => (input as { params: { id: string } }).params.id,
  },
  'library-refresh-and-mutations': {
    owner: 'client/files/library-store.ts',
    boundary: 'LibraryRequest(library.get)',
    event: 'recovery',
    create: driveLibrary('refresh'),
    callScoped: true,
  },
  'library-mutation-recovery': {
    owner: 'client/files/library-store.ts',
    boundary: 'LibraryRequest(library.delete)',
    event: 'recovery',
    create: driveLibrary('mutation'),
    callScoped: true,
  },
  'file-selection-checkout': {
    owner: 'client/files/library-store.ts',
    boundary: 'LibraryRequest(library.finish) after actual prepare/RTC commit',
    event: 'library.checkout',
    create: driveLibrary('checkout'),
    callScoped: true,
  },
  'file-channel-request': {
    owner: 'client/files/file-channel.ts',
    boundary: 'RTC data channel files.result',
    event: 'file_request',
    create: driveFileChannel,
    callScoped: true,
  },
  'control-websocket-reconnect-auth-probe': {
    owner: 'client/control/control-session.ts',
    boundary: 'WebSocket connection with HTTP authentication probe',
    event: 'control_connection',
    create: driveControlSession,
    recoveryDelay: 10000,
    callScoped: (code) => code === 'unauthenticated',
  },
  'service-peer-authorization-liveness': {
    owner: 'server/viewers/service-peers.ts',
    boundary: 'NodeLink.request(service.authorize)',
    event: 'service.authorize',
    create: driveServicePeer('authorization'),
  },
  'service-peer-retirement': {
    owner: 'server/viewers/service-peers.ts',
    boundary: 'NodeLink.request(service.close)',
    event: 'service.close',
    create: driveServicePeer('retirement'),
  },
  'surviving-rtc-peer-after-management-reconnect': {
    owner: 'server/viewers/rtc-signaling.ts',
    boundary: 'EndpointGateway.snapshot',
    event: 'rtc.reconnect',
    create: driveRtcReconnection,
  },
  'browser-service-rtc-establishment': {
    owner: 'client/rtc/rtc-session.ts',
    boundary: 'browser rtc.offer/offerStatus RPC and fake RTCPeerConnection',
    event: (code) => (code === 'outcome_unknown' ? 'retry_unit' : 'rtc'),
    create: driveRtc('browser'),
    identity: (input) => (input as { params: { attemptId: string } }).params.attemptId,
    conflict: (previous, next) =>
      assert.notEqual(
        (previous as { params: { attemptId: string } }).params.attemptId,
        (next as { params: { attemptId: string } }).params.attemptId,
        'conflict creates a fresh native RTC offer',
      ),
  },
  'service-rtc-establishment': {
    owner: 'client/rtc/rtc-session.ts',
    boundary: 'service.offer/offerStatus RPC and fake RTCPeerConnection',
    event: (code) => (code === 'outcome_unknown' ? 'retry_unit' : 'rtc'),
    create: driveRtc('service'),
    identity: (input) => (input as { params: { attemptId: string } }).params.attemptId,
    conflict: (previous, next) =>
      assert.notEqual(
        (previous as { params: { attemptId: string } }).params.attemptId,
        (next as { params: { attemptId: string } }).params.attemptId,
        'conflict creates a fresh native RTC offer',
      ),
  },
  'rtc-offer-status-reconciliation': {
    owner: 'client/rtc/rtc-session.ts',
    boundary: 'rtc.offerStatus after a lost offer response',
    event: (code) =>
      ['busy', 'unavailable', 'rate_limited', 'outcome_unknown'].includes(code) ? 'retry_unit' : 'rtc',
    create: driveRtc('browser', 'status'),
    startup: 1000,
    initialAttempt: (code) =>
      ['busy', 'unavailable', 'rate_limited', 'outcome_unknown'].includes(code) ? 1 : 0,
    identity: (input) => (input as { params: { attemptId: string } }).params.attemptId,
  },
  'product-admission-submission': {
    owner: 'client/control/operations-store.ts',
    boundary: 'OperationsPort.submit/status',
    event: (code) => (code === 'outcome_unknown' ? 'operation_query' : 'operation_submission'),
    create: driveOperations('submission'),
    callScoped: true,
    identity: (input) => {
      const { operationId, operationGeneration } = (
        input as { operation: { operationId: string; operationGeneration: string } }
      ).operation;
      return { operationId, operationGeneration };
    },
  },
  'product-receipt-queries': {
    owner: 'client/control/operations-store.ts',
    boundary: 'OperationsPort.status',
    event: 'operation_query',
    create: driveOperations('query'),
    callScoped: true,
  },
  'media-feedback-recovery': {
    owner: 'client/media/observations.ts',
    boundary: 'feedback RPC after real capture/paint samples',
    event: 'retry_unit',
    create: driveMediaFeedback,
    startup: 2500,
    callScoped: true,
    conflict: (previous, next) =>
      assert.notEqual(
        (previous as { sequence: number }).sequence,
        (next as { sequence: number }).sequence,
        'conflict produces a fresh measured report',
      ),
    retryAfterMs: { busy: 2500, rate_limited: 2500, unavailable: 2500 },
    cadence: (code) => (code === 'conflict' ? 2000 : 0),
  },
  'rtc-stats-feedback-control-endpoint-clock-probes': {
    owner: 'client/media/observations.ts',
    boundary: 'RTCPeerConnection.getStats',
    event: 'retry_unit',
    create: driveMediaStats,
    callScoped: true,
  },
  'clock-probe-recovery': {
    owner: 'client/media/clock-domain.ts',
    boundary: 'clock.ping reply',
    event: 'retry_unit',
    create: driveClockProbe,
  },
  'idle-monitoring-autolock': {
    owner: 'client/auth/idle-policy.ts',
    boundary: 'IdleDetector.start',
    event: 'idle.monitor',
    create: driveIdle,
  },
  'imap-round-and-retained-messages': {
    owner: 'server/session-import/mailbox.ts',
    boundary: 'MailClient.connect',
    event: 'session_import.mailbox',
    create: driveImports('mailbox'),
  },
  'recipient-event-envelopes': {
    owner: 'server/session-import/outbox.ts',
    boundary: 'SMTP sendMail with decrypted recipient envelope identity',
    event: 'session_import.outbox',
    create: driveImports('outbox'),
  },
  'pair-verification': {
    owner: 'server/session-import/importer.ts',
    boundary: 'AuthAttempts.run password verification',
    event: 'session_import.pair',
    create: driveImports('pair'),
  },
  'pending-imports-per-tenant': {
    owner: 'server/session-import/importer.ts',
    boundary: 'SessionImportsRepository.payload',
    event: 'session_import.apply',
    create: driveImports('record'),
  },
  'retention-outbox-pending-tenant-dispatcher': {
    owner: 'server/session-import/importer.ts',
    boundary: 'SQLite retention statement',
    event: 'session_import.dispatch',
    create: driveImports('dispatch'),
  },
  'pending-import-tenant-dispatch': {
    owner: 'server/session-import/importer.ts',
    boundary: 'SQLite pending imports query',
    event: 'session_import.tenant_dispatch',
    create: driveImports('tenant'),
  },
  'storage-import-chunk-admission-status': {
    owner: 'server/session-import/importer.ts',
    boundary: 'Endpoint storage import admission/status',
    event: 'retry_unit',
    create: driveImports('chunk'),
    callScoped: true,
    retryAfterMs: { rate_limited: 1000 },
  },
  'local-endpoint-launch-install': {
    owner: 'server/cluster/node-link.ts',
    boundary: 'child_process.spawn installer with fake authenticated stdio Endpoint',
    event: 'node.launch',
    create: driveLaunch,
  },
  'xinjiaoyu-read-callback': {
    owner: 'server/learning/providers/xinjiaoyu/client.ts',
    boundary: 'fetch',
    event: 'retry_unit',
    create: driveXinjiaoyu,
    callScoped: true,
  },
  'provider-read-callback': {
    owner: 'server/learning/providers/http.ts',
    boundary: 'provider callback',
    event: 'retry_unit',
    create: driveProviderRead,
    callScoped: true,
  },
  'learning-read-with-credential-renewal': {
    owner: 'server/learning/accounts.ts',
    boundary: 'provider read callback',
    event: 'learning.account_read',
    create: driveLearningRead,
    callScoped: true,
  },
  'login-captcha-renewal-step': {
    owner: 'server/learning/sign-in.ts',
    boundary: 'AuthClient.captchaPolicy',
    event: 'learning.step',
    create: driveSignIn,
    callScoped: true,
  },
  'security-capabilities': {
    owner: 'server/auth/viewer-security.ts',
    boundary: 'ServicePeers.faceCapabilities',
    event: 'security.capabilities',
    create: driveSecurity('capabilities'),
  },
  'security-authorization': {
    owner: 'server/auth/viewer-security.ts',
    boundary: 'EndpointGateway.published authorization',
    event: 'security.authorization',
    create: driveSecurity('authorization'),
  },
  'device-clipboard-read': {
    owner: 'client/clipboard/device-clipboard.ts',
    boundary: 'navigator.clipboard.readText',
    event: 'clipboard.read',
    create: driveClipboard('read'),
  },
  'device-clipboard-outbound': {
    owner: 'client/clipboard/device-clipboard.ts',
    boundary: 'clipboard.set RPC',
    event: 'clipboard.outbound',
    create: driveClipboard('outbound'),
  },
  'admin-import-state-polling': {
    owner: 'client/app/admin/shared.tsx',
    boundary: 'admin resource load callback',
    event: 'admin_poll',
    create: driveReact('admin'),
  },
  'background-import-state-polling': {
    owner: 'client/failures/background.ts',
    boundary: 'sessionImport.state RPC',
    event: 'retry_unit',
    create: driveReact('background'),
    callScoped: true,
    presentation: true,
  },
  'launcher-app-inspection-learning-snippet-image-reads': {
    owner: 'client/learning/queries.ts',
    boundary: 'learning query loader',
    event: 'recovery',
    create: driveReact('query'),
    callScoped: true,
  },
  'reconciler-objects-service-peers-endpoint-ready-reconciliation': {
    owner: 'server/application.ts',
    boundary: 'Reconciler.tick',
    event: 'background.run',
    create: driveApplication('reconciler'),
  },
  'application-object-maintenance': {
    owner: 'server/application.ts',
    boundary: 'ObjectIndex.tick',
    event: 'background.run',
    create: driveApplication('objects'),
  },
  'application-service-peer-maintenance': {
    owner: 'server/application.ts',
    boundary: 'ServicePeers.tick',
    event: 'background.run',
    create: driveApplication('servicePeers'),
  },
  'application-endpoint-ready': {
    owner: 'server/application.ts',
    boundary: 'Reconciler.endpointReady',
    event: 'background.run',
    create: driveApplication('endpointReady'),
  },
  'product-reconciliation-per-tenant': {
    owner: 'server/workspace/reconciler.ts',
    boundary: 'EndpointGateway.published',
    event: 'reconciler.product',
    create: driveReconciler('product'),
  },
  'reconnect-process-change-reconciliation': {
    owner: 'server/workspace/reconciler.ts',
    boundary: 'EndpointGateway.published after endpointReady',
    event: 'reconciler.product',
    create: driveReconciler('reconnect'),
  },
  'pending-site-ua-reload': {
    owner: 'server/workspace/reconciler.ts',
    boundary: 'EndpointGateway.command(reload)',
    event: 'reconciler.product',
    create: driveReconciler('ua'),
  },
  'dwell-flush-presence-pruning-heartbeat': {
    owner: 'server/workspace/reconciler.ts',
    boundary: 'ControlDatabase.reclaim.tick',
    event: 'reclaim.statistics',
    create: driveReconciler('reclaim'),
  },
  'node-fencing-document': {
    owner: 'server/cluster/node-link.ts',
    boundary: 'encrypted node.desired response',
    event: 'node.coordination',
    create: driveNodeCoordination,
    conflict: (previous, next) =>
      assert.notEqual(
        (previous as { revision: string }).revision,
        (next as { revision: string }).revision,
        'conflict recomputes the fencing document revision',
      ),
  },
  'upload-process-commit-photo-task': {
    owner: 'client/files/photo-job-store.ts',
    boundary: 'FileChannel.processPhoto',
    event: 'retry_unit',
    create: drivePhoto,
    startup: 600,
    inputDelay: 600,
  },
  'automatic-presence-verification-challenge': {
    owner: 'client/auth/auth-camera-session.ts',
    boundary: 'auth.face.begin RPC',
    event: 'auth_camera',
    create: driveCamera,
  },
  'input-drain-and-focus-acknowledgment': {
    owner: 'client/input/input-pipeline.ts',
    boundary: 'RTC data channel focus result',
    event: 'input.focus',
    create: driveFocus,
    callScoped: true,
  },
  'node-object-inventory-reconciliation': {
    owner: 'server/cluster/objects.ts',
    boundary: 'NodeLink.request(object.inventory)',
    event: 'objects.background',
    create: driveObjects('inventory'),
  },
  'object-claim-orphan-gc': {
    owner: 'server/cluster/objects.ts',
    boundary: 'NodeLink.request(object.delete)',
    event: 'object_cleanup',
    create: driveObjects('gc'),
  },
  'disk-relief-cold-copies-replica-migration-deletion': {
    owner: 'server/cluster/objects.ts',
    boundary: 'NodeLink.request(session.cold.delete)',
    event: 'object_cleanup',
    create: driveObjects('relief'),
  },
  'missing-object-replicas': {
    owner: 'server/cluster/objects.ts',
    boundary: 'NodeLink.request(object.fetch)',
    event: 'replica',
    create: driveObjects('replica'),
  },
  'document-conversion-per-source-build': {
    owner: 'server/cluster/objects.ts',
    boundary: 'NodeLink.request(object.render)',
    event: 'render',
    create: driveObjects('render'),
  },
  'study-collection': {
    owner: 'server/learning/study-sync.ts',
    boundary: 'StudyService.collect',
    event: 'learning.collection',
    create: driveStudy('collection'),
    conflict: (previous, next) =>
      assert.notEqual(
        (previous as { cutoff: number }).cutoff,
        (next as { cutoff: number }).cutoff,
        'conflict recomputes the collection cutoff',
      ),
  },
  'attachment-save-download': {
    owner: 'server/learning/study-sync.ts',
    boundary: 'StudyService.resolve',
    event: 'learning.attachment',
    create: driveStudy('attachment'),
  },
  'attachment-retention': {
    owner: 'server/learning/study-sync.ts',
    boundary: 'FileLibrary.expireStudyEntry',
    event: 'learning.retention',
    create: driveStudy('retention'),
  },
  'face-status-and-revocations': {
    owner: 'server/auth/viewer-security.ts',
    boundary: 'ServicePeers.faceStatus',
    event: 'security.face_status',
    create: driveSecurity('status'),
  },
  'retiring-media-peer-revocation': {
    owner: 'server/auth/viewer-security.ts',
    boundary: 'EndpointGateway.published',
    event: 'security.authorization',
    create: driveSecurity('revocation'),
  },
  'generic-background-job': {
    owner: 'server/background.ts',
    boundary: 'job callback',
    event: 'matrix.background',
    create: driveBackground,
  },
  'desired-clipboard-publication-per-tenant': {
    owner: 'server/endpoint/gateway.ts',
    boundary: 'NodeLink.publish',
    event: 'session.publication',
    create: drivePublication,
  },
  'session-deletion-per-node-session-id': {
    owner: 'server/cluster/session-purge.ts',
    boundary: 'NodeLink.request(session.delete)',
    event: 'session_purge.delete',
    create: drivePurge,
  },
  'durable-session-event-delivery': {
    owner: 'server/workspace/session-events.ts',
    boundary: 'EndpointGateway.acknowledge',
    event: 'session.event',
    create: driveEventDelivery,
  },
  'browser-rtc-retirement': {
    owner: 'server/viewers/rtc-signaling.ts',
    boundary: 'EndpointGateway.closeRtc',
    event: 'rtc.close',
    create: driveRtcRetirement,
  },
  'generic-recovery-callback': {
    owner: 'client/failures/recovery.ts',
    boundary: 'read callback',
    event: 'recovery',
    create: driveRecovery,
    callScoped: true,
  },
  'thumbnail-per-subscribed-asset': {
    owner: 'client/files/file-thumbnails.ts',
    boundary: 'thumbnail loader',
    event: 'retry_unit',
    create: driveThumbnails,
    callScoped: true,
  },
  'document-conversion-open-and-page-resource-mounting': {
    owner: 'client/documents/channel-source.ts',
    boundary: 'FileChannel.documentOpen',
    event: 'retry_unit',
    create: driveDocument,
    callScoped: true,
  },
  'latest-viewport-publication': {
    owner: 'client/control/viewport-requests.ts',
    boundary: 'viewport RPC',
    event: 'viewport',
    create: driveViewport,
    startup: 100,
  },
  'upload-then-library-import-per-queued-file': {
    owner: 'client/files/import-queue.ts',
    boundary: 'FileChannel.uploadAsset',
    event: 'retry_unit',
    create: driveImportQueue,
    callScoped: true,
  },
  'upstream-http-read-provider-read-callback': {
    owner: 'server/learning/providers/http.ts',
    boundary: 'fetch',
    event: 'retry_unit',
    create: driveHttpRead,
    callScoped: true,
  },
  'device-clipboard-synchronization': {
    owner: 'client/clipboard/device-clipboard.ts',
    boundary: 'navigator.clipboard.writeText',
    event: 'clipboard.inbound',
    create: driveClipboard('inbound'),
  },
};

const root = fileURLToPath(new URL('../', import.meta.url));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

export function creationSites() {
  return ['server', 'client']
    .flatMap((directory) => sources(join(root, directory)))
    .flatMap((path) => {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const counts = new Map<string, number>();
      const constructors = new Map(['RetryUnit', 'RetryLedger', 'BackgroundJob'].map((name) => [name, name]));
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const entry of bindings.elements) {
            const name = entry.propertyName?.text ?? entry.name.text;
            if (constructors.has(name)) constructors.set(entry.name.text, name);
          }
      }
      const recoveryFactories = new Map(['recover', 'recoverRead'].map((name) => [name, name]));
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const entry of bindings.elements) {
            const name = entry.propertyName?.text ?? entry.name.text;
            if (recoveryFactories.has(name)) recoveryFactories.set(entry.name.text, name);
          }
      }
      const sites: string[] = [];
      const visit = (node: ts.Node) => {
        if (
          (ts.isNewExpression(node) && constructors.has(node.expression.getText(source))) ||
          (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            constructors.has(node.expression.expression.getText(source)) &&
            ['create', 'from', 'restore'].includes(node.expression.name.text)) ||
          (ts.isCallExpression(node) && recoveryFactories.has(node.expression.getText(source)))
        ) {
          const factory = ts.isNewExpression(node)
            ? constructors.get(node.expression.getText(source))!
            : (recoveryFactories.get(node.expression.getText(source)) ?? node.expression.getText(source));
          const count = (counts.get(factory) ?? 0) + 1;
          counts.set(factory, count);
          sites.push(relative(root, path).split('\\').join('/') + '#' + factory + ':' + count);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return sites;
    });
}

function assertDriverSyntax(syntax: ts.SourceFile, path: string, checker?: ts.TypeChecker) {
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      /retry-unit|retry-units/.test(node.moduleSpecifier.getText(syntax))
    )
      assert.fail(`${path}: driver imports retry machinery`);
    if (ts.isIdentifier(node) && ['RetryUnit', 'RetryLedger'].includes(node.text))
      assert.fail(`${path}: driver accesses retry machinery`);
    if (ts.isStringLiteral(node) && /retry-unit(?:s)?(?:\.|$)/.test(node.text))
      assert.fail(`${path}: driver loads retry machinery`);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = node.expression;
      const type = checker?.getTypeAtLocation(receiver);
      const types = type?.isUnion() ? type.types : type ? [type] : [];
      const member = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression?.getText(syntax).replace(/['"]/g, '');
      if (
        (types.some((type) => ['RetryUnit', 'RetryLedger'].includes(type.getSymbol()?.name ?? '')) &&
          !['error', 'state', 'identity'].includes(member ?? '')) ||
        (/\.(retry|unit)(\.current)?$/.test(receiver.getText(syntax).replace(/\[['"](\w+)['"]\]/g, '.$1')) &&
          ['ready', 'fail', 'succeed', 'execute', 'schedule', 'cancel', 'wait', 'restore'].includes(
            member ?? '',
          ))
      )
        assert.fail(`${path}: driver invokes retry machinery directly`);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
}

export function assertOwnerDriver(source: string, path: string) {
  assertDriverSyntax(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true), path);
}

test('drivers cannot import or manipulate retry machinery', () => {
  const registry = ts.createSourceFile(
    'retry-loops.test.ts',
    readFileSync(new URL(import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const factories = new Set<string>();
  for (const statement of registry.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/\/retry-loop-.*drivers$/.test(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const entry of bindings.elements) factories.add(entry.name.text);
  }
  const declaration = registry.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((entry) => entry.name.getText(registry) === 'retryLoops');
  assert(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer));
  for (const entry of declaration.initializer.properties) {
    assert(ts.isPropertyAssignment(entry) && ts.isObjectLiteralExpression(entry.initializer));
    const create = entry.initializer.properties.find(
      (property) => property.name?.getText(registry) === 'create',
    );
    assert(create && ts.isPropertyAssignment(create));
    const factory = ts.isCallExpression(create.initializer)
      ? create.initializer.expression
      : create.initializer;
    assert(
      ts.isIdentifier(factory) && factories.has(factory.text),
      `${entry.name.getText(registry)} must use an inspected owner driver`,
    );
    if (ts.isCallExpression(create.initializer))
      for (const argument of create.initializer.arguments) {
        assert(
          ts.isStringLiteral(argument) ||
            argument.kind === ts.SyntaxKind.TrueKeyword ||
            argument.kind === ts.SyntaxKind.FalseKeyword,
          'driver configuration cannot inject retry machinery',
        );
      }
  }
  const files = sources(join(root, 'test')).filter((path) => /retry-loop-.*drivers\.ts$/.test(path));
  const options = ts.parseJsonConfigFileContent(
    ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config,
    ts.sys,
    root,
  ).options;
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const visited = new Set<string>();
  const inspect = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const syntax = program.getSourceFile(file);
    assert(syntax, file);
    assertDriverSyntax(syntax, file, checker);
    for (const statement of syntax.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const dependency = ts.resolveModuleName(statement.moduleSpecifier.text, file, options, ts.sys)
        .resolvedModule?.resolvedFileName;
      if (
        dependency &&
        relative(join(root, 'test'), dependency).split(/[\\/]/)[0] !== '..' &&
        !dependency.includes('node_modules')
      )
        inspect(dependency);
    }
  };
  for (const file of files) inspect(file);
  assert.throws(() =>
    assertOwnerDriver(
      "import { RetryUnit as R } from '../shared/retry-unit'; new R().fail(error)",
      'shortcut.ts',
    ),
  );
  assert.throws(() => assertOwnerDriver('owner.retry.fail(error)', 'shortcut.ts'));
  assert.throws(() => assertOwnerDriver('const fail = owner.retry.fail; fail(error)', 'shortcut.ts'));
  assert.throws(() => assertOwnerDriver("owner['retry']['fail'](error)", 'shortcut.ts'));
});

test('owner dependency mocks release nested replacements and the mocked clock', (t) => {
  const interval = globalThis.setInterval;
  const date = globalThis.Date;
  const target = { read: () => 'original' };
  const read = target.read;
  const mocks = ownerMocks(t);
  mocks.context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  mocks.context.mock.method(globalThis, 'setInterval', interval);
  mocks.context.mock.method(globalThis, 'setInterval', interval);
  mocks.context.mock.method(target, 'read', () => 'first owner');
  mocks.context.mock.method(target, 'read', () => 'second owner');
  mocks.restore();
  assert.equal(globalThis.setInterval, interval);
  assert.equal(globalThis.Date, date);
  assert.equal(target.read, read);
});

test('the registry covers the actual audit D inventory', () => {
  const audit = readFileSync(
    new URL('../../develop/tmp/codex-fps/auditc.result.md', import.meta.url),
    'utf8',
  );
  const section = audit.split('**D inventory**')[1];
  assert(section, 'missing D inventory');
  const rows = section.split('\n').filter((line) => /^\| `/.test(line));
  const names = rows.map((row) =>
    row
      .split('|')[2]!
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
  );
  assert.deepEqual(
    names.sort(),
    Object.keys(auditLoops)
      .filter((name) => name !== 'browser-rtc-retirement')
      .sort(),
    'audit changed; update inventory bindings',
  );
  const missing = [...names, 'browser-rtc-retirement'].filter((name) => !retryLoops[name]);
  assert.deepEqual(missing, [], 'every audited loop needs a real owner driver');
});

test('every retry creation or durable/background factory has a registered owner driver', () => {
  assert.deepEqual(
    creationSites().sort(),
    Object.keys(creationBindings).sort(),
    'new retry creation needs a named registry binding',
  );
  const missing = [...new Set(Object.values(creationBindings).flat())].filter((name) => !retryLoops[name]);
  assert.deepEqual(missing, [], 'retry factories must be exercised through their actual owners');
});

const retryable = new Set<ErrorCode>(['busy', 'rate_limited', 'unavailable', 'conflict', 'outcome_unknown']);
function delay(code: ErrorCode, attempt: number) {
  return code === 'busy'
    ? Math.min(5000, 250 * 2 ** attempt)
    : code === 'rate_limited'
      ? 30000
      : Math.min(300000, 1000 * 2 ** attempt);
}
for (const [name, binding] of Object.entries(retryLoops))
  for (const code of Object.keys(httpStatus) as ErrorCode[]) {
    test(`${name}: ${code} through ${binding.boundary}`, async (t) => {
      const mocks = ownerMocks(t);
      t = mocks.context;
      t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000000000 });
      t.mock.method(Math, 'random', () => 0.5);
      const logs = observeLogs(t, typeof binding.event === 'function' ? binding.event(code) : binding.event);
      const boundary = new FailingBoundary();
      boundary.code = code;
      boundary.retryAfterMs = binding.retryAfterMs?.[code];
      const retryDelay = (attempt: number) =>
        Math.max(
          binding.cadence?.(code) ?? 0,
          boundary.retryAfterMs ?? delay(code, attempt + (binding.initialAttempt?.(code) ?? 0)),
        );
      let owner = await binding.create(boundary, t);
      const advance = async (milliseconds: number) => {
        if (owner.advance) await owner.advance(milliseconds);
        else t.mock.timers.tick(milliseconds);
      };
      const drive = async () => {
        if (binding.join || boundary.attempts[boundary.attempts.length - 1]?.at !== Date.now())
          await owner.drive();
      };
      let retired = false;
      t.after(async () => {
        try {
          if (!retired) await owner.dispose();
          await settle();
        } finally {
          mocks.restore();
        }
      });
      await owner.start();
      await advance(binding.startup ?? 0);
      await settle();
      assert.equal(
        boundary.attempts.length,
        1,
        'the actual dependency was called once: ' + JSON.stringify(owner.error()),
      );
      assert.equal(
        logs.warnings.length,
        code === 'canceled' || binding.oneShot ? 0 : 1,
        'one failure log starts the streak; cancellation and one-shot work have no retry streak',
      );
      const first = boundary.attempts[0];
      if (retryable.has(code) && !binding.stopOn?.includes(code) && !binding.oneShot) {
        await advance(retryDelay(0) - 1);
        await drive();
        await settle();
        assert.equal(boundary.attempts.length, 1, 'owner must enforce the deadline');
        await advance(1);
        await drive();
        await settle();
        assert.equal(boundary.attempts.length, 2, 'owner must retry at the deadline');
        assert.equal(boundary.attempts[1].at - first.at, retryDelay(0));
        if (code === 'outcome_unknown')
          assert.deepEqual(
            binding.identity?.(boundary.attempts[1].input) ?? boundary.attempts[1].input,
            binding.identity?.(first.input) ?? first.input,
            'uncertain work retains its identity and revision',
          );
        if (code === 'conflict') binding.conflict?.(first.input, boundary.attempts[1].input);
        assert.equal(logs.warnings.length, 1, 'attempts do not repeat warnings');
        await advance(retryDelay(1) - 1);
        await drive();
        await settle();
        assert.equal(boundary.attempts.length, 2, 'the second deadline grows');
        boundary.code = undefined;
        await advance(1);
        await drive();
        await settle();
        assert.equal(boundary.attempts.length, 2 + (binding.successCalls ?? 1));
        if (binding.recoveryDelay) {
          await advance(binding.recoveryDelay);
          await settle();
        }
        assert.equal(logs.recoveries.length, 1);
        assert.equal(owner.error(), undefined);
        const recovered = boundary.attempts.length;
        boundary.code = code;
        await owner.drive();
        await settle();
        if (boundary.attempts.length === recovered) {
          await owner.changeInput();
          await advance(binding.inputDelay ?? binding.startup ?? 0);
          await settle();
        }
        if (boundary.attempts.length === recovered) {
          // Completed work releases its unit; another actual owner starts the next unit.
          await owner.dispose();
          owner = await binding.create(boundary, t);
          await owner.start();
          await advance(binding.startup ?? 0);
          await settle();
        }
        assert.equal(boundary.attempts.length, recovered + 1, 'the next real work item starts a new streak');
        assert.equal(logs.warnings.length, 2, 'recovery resets the failure streak');
        const again = boundary.attempts[recovered];
        await advance(retryDelay(0) - 1);
        await drive();
        await settle();
        assert.equal(boundary.attempts.length, recovered + 1, 'the reset deadline is enforced');
        boundary.code = undefined;
        await advance(1);
        await drive();
        await settle();
        assert.equal(
          boundary.attempts[recovered + 1]?.at - again.at,
          retryDelay(0),
          'success resets delay growth',
        );
        if (binding.recoveryDelay) {
          await advance(binding.recoveryDelay);
          await settle();
        }
        assert.equal(logs.recoveries.length, 2);
      } else {
        if (code !== 'canceled') {
          if (binding.presentation || (code === 'not_found' && binding.dropAsResult))
            assert(owner.error(), 'the owner presents the final/dropped result');
          else
            assert.equal(
              (owner.error() as { code?: string } | undefined)?.code,
              code,
              'the owner surfaces a final/dropped result',
            );
        }
        await advance(86400000);
        await drive();
        await settle();
        assert.equal(boundary.attempts.length, 1, 'final and dropped units do not retry');
        boundary.code = undefined;
        await owner.changeInput();
        await advance(binding.inputDelay ?? binding.startup ?? 0);
        await settle();
        assert.equal(
          boundary.attempts.length,
          1 + (binding.successCalls ?? 1),
          'changed owner input permits work',
        );
        if (binding.recoveryDelay) {
          await advance(binding.recoveryDelay);
          await settle();
        }
        assert.equal(owner.error(), undefined);
        const scoped =
          typeof binding.callScoped === 'function' ? binding.callScoped(code) : binding.callScoped;
        assert.equal(logs.recoveries.length, scoped || code === 'canceled' ? 0 : 1);
      }
      await owner.dispose();
      retired = true;
      const completed = boundary.attempts.length;
      await advance(86400000);
      await settle();
      assert.equal(boundary.attempts.length, completed, 'retirement releases the owner timers and work');
    });
  }

test('an import time budget records unknown and resumes the same chunk identity through its tenant owner', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000000000 });
  t.mock.method(Math, 'random', () => 0.5);
  observeLogs(t, 'session_import.apply');
  const boundary = new FailingBoundary();
  boundary.code = 'rate_limited';
  const owner = await driveImports('chunk')(boundary, t);
  t.after(async () => {
    await owner.dispose();
    await settle();
  });
  await owner.start();
  await settle();
  t.mock.timers.tick(30000);
  await settle();
  assert.equal(boundary.attempts.length, 2);
  t.mock.timers.tick(30000);
  await settle();
  assert.equal((owner.error() as { code: string }).code, 'outcome_unknown');
  boundary.code = undefined;
  t.mock.timers.tick(999);
  await owner.drive();
  await settle();
  assert.equal(boundary.attempts.length, 2);
  t.mock.timers.tick(1);
  await owner.drive();
  await settle();
  assert.equal(boundary.attempts.length, 3);
  assert.deepEqual(boundary.attempts[2].input, boundary.attempts[0].input);
  assert.equal(owner.error(), undefined);
});
