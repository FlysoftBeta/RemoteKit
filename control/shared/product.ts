import type { WireError } from './errors';
import type { LibraryMethods } from './file-library';
import type { AuthMessage, AuthSocketMethods } from './security';
import type { DiagnosticMethods } from './diagnostics';
/** Persistent product state belongs to Control; clients keep only an HttpOnly token. */
export interface ProductUser {
  id: string;
  username: string;
  isAdmin: boolean;
}
export type SearchEngine = 'google' | 'bing' | 'duckduckgo' | 'baidu';
export const SEARCH_ENGINES: { value: SearchEngine; label: string }[] = [
  { value: 'google', label: 'Google' },
  { value: 'bing', label: 'Bing' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'baidu', label: '百度' },
];
export interface ProductSettings {
  searchEngine: SearchEngine;
  qualityPreference: 'quality' | 'auto' | 'smooth';
  clientScaleOverride: number | null;
  memorySaverEnabled: boolean;
  showStats: boolean;
  autoFullscreen: boolean;
  avSync: boolean;
  audioChannels: { left: boolean; right: boolean };
}
export interface LifecycleRecovery {
  browserIncarnation: string;
  generation: string;
  phase: 'unload' | 'unloaded' | 'restore';
  submittedAt: number;
}
export type ProductTabKind = 'start' | 'files' | 'remote';
export const isLocalTab = (tab: Pick<ProductTab, 'kind'>) => tab.kind === 'start' || tab.kind === 'files';
export interface ProductTab {
  navigation?: {
    resolved?: boolean;
    browserIncarnation?: string;
    operationId: string;
    operationGeneration: string;
    status: 'applying' | 'unknown' | 'committed' | 'rejected';
    previousUrl: string;
    previousKind: ProductTabKind;
  };
  kind?: ProductTabKind;
  id: string;
  windowId: string;
  webviewId: string;
  title: string;
  url: string;
  pendingUrl?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  loading?: boolean;
  residency?: 'live' | 'frozen' | 'discarded' | 'unloaded';
  restoring?: boolean;
  lifecycleRecovery?: LifecycleRecovery;
  lifecycleRecoveryError?: string;
  pendingUaReloadOrigin?: string;
  popup?: { provisionalId: string; status: 'pending' | 'adopted' | 'failed'; error?: string };
}
export interface ProductWindow {
  id: string;
  activeTabId: string | null;
  weight: number;
}
/** Browser-local request IDs are never exposed as the user confirmation token. */
export interface PendingClose {
  id: string;
  windowId?: string;
  requestId?: string;
  nativeRequestId?: string;
  browserIncarnation?: string;
  instance?: string;
  document?: string;
  awaiting?: boolean;
}
export interface SitePreferences {
  tabletUa: boolean;
  manualKeyboard?: boolean;
}
export interface ProductWorkspace {
  tenantId: string;
  revision: number;
  tabs: ProductTab[];
  windows: ProductWindow[];
  activeWindowId: string | null;
  layoutMode: 'side-by-side' | 'focused';
  settings: ProductSettings;
  sites: Record<string, SitePreferences>;
  pendingClose?: PendingClose | null;
  pendingWindowCloseId?: string | null;
}
export interface PageDialog {
  id: string;
  tabId: string;
  windowId: string;
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt: string;
  origin: string;
  isReload?: boolean;
}
export const FILE_LIMITS = {
  maxFileBytes: 256 * 1024 * 1024,
  maxBatchBytes: 512 * 1024 * 1024,
  maxFiles: 64,
  sessionBytes: 1024 * 1024 * 1024,
} as const;
export interface FileRequestAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  instance: string;
  document: string;
  layoutGeneration: string;
}
export interface FileRequest {
  anchor?: FileRequestAnchor;
  id: string;
  tabId: string;
  windowId: string;
  origin: string;
  multiple: boolean;
  accept: string[];
  acceptTypesOmitted?: boolean;
  state: 'pending' | 'validating';
  limits: { maxFileBytes: number; maxBatchBytes: number; maxFiles: number; sessionBytes: number };
}
export type DegradationPreference = 'maintain-resolution' | 'balanced' | 'maintain-framerate';
export interface MediaPolicy {
  audio: boolean;
  degradationPreference: DegradationPreference;
  maxFps: number;
}
export interface AppliedMediaPolicy {
  audio: boolean;
  degradationPreference: DegradationPreference;
  maxFps: number;
}
export interface ProductFeedback {
  sequence: number;
  sourceCaptureId: string;
  sampledAtServerMs: number;
  visible: boolean;
  presentationLatencyMs: number;
  latencySource: 'capture-end-to-paint';
  clockUncertaintyMs: number;
  sampleCount: number;
  windowMs: number;
  displayHzEstimate?: number;
}
export interface ProductQuality {
  resourceLimitation: string | null;
  mode: 'product';
  preference: ProductSettings['qualityPreference'];
  clientScale: number;
  effectiveDpr: number;
  requested: MediaPolicy;
  applied: AppliedMediaPolicy | null;
  estimatedLatencyMs: number | null;
  clockUncertaintyMs: number | null;
  feedbackStatus: 'unknown' | 'valid' | 'stale';
  reason: string;
}
export interface PageFullscreen {
  tabId: string;
  windowId: string;
  target: string;
}
export interface ProductState {
  operationReceipts?: OperationReceipt[];
  serverIncarnation?: string;
  snapshotSequence?: number;
  operationGeneration?: string;
  user: ProductUser;
  workspace: ProductWorkspace;
  pageFullscreen?: PageFullscreen;
  pageDialogs: PageDialog[];
  fileRequests: FileRequest[];
  quality: ProductQuality;
  endpointGeneration: number;
  endpointError: string | null;
  viewer: { connected: boolean };
  integrations: { siteUa: boolean; lifecycle: boolean; popupAdoption: boolean };
  constraints: { clientScaleMin: number; clientScaleMax: number };
}
export type ProductAction =
  | { type: 'window.create'; url?: string; title?: string }
  | { type: 'window.activate' | 'window.close'; windowId: string }
  | {
      type: 'window.layout';
      mode: 'side-by-side' | 'focused';
      weights?: { windowId: string; weight: number }[];
    }
  | { type: 'tab.files'; windowId: string }
  | { type: 'tab.create'; windowId: string; url?: string; title?: string }
  | {
      type: 'tab.activate' | 'tab.close';
      tabId: string;
      requestId?: string;
      confirm?: boolean;
      cancel?: boolean;
    }
  | { type: 'tab.move'; tabId: string; windowId: string }
  | { type: 'tab.navigate'; tabId: string; url: string }
  | { type: 'tab.command'; tabId: string; command: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'settings.update'; settings: Partial<ProductSettings> }
  | { type: 'page.reply'; dialogId: string; accept: boolean; text?: string }
  | { type: 'page.exitFullscreen'; target: string }
  | ({ type: 'site.set'; origin: string; tabId?: string } & (
      { tabletUa: boolean; manualKeyboard?: boolean } | { tabletUa?: boolean; manualKeyboard: boolean }
    ));
