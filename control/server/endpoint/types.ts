import type { FileRequest } from '../../shared/product';
import type {
  AppliedMediaPolicy,
  OperationReceipt,
  PageDialogReply,
  SitePreferences,
} from '../../shared/product';
import type { ErrorCode, NativeErrorReason, WireError } from '../../shared/errors';
export type NativeError = WireError & { reason?: NativeErrorReason };
export type ClipboardChangedEvent = {
  type: 'clipboard.changed';
  tenantId: string;
  sessionId: string;
  browserSequence: string;
  baseRevision: string;
  viewId?: string;
  excludeFromHistory?: boolean;
} & (
  { oversize: true; textBytes: number; htmlBytes: number } | { oversize?: false; text: string; html: string }
);
export interface RtcSignal {
  tenantId: string;
  connectionId: string;
  signal:
    | { type: 'answer'; sdp: string }
    | { type: 'ice'; candidate: { candidate: string; sdpMid: string; sdpMLineIndex: number } }
    | { type: 'complete' }
    | { type: 'error'; error: NativeError };
}
export interface Accepted {
  accepted: boolean;
  browser?: { ok?: boolean };
  result?: { ok?: boolean };
  applied?: boolean;
  completed?: boolean;
  generation?: string;
  connectionId?: string;
  epoch?: number;
  closed?: boolean;
  pending?: boolean;
  requestId?: string;
  [key: string]: unknown;
}
export type ViewSnapshot = import('./coordination').ObservedView;
// Raw log names an Endpoint serves for diagnostics: this Session's Browser log
// and the node's Endpoint log with its first rotation.
export type EndpointLogName = 'browser' | 'endpoint' | 'endpoint.1' | 'crashes' | `dump/${string}`;
export interface LogWindowRequest {
  log: EndpointLogName;
  end?: number;
  maxBytes: number;
}
export interface LogWindow {
  exists: boolean;
  size: number;
  start: number;
  end: number;
  data: string;
  dumps?: { name: string; size: number }[];
}
export interface EndpointSnapshot {
  status?: NativeError | null;
  browserRestart?: 'ready' | 'waiting' | 'exhausted';
  stopBlockers?: {
    unacknowledgedEvents: number;
    pendingNativeSelections: number;
    inFlightUploads: number;
    pendingPageRequests: number;
    downloadsInProgress: number;
    pendingDownloadImports: number;
    rtcConnected: boolean;
    lifecycleUncertain: boolean;
  };
  running?: boolean;
  browserIncarnation?: string;
  browserPid?: number;
  views: ViewSnapshot[];
  rtc?: { active: boolean; connectionId?: string; avSync?: boolean | null };
  stats?: {
    allocationPressure?: boolean;
    mediaPolicy?: { applied?: AppliedMediaPolicy | null };
    [key: string]: unknown;
  };
  pendingPopups?: import('./coordination').PendingPopup[];
  [key: string]: unknown;
}
export type DownloadEvent = {
  eventId: string;
  name: string;
  origin: string;
} & (
  | { type: 'download.imported'; assetId: string; mimeType: string; size: string }
  | { type: 'download.failed'; error: NativeError }
);
export interface OperationIdentity {
  operationId?: string;
  operationGeneration?: string;
  operationSequence?: string;
  browserIncarnation?: string;
}
export interface FaceBinding {
  connectionId: string;
  epoch: number;
  challengeId: string;
}
export interface FaceStatusReply {
  challengeId: string;
  status: string;
  template?: number[];
  error?: NativeError;
  outcome?: 'no_matching_face' | 'camera_unavailable';
}

export interface PageIdentity {
  viewId: string;
  browserIncarnation: string;
  instance: string;
  document: string;
}
export interface SessionSitePreferencesRequest {
  sites: Record<string, Pick<SitePreferences, 'permissions' | 'protocolHandlers'> & { tabletUa?: true }>;
}
export type PageReplyFields =
  | {
      decision: Extract<PageDialogReply, { kind: 'permission' }>['decision'];
      accept?: never;
      text?: never;
      username?: never;
      password?: never;
    }
  | { accept: boolean; text?: string; decision?: never; username?: never; password?: never }
  | { accept: true; username: string; password: string; decision?: never; text?: never };
export type PageReplyRequest = PageIdentity & { requestId: string } & PageReplyFields;
export interface FileBinding {
  browserIncarnation: string;
  view: string;
  instance: string;
  document: string;
  request: string;
}
export interface PrepareSelection {
  selectionId: string;
  requestId: string;
  binding: FileBinding;
  files: { assetId: string; name: string; type: string }[];
  limits: FileRequest['limits'];
}
export interface LifecycleRequest {
  viewId: string;
  action: string;
  requireRunning?: boolean;
  browserIncarnation?: string;
  lifecycleGeneration?: string;
}
export interface ViewAppInfo {
  title: string;
  url: string;
  manifest?: {
    name?: string;
    shortName?: string;
    startUrl?: string;
    scope?: string;
    themeColor?: string;
    display?: string;
  };
  icon?: { png: string; width: number; height: number };
}
