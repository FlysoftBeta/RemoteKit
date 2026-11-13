import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteKitError } from '../shared/errors';
import { readBuildId } from './cluster/build-id';
import { publicKey } from './cluster/noise';
import { validateNodeReadySizes } from './cluster/ready';
import {
  configDocument,
  controlKey,
  nodeBootstrap,
  decodeConfigFile,
  encodeConfigFile,
  type NodeBootstrap,
} from './config-formats';
import { corruptState } from './persistence/codec';
import { log } from './log';

export interface MediaConfig {
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
}
export interface NodeLimits {
  maxSessions: number | null;
  diskReserveBytes: number | null;
  sessionMemoryBytes: number | null;
}
export interface NodeConfig {
  nodeId: string;
  peer: Readonly<{ listen: string; address: string }>;
  rtc: Readonly<{ ports: string | null; address: string | null }>;
  media: Readonly<MediaConfig>;
}
export interface ParsedNode {
  readonly config: Readonly<NodeConfig>;
  readonly configHash: string;
  readonly limits: Readonly<NodeLimits>;
  readonly bootstrapFile: string;
  readonly remote?: Readonly<{ control: string }>;
  readonly local?: Readonly<{ executable: string; root: string; versionDir?: string }>;
}
export interface ConfiguredNode extends ParsedNode {
  readonly publicKey: string;
}
export interface ParsedConfig {
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
  readonly logDir: string;
  readonly quotas: Readonly<{ tenantObjectBytes: number | null }>;
  readonly nodes: Readonly<Record<string, ParsedNode>>;
}
export interface RuntimeConfig extends Omit<ParsedConfig, 'nodes'> {
  readonly identity: Readonly<{ privateKey: string; publicKey: string }>;
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
export const mediaDefaults: MediaConfig = Object.freeze({
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
function invalid(message: string): never {
  throw corruptState('configuration', new Error(message));
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
function validateMedia(value: Record<string, any>, partial = false): MediaConfig {
  for (const [key, values] of Object.entries({
    encoder: ['auto', 'qsv', 'nvenc'],
    qsvLowPower: ['auto', 'on', 'off'],
    rateControl: [null, 'cbr', 'vbr'],
  }))
    if ((!partial || key in value) && !values.includes(value[key])) invalid(`Invalid media.${key}`);
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
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (partial && !(key in value)) continue;
    if (value[key] === null && ['asyncDepth', 'gop', 'targetUsage', 'bufferMs'].includes(key)) continue;
    integer(value[key], min, max, `media.${key}`);
  }
  if (!partial && value.maxBitrate < value.bitrate) invalid('maxBitrate must be >= bitrate');
  if (!partial && value.encoder === 'nvenc' && value.qsvLowPower !== 'auto')
    invalid('nvenc requires qsvLowPower auto');
  return value as MediaConfig;
}
export const limitDefaults: NodeLimits = Object.freeze({
  maxSessions: null,
  diskReserveBytes: null,
  sessionMemoryBytes: null,
});
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
function localExecutable(localRoot: string, buildId: string, directory: string, value: unknown) {
  if (buildId === 'dev') return resolve(directory, string(value, 'local.executable'));
  if (value !== undefined) invalid('local.executable is only for development builds');
  return resolve(localRoot, 'runtime', buildId, 'bin', 'endpoint_service.exe');
}
const defaultOrigins = Object.freeze([
  'http://127.0.0.1:3001',
  'http://localhost:3001',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);
export function parseConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
): ParsedConfig {
  if (argv.length) invalid('Control does not accept command-line arguments');
  const buildId = readBuildId(root);
  const configPath = resolve(env.REMOTEKIT_CONTROL_CONFIG ?? resolve(root, 'data/control.json'));
  const directory = dirname(configPath);
  let parsed: unknown;
  try {
    parsed = existsSync(configPath)
      ? decodeConfigFile(readFileSync(configPath, 'utf8'), configDocument, 'control')
      : defaultConfig(buildId);
  } catch (error) {
    if (error instanceof RemoteKitError) throw error;
    throw corruptState(configPath, error);
  }
  const source = object(
    parsed,
    ['version', 'http', 'storage', 'media', 'nodes', 'quotas', 'sessionImport'],
    'config',
  );
  const http = object(source.http, ['listen', 'origins', 'tls'], 'http');
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
      replyWindowSeconds: integer(value.replyWindowSeconds, 0, 600, 'sessionImport.replyWindowSeconds'),
      imap: Object.freeze({
        host: string(imap.host, 'sessionImport.imap.host'),
        port: integer(imap.port, 1, 65535, 'sessionImport.imap.port'),
        user: string(imap.user, 'sessionImport.imap.user'),
        password: string(imap.password, 'sessionImport.imap.password'),
      }),
      folder: string(value.folder, 'sessionImport.folder'),
      pollSeconds: integer(value.pollSeconds, 15, 3600, 'sessionImport.pollSeconds'),
    });
  }
  // Port 0 lets the OS choose, which only tests use.
  const listen = hostPort(http.listen, 'http.listen', 0);
  const origins = http.origins;
  if (!Array.isArray(origins) || !origins.every((value) => typeof value === 'string'))
    invalid('Invalid http.origins');
  let tls: RuntimeConfig['tls'];
  if (http.tls !== undefined) {
    const value = object(http.tls, ['key', 'cert'], 'http.tls');
    const keyPath = resolve(directory, string(value.key, 'tls.key'));
    const certPath = resolve(directory, string(value.cert, 'tls.cert'));
    tls = Object.freeze({ key: readFileSync(keyPath), cert: readFileSync(certPath) });
  }
  const storage = object(source.storage, ['database', 'diagnostics', 'logs'], 'storage');
  const defaults = object(source.media, Object.keys(mediaDefaults), 'media');
  validateMedia(defaults, true);
  const entries = object(source.nodes, Object.keys(source.nodes), 'nodes');
  const quotas = object(source.quotas, ['tenantObjectBytes'], 'quotas');
  const tenantObjectBytes =
    quotas.tenantObjectBytes === null
      ? null
      : integer(quotas.tenantObjectBytes, 1, Number.MAX_SAFE_INTEGER, 'quotas.tenantObjectBytes');
  const nodes: Record<string, ParsedNode> = Object.create(null);
  const localPorts = new Map<number, string>();
  const localRoots = new Map<string, string>();
  for (const [nodeId, entry] of Object.entries(entries)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(nodeId)) invalid('Invalid node ID');
    const node = object(entry, ['local', 'remote', 'peer', 'rtc', 'limits', 'media'], `nodes.${nodeId}`);
    if ('local' in node === 'remote' in node)
      invalid(`nodes.${nodeId} requires exactly one of local or remote`);
    const options =
      node.media === undefined
        ? undefined
        : object(node.media, Object.keys(mediaDefaults), `nodes.${nodeId}.media`);
    if (options !== undefined) validateMedia(options, true);
    const media = Object.freeze(validateMedia({ ...defaults, ...options }));
    const peerValue = object(node.peer, ['listen', 'address'], `nodes.${nodeId}.peer`);
    if (
      Object.keys(entries).length > 1 &&
      (peerValue.listen === undefined || peerValue.address === undefined)
    )
      invalid(`nodes.${nodeId}.peer.listen and peer.address are required with multiple nodes`);
    const listenAddress = peerValue.listen;
    const peerPort = hostPort(listenAddress, `nodes.${nodeId}.peer.listen`).port;
    const address = peerValue.address;
    hostPort(address, `nodes.${nodeId}.peer.address`);
    const peer = Object.freeze({ listen: listenAddress, address });
    const rtcValue = object(node.rtc, ['ports', 'address'], `nodes.${nodeId}.rtc`);
    const rtc = Object.freeze({
      ports: rtcValue.ports,
      address: rtcValue.address,
    });
    if (rtc.ports !== null) portRange(rtc.ports, 'rtc.ports');
    if (
      rtc.address !== null &&
      (!/^[A-Za-z0-9.-]+$/.test(string(rtc.address, 'rtc.address')) || rtc.ports === null)
    )
      invalid('rtc.address requires a valid host and rtc.ports');
    const limitsValue = object(node.limits, Object.keys(limitDefaults), `nodes.${nodeId}.limits`);
    const limits = limitsValue as NodeLimits;
    for (const [key, min, max] of [
      ['maxSessions', 1, 64],
      ['diskReserveBytes', 0, Number.MAX_SAFE_INTEGER],
      ['sessionMemoryBytes', 1, Number.MAX_SAFE_INTEGER],
    ] as const)
      if (limits[key] !== null) integer(limits[key], min, max, `nodes.${nodeId}.limits.${key}`);
    const config = Object.freeze({ nodeId, peer, rtc, media });
    let local: ParsedNode['local'];
    let remote: ParsedNode['remote'];
    if (node.local !== undefined) {
      const value = object(node.local, ['executable', 'root'], `nodes.${nodeId}.local`);
      const localRoot = resolve(directory, string(value.root, `nodes.${nodeId}.local.root`));
      if (localPorts.has(peerPort))
        invalid(
          `nodes.${localPorts.get(peerPort)} and nodes.${nodeId} share local peer listen port ${peerPort}`,
        );
      if (localRoots.has(localRoot.toLowerCase()))
        invalid(`nodes.${localRoots.get(localRoot.toLowerCase())} and nodes.${nodeId} share local.root`);
      localPorts.set(peerPort, nodeId);
      localRoots.set(localRoot.toLowerCase(), nodeId);
      local = Object.freeze({
        executable: localExecutable(localRoot, buildId, directory, value.executable),
        root: localRoot,
        ...(buildId === 'dev' ? {} : { versionDir: resolve(root, '..') }),
      });
    } else {
      const value = object(node.remote, ['control'], `nodes.${nodeId}.remote`);
      remote = Object.freeze({ control: controlUrl(value.control, `nodes.${nodeId}.remote.control`) });
    }
    nodes[nodeId] = Object.freeze({
      config,
      limits: Object.freeze(limits),
      configHash: createHash('sha256').update(canonicalJson({ peer, rtc })).digest('hex'),
      bootstrapFile: local
        ? resolve(local.root, 'node.json')
        : resolve(directory, 'nodes', nodeId, 'node.json'),
      ...(local ? { local } : { remote }),
    });
  }
  try {
    validateNodeReadySizes(nodes, buildId);
  } catch (error) {
    invalid((error as Error).message);
  }
  return Object.freeze({
    sessionImport,
    configPath,
    root,
    buildId,
    host: listen.host.replace(/^\[(.*)\]$/, '$1'),
    port: listen.port,
    tls,
    origins: Object.freeze([...origins]),
    dbPath: resolve(directory, string(storage.database, 'storage.database')),
    diagnosticDir: resolve(directory, string(storage.diagnostics, 'storage.diagnostics')),
    logDir: resolve(directory, string(storage.logs, 'storage.logs')),
    clientDir: resolve(root, 'dist/client'),
    nodes: Object.freeze(nodes),
    quotas: Object.freeze({ tenantObjectBytes }),
  });
}

