import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteKitError } from '../shared/errors';
import { readBuildId } from './cluster/build-id';

export interface NodeConfig {
  nodeId: string;
  encoder: 'auto' | 'qsv' | 'nvenc';
  fps: number;
  bitrate: number;
  maxBitrate: number;
  asyncDepth: number | null;
  gop: number | null;
  targetUsage: number | null;
  qsvLowPower: 'auto' | 'on' | 'off';
  bufferMs: number | null;
  rateControl: 'cbr' | 'vbr' | null;
  idleIdrMs: number;
  maxEncodeWidth: number;
  maxEncodeHeight: number;
  dataPath: string;
  browser: string | null;
  browserTraceDir: string | null;
  maxSessions: number;
  /** Node-to-node object transfer: where this node listens and where other nodes reach it. */
  peer: Readonly<{ listen: string; address: string }>;
  /** Viewer media: UDP port range for WebRTC and the host or IP Viewers use to reach it. */
  rtc: Readonly<{ ports: string | null; address: string | null }>;
  diskReserveBytes: number;
  sessionMemoryBytes: number;
}
export interface ConfiguredNode {
  readonly config: Readonly<NodeConfig>;
  readonly configHash: string;
  /** Present for a node Control starts itself over stdio. */
  readonly local?: Readonly<{ executable: string; root: string }>;
}
export interface RuntimeConfig {
  readonly sessionImport?: SessionImportConfig;
  readonly configPath: string;
  readonly root: string;
  readonly buildId: string;
  readonly dbPath: string;
  readonly host: string;
  readonly port: number;
  readonly tls?: Readonly<{ key: Buffer; cert: Buffer }>;
  readonly origins: readonly string[];
  readonly clientDir: string;
  readonly diagnosticDir: string;
  readonly cluster: Readonly<{ keyFile: string; key: string }>;
  readonly quotas: Readonly<{ tenantObjectBytes: number }>;
  readonly nodes: Readonly<Record<string, ConfiguredNode>>;
}
export interface SessionImportConfig {
  readonly mailbox: string;
  readonly imap: Readonly<{ host: string; port: number; user: string; password: string }>;
  readonly smtp: Readonly<{ host: string; port: number; user: string; password: string }>;
  readonly appMailbox: string;
  readonly folder: string;
  readonly pollSeconds: number;
  readonly replyWindowSeconds: number;
}
export const defaultQuotas = Object.freeze({ tenantObjectBytes: 4 * 1024 ** 3 });
export const nodeDefaults: Omit<NodeConfig, 'nodeId'> = Object.freeze({
  encoder: 'auto',
  fps: 60,
  bitrate: 36000000,
  maxBitrate: 48000000,
  asyncDepth: null,
  gop: null,
  targetUsage: null,
  qsvLowPower: 'auto',
  bufferMs: null,
  rateControl: null,
  idleIdrMs: 150,
  maxEncodeWidth: 4096,
  maxEncodeHeight: 4096,
  dataPath: 'data',
  browser: null,
  browserTraceDir: null,
  maxSessions: 3,
  peer: Object.freeze({ listen: '0.0.0.0:3101', address: '' }),
  rtc: Object.freeze({ ports: null, address: null }),
  diskReserveBytes: 10 * 1024 ** 3,
  sessionMemoryBytes: 2 * 1024 ** 3,
});
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function fallback<T>(value: T | undefined, defaultValue: T): T {
  return value === undefined ? defaultValue : value;
}
function invalid(message: string): never {
  throw new RemoteKitError('invalid_request', message);
}
function object(value: unknown, keys: readonly string[], name: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`Unknown ${name}.${key}`);
  return value as Record<string, any>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.length) invalid(`${name} must be a nonempty string`);
  return value;
}
function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    invalid(`Invalid ${name}`);
  return value;
}
function validateNode(value: Record<string, any>, partial = false): NodeConfig {
  for (const [key, values] of Object.entries({
    encoder: ['auto', 'qsv', 'nvenc'],
    qsvLowPower: ['auto', 'on', 'off'],
    rateControl: [null, 'cbr', 'vbr'],
  }))
    if ((!partial || key in value) && !values.includes(value[key])) invalid(`Invalid ${key}`);
  const ranges: Record<string, [number, number]> = {
    fps: [1, 120],
    bitrate: [100000, 50000000],
    maxBitrate: [100000, 60000000],
    asyncDepth: [1, 8],
    gop: [1, 65535],
    targetUsage: [1, 7],
    bufferMs: [50, 5000],
    idleIdrMs: [0, 4294967295],
    maxEncodeWidth: [16, 4096],
    maxEncodeHeight: [16, 4096],
    maxSessions: [1, 64],
    diskReserveBytes: [0, Number.MAX_SAFE_INTEGER],
    sessionMemoryBytes: [1, Number.MAX_SAFE_INTEGER],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (partial && !(key in value)) continue;
    if (value[key] === null && ['asyncDepth', 'gop', 'targetUsage', 'bufferMs'].includes(key)) continue;
    integer(value[key], min, max, key);
  }
  if (!partial && value.maxBitrate < value.bitrate) invalid('maxBitrate must be >= bitrate');
  if (!partial && value.encoder === 'nvenc' && value.qsvLowPower !== 'auto')
    invalid('nvenc requires qsvLowPower auto');
  if (!partial || 'dataPath' in value) string(value.dataPath, 'dataPath');
  for (const key of ['browser', 'browserTraceDir'])
    if ((!partial || key in value) && value[key] !== null) string(value[key], key);
  if (!partial || 'peer' in value) {
    const peer = object(value.peer, ['listen', 'address'], 'peer');
    if (!partial || 'listen' in peer) hostPort(peer.listen, 'peer.listen');
    if ((!partial || 'address' in peer) && peer.address !== '') hostPort(peer.address, 'peer.address');
  }
  if (!partial || 'rtc' in value) {
    const rtc = object(value.rtc, ['ports', 'address'], 'rtc');
    if ((!partial || 'ports' in rtc) && rtc.ports !== null) portRange(rtc.ports, 'rtc.ports');
    if ((!partial || 'address' in rtc) && rtc.address !== null) {
      const address = string(rtc.address, 'rtc.address');
      if (!/^[A-Za-z0-9.-]+$/.test(address)) invalid('Invalid rtc.address');
    }
  }
  if (!partial && value.rtc.address !== null && value.rtc.ports === null)
    invalid('rtc.address requires rtc.ports so the forwarded ports are fixed');
  return value as NodeConfig;
}
function hostPort(value: unknown, name: string, minPort = 1): { host: string; port: number } {
  const address = string(value, name);
  const match = /^(\[[^\]]+\]|[^\s:[\]]+):([0-9]{1,5})$/.exec(address);
  if (!match || Number(match[2]) < minPort || Number(match[2]) > 65535) invalid(`Invalid ${name}`);
  return { host: match[1], port: Number(match[2]) };
}
function portRange(value: unknown, name: string) {
  const match = /^([0-9]{1,5})-([0-9]{1,5})$/.exec(string(value, name));
  const [min, max] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (!match || min < 1024 || max > 65535 || min > max) invalid(`Invalid ${name}`);
}
function controlUrl(value: unknown, name: string): string {
  const text = string(value, name);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    invalid(`Invalid ${name}`);
  }
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.pathname !== '/api/node' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalid(`${name} must be ws(s)://host:port/api/node`);
  return text;
}
/** A packaged Control runs the node runtime it installed for its own build; a dev build names its Endpoint. */
function localExecutable(root: string, buildId: string, directory: string, value: unknown) {
  if (buildId === 'dev') return resolve(directory, string(value, 'local.executable'));
  if (value !== undefined) invalid('local.executable is only for development builds');
  return resolve(root, '..', 'data', 'local', 'runtime', buildId, 'bin', 'endpoint_service.exe');
}
function writeNodeFiles(directory: string, files: ReadonlyMap<string, string>) {
  const parent = resolve(directory, 'nodes');
  mkdirSync(parent, { recursive: true });
  for (const entry of readdirSync(parent, { withFileTypes: true }))
    if (entry.isDirectory() && !files.has(entry.name))
      rmSync(resolve(parent, entry.name, 'node.json'), { force: true });
  for (const [nodeId, contents] of files) {
    const file = resolve(parent, nodeId, 'node.json');
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file) || readFileSync(file, 'utf8') !== contents)
      writeFileSync(file, contents, { mode: 0o600 });
  }
}
const defaultOrigins = Object.freeze([
  'http://127.0.0.1:3001',
  'http://localhost:3001',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);
export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): RuntimeConfig {
  if (argv.length) invalid('Control does not accept command-line arguments');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const buildId = readBuildId(root);
  const configPath = resolve(env.REMOTEKIT_CONTROL_CONFIG ?? resolve(root, 'data/control.json'));
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(configPath))
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          http: { listen: '127.0.0.1:3001', origins: defaultOrigins },
          storage: { database: 'control.db', diagnostics: 'diagnostics' },
          cluster: { keyFile: 'cluster.key' },
          nodeDefaults,
          quotas: defaultQuotas,
          nodes: {
            local: {
              local: { executable: '../../build/endpoint/endpoint/endpoint_service.exe', root: 'node' },
            },
          },
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    invalid('Invalid control configuration JSON');
  }
  const source = object(
    parsed,
    ['http', 'storage', 'cluster', 'nodeDefaults', 'nodes', 'quotas', 'sessionImport'],
    'config',
  );
  const http = object(fallback(source.http, {}), ['listen', 'origins', 'tls'], 'http');
  let sessionImport: SessionImportConfig | undefined;
  if (source.sessionImport !== undefined) {
    const value = object(
      source.sessionImport,
      ['mailbox', 'imap', 'smtp', 'appMailbox', 'folder', 'pollSeconds', 'replyWindowSeconds'],
      'sessionImport',
    );
    const imap = object(value.imap, ['host', 'port', 'user', 'password'], 'sessionImport.imap');
    const smtp = object(value.smtp, ['host', 'port', 'user', 'password'], 'sessionImport.smtp');
    const smtpPort = integer(smtp.port, 1, 65535, 'sessionImport.smtp.port');
    if (smtpPort !== 465 && smtpPort !== 587) invalid('Invalid sessionImport.smtp.port');
    const appMailbox = string(value.appMailbox, 'sessionImport.appMailbox');
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(appMailbox)) invalid('Invalid sessionImport.appMailbox');
    const mailbox = string(value.mailbox, 'sessionImport.mailbox');
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(mailbox)) invalid('Invalid sessionImport.mailbox');
    sessionImport = Object.freeze({
      mailbox,
      appMailbox,
      smtp: Object.freeze({
        host: string(smtp.host, 'sessionImport.smtp.host'),
        port: smtpPort,
        user: string(smtp.user, 'sessionImport.smtp.user'),
        password: string(smtp.password, 'sessionImport.smtp.password'),
      }),
      replyWindowSeconds: integer(
        fallback(value.replyWindowSeconds, 30),
        0,
        600,
        'sessionImport.replyWindowSeconds',
      ),
      imap: Object.freeze({
        host: string(imap.host, 'sessionImport.imap.host'),
        port: integer(fallback(imap.port, 993), 1, 65535, 'sessionImport.imap.port'),
        user: string(imap.user, 'sessionImport.imap.user'),
        password: string(imap.password, 'sessionImport.imap.password'),
      }),
      folder: string(fallback(value.folder, 'INBOX'), 'sessionImport.folder'),
      pollSeconds: integer(fallback(value.pollSeconds, 60), 15, 3600, 'sessionImport.pollSeconds'),
    });
  }
  // Port 0 lets the OS choose, which only tests use.
  const listen = hostPort(fallback(http.listen, '127.0.0.1:3001'), 'http.listen', 0);
  const origins = fallback<unknown>(http.origins, defaultOrigins);
  if (!Array.isArray(origins) || !origins.every((value) => typeof value === 'string'))
    invalid('Invalid http.origins');
  let tls: RuntimeConfig['tls'];
  if (http.tls !== undefined) {
    const value = object(http.tls, ['key', 'cert'], 'http.tls');
    const keyPath = resolve(directory, string(value.key, 'tls.key'));
    const certPath = resolve(directory, string(value.cert, 'tls.cert'));
    tls = Object.freeze({ key: readFileSync(keyPath), cert: readFileSync(certPath) });
  }
  const storage = object(fallback(source.storage, {}), ['database', 'diagnostics'], 'storage');
  const cluster = object(fallback(source.cluster, {}), ['keyFile', 'controlUrl'], 'cluster');
  const keyFile = resolve(directory, string(fallback(cluster.keyFile, 'cluster.key'), 'cluster.keyFile'));
  const defaultControlUrl =
    cluster.controlUrl === undefined ? undefined : controlUrl(cluster.controlUrl, 'cluster.controlUrl');
  const defaults = object(fallback(source.nodeDefaults, {}), Object.keys(nodeDefaults), 'nodeDefaults');
  validateNode(defaults, true);
  const entries = object(source.nodes, Object.keys(source.nodes ?? {}), 'nodes');
  const quotas = object(fallback(source.quotas, {}), ['tenantObjectBytes'], 'quotas');
  const tenantObjectBytes = integer(
    fallback(quotas.tenantObjectBytes, defaultQuotas.tenantObjectBytes),
    1,
    Number.MAX_SAFE_INTEGER,
    'quotas.tenantObjectBytes',
  );
  const nodes: Record<string, ConfiguredNode> = Object.create(null);
  const remoteControlUrls = new Map<string, string>();
  for (const [nodeId, entry] of Object.entries(entries)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(nodeId)) invalid('Invalid node ID');
    const override = object(entry, [...Object.keys(nodeDefaults), 'local', 'controlUrl'], `nodes.${nodeId}`);
    const { local: localValue, controlUrl: urlValue, ...options } = override;
    validateNode(options, true);
    const peer = { ...nodeDefaults.peer, ...defaults.peer, ...options.peer };
    if (!peer.address) {
      if (localValue === undefined && Object.keys(entries).length > 1)
        invalid(`nodes.${nodeId}.peer.address is required when there are several nodes`);
      peer.address = '127.0.0.1:' + hostPort(peer.listen, 'peer.listen').port;
    }
    const rtc = { ...nodeDefaults.rtc, ...defaults.rtc, ...options.rtc };
    const config = Object.freeze(
      validateNode({
        ...nodeDefaults,
        ...defaults,
        ...options,
        nodeId,
        peer: Object.freeze(peer),
        rtc: Object.freeze(rtc),
      }),
    );
    let local: ConfiguredNode['local'];
    if (localValue !== undefined) {
      if (urlValue !== undefined) invalid(`nodes.${nodeId}.controlUrl is only for remote nodes`);
      const value = object(localValue, ['executable', 'root'], `nodes.${nodeId}.local`);
      local = Object.freeze({
        executable: localExecutable(root, buildId, directory, value.executable),
        root: resolve(directory, string(value.root, `nodes.${nodeId}.local.root`)),
      });
    } else {
      const url =
        urlValue === undefined ? defaultControlUrl : controlUrl(urlValue, `nodes.${nodeId}.controlUrl`);
      if (!url) invalid(`nodes.${nodeId} needs cluster.controlUrl or its own controlUrl`);
      remoteControlUrls.set(nodeId, url);
    }
    nodes[nodeId] = Object.freeze({
      config,
      configHash: createHash('sha256').update(canonicalJson(config)).digest('hex'),
      ...(local ? { local } : {}),
    });
  }
  mkdirSync(dirname(keyFile), { recursive: true });
  try {
    writeFileSync(keyFile, randomBytes(32).toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const key = readFileSync(keyFile, 'utf8').trim();
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    Buffer.from(key, 'base64').length !== 32 ||
    Buffer.from(key, 'base64').toString('base64') !== key
  )
    invalid('Invalid cluster key file');
  writeNodeFiles(
    directory,
    new Map(
      [...remoteControlUrls].map(([nodeId, control]) => [
        nodeId,
        JSON.stringify({ nodeId, control, key }, null, 2) + '\n',
      ]),
    ),
  );
  for (const node of Object.values(nodes)) if (node.local) mkdirSync(node.local.root, { recursive: true });
  return Object.freeze({
    sessionImport,
    configPath,
    root,
    buildId,
    host: listen.host.replace(/^\[(.*)\]$/, '$1'),
    port: listen.port,
    tls,
    origins: Object.freeze([...origins]),
    dbPath: resolve(directory, string(fallback(storage.database, 'control.db'), 'storage.database')),
    diagnosticDir: resolve(
      directory,
      string(fallback(storage.diagnostics, 'diagnostics'), 'storage.diagnostics'),
    ),
    clientDir: resolve(root, 'dist/client'),
    cluster: Object.freeze({ keyFile, key }),
    nodes: Object.freeze(nodes),
    quotas: Object.freeze({ tenantObjectBytes }),
  });
}
