import type {
  LibraryEntry,
  StoredLibraryEntry,
  LibraryPartition,
  LibrarySnapshot,
  LibrarySource,
} from '../../shared/file-library';
import type {
  Favorite,
  InstalledApp,
  OperationReceipt,
  ProductSettings,
  ProductSpace,
  ProductTab,
  SitePreferences,
} from '../../shared/product';
import type { RecordedAction } from '../../shared/recorded-action';
import type { AuthSettings } from '../../shared/security';
import type { ControlEvent, ImportChunk, ImportSite } from '../../shared/session-import';
import type { AccountSession } from '../learning/providers/changyan/auth';
import type { XinjiaoyuSession } from '../learning/providers/xinjiaoyu/client';
import {
  array,
  boolean,
  integer,
  literal,
  nullable,
  number,
  object,
  record,
  string,
  union,
  type Codec,
} from './codec';
import type { Selection } from './library';

const s = string;
const b = boolean;
const n = () => number({ min: 0, max: Number.MAX_SAFE_INTEGER });
const i = () => integer({ min: 0 });
const counter = string({ pattern: /^(0|[1-9][0-9]{0,19})$/ });
const positiveCounter = string({ pattern: /^[1-9][0-9]{0,19}$/ });
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
  {
    capacity: literal(
      'storage',
      'basket',
      'catalog',
      'windows',
      'tabs',
      'site-settings',
      'field',
      'selection',
      'file',
    ),
    reason: literal(
      'browser_crashed',
      'browser_restarting',
      'output_failed',
      'document_encrypted',
      'document_corrupt',
      'document_unsupported',
      'document_too_complex',
      'file_too_large',
      'storage_quota_exceeded',
      'browser_state_too_large',
      'no_document_contour',
      'corrupt_state',
      'corrupt_record',
      'session_data_on_offline_node',
      'no_eligible_node',
    ),
    retryAfterMs: integer({ min: 0, max: 86400000 }),
    errorId: s({ pattern: /^[cev]-[0-9a-f]{10}$/ }),
  },
);

import { windowState } from '../../shared/persisted-window-state';
export { windowState };
const tabKind = literal('start', 'remote');
export const tab = object(
  { id: s(), windowId: s(), webviewId: s(), title: s(), url: s(), idleKeepAlive: b() },
  {
    idleKeepAliveState: object({ enabledAt: n() }, { eligibleSince: n(), leftAt: n() }),
    idleKeepAliveOutcome: object(
      {
        enabledAt: n(),
        eligibleSince: n(),
        leftAt: n(),
        outcome: literal('survived', 'frozen', 'discarded', 'stopped'),
        at: n(),
        reason: literal('statistics', 'pressure', 'exhaustion'),
      },
      { returnedAt: n() },
    ),
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
    lifecycleRecoveryError: wireError,
    pendingUaReloadOrigin: s(),
    popup: object(
      { provisionalId: s(), status: literal('pending', 'adopted', 'failed') },
      { error: wireError },
    ),
    navigation: object(
      {
        operationId: s(),
        operationGeneration: s(),
        status: literal('applying', 'unknown', 'committed', 'rejected'),
        previousUrl: s(),
        previousKind: tabKind,
      },
      { resolved: b(), browserIncarnation: s(), viewPrepared: b() },
    ),
  },
) satisfies Codec<ProductTab>;
export const space = object({
  id: s(),
  windowIds: array(s({ min: 1, max: 128 }), { min: 1, max: 3 }),
  weights: array(number({ min: Number.MIN_VALUE, max: Number.MAX_SAFE_INTEGER }), { min: 1, max: 3 }),
  focusedWindowId: s(),
  lastActiveAt: n(),
}) satisfies Codec<ProductSpace>;
const workspaceFields = {
  qualityPreference: literal('quality', 'auto', 'smooth'),
  uiScale: number({ min: 0.5, max: 2 }),
  topDeadZone: union(literal('off', 'auto'), integer({ min: 1, max: 200 })),
  showStats: b(),
  autoFullscreen: b(),
  autoKeyboard: b(),
  clipboardSync: b(),
  avSync: b(),
  audioChannels: object({ left: b(), right: b() }),
};
const browserFields = {
  searchEngine: literal('google', 'bing', 'duckduckgo', 'baidu'),
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
  idleSeconds: integer({ min: 15, max: 3600 }),
  lockOnDeparture: b(),
  faceEnabled: b(),
}) satisfies Codec<AuthSettings>;
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
  object({ type: literal('tab.setIdleKeepAlive'), tabId: s(), enabled: b() }),
  object({ type: literal('tab.ackIdleKeepAliveOutcome'), tabId: s(), at: n(), returnedAt: n() }),
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
  size: integer({ min: 0 }),
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
          advisory: literal('low-quality'),
          processingFailure: wireError,
        },
      ),
    },
  ),
  object({ ...entryFields, kind: literal('snippet'), preview: s(), origin: snippetOrigin }, { detail: s() }),
) satisfies Codec<StoredLibraryEntry>;
export const librarySnapshot = object({
  revision: i(),
  entries: array(libraryEntry, { max: 4096 }),
  basket: array(s(), { max: 64 }),
  partitions: array(partition, { max: 256 }),
  sources: array(object({ app: s(), channel: s(), count: i(), excluded: b() })),
  excludedSources: array(librarySource),
  basketPartitionId: nullable(s()),
}) satisfies Codec<Omit<LibrarySnapshot, 'entries'> & { entries: StoredLibraryEntry[] }>;
export const selection = object({
  selectionId: s(),
  requestId: s(),
  binding: object({ browserIncarnation: s(), view: s(), instance: s(), document: s(), request: s() }),
  entryIds: array(s()),
  files: array(object({ assetId: s(), name: s(), type: s() })),
  limits: object({
    maxFileBytes: integer({ min: 1, max: 268435456 }),
    maxBatchBytes: integer({ min: 1, max: 536870912 }),
    maxFiles: integer({ min: 1, max: 64 }),
  }),
  prepared: b(),
}) satisfies Codec<Selection>;
export const sites = array(object({ name: s(), url: s() })) satisfies Codec<ImportSite[]>;
export const counts = object({ applied: i(), rejected: i() });
export const applyCounts = object({ cookies: counts, localStorage: counts });
export const storageJob = object({ importId: s() });
export const pairingCode = array(s({ min: 1, max: 64 }), { min: 5, max: 5 });
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
  object({
    ...eventFields,
    type: literal('importFailed'),
    ref: i(),
    id: s(),
    retryable: b(),
    error: wireError,
  }),
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

