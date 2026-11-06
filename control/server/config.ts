import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  peer: Readonly<{ listen: string; advertise: string }>;
  diskReserveBytes: number;
  sessionMemoryBytes: number;
}
export interface ConfiguredNode {
  readonly config: Readonly<NodeConfig>;
  readonly configHash: string;
  readonly launch?: Readonly<{ executable: string; root: string }>;
}
export interface RuntimeConfig {
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
  readonly cluster: Readonly<{ keyFile: string; key: string; advertiseUrl?: string }>;
  readonly quotas: Readonly<{ tenantObjectBytes: number }>;
  readonly nodes: Readonly<Record<string, ConfiguredNode>>;
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
  peer: Object.freeze({ listen: '0.0.0.0:3101', advertise: '' }),
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
    const peer = object(value.peer, ['listen', 'advertise'], 'peer');
    for (const key of ['listen', 'advertise']) {
      if (partial && !(key in peer)) continue;
      if (key === 'advertise' && peer[key] === '') continue;
      const address = string(peer[key], `peer.${key}`);
      if (
        !/^(?:\[[^\]]+\]|[^\s:]+):[0-9]+$/.test(address) ||
        Number(address.slice(address.lastIndexOf(':') + 1)) < 1 ||
        Number(address.slice(address.lastIndexOf(':') + 1)) > 65535
      )
        invalid(`Invalid peer.${key}`);
    }
  }
  return value as NodeConfig;
}
export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): RuntimeConfig {
  if (argv.length) invalid('Control does not accept command-line arguments');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = resolve(env.REMOTEKIT_CONTROL_CONFIG ?? resolve(root, 'data/control.json'));
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(configPath))
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          http: {
            host: '127.0.0.1',
            port: 3001,
            origins: [
              'http://127.0.0.1:3001',
              'http://localhost:3001',
              'http://127.0.0.1:5173',
              'http://localhost:5173',
            ],
          },
          database: 'control.db',
          diagnostics: 'diagnostics',
          cluster: { keyFile: 'cluster.key' },
          nodeDefaults,
          quotas: defaultQuotas,
          nodes: {
            local: {
              launch: { executable: '../../build/endpoint/endpoint/endpoint_service.exe', root: 'node' },
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
    ['http', 'database', 'diagnostics', 'cluster', 'nodeDefaults', 'nodes', 'quotas'],
    'config',
  );
  const http = object(fallback(source.http, {}), ['host', 'port', 'origins', 'tls'], 'http');
  const host = string(fallback(http.host, '127.0.0.1'), 'http.host');
  const port = integer(fallback(http.port, 3001), 0, 65535, 'http.port');
  const origins = fallback(http.origins, [
    'http://127.0.0.1:3001',
    'http://localhost:3001',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
  if (!Array.isArray(origins) || !origins.every((value) => typeof value === 'string'))
    invalid('Invalid http.origins');
  let tls: RuntimeConfig['tls'];
  if (http.tls !== undefined) {
    const value = object(http.tls, ['key', 'cert'], 'http.tls');
    const keyPath = resolve(directory, string(value.key, 'tls.key'));
    const certPath = resolve(directory, string(value.cert, 'tls.cert'));
    tls = Object.freeze({ key: readFileSync(keyPath), cert: readFileSync(certPath) });
  }
  const cluster = object(fallback(source.cluster, {}), ['keyFile', 'advertiseUrl'], 'cluster');
  const keyFile = resolve(directory, string(fallback(cluster.keyFile, 'cluster.key'), 'cluster.keyFile'));
  const defaults = object(fallback(source.nodeDefaults, {}), Object.keys(nodeDefaults), 'nodeDefaults');
  validateNode(defaults, true);
  const entries = object(source.nodes, Object.keys(source.nodes ?? {}), 'nodes');
  if (!Object.keys(entries).length) invalid('At least one node is required');
  const quotas = object(fallback(source.quotas, {}), ['tenantObjectBytes'], 'quotas');
  const tenantObjectBytes = integer(
    fallback(quotas.tenantObjectBytes, defaultQuotas.tenantObjectBytes),
    1,
    Number.MAX_SAFE_INTEGER,
    'quotas.tenantObjectBytes',
  );
  const nodes: Record<string, ConfiguredNode> = Object.create(null);
  for (const [nodeId, entry] of Object.entries(entries)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(nodeId)) invalid('Invalid node ID');
    const override = object(entry, [...Object.keys(nodeDefaults), 'launch'], `nodes.${nodeId}`);
    const { launch: launchValue, ...options } = override;
    validateNode(options, true);
    const peer = { ...nodeDefaults.peer, ...defaults.peer, ...options.peer };
    if (!peer.advertise) {
      if (launchValue === undefined && Object.keys(entries).length > 1)
        invalid(`nodes.${nodeId}.peer.advertise is required for remote nodes`);
      peer.advertise = '127.0.0.1:' + peer.listen.slice(peer.listen.lastIndexOf(':') + 1);
    }
    const config = Object.freeze(
      validateNode({ ...nodeDefaults, ...defaults, ...options, nodeId, peer: Object.freeze(peer) }),
    );
    let launch: ConfiguredNode['launch'];
    if (launchValue !== undefined) {
      const value = object(launchValue, ['executable', 'root'], 'launch');
      launch = Object.freeze({
        executable: resolve(directory, string(value.executable, 'launch.executable')),
        root: resolve(directory, string(value.root, 'launch.root')),
      });
    }
    nodes[nodeId] = Object.freeze({
      config,
      configHash: createHash('sha256').update(canonicalJson(config)).digest('hex'),
      ...(launch ? { launch } : {}),
    });
  }
  let advertiseUrl: string | undefined;
  if (cluster.advertiseUrl !== undefined) {
    advertiseUrl = string(cluster.advertiseUrl, 'cluster.advertiseUrl');
    let url: URL;
    try {
      url = new URL(advertiseUrl);
    } catch {
      invalid('Invalid cluster.advertiseUrl');
    }
    if (
      !['ws:', 'wss:'].includes(url.protocol) ||
      url.pathname !== '/api/node' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      invalid('Invalid cluster.advertiseUrl');
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
  if (advertiseUrl) {
    const nodeFile = resolve(directory, 'node.json');
    const contents = JSON.stringify({ control: advertiseUrl, key }) + '\n';
    if (!existsSync(nodeFile) || readFileSync(nodeFile, 'utf8') !== contents)
      writeFileSync(nodeFile, contents, { mode: 0o600 });
  }
  for (const node of Object.values(nodes)) if (node.launch) mkdirSync(node.launch.root, { recursive: true });
  return Object.freeze({
    configPath,
    root,
    buildId: readBuildId(root),
    host,
    port,
    tls,
    origins: Object.freeze(origins),
    dbPath: resolve(directory, string(fallback(source.database, 'control.db'), 'database')),
    diagnosticDir: resolve(directory, string(fallback(source.diagnostics, 'diagnostics'), 'diagnostics')),
    clientDir: resolve(root, 'dist/client'),
    cluster: Object.freeze({ keyFile, key, advertiseUrl }),
    nodes: Object.freeze(nodes),
    quotas: Object.freeze({ tenantObjectBytes }),
  });
}
