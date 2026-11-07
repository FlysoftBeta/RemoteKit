import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { RemoteKitError, httpStatus, toRemoteKitError } from '../../shared/errors';

import type { DomainServices } from '../application';
import type { ProcessLog } from '../diagnostics/process-log';
import { DiagnosticSessions } from '../diagnostics/sessions';
import type { NodeRegistry } from '../cluster/node-link';
import { attachViewerSocket } from './viewer-socket';

export function createHttp(
  control: DomainServices,
  options: {
    origins: string[];
    clientDir: string;
    diagnosticDir?: string;
    tls?: { key: Buffer; cert: Buffer };
    nodes?: NodeRegistry;
    processLog?: ProcessLog;
  },
) {
  let closing = false;
  const diagnosticSessions = options.diagnosticDir
    ? new DiagnosticSessions(options.diagnosticDir, {
        control: (tenant) => {
          const { revision, layoutMode, settings, tabs, windows } =
            control.store.workspaces.workspace(tenant);
          return {
            revision,
            layoutMode,
            windowCount: windows.length,
            tabCount: tabs.length,
            windows: windows
              .slice(0, 64)
              .map((window) => ({ weight: window.weight, active: window.activeTabId !== null })),
            settings: {
              qualityPreference: settings.qualityPreference,
              clientScaleOverride: settings.clientScaleOverride,
              memorySaverEnabled: settings.memorySaverEnabled,
              autoFullscreen: settings.autoFullscreen,
              avSync: settings.avSync,
              audioChannels: settings.audioChannels,
            },
          };
        },
        endpoint: (tenant) => control.endpoint.snapshot(tenant, { outputDiagnostics: true }),
        endpointLog: (tenant, request) => control.endpoint.readLog(tenant, request),
        controlLog: options.processLog && (() => options.processLog!.snapshot()),
      })
    : undefined;
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.then(
      () => inflight.delete(promise),
      () => inflight.delete(promise),
    );
    return promise;
  };
  const firstViewer = new Map<string, number>();
  const cookie = (token: string, clear = false) =>
    `rk_session=${token}; HttpOnly; SameSite=Strict; Path=/${options.tls ? '; Secure' : ''}${clear ? '; Max-Age=0' : '; Max-Age=2592000'}`;
  const checkOrigin = (req: IncomingMessage) => {
    if (!req.headers.origin || !options.origins.includes(req.headers.origin))
      throw new RemoteKitError('forbidden', '请求来源不允许');
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (closing) throw new RemoteKitError('unavailable', '服务正在关闭');
      const address = new URL(req.url ?? '/', 'http://localhost'),
        path = address.pathname,
        token = readToken(req);
      if (path === '/api/auth/setup' && req.method === 'GET')
        return json(res, 200, control.accounts.setupStatus());
      const download = /^\/api\/admin\/diagnostics\/([0-9a-f]{64})$/.exec(path);
      if (download && req.method === 'GET') {
        if (!diagnosticSessions) throw new RemoteKitError('not_found', '诊断采集未配置');
        if (!control.accounts.identity(token)?.user.isAdmin)
          throw new RemoteKitError('forbidden', '需要管理员权限');
        const archive = diagnosticSessions.takeDownload(download[1]);
        res.writeHead(200, {
          'Content-Type': 'application/zstd',
          'Content-Disposition': `attachment; filename="remotekit-diagnostics-${archive.id}.tar.zst"`,
        });
        await pipeline(createReadStream(archive.path), res);
        return;
      }
      if (path === '/api/auth/me' && req.method === 'GET') {
        return json(res, 200, control.accounts.me(token));
      }
      if (path.startsWith('/api/')) {
        if (!['/api/auth/setup', '/api/auth/login', '/api/auth/logout'].includes(path))
          throw new RemoteKitError('not_found', 'Interface does not exist');
        if (req.method !== 'POST') throw new RemoteKitError('invalid_request', '不支持的方法');
        checkOrigin(req);
        if (!req.headers['content-type']?.startsWith('application/json'))
          throw new RemoteKitError('invalid_request', '需要 JSON 请求');
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new RemoteKitError('invalid_request', '需要 JSON 对象');
        if (['tenantId', 'tenant', 'userId', 'user'].some((key) => key in body))
          throw new RemoteKitError('invalid_request', '客户端不能指定用户或租户');
        if (path === '/api/auth/setup' || path === '/api/auth/login') {
          const session = path.endsWith('setup')
            ? await control.accounts.setup(body.username, body.password)
            : await control.accounts.login(body.username, body.password);
          const previous = control.accounts.identity(token);
          if (previous) {
            control.accounts.logout(token);
            await control.viewers.logout(previous.tenantId, authenticationIdentity(token!));
          }
          for (const [hash, expires] of firstViewer) if (expires <= Date.now()) firstViewer.delete(hash);
          if (firstViewer.size >= 4096) firstViewer.delete(firstViewer.keys().next().value!);
          firstViewer.set(authenticationIdentity(session.token), Date.now() + 30000);
          res.setHeader('Set-Cookie', cookie(session.token));
          return json(res, 200, { authenticated: true, user: session.user });
        }
        if (path === '/api/auth/logout') {
          const previous = control.accounts.identity(token);
          control.accounts.logout(token);
          if (previous) await control.viewers.logout(previous.tenantId, authenticationIdentity(token!));
          res.setHeader('Set-Cookie', cookie('', true));
          return json(res, 200, { loggedOut: true });
        }
        throw new RemoteKitError('not_found', '接口不存在');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        throw new RemoteKitError('invalid_request', '不支持的方法');
      const root = resolve(options.clientDir),
        appEntry = path === '/',
        file = resolve(root, appEntry ? 'index.html' : `.${path}`);
      if (!file.startsWith(root + sep)) throw new RemoteKitError('forbidden', '无效路径');
      const content = await readFile(file).catch(() => {
        throw new RemoteKitError('not_found', '文件不存在，请先 npm run build');
      });
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      };
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const failure = toRemoteKitError(error);
      json(res, httpStatus[failure.code], { error: { code: failure.code, message: failure.message } });
    }
  };
  const server = options.tls
    ? createHttpsServer(options.tls, (req, res) => {
        void track(handler(req, res));
      })
    : createServer((req, res) => {
        void track(handler(req, res));
      });
  const connections = new Set<Socket>();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  const viewerSocket = attachViewerSocket(control, server, options, {
    diagnosticSessions,
    firstViewer,
    checkOrigin,
    readToken,
    authenticationIdentity,
    track,
    isClosing: () => closing,
  });
  const originalClose = server.close.bind(server);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    const archivesClosed = diagnosticSessions?.shutdown();
    // Fail remote management requests before draining handlers waiting on them.
    options.nodes?.stop();
    viewerSocket.close();
    const httpClosed = new Promise<void>((resolve, reject) =>
      originalClose((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }),
    );
    // Abort owned streams/sockets; keep their async finalizers tracked until
    // detach/write/RPC cleanup settles before SQLite can close.
    for (const socket of connections) socket.destroy();
    shutdownPromise = (async () => {
      await httpClosed;
      while (inflight.size) await Promise.allSettled([...inflight]);
      await archivesClosed;
      control.rtc.clearSignals();
    })();
    return shutdownPromise;
  };
  server.close = ((callback?: (error?: Error) => void) => {
    void shutdown().then(
      () => callback?.(),
      (error) => callback?.(error),
    );
    return server;
  }) as typeof server.close;
  return Object.assign(server, { shutdown });
}
function readToken(req: IncomingMessage) {
  return req.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('rk_session='))
    ?.slice(11);
}
function json(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new RemoteKitError('limit_exceeded', '请求过大');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RemoteKitError('invalid_request', 'JSON 格式错误');
  }
}

function authenticationIdentity(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
