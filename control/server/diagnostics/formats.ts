import {
  array,
  boolean,
  integer,
  literal,
  number,
  object,
  record,
  string,
  union,
} from '../persistence/codec';

export const stopReason = literal(
  'user',
  'duration-limit',
  'size-limit',
  'disconnected',
  'authorization-changed',
  'shutdown',
);
export const archiveMetadata = object({ version: literal(1), reason: stopReason });
const count = () => integer({ min: 0 });
const duration = () => number({ min: 0, max: Number.MAX_SAFE_INTEGER });
const text = () => string({ max: 32768 });
const environment = object(
  {},
  {
    browserFamily: literal('chrome', 'chromium', 'edge', 'safari', 'firefox', 'brave', 'other'),
    platform: literal('android', 'ios', 'windows', 'macos', 'linux', 'chromeos', 'other'),
    effectiveConnectionType: literal('slow-2g', '2g', '3g', '4g'),
    browserVersion: string({ pattern: /^\d{1,5}(?:\.\d{1,5}){0,4}$/ }),
    osVersion: string({ pattern: /^\d{1,5}(?:\.\d{1,5}){0,4}$/ }),
    browserMajorVersion: count(),
    viewportWidth: duration(),
    viewportHeight: duration(),
    devicePixelRatio: duration(),
    screenWidth: duration(),
    screenHeight: duration(),
    screenColorDepth: count(),
    maxTouchPoints: count(),
    videoFrameCallbackSupported: boolean(),
    hardwareConcurrency: count(),
    deviceMemoryGiB: duration(),
    networkRttMs: duration(),
    networkDownlinkMbps: duration(),
  },
);
const logSummary = union(
  object({ available: literal(false) }),
  object({ bytes: count(), droppedBefore: count() }),
  object({ exists: boolean(), size: count(), start: count(), bytes: count() }),
  object({ error: text() }, { size: count() }),
);
const source = object({ records: count(), available: boolean() });
export const diagnosticManifest = object({
  schemaVersion: literal(1),
  id: string({ pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/ }),
  startedAt: count(),
  endedAt: count(),
  elapsedMs: duration(),
  reason: stopReason,
  interrupted: boolean(),
  runtime: object({
    node: text(),
    platform: literal('win32', 'linux', 'darwin', 'aix', 'freebsd', 'openbsd', 'sunos', 'android'),
    architecture: literal(
      'x64',
      'arm64',
      'ia32',
      'arm',
      'ppc',
      'ppc64',
      's390',
      's390x',
      'riscv64',
      'loong64',
      'mips',
      'mipsel',
    ),
  }),
  environment,
  limits: object({
    maxDurationMs: count(),
    maxBytes: count(),
    sampleIntervalMs: count(),
    messageBytes: count(),
    logBytes: object({
      browser: count(),
      endpoint: count(),
      crashes: count(),
      dump: count(),
      dumpCount: count(),
    }),
  }),
  logs: record(logSummary, {
    key: /^(?:control|browser|endpoint|endpoint\.1|crashes|dump\/[0-9a-f-]{36}\.dmp)$/,
    max: 8,
  }),
  sources: object({ client: source, control: source, endpoint: source, events: source }),
  unavailable: object({
    control: count(),
    endpoint: count(),
    browserOutput: count(),
    endpointPending: count(),
  }),
  truncated: array(string({ min: 1, max: 128 }), { max: 128 }),
  clocks: object({
    receivedAt: text(),
    elapsedMs: text(),
    requestedElapsedMs: text(),
    clientTimeMs: text(),
    endpoint: text(),
    cpuUsageUs: text(),
  }),
});