export interface ViewerViewport {
  devicePixelRatio: number;
  refreshHz?: number;
  windows: { windowId: string; width: number; height: number; visible: boolean }[];
}
export interface ProductActionResult {
  state: ProductState;
  application?: { status: 'pending'; reason: string };
}
export type OperationStatus = 'accepted' | 'applying' | 'committed' | 'rejected' | 'unknown' | 'expired';
export interface ProductOperation {
  operationId: string;
  operationGeneration: string;
  action: ProductAction;
}
export interface OperationReceipt {
  browserIncarnation?: string;
  resolved?: boolean;
  resolution?: 'target-retired';
  operationSequence?: string;
  operationId: string;
  operationGeneration: string;
  status: OperationStatus;
  revision?: number;
  application?: ProductActionResult['application'];
  error?: string;
}
export interface RegistrationStatus {
  hasAdmin: boolean;
  credentialRequired: boolean;
  registrationOpen: boolean;
}
export interface AdminStatus {
  registrationCredentialConfigured: boolean;
}
export interface SocketMethods extends AuthSocketMethods, LibraryMethods, DiagnosticMethods {
  'admin.get': { params: Record<string, never>; result: AdminStatus };
  'admin.setRegistrationCredential': { params: { serverCredential: string }; result: AdminStatus };
  'operation.status': {
    params: { operationId: string; operationGeneration: string };
    result: OperationReceipt;
  };
  action: { params: Extract<ProductAction, { type: 'settings.update' }>; result: ProductActionResult };
  viewport: { params: ViewerViewport; result: ProductState };
  feedback: { params: ProductFeedback; result: { accepted: boolean } };
  'rtc.offer': {
    params: { type: 'offer'; sdp: string; attemptId: string };
    result: {
      type: 'answer';
      avSync: boolean;
      sdp: string;
      connectionId: string;
      endpointGeneration: number;
      signalingMode?: string;
    };
  };
  'rtc.ice': { params: { connectionId: string; candidate: unknown; attemptId?: string }; result: unknown };
  'rtc.close': { params: { connectionId: string }; result: { closed: boolean } };
  'clock.ping': { params: { clientTime?: number }; result: { serverTime: number; clientTime?: number } };
}
export type SocketRequest = {
  [K in keyof SocketMethods]: { id: string; method: K; params: SocketMethods[K]['params'] };
}[keyof SocketMethods];
export type RtcServerSignal = {
  type: 'rtc.signal';
  connectionId: string;
  attemptId: string;
  signal:
    | { type: 'ice'; candidate: RTCIceCandidateInit }
    | { type: 'complete' }
    | { type: 'error'; message: string };
};
export type SocketMessage =
  | AuthMessage
  | RtcServerSignal
  | { type: 'state'; revision: number; state: ProductState }
  | { type: 'result'; id: string; result: unknown }
  | { type: 'error'; id: string; error: WireError }
  | { type: 'lease'; status: 'revoked'; reason: 'another-viewer' | 'logout' };