export function defaultConfig(buildId: string) {
  return {
    version: 1 as const,
    http: { listen: '127.0.0.1:3001', origins: [...defaultOrigins] },
    storage: { database: '../data/control.db', diagnostics: '../data/diagnostics', logs: '../logs' },
    media: { ...mediaDefaults },
    quotas: { tenantObjectBytes: null },
    nodes: {
      local: {
        peer: { listen: '127.0.0.1:3101', address: '127.0.0.1:3101' },
        rtc: { ports: null, address: null },
        limits: { ...limitDefaults },
        local: {
          root: '../data/node',
          ...(buildId === 'dev' ? { executable: '../../build/endpoint/endpoint/endpoint_service.exe' } : {}),
        },
      },
    },
  };
}
export function decodeIdentityKey(value: unknown, name: string): Buffer {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Buffer.from(value, 'base64').toString('base64') !== value
  )
    invalid(`Invalid ${name}`);
  return Buffer.from(value, 'base64');
}
function readBootstrap(
  node: ParsedNode,
  nodeId: string,
  controlPublicKey: string,
): NodeBootstrap | undefined {
  let contents: string;
  try {
    contents = readFileSync(node.bootstrapFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const file = decodeConfigFile(contents, nodeBootstrap, 'node');
  if (file.nodeId !== nodeId || file.controlPublicKey !== controlPublicKey)
    invalid('Node bootstrap identity does not match configuration');
  if (node.remote) controlUrl(file.control, 'node.json.control');
  else if (file.control !== undefined) invalid('Local node bootstrap must omit control');
  return file;
}
export function provisionConfig(config: ParsedConfig): RuntimeConfig {
  const directory = dirname(config.configPath);
  const keyFile = resolve(directory, 'control.key');
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(
      keyFile,
      encodeConfigFile(
        { version: 1, privateKey: randomBytes(32).toString('base64') },
        controlKey,
        'control.key',
      ),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const { privateKey } = decodeConfigFile(readFileSync(keyFile, 'utf8'), controlKey, 'key');
  const controlPublicKey = publicKey(decodeIdentityKey(privateKey, 'control.key')).toString('base64');
  const parent = resolve(directory, 'nodes');
  mkdirSync(parent, { recursive: true });
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (entry.isDirectory() && !config.nodes[entry.name]?.remote)
      rmSync(resolve(parent, entry.name, 'node.json'), { force: true });
  }
  const nodes: Record<string, ConfiguredNode> = Object.create(null);
  for (const [nodeId, node] of Object.entries(config.nodes)) {
    mkdirSync(dirname(node.bootstrapFile), { recursive: true });
    const loaded = readBootstrap(node, nodeId, controlPublicKey);
    let file: NodeBootstrap;
    let write = false;
    if (loaded === undefined) {
      file = {
        version: 1,
        nodeId,
        privateKey: randomBytes(32).toString('base64'),
        controlPublicKey,
        ...(node.remote ? { control: node.remote.control } : {}),
      };
      write = true;
      log.info('config.identity_created', { nodeId });
    } else {
      file = loaded;
      if (node.remote && file.control !== node.remote.control) {
        file.control = node.remote.control;
        write = true;
        log.info('config.bootstrap_updated', { nodeId });
      }
    }
    if (write)
      writeFileSync(node.bootstrapFile, encodeConfigFile(file, nodeBootstrap, 'node.json'), { mode: 0o600 });
    const nodePublicKey = publicKey(decodeIdentityKey(file.privateKey, 'node.json.privateKey')).toString(
      'base64',
    );
    nodes[nodeId] = Object.freeze({ ...node, publicKey: nodePublicKey });
  }
  return Object.freeze({
    ...config,
    identity: Object.freeze({ privateKey, publicKey: controlPublicKey }),
    nodes: Object.freeze(nodes),
  });
}
export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
): RuntimeConfig {
  const config = parseConfig(env, argv, root);
  const directory = dirname(config.configPath);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(config.configPath))
    writeFileSync(
      config.configPath,
      encodeConfigFile(defaultConfig(config.buildId), configDocument, 'control.json'),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
  const runtime = provisionConfig(config);
  return runtime;
}
