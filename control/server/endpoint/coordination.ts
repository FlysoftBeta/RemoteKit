import { RemoteKitError } from '../../shared/errors';
import type { Asset } from '../../shared/file-library';
import type { MediaPolicy, ProductOperation } from '../../shared/product';
import type { FileBinding, NativeError, SessionSitePreferencesRequest } from './types';

export const coordinationLimits = {
  sessions: 64,
  views: 256,
  sites: 4096,
  fileRequests: 64,
  descriptions: 256,
  documentBytes: 4 * 1024 * 1024 - 1,
  configurationBytes: 1024 * 1024,
  textBytes: 1024 * 1024,
  htmlBytes: 2 * 1024 * 1024,
  results: 1024,
  events: 4096,
  eventBytes: 32 * 1024 * 1024,
} as const;

export interface SessionTarget {
  tenantId: string;
  sessionId: string;
  placementEpoch: number;
}
export interface NodeDesired {
  method: 'node.desired';
  connectionEpoch: string;
  revision: string;
  sessions: (SessionTarget & { dataState: 'clean' | 'dirty' })[];
}
export interface DesiredView {
  viewId: string;
  presence: 'ensure' | 'ifPresent';
  url: string;
  width: number;
  height: number;
  visible: boolean;
  device: { mode: 'desktop'; deviceScaleFactor: number };
  occludedBottom: number;
  occlusionRevision: string;
  signIn?: 'changyan' | 'xinjiaoyu';
  adopt?: { browserIncarnation: string; provisionalId: string };
}
export interface SessionDesired extends SessionTarget {
  method: 'session.desired';
  connectionEpoch: string;
  revision: string;
  run: 'running' | 'stopped';
  commit: string | null;
  profileKey: string;
  checkpoint: string | null;
  sitePreferences: SessionSitePreferencesRequest;
  mediaPolicy: MediaPolicy;
  quality: { effectiveDpr: number };
  clipboard: { revision: string; value: { text: string; html: string } };
  views: DesiredView[];
  authorization: {
    connectionId: string | null;
    epoch: number;
    unlocked: boolean;
    files: { library: boolean; requests: { id: string; binding: FileBinding }[] };
  };
  lock: {
    leaseId: string | null;
    epoch: number;
    state: 'locked' | 'unlocking' | 'unlocked';
  };
  library: { describe: string[] };
}
export interface CopyObservation {
  state: 'clean' | 'dirty';
  base: string | null;
  stoppedCleanly: boolean;
  changesAt: number;
  committed: { requestId: string; manifestId: string } | null;
}
export interface StopBlockers {
  unacknowledgedEvents: number;
  pendingNativeSelections: number;
  inFlightUploads: number;
  pendingPageRequests: number;
  downloadsInProgress: number;
  pendingDownloadImports: number;
  rtcConnected: boolean;
  lifecycleUncertain: boolean;
}
export interface RecoveryStatus {
  pending: boolean;
  phase: string;
  error: NativeError | null;
}
export interface PendingPopup {
  provisionalId: string;
  openerViewId: string;
  url: string;
  disposition: number;
  userGesture: boolean;
  status: string;
}
export interface PageRequest {
  kind:
    | 'alert'
    | 'confirm'
    | 'prompt'
    | 'beforeunload'
    | 'permission'
    | 'http_auth'
    | 'repost'
    | 'protocol_handler'
    | 'file_chooser';
  request: string;
  state: string;
  origin?: string;
  embedding_origin?: string;
  message?: string;
  default_prompt?: string;
  beforeunload?: boolean;
  is_reload?: boolean;
  permissions?: string[];
  protocol?: string;
  url?: string;
  realm?: string;
  scheme?: string;
  proxy?: boolean;
  selection_id?: string;
  mode?: 'open' | 'open_multiple';
  multiple?: boolean;
  need_local_path?: boolean;
  accept_types?: string[];
  accept_types_omitted?: boolean;
  input_anchor?: {
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
  };
}
export interface PageEvent {
  kind:
    | 'request_rejected'
    | 'request_cancelled'
    | 'find_cancelled'
    | 'file_chooser_unsupported'
    | 'fullscreen'
    | 'pointer_lock_denied'
    | 'keyboard_lock_denied'
    | 'blocked_popup'
    | 'request_replied'
    | 'find_result';
  request?: string;
  reason?: string;
  state?: string;
  active?: boolean;
  native_host_fullscreen?: boolean;
  origin?: string;
  url?: string;
  mode?: number;
  find_request?: number;
  matches?: number;
  active_match?: number;
  final?: boolean;
  selection_rect?: { x_dip: number; y_dip: number; width_dip: number; height_dip: number };
}
export interface NavigationObservation {
  operationId: string;
  operationGeneration: string;
  operationSequence: string;
  state: 'accepted' | 'started' | 'committed' | 'cancelled' | 'failed' | 'superseded';
  documentCommitted?: boolean;
  isErrorPage?: boolean;
  navigationId?: string;
  url?: string;
  error?: string | NativeError;
}
export interface ObservedView {
  viewId: string;
  instance?: string;
  document?: string;
  focus?: string;
  profile?: string;
  actual?: 0 | 1 | 2 | 3;
  desired?: 0 | 1 | 2 | 3;
  pending?: boolean;
  focused?: boolean;
  visible?: boolean;
  lifecycle_generation?: string;
  last_lifecycle?: { generation: string; action: number; succeeded: boolean; error?: NativeError };
  close_state?: string;
  close_reason?: string;
  width?: number;
  height?: number;
  device?: string;
  deviceScaleFactor?: number;
  url?: string;
  title?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  audible?: boolean;
  captured?: boolean;
  crashed?: boolean;
  fullscreen?: boolean;
  navigationRevision?: string;
  navigationOperations?: NavigationObservation[];
  lifecycle_uncertain?: boolean;
  canDiscard?: boolean;
  discardBlockReason?: string;
  pending_page_requests?: number;
  pageRequests?: { pending: PageRequest[]; events: PageEvent[] };
  pending_close?: { requestId: string };
  requestId?: string;
  recovery?: RecoveryStatus;
  touch_error?: NativeError;
  renderer_pids?: string[];
  compositor?: Record<string, unknown>;
  browserPending?: boolean;
  browserDesired?: number;
}
export interface SessionObserved extends SessionTarget {
  event: 'session.observed';
  connectionEpoch: string;
  endpointIncarnation: string;
  nodeRevision: string;
  seq: string;
  observedRevision: string;
  converged: boolean;
  browser: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  browserIncarnation: string | null;
  browserPid: number;
  browserRestart: 'ready' | 'waiting' | 'exhausted';
  data: CopyObservation | null;
  checkpoint: { manifestId: string; objects: string[]; buildId: string } | null;
  applied: {
    sitePreferencesRevision: string;
    mediaPolicyRevision: string;
    viewsRevision: string;
    clipboardRevision: string;
  };
  authorization: {
    connectionId: string | null;
    epoch: number;
    unlocked: boolean;
    revoked: boolean;
    filesApplied: boolean;
  };
  lock: SessionDesired['lock'];
  views: ObservedView[];
  pendingPopups: PendingPopup[];
  recovery: { pending: boolean; views: Record<string, RecoveryStatus>; exportPending: boolean };
  rtc: { active: boolean; connectionId: string | null; avSync: boolean | null };
  blockers: StopBlockers;
  library: {
    descriptions: (
      { assetId: string; asset: Asset; error: null } | { assetId: string; asset: null; error: NativeError }
    )[];
  };
  events: { streamId: string | null; ackedThrough: string; lastSeq: string };
  stats: { mediaPolicy?: { applied: MediaPolicy | null }; [extension: string]: unknown };
  lastError: NativeError | null;
}
export type EventBodies = {
  'view.closed': { viewId: string; instance?: string; document?: string; reason: string };
  'download.imported': { name: string; origin: string; assetId: string; mimeType: string; size: string };
  'download.failed': { name: string; origin: string; error: NativeError };
  'clipboard.changed': {
    browserSequence: string;
    baseRevision: string;
    viewId?: string;
    excludeFromHistory: boolean;
  } & (
    | { text: string; html: string; oversize?: false }
    | { oversize: true; textBytes: number; htmlBytes: number }
  );
  'view.signIn': {
    version: 1;
    webviewId: string;
    provider: 'changyan' | 'xinjiaoyu';
    result: Record<string, string>;
  };
  'client.action': ProductOperation & { connectionId: string; authEpoch: number; leaseId: string };
};
export type SessionEvent = {
  [Type in keyof EventBodies]: SessionTarget & {
    event: 'session.event';
    connectionEpoch: string;
    streamId: string;
    seq: string;
    eventId: string;
    browserIncarnation: string | null;
    type: Type;
    body: EventBodies[Type];
  };
}[keyof EventBodies];
export interface EventsAck extends SessionTarget {
  method: 'session.events.ack';
  connectionEpoch: string;
  streamId: string;
  upTo: string;
}
export interface OneShotRequest {
  method: string;
  opId: string;
  replay: boolean;
  endpointIncarnation: string;
  tenantId: string;
  sessionId: string | null;
  placementEpoch: number | null;
  params: Record<string, unknown>;
}

