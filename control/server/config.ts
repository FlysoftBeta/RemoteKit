import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteKitError } from '../shared/errors';
export interface RuntimeConfig {
  readonly dbPath: string;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly endpointArgs: readonly string[];
  readonly node?: Readonly<{ nodeId: string; token: string; tlsProxy: boolean }>;
  readonly tls?: Readonly<{ key: Buffer; cert: Buffer }>;
  readonly origins: readonly string[];
  readonly clientDir: string;
  readonly diagnosticDir: string;
}
export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): RuntimeConfig {
  if (argv.length) throw new RemoteKitError('invalid_request', 'Control 不接受命令行参数');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dbPath = resolve(env.REMOTEKIT_CONTROL_DB ?? resolve(root, 'data/control.db'));
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RemoteKitError('invalid_request', '无效端口');
  const tlsKey = env.REMOTEKIT_HTTPS_KEY,
    tlsCert = env.REMOTEKIT_HTTPS_CERT;
  if (!!tlsKey !== !!tlsCert) throw new RemoteKitError('invalid_request', 'HTTPS key 和 cert 需同时配置');
  const tls =
    tlsKey && tlsCert ? Object.freeze({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }) : undefined;
  const scheme = tls ? 'https' : 'http';
  let endpointArgs: unknown;
  try {
    endpointArgs = JSON.parse(env.REMOTEKIT_ENDPOINT_ARGS ?? '[]');
  } catch {
    throw new RemoteKitError('invalid_request', '无效 Endpoint 参数');
  }
  if (!Array.isArray(endpointArgs) || !endpointArgs.every((value) => typeof value === 'string'))
    throw new RemoteKitError('invalid_request', 'Endpoint 参数需字符串数组');
  return Object.freeze({
    dbPath,
    port,
    host: env.REMOTEKIT_CONTROL_HOST ?? '127.0.0.1',
    endpoint: env.REMOTEKIT_ENDPOINT ?? resolve(root, '../build/endpoint/endpoint/endpoint_service.exe'),
    endpointArgs: Object.freeze(endpointArgs),
    node: env.REMOTEKIT_ENDPOINT_NODE_ID
      ? Object.freeze({
          nodeId: env.REMOTEKIT_ENDPOINT_NODE_ID,
          token: env.REMOTEKIT_ENDPOINT_TOKEN ?? '',
          tlsProxy: env.REMOTEKIT_ENDPOINT_TLS_PROXY === '1',
        })
      : undefined,
    tls,
    origins: Object.freeze(
      (
        env.REMOTEKIT_CONTROL_ORIGINS ??
        `${scheme}://127.0.0.1:${port},${scheme}://localhost:${port},http://127.0.0.1:5173,http://localhost:5173`
      )
        .split(',')
        .map((value) => value.trim()),
    ),
    clientDir: resolve(root, 'dist/client'),
    diagnosticDir: resolve(env.REMOTEKIT_DIAGNOSTICS_DIR ?? resolve(dirname(dbPath), 'diagnostics')),
  });
}
