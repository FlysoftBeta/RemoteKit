import {
  array,
  boolean,
  integer,
  jsonValue,
  literal,
  nullable,
  number,
  object,
  record,
  string,
  union,
  type Codec,
} from './codec';
import type {
  Favorite,
  InstalledApp,
  OperationReceipt,
  ProductSettings,
  ProductSpace,
  ProductTab,
  SitePreferences,
} from '../../shared/product';
import type { AuthSettings } from '../../shared/security';
import type {
  LibraryEntry,
  LibraryPartition,
  LibrarySnapshot,
  LibrarySource,
} from '../../shared/file-library';
import type { ControlEvent, ImportChunk, ImportSite } from '../../shared/session-import';
import type { RecordedAction } from '../../shared/recorded-action';
import type { AccountSession } from '../learning/providers/changyan/auth';
import type { XinjiaoyuSession } from '../learning/providers/xinjiaoyu/client';
import type { Selection } from './library';

const s = string;
const b = boolean;
const n = number;
const i = integer;
export const windowState = record(jsonValue);
const tabKind = literal('start', 'remote');
export const tab = object(
  { id: s(), windowId: s(), webviewId: s(), title: s(), url: s() },
  {
    signIn: literal('changyan', 'xinjiaoyu'),
    usageDocument: s(),
    usageSource: literal('launcher'),
    kind: tabKind,
    pendingUrl: s(),
    canGoBack: b(),
    canGoForward: b(),
    loading: b(),
    residency: literal('live', 'frozen', 'discarded', 'unloaded'),
    restoring: b(),
    lifecycleRecovery: object({
      browserIncarnation: s(),
      generation: s(),
      phase: literal('unload', 'unloaded', 'restore'),
      submittedAt: n(),
    }),
    lifecycleRecoveryError: s(),
    pendingUaReloadOrigin: s(),
    popup: object({ provisionalId: s(), status: literal('pending', 'adopted', 'failed') }, { error: s() }),
    navigation: object(
      {
        operationId: s(),
        operationGeneration: s(),
        status: literal('applying', 'unknown', 'committed', 'rejected'),
        previousUrl: s(),
        previousKind: tabKind,
      },
      { resolved: b(), browserIncarnation: s() },
    ),
  },
) satisfies Codec<ProductTab>;
export const space = object({
  id: s(),
  windowIds: array(s()),
  weights: array(n()),
  focusedWindowId: s(),
  lastActiveAt: n(),
}) satisfies Codec<ProductSpace>;
const workspaceFields = {
  qualityPreference: literal('quality', 'auto', 'smooth'),
  uiScale: n(),
  topDeadZone: union(literal('off', 'auto'), n()),
  showStats: b(),
  autoFullscreen: b(),
  autoKeyboard: b(),
  clipboardSync: b(),
  avSync: b(),
  audioChannels: object({ left: b(), right: b() }),
};
const browserFields = {
  searchEngine: literal('google', 'bing', 'duckduckgo', 'baidu'),
  memorySaverEnabled: b(),
};
export const settings = object({
  workspace: object(workspaceFields),
  browser: object(browserFields),
}) satisfies Codec<ProductSettings>;
const permissions = {
  geolocation: literal('allow', 'block'),
  clipboard_read: literal('allow', 'block'),
  local_fonts: literal('allow', 'block'),
  window_management: literal('allow', 'block'),
  midi_sysex: literal('allow', 'block'),
  idle_detection: literal('allow', 'block'),
};
export const site = object(
  {},
  {
    tabletUa: b(),
    permissions: object({}, permissions),
    protocolHandlers: array(object({ protocol: s(), url: s(), allowed: b() })),
  },
) satisfies Codec<SitePreferences>;
const appFields = {
  name: s(),
  startUrl: s(),
  scope: s(),
  display: literal('standalone', 'browser'),
  themeColor: s(),
  iconToken: s(),
};
export const app = object(
  {
    id: s(),
    name: s(),
    startUrl: s(),
    scope: s(),
    display: literal('standalone', 'browser'),
    createdAt: n(),
    updatedAt: n(),
  },
  { themeColor: s(), iconHash: s(), iconUrl: s() },
) satisfies Codec<InstalledApp>;
export const favorite = object({ id: s(), url: s(), title: s(), createdAt: n() }) satisfies Codec<Favorite>;
const pendingClose = object(
  { id: s() },
  {
    windowId: s(),
    requestId: s(),
    nativeRequestId: s(),
    browserIncarnation: s(),
    instance: s(),
    document: s(),
    awaiting: b(),
  },
);
export const pending = object(
  { pendingClose: nullable(pendingClose), pendingWindowCloseId: nullable(s()) },
  { pendingWindowCloseIds: array(s()), pendingAppUninstallId: s() },
);
export const authSettings = object({
  lockOnHidden: b(),
  lockOnIdle: b(),
  idleSeconds: n(),
  lockOnDeparture: b(),
  faceEnabled: b(),
}) satisfies Codec<AuthSettings>;
export const errorCode = literal(
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'locked',
  'not_found',
  'conflict',
  'limit_exceeded',
  'rate_limited',
  'busy',
  'unavailable',
  'rejected',
  'outcome_unknown',
  'canceled',
  'internal',
);
export const wireError = object(
  { code: errorCode, message: s() },
  { retryAfterMs: i(), errorId: s({ pattern: /^[ce]-[0-9a-f]{10}$/ }) },
);
const receiptFields = { operationId: s(), operationGeneration: s() };
const receiptOptional = {
  browserIncarnation: s(),
  resolved: b(),
  resolution: literal('target-retired'),
  operationSequence: s(),
  revision: n(),
  application: object({ status: literal('pending'), reason: s() }),
};
export const receipt = union(
  object({ ...receiptFields, status: literal('failed'), error: wireError }, receiptOptional),
  object(
    { ...receiptFields, status: literal('accepted', 'applying', 'committed', 'unknown') },
    { ...receiptOptional, error: wireError },
  ),
) satisfies Codec<OperationReceipt>;
const placement = union(
  object({ mode: literal('space') }),
  object({ mode: literal('split'), besideWindowId: s(), side: literal('left', 'right') }),
  object({ mode: literal('replace'), windowId: s() }),
);
const source = { source: literal('launcher') };
const reply = union(
  object({ kind: literal('dialog'), accept: b() }, { text: s() }),
  object({ kind: literal('http_auth', 'repost'), accept: b() }),
  object({ kind: literal('permission'), decision: literal('allow', 'allow_once', 'block', 'dismiss') }),
  object({ kind: literal('protocol_handler'), accept: b(), remember: b() }),
);
export const action = union(
  object({ type: literal('window.open'), appId: s(), placement }, { url: s(), ...source }),
  object({ type: literal('window.focus'), windowId: s() }, source),
  object({
    type: literal('window.place'),
    windowId: s(),
    placement: union(
      object({ mode: literal('space') }),
      object({ mode: literal('split'), besideWindowId: s(), side: literal('left', 'right') }),
    ),
  }),
  object({ type: literal('window.close'), windowId: s() }),
  object({ type: literal('window.state'), windowId: s(), state: windowState }),
  object({ type: literal('space.activate'), spaceId: s() }, source),
  object({ type: literal('space.close'), spaceId: s() }),
  object({ type: literal('space.layout'), spaceId: s(), weights: array(n()) }),
  object(
    { type: literal('app.install'), name: s(), startUrl: s() },
    { scope: s(), display: literal('standalone', 'browser'), themeColor: s(), iconToken: s() },
  ),
  object({ type: literal('app.update'), appId: s() }, appFields),
  object({ type: literal('app.uninstall'), appId: s() }),
  object({ type: literal('favorite.add'), url: s(), title: s() }),
  object({ type: literal('favorite.remove'), id: s() }),
  object({ type: literal('tab.create'), windowId: s() }, { url: s(), query: s(), title: s(), ...source }),
  object(
    { type: literal('tab.activate', 'tab.close'), tabId: s() },
    { requestId: s(), confirm: b(), cancel: b(), ...source },
  ),
  object({ type: literal('tab.move'), tabId: s(), windowId: s() }, { index: i() }),
  object({ type: literal('tab.navigate'), tabId: s(), url: s() }, source),
  object({ type: literal('tab.command'), tabId: s(), command: literal('back', 'forward', 'reload', 'stop') }),
  object({
    type: literal('settings.update'),
    settings: object({}, { workspace: object({}, workspaceFields), browser: object({}, browserFields) }),
  }),
  object({ type: literal('page.reply'), dialogId: s(), reply }),
  object({
    type: literal('site.permission'),
    origin: s(),
    permission: literal(
      'geolocation',
      'clipboard_read',
      'local_fonts',
      'window_management',
      'midi_sysex',
      'idle_detection',
    ),
    setting: literal('ask', 'allow', 'block'),
  }),
  object({ type: literal('site.protocolHandler.remove'), origin: s(), protocol: s() }),
  object({ type: literal('site.permissions.reset'), origin: s() }),
  object({ type: literal('page.exitFullscreen'), target: s() }),
  object({ type: literal('site.set'), origin: s(), tabletUa: b() }, { tabId: s() }),
) satisfies Codec<RecordedAction>;
export const librarySource = object({ app: s(), channel: s() }) satisfies Codec<LibrarySource>;
export const partition = object({ id: s(), name: s() }) satisfies Codec<LibraryPartition>;
export const snippetOrigin = union(
  object({ kind: literal('page'), url: s(), app: s() }, { title: s() }),
  object({ kind: literal('app'), app: s() }),
  object({ kind: literal('device') }),
);
const entryFields = {
  id: s(),
  name: s(),
  type: s(),
  size: n(),
  createdAt: n(),
  source: nullable(librarySource),
  partitionId: nullable(s()),
  collected: b(),
};
export const libraryEntry = union(
  object(
    { ...entryFields, kind: literal('file'), assetId: s() },
    {
      detail: s(),
      originalAssetId: s(),
      photo: object(
        { mode: literal('photo', 'scan') },
        {
          quarterTurns: literal(1, 2, 3),
          candidateAssetIds: array(s()),
          pending: literal('choice', 'scan-error'),
          warning: s(),
        },
      ),
    },
  ),
  object({ ...entryFields, kind: literal('snippet'), preview: s(), origin: snippetOrigin }, { detail: s() }),
) satisfies Codec<LibraryEntry>;
export const librarySnapshot = object({
  revision: i(),
  entries: array(libraryEntry, { max: 4096 }),
  basket: array(s(), { max: 64 }),
  partitions: array(partition, { max: 256 }),
  sources: array(object({ app: s(), channel: s(), count: i(), excluded: b() })),
  excludedSources: array(librarySource),
  basketPartitionId: nullable(s()),
}) satisfies Codec<LibrarySnapshot>;
export const selection = object({
  selectionId: s(),
  requestId: s(),
  binding: object({ browserIncarnation: s(), view: s(), instance: s(), document: s(), request: s() }),
  entryIds: array(s()),
  files: array(object({ assetId: s(), name: s(), type: s() })),
  limits: object({ maxFileBytes: n(), maxBatchBytes: n(), maxFiles: i() }),
  prepared: b(),
}) satisfies Codec<Selection>;
export const sites = array(object({ name: s(), url: s() })) satisfies Codec<ImportSite[]>;
export const counts = object({ applied: i(), rejected: i() });
export const applyCounts = object({ cookies: counts, localStorage: counts });
export const storageJob = object({ importId: s() });
export const pairingCode = array(s());
const cookie = object({
  name: s(),
  value: s(),
  domain: s(),
  path: s(),
  hostOnly: b(),
  secure: b(),
  httpOnly: b(),
  sameSite: literal('unspecified', 'none', 'lax', 'strict'),
  expires: nullable(n()),
});
const stringPair: Codec<[string, string]> = {
  read(value, path) {
    const pair = array(s(), { max: 2 }).read(value, path);
    if (pair.length !== 2) throw new Error(`${path} expected string pair`);
    return [pair[0], pair[1]];
  },
};
export const importPayload = object({
  cookies: array(cookie),
  localStorage: array(object({ origin: s(), items: array(stringPair) })),
  ref: i(),
}) satisfies Codec<ImportChunk & { ref: number }>;
const eventFields = { seq: i(), at: n() };
export const controlEvent = union(
  object({ ...eventFields, type: literal('paired'), ref: i(), username: s() }),
  object({ seq: literal(0), at: n(), type: literal('pairRejected'), ref: i(), reason: s() }),
  object({ ...eventFields, type: literal('importReceived', 'importDiscarded'), ref: i(), id: s() }),
  object({
    ...eventFields,
    type: literal('importApplied'),
    ref: i(),
    id: s(),
    cookies: counts,
    localStorage: counts,
  }),
  object({ ...eventFields, type: literal('importFailed'), ref: i(), id: s(), retryable: b(), reason: s() }),
  object({ ...eventFields, type: literal('revoked') }),
) satisfies Codec<ControlEvent>;
const incomingFields = { ...eventFields, receivedAt: n(), device: s(), publicKey: s() };
export const incomingEvent = union(
  object({ ...incomingFields, type: literal('pair'), username: s() }),
  object({ ...incomingFields, type: literal('withdraw'), id: s() }),
  object({ ...incomingFields, type: literal('import'), id: s(), sites, cookies: i(), origins: i() }),
);
export const eventBody = union(controlEvent, incomingEvent);
export const changyanSession = object(
  {
    sso: object({ tgt: s(), at: s(), userId: s() }),
    changyan: object({ token: s(), userId: s(), createdAt: s(), expiresAt: s() }),
  },
  {
    displayName: s(),
    zhixue: object(
      { token: s(), accountId: s(), studentId: s(), createdAt: s(), expiresAt: s() },
      { classId: s(), schoolId: s(), gradeCode: s(), phaseCode: s(), cookies: record(s()) },
    ),
  },
) satisfies Codec<AccountSession>;
export const xinjiaoyuSession = object(
  { token: s(), accessToken: s(), clientSessionId: s(), device: s(), deviceType: s() },
  {
    safeCode: s(),
    userAgent: s(),
    acceptLanguage: s(),
    secChUa: s(),
    secChUaMobile: s(),
    secChUaPlatform: s(),
  },
) satisfies Codec<XinjiaoyuSession>;
