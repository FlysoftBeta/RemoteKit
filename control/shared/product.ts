import type { WireError } from './errors';
import type { LibraryMethods } from './file-library';
import type { AuthMessage, AuthSocketMethods } from './security';
import type { DiagnosticMethods } from './diagnostics';
import type { AdminSocketMethods } from './admin';
import type { SessionImportSocketMethods } from './session-import';
import type { LearningProvider, LearningSocketMethods, LearningState } from './learning';
/** Persistent product state belongs to Control; clients keep only an HttpOnly token. */
export interface ProductUser {
  id: string;
  username: string;
  isAdmin: boolean;
}
// Local Apps render in the Viewer shell; browser windows render remote tabs.
// The admin console exists only for the administrator.
export const BUILTIN_APP_TITLES = {
  browser: '浏览器',
  files: '我的文件',
  study: '学习',
  questions: '题库',
  settings: '设置',
  admin: '管理',
} as const;
export type BuiltinApp = keyof typeof BUILTIN_APP_TITLES;
export const isBuiltinApp = (appId: string): appId is BuiltinApp =>
  Object.prototype.hasOwnProperty.call(BUILTIN_APP_TITLES, appId);
export const isSingletonApp = (appId: string) => ['settings', 'admin', 'study', 'questions'].includes(appId);
export const isLocalApp = (appId: string) => appId === 'files' || isSingletonApp(appId);
/** An active announcement as one user sees it. */
export interface Announcement {
  id: string;
  title: string;
  body: string;
  publishedAt: number;
  read: boolean;
}
export const ANNOUNCEMENT_LIMITS = { title: 100, body: 5000 } as const;
export type SearchEngine = 'google' | 'bing' | 'duckduckgo' | 'baidu';
export const SEARCH_ENGINES: { value: SearchEngine; label: string }[] = [
  { value: 'google', label: 'Google' },
  { value: 'bing', label: 'Bing' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'baidu', label: '百度' },
];
// App-wide zoom of the Viewer shell and remote pages together; streaming stays at native pixels.
export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 2;
// A reserved strip above the Viewer, never smaller than the safe area: off adds nothing, auto also
// clears the title bar, a number is a fixed height in CSS px.
export type TopDeadZone = 'off' | 'auto' | number;
export const DEAD_ZONE_MAX = 200;
export interface WorkspaceSettings {
  qualityPreference: 'quality' | 'auto' | 'smooth';
  uiScale: number;
  topDeadZone: TopDeadZone;
  showStats: boolean;
  autoFullscreen: boolean;
  avSync: boolean;
  audioChannels: { left: boolean; right: boolean };
}
export interface BrowserSettings {
  searchEngine: SearchEngine;
  memorySaverEnabled: boolean;
}
export interface ProductSettings {
  workspace: WorkspaceSettings;
  browser: BrowserSettings;
}
export interface ProductSettingsUpdate {
  workspace?: Partial<WorkspaceSettings>;
  browser?: Partial<BrowserSettings>;
}
export interface LifecycleRecovery {
  browserIncarnation: string;
  generation: string;
  phase: 'unload' | 'unloaded' | 'restore';
  submittedAt: number;
}
export type ProductTabKind = 'start' | 'remote';
export const isLocalTab = (tab: Pick<ProductTab, 'kind'>) => tab.kind === 'start';