export function counter(value: unknown, positive = false): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18446744073709551615n &&
    (!positive || value !== '0')
  );
}
export function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    return item;
  };
  return JSON.stringify(ordered(value));
}
export function validateDesired(value: SessionDesired): void {
  const invalid = (condition: boolean, field: string) => {
    if (condition) throw new RemoteKitError('invalid_request', `Invalid desired ${field}`);
  };
  const fields = new Set([
    'method',
    'connectionEpoch',
    'tenantId',
    'sessionId',
    'placementEpoch',
    'revision',
    'run',
    'commit',
    'profileKey',
    'checkpoint',
    'sitePreferences',
    'mediaPolicy',
    'quality',
    'clipboard',
    'views',
    'authorization',
    'lock',
    'library',
  ]);
  invalid(
    Object.keys(value).some((field) => !fields.has(field)),
    'field',
  );
  invalid(!counter(value.revision, true), 'revision');
  invalid(!/^[0-9a-f]{32}$/.test(value.sessionId), 'sessionId');
  invalid(!Number.isSafeInteger(value.placementEpoch) || value.placementEpoch < 1, 'placementEpoch');
  invalid(!['running', 'stopped'].includes(value.run), 'run');
  invalid(
    value.commit !== null &&
      (value.run === 'running' || !value.commit || Buffer.byteLength(value.commit) > 128),
    'commit',
  );
  invalid(!/^[A-Za-z0-9+/]{43}=$/.test(value.profileKey), 'profileKey');
  invalid(value.checkpoint !== null && !/^[0-9a-f]{64}$/.test(value.checkpoint), 'checkpoint');
  invalid(!counter(value.clipboard.revision), 'clipboard.revision');
  invalid(
    Buffer.byteLength(value.clipboard.value.text) > coordinationLimits.textBytes ||
      Buffer.byteLength(value.clipboard.value.html) > coordinationLimits.htmlBytes,
    'clipboard',
  );
  invalid(
    value.views.length > coordinationLimits.views ||
      new Set(value.views.map((view) => view.viewId)).size !== value.views.length,
    'views',
  );
  for (const view of value.views) {
    invalid(!counter(view.viewId, true), 'viewId');
    invalid(!['ensure', 'ifPresent'].includes(view.presence), 'presence');
    invalid(
      ![view.width, view.height].every((size) => Number.isInteger(size) && size >= 1 && size <= 8192),
      'dimensions',
    );
    invalid(
      !Number.isInteger(view.occludedBottom) ||
        view.occludedBottom < 0 ||
        view.occludedBottom > view.height ||
        !counter(view.occlusionRevision),
      'occlusion',
    );
    invalid(
      view.device.mode !== 'desktop' ||
        !Number.isFinite(view.device.deviceScaleFactor) ||
        view.device.deviceScaleFactor <= 0 ||
        view.device.deviceScaleFactor !== value.quality.effectiveDpr,
      'device',
    );
    invalid(!!view.signIn && !!view.adopt, 'adopt');
  }
  invalid(
    !Number.isInteger(value.mediaPolicy.maxFps) ||
      value.mediaPolicy.maxFps < 1 ||
      value.mediaPolicy.maxFps > 240 ||
      !['maintain-resolution', 'balanced', 'maintain-framerate'].includes(
        value.mediaPolicy.degradationPreference,
      ),
    'mediaPolicy',
  );
  invalid(Object.keys(value.sitePreferences.sites).length > coordinationLimits.sites, 'sites');
  invalid(value.authorization.files.requests.length > coordinationLimits.fileRequests, 'files');
  invalid(
    typeof value.mediaPolicy.audio !== 'boolean' || typeof value.authorization.unlocked !== 'boolean',
    'authorization',
  );
  invalid(
    !Number.isSafeInteger(value.authorization.epoch) ||
      value.authorization.epoch < 0 ||
      (value.authorization.connectionId === null &&
        (value.authorization.epoch !== 0 || value.authorization.unlocked)),
    'authorization.epoch',
  );
  invalid(
    value.library.describe.length > coordinationLimits.descriptions ||
      value.library.describe.some((id) => !/^[0-9a-f]{64}$/.test(id)),
    'library',
  );
  const { clipboard, ...configuration } = value;
  invalid(
    Buffer.byteLength(JSON.stringify(configuration)) > coordinationLimits.configurationBytes ||
      Buffer.byteLength(JSON.stringify(value)) > coordinationLimits.documentBytes,
    'size',
  );
}

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function boundedString(value: unknown, max: number, nonempty = true): value is string {
  return typeof value === 'string' && (!nonempty || value.length > 0) && Buffer.byteLength(value) <= max;
}
function coordinationTarget(value: Record<string, any>) {
  return (
    boundedString(value.tenantId, 128) &&
    /^[0-9a-f]{32}$/.test(value.sessionId) &&
    Number.isSafeInteger(value.placementEpoch) &&
    value.placementEpoch > 0 &&
    boundedString(value.connectionEpoch, 128) &&
    counter(value.seq, true)
  );
}
export function validateSessionEvent(value: unknown): asserts value is SessionEvent {
  const invalid = () => {
    throw new RemoteKitError('invalid_request', 'Invalid Session event');
  };
  if (
    !record(value) ||
    !coordinationTarget(value) ||
    value.event !== 'session.event' ||
    !boundedString(value.streamId, 128) ||
    !boundedString(value.eventId, 128) ||
    !(value.browserIncarnation === null || boundedString(value.browserIncarnation, 128)) ||
    !record(value.body)
  )
    return invalid();
  const body = value.body;
  switch (value.type) {
    case 'view.closed':
      if (!counter(body.viewId, true) || !boundedString(body.reason, 128)) return invalid();
      break;
    case 'download.imported':
    case 'download.failed':
      if (!boundedString(body.name, 4096, false) || !boundedString(body.origin, 2048, false))
        return invalid();
      if (
        value.type === 'download.imported'
          ? !/^[0-9a-f]{64}$/.test(body.assetId) ||
            !boundedString(body.mimeType, 255, false) ||
            !counter(body.size)
          : !record(body.error) ||
            !boundedString(body.error.code, 64) ||
            typeof body.error.message !== 'string'
      )
        return invalid();
      break;
    case 'clipboard.changed':
      if (
        !counter(body.baseRevision) ||
        !counter(body.browserSequence) ||
        typeof body.excludeFromHistory !== 'boolean' ||
        (body.viewId !== undefined && !counter(body.viewId, true))
      )
        return invalid();
      if (
        body.oversize === true
          ? ![body.textBytes, body.htmlBytes].every((value) => Number.isSafeInteger(value) && value >= 0)
          : !boundedString(body.text, coordinationLimits.textBytes, false) ||
            !boundedString(body.html, coordinationLimits.htmlBytes, false)
      )
        return invalid();
      break;
    case 'view.signIn':
      if (
        body.version !== 1 ||
        !counter(body.webviewId, true) ||
        !['changyan', 'xinjiaoyu'].includes(body.provider) ||
        !record(body.result) ||
        Buffer.byteLength(JSON.stringify(body.result)) > 8192 ||
        Object.values(body.result).some((value) => typeof value !== 'string')
      )
        return invalid();
      break;
    case 'client.action':
      if (
        !boundedString(body.connectionId, 128) ||
        !boundedString(body.leaseId, 128) ||
        !Number.isSafeInteger(body.authEpoch) ||
        body.authEpoch < 1 ||
        !boundedString(body.operationId, 64) ||
        !boundedString(body.operationGeneration, 64) ||
        !record(body.action) ||
        Buffer.byteLength(JSON.stringify(body.action)) > 32768
      )
        return invalid();
      break;
    default:
      return invalid();
  }
}
export function validateSessionObserved(value: unknown): asserts value is SessionObserved {
  const invalid = () => {
    throw new RemoteKitError('invalid_request', 'Invalid Session observation');
  };
  if (
    !record(value) ||
    !coordinationTarget(value) ||
    value.event !== 'session.observed' ||
    !counter(value.nodeRevision, true) ||
    !counter(value.observedRevision) ||
    !boundedString(value.endpointIncarnation, 128) ||
    typeof value.converged !== 'boolean' ||
    !['starting', 'running', 'stopping', 'stopped', 'failed'].includes(value.browser) ||
    !(value.browserIncarnation === null || boundedString(value.browserIncarnation, 128)) ||
    !Array.isArray(value.views) ||
    value.views.length > coordinationLimits.views ||
    !Array.isArray(value.pendingPopups) ||
    !record(value.events) ||
    !(value.events.streamId === null || boundedString(value.events.streamId, 128)) ||
    !counter(value.events.ackedThrough) ||
    !counter(value.events.lastSeq) ||
    BigInt(value.events.ackedThrough) > BigInt(value.events.lastSeq) ||
    !record(value.applied) ||
    !Object.values(value.applied).every((revision) => counter(revision)) ||
    !record(value.authorization) ||
    !record(value.lock) ||
    !record(value.rtc) ||
    !record(value.blockers) ||
    !record(value.library) ||
    !Array.isArray(value.library.descriptions) ||
    value.library.descriptions.length > coordinationLimits.descriptions ||
    !record(value.stats)
  )
    return invalid();
  if (
    value.checkpoint !== null &&
    (!record(value.checkpoint) ||
      !/^[0-9a-f]{64}$/.test(value.checkpoint.manifestId) ||
      !Array.isArray(value.checkpoint.objects) ||
      value.checkpoint.objects.length > 32768 ||
      value.checkpoint.objects.some((id: unknown) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) ||
      !boundedString(value.checkpoint.buildId, 128))
  )
    return invalid();
  for (const view of value.views) {
    if (!record(view) || !counter(view.viewId, true)) return invalid();
    if (
      view.pageRequests !== undefined &&
      (!record(view.pageRequests) ||
        !Array.isArray(view.pageRequests.pending) ||
        !Array.isArray(view.pageRequests.events))
    )
      return invalid();
  }
}
