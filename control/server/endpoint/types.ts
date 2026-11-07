import type { AppliedMediaPolicy, OperationReceipt, ProductOperation } from '../../shared/product';
export interface RtcSignal {
  tenantId: string;
  connectionId: string;
  signal:
    | { type: 'answer'; sdp: string }
    | { type: 'ice'; candidate: { candidate: string; sdpMid: string; sdpMLineIndex: number } }
    | { type: 'complete' }
    | { type: 'error'; message: string };
}
export type ClientActionEvent = ProductOperation & {
  tenantId: string;
  connectionId: string;
  authEpoch?: number;
};

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
export interface ViewSnapshot {
  viewId: string;
  instance?: string;
  document?: string;
  url?: string;
  title?: string;
  actual?: number;
  desired?: number;
  pending?: boolean;
  visible?: boolean;
  canDiscard?: boolean;
  audible?: boolean;
  captured?: boolean;
  pending_close?: boolean;
  close_state?: string;
  lifecycle_uncertain?: boolean;
  lifecycle_generation?: string;
  recovery?: { pending?: boolean; phase?: string; error?: string };
  pageRequests?: { pending?: Record<string, unknown>[]; fullscreen?: Record<string, unknown> };
  navigationOperations?: Record<string, unknown>[];
  provisional?: boolean;
  [key: string]: unknown;
}
// Raw log names an Endpoint serves for diagnostics: this Session's Browser log
// and the node's Endpoint log with its first rotation.
export type EndpointLogName = 'browser' | 'endpoint' | 'endpoint.1';
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
}
export interface EndpointSnapshot {
  hibernation?: {
    unacknowledgedClosedEvents: number;
    pendingNativeSelections: number;
    inFlightUploads: number;
    pendingPageRequests: number;
    downloadsInProgress: number;
    rtcConnected: boolean;
    lifecycleUncertain: boolean;
  };
  running?: boolean;
  browserIncarnation?: string;
  browserPid?: number;
  views: ViewSnapshot[];
  rtc?: { active: boolean; connectionId?: string; avSync?: boolean | null };
  stats?: { mediaPolicy?: { applied?: AppliedMediaPolicy | null }; [key: string]: unknown };
  events?: Record<string, unknown>[];
  pendingPopups?: Record<string, unknown>[];
  [key: string]: unknown;
}
export interface ViewConfiguration {
  viewId: string;
  width?: number;
  height?: number;
  device?: { mode: string; deviceScaleFactor: number };
  visible: boolean;
  requireRunning?: boolean;
}
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
  reason?: string;
}

export interface PageIdentity {
  viewId: string;
  browserIncarnation: string;
  instance: string;
  document: string;
}
export interface FileBinding {
  browserIncarnation: string;
  view: string;
  instance: string;
  document: string;
  request: string;
}
export interface ActionResult {
  connectionId: string;
  authEpoch?: number;
  operationId: string;
  operationGeneration: string;
  ok: boolean;
  result: OperationReceipt;
}
export interface FileAuthorization {
  connectionId: string;
  requests: { id: string; binding: FileBinding }[];
  library: boolean;
  authEpoch: number;
}
export interface PrepareSelection {
  selectionId: string;
  requestId: string;
  binding: FileBinding;
  files: { assetId: string; name: string; type: string }[];
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