// Tabs keep one workspace-wide order; a window's strip is that order filtered by windowId.
export function placeTab<T extends { id: string; windowId: string }>(
  tabs: T[],
  tabId: string,
  windowId: string,
  index?: number,
) {
  const from = tabs.findIndex((tab) => tab.id === tabId);
  if (from < 0) return;
  const [moved] = tabs.splice(from, 1);
  moved.windowId = windowId;
  const siblings: number[] = [];
  tabs.forEach((tab, at) => tab.windowId === windowId && siblings.push(at));
  const slot = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
  const at =
    slot < siblings.length
      ? siblings[slot]
      : siblings.length
        ? siblings[siblings.length - 1] + 1
        : tabs.length;
  tabs.splice(at, 0, moved);
}
export interface ProductTab {
  signIn?: LearningProvider;
  usageDocument?: string;
  usageSource?: 'launcher';
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
  appId: string;
  state?: Record<string, unknown>;
  lastActiveAt: number;
}
export interface ProductSpace {
  id: string;
  windowIds: string[];
  weights: number[];
  focusedWindowId: string;
  lastActiveAt: number;
}
export interface InstalledApp {
  id: string;
  name: string;
  startUrl: string;
  scope: string;
  display: 'standalone' | 'browser';
  themeColor?: string;
  iconHash?: string;
  iconUrl?: string;
  createdAt: number;
  updatedAt: number;
}
export interface Favorite {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}
export type WindowPlacement =
  | { mode: 'space' }
  | { mode: 'split'; besideWindowId: string; side: 'left' | 'right' }
  | { mode: 'replace'; windowId: string };