const eventIncarnation = nullable(s({ max: 128 }));
const eventDownload = { name: s({ max: 4096 }), origin: s({ max: 2048 }) };
const clipboardEvent = {
  browserSequence: counter,
  baseRevision: counter,
  excludeFromHistory: b(),
};
export const sessionEventPayload = union(
  object({
    type: literal('view.closed'),
    browserIncarnation: eventIncarnation,
    body: object(
      { viewId: positiveCounter, reason: s({ min: 1, max: 128 }) },
      { instance: positiveCounter, document: positiveCounter },
    ),
  }),
  object({
    type: literal('download.imported'),
    browserIncarnation: eventIncarnation,
    body: object({
      ...eventDownload,
      assetId: s({ pattern: /^[0-9a-f]{64}$/ }),
      mimeType: s({ max: 255 }),
      size: counter,
    }),
  }),
  object({
    type: literal('download.failed'),
    browserIncarnation: eventIncarnation,
    body: object({ ...eventDownload, error: wireError }),
  }),
  object({
    type: literal('clipboard.changed'),
    browserIncarnation: eventIncarnation,
    body: union(
      object(
        { ...clipboardEvent, text: s({ max: 1024 * 1024 }), html: s({ max: 2 * 1024 * 1024 }) },
        { viewId: positiveCounter, oversize: literal(false) },
      ),
      object(
        { ...clipboardEvent, oversize: literal(true), textBytes: i(), htmlBytes: i() },
        { viewId: positiveCounter },
      ),
    ),
  }),
  object({
    type: literal('view.signIn'),
    browserIncarnation: eventIncarnation,
    body: union(
      object({
        version: literal(1),
        webviewId: positiveCounter,
        provider: literal('changyan'),
        result: object({
          lot_number: s({ max: 8192 }),
          captcha_output: s({ max: 8192 }),
          pass_token: s({ max: 8192 }),
          gen_time: s({ max: 8192 }),
        }),
      }),
      object({
        version: literal(1),
        webviewId: positiveCounter,
        provider: literal('xinjiaoyu'),
        result: object(
          { authorization: s({ max: 8192 }), accesstoken: s({ max: 8192 }), clientsession: s({ max: 8192 }) },
          {
            device: s({ max: 8192 }),
            devicetype: s({ max: 8192 }),
            'user-agent': s({ max: 8192 }),
            'accept-language': s({ max: 8192 }),
            'sec-ch-ua': s({ max: 8192 }),
            'sec-ch-ua-mobile': s({ max: 8192 }),
            'sec-ch-ua-platform': s({ max: 8192 }),
          },
        ),
      }),
    ),
  }),
);