export interface AppDefinition {
  name: string;
  startUrl: string;
  scope?: string;
  display?: 'standalone' | 'browser';
  themeColor?: string;
  iconToken?: string;
}
export interface LauncherItem {
  key: string;
  kind: 'app' | 'page' | 'file';
  group: 'frequent' | 'apps' | 'pages' | 'files';
  score: number;
  title: string;
  subtitle?: string;
  appId?: string;
  url?: string;
  entryId?: string;
  favorite?: boolean;
  previewUrl?: string;
  organized?: boolean;
  themeColor?: string;
  iconUrl?: string;
}
export interface AppInspectResult {
  iconDataUrl?: string;
  name: string;
  startUrl: string;
  scope: string;
  display: 'standalone' | 'browser';
  themeColor?: string;
  iconToken?: string;
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
export const SITE_PERMISSIONS = [
  'geolocation',
  'clipboard_read',
  'local_fonts',
  'window_management',
  'midi_sysex',
  'idle_detection',
] as const;
export type SitePermission = (typeof SITE_PERMISSIONS)[number];
export interface SitePreferences {
  tabletUa?: boolean;
  manualKeyboard?: boolean;
  permissions?: Partial<Record<SitePermission, 'allow' | 'block'>>;
  protocolHandlers?: { protocol: string; url: string; allowed: boolean }[];
}
export interface ProductWorkspace {
  tenantId: string;
  revision: number;
  tabs: ProductTab[];
  windows: ProductWindow[];
  spaces: ProductSpace[];
  activeSpaceId: string | null;
  apps: InstalledApp[];
  favorites: Favorite[];
  settings: ProductSettings;
  sites: Record<string, SitePreferences>;
  pendingClose?: PendingClose | null;
  pendingWindowCloseId?: string | null;
  pendingWindowCloseIds?: string[];
  pendingAppUninstallId?: string;
}
interface PageDialogIdentity {
  id: string;
  tabId: string;
  windowId: string;
  origin: string;
}
export type PageDialog = PageDialogIdentity &
  (
    | {
        kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
        message: string;
        defaultPrompt: string;
        isReload?: boolean;
      }
    | { kind: 'permission'; embeddingOrigin: string; permissions: SitePermission[] }
    | { kind: 'http_auth'; realm: string; scheme: string; proxy: boolean; url: string }
    | { kind: 'repost' }
    | { kind: 'protocol_handler'; protocol: string; url: string }
  );
export type PageDialogReply =
  | { kind: 'dialog'; accept: boolean; text?: string }
  | { kind: 'permission'; decision: 'allow' | 'allow_once' | 'block' | 'dismiss' }
  | { kind: 'http_auth'; accept: false }
  | { kind: 'http_auth'; accept: true; username: string; password: string }
  | { kind: 'repost'; accept: boolean }
  | { kind: 'protocol_handler'; accept: boolean; remember: boolean };
export const FILE_LIMITS = {
  maxFileBytes: 256 * 1024 * 1024,
  maxBatchBytes: 512 * 1024 * 1024,
  maxFiles: 64,
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
  limits: { maxFileBytes: number; maxBatchBytes: number; maxFiles: number };
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
  preference: WorkspaceSettings['qualityPreference'];
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
  learning: LearningState;
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
  /** Newest first. */
  announcements: Announcement[];
  integrations: { siteUa: boolean; lifecycle: boolean; popupAdoption: boolean };
}
export type ProductAction =
  | { type: 'window.open'; appId: string; url?: string; placement: WindowPlacement; source?: 'launcher' }
  | { type: 'window.focus'; windowId: string; source?: 'launcher' }
  | { type: 'window.place'; windowId: string; placement: Exclude<WindowPlacement, { mode: 'replace' }> }
  | { type: 'window.close'; windowId: string }
  | { type: 'window.state'; windowId: string; state: Record<string, unknown> }
  | { type: 'space.activate'; spaceId: string; source?: 'launcher' }
  | { type: 'space.close'; spaceId: string }
  | { type: 'space.layout'; spaceId: string; weights: number[] }
  | ({ type: 'app.install' } & AppDefinition)
  | ({ type: 'app.update'; appId: string } & Partial<AppDefinition>)
  | { type: 'app.uninstall'; appId: string }
  | { type: 'favorite.add'; url: string; title: string }
  | { type: 'favorite.remove'; id: string }
  | {
      type: 'tab.create';
      windowId: string;
      url?: string;
      query?: string;
      title?: string;
      source?: 'launcher';
    }
  | {
      type: 'tab.activate' | 'tab.close';
      tabId: string;
      requestId?: string;
      confirm?: boolean;
      cancel?: boolean;
      source?: 'launcher';
    }
  | { type: 'tab.move'; tabId: string; windowId: string; index?: number }
  | { type: 'tab.navigate'; tabId: string; url: string; source?: 'launcher' }
  | { type: 'tab.command'; tabId: string; command: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'settings.update'; settings: ProductSettingsUpdate }
  | { type: 'page.reply'; dialogId: string; reply: PageDialogReply }
  | {
      type: 'site.permission';
      origin: string;
      permission: SitePermission;
      setting: 'ask' | 'allow' | 'block';
    }
  | { type: 'site.protocolHandler.remove'; origin: string; protocol: string }
  | { type: 'site.permissions.reset'; origin: string }
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
export interface SetupStatus {
  setupRequired: boolean;
}
export interface SocketMethods
  extends
    AuthSocketMethods,
    LibraryMethods,
    DiagnosticMethods,
    AdminSocketMethods,
    LearningSocketMethods,
    SessionImportSocketMethods {
  'operation.status': {
    params: { operationId: string; operationGeneration: string };
    result: OperationReceipt;
  };
  action: {
    params: Extract<ProductAction, { type: 'settings.update' | 'window.state' }>;
    result: ProductActionResult;
  };
  'window.state': {
    params: { windowId: string; state: Record<string, unknown> };
    result: ProductActionResult;
  };
  'usage.record': {
    params: { item: string; windowId: string; source?: 'launcher' };
    result: { recorded: boolean };
  };
  'announcement.read': { params: { id: string }; result: { read: boolean } };
  'usage.clear': { params: { scope: 'all' | 'pages' }; result: { cleared: boolean } };
  'page.preview': { params: { url: string; image: string }; result: { saved: boolean } };
  'launcher.get': { params: { query?: string }; result: { items: LauncherItem[] } };
  'app.inspect': { params: { tabId: string }; result: AppInspectResult };
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
  | { type: 'library'; snapshot: import('./file-library').LibrarySnapshot }
  | { type: 'result'; id: string; result: unknown }
  | { type: 'error'; id: string; error: WireError }
  | { type: 'lease'; status: 'revoked'; reason: 'another-viewer' | 'logout' };
