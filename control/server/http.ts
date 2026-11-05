import { RemoteKitError, toRemoteKitError, httpStatus } from '../shared/errors';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { Control } from './control';
import type { ProductState } from '../shared/product';
import type { RemoteNodeLink } from './endpoint/remote-node';
import { DiagnosticSessions, diagnosticMessageLimit } from './diagnostic-sessions';

export function createHttp(
  control: Control,
  options: {
    origins: string[];
    clientDir: string;
    diagnosticDir?: string;
    tls?: { key: Buffer; cert: Buffer };
    endpointNode?: RemoteNodeLink;
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
              audioChannels: settings.audioChannels,
            },
          };
        },
        endpoint: (tenant) => control.endpoint.snapshot(tenant, { outputDiagnostics: true }),
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
      if (path === '/api/auth/registration' && req.method === 'GET')
        return json(res, 200, control.store.accounts.registrationStatus());
      if (path === '/api/auth/me' && req.method === 'GET') {
        const identity = control.store.accounts.identity(token);
        if (!identity) throw new RemoteKitError('unauthenticated', '请先登录');
        return json(res, 200, { authenticated: true, user: identity.user });
      }
      if (path.startsWith('/api/')) {
        if (!['/api/auth/register', '/api/auth/login', '/api/auth/logout'].includes(path))
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
        if (path === '/api/auth/register' || path === '/api/auth/login') {
          const session = path.endsWith('register')
            ? await control.store.accounts.register(body.username, body.password, body.serverCredential)
            : await control.store.accounts.login(body.username, body.password);
          const previous = control.store.accounts.identity(token);
          if (previous) {
            control.store.accounts.revoke(token);
            await control.logout(previous.tenantId, authenticationIdentity(token!));
          }
          for (const [hash, expires] of firstViewer) if (expires <= Date.now()) firstViewer.delete(hash);
          if (firstViewer.size >= 4096) firstViewer.delete(firstViewer.keys().next().value!);
          firstViewer.set(authenticationIdentity(session.token), Date.now() + 30000);
          res.setHeader('Set-Cookie', cookie(session.token));
          return json(res, 200, { authenticated: true, user: session.user });
        }
        if (path === '/api/auth/logout') {
          const previous = control.store.accounts.identity(token);
          control.store.accounts.revoke(token);
          if (previous) await control.logout(previous.tenantId, authenticationIdentity(token!));
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
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const peers = new Map<WebSocket, { tenant: string; lease: string; token: string; alive: boolean }>();
  const send = (ws: WebSocket, message: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 2 * 1024 * 1024) ws.terminate();
      else ws.send(JSON.stringify(message));
    }
  };
  const push = (tenant: string, state: ProductState) => {
    for (const [ws, peer] of peers)
      if (peer.tenant === tenant && control.productAllowed(tenant, peer.lease))
        send(ws, { type: 'state', revision: state.workspace.revision, state });
  };
  control.on('state', push);
  const signal = (tenant: string, lease: string, message: unknown) => {
    for (const [ws, peer] of peers) if (peer.tenant === tenant && peer.lease === lease) send(ws, message);
  };
  control.on('rtc.signal', signal);
  const auth = (tenant: string, lease: string, state: unknown) => {
    diagnosticSessions?.checkViewer(tenant, lease);
    signal(tenant, lease, { type: 'auth', auth: state });
  };
  control.on('auth', auth);
  server.on('upgrade', (req, socket, head) => {
    try {
      if (closing) throw new RemoteKitError('unavailable', '服务正在关闭');
      if (options.endpointNode?.handleUpgrade(req, socket, head)) return;
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/socket')
        throw new RemoteKitError('not_found', '接口不存在');
      checkOrigin(req);
      const token = readToken(req),
        identity = control.store.accounts.identity(token);
      if (!identity || !token) throw new RemoteKitError('unauthenticated', '请先登录');
      sockets.handleUpgrade(req, socket, head, (ws) => {
        const lease = randomUUID(),
          peer = { tenant: identity.tenantId, lease, token, alive: true };
        peers.set(ws, peer);
        const pending = new Set<string>();
        const hash = authenticationIdentity(token);
        const initialUnlocked = (firstViewer.get(hash) ?? 0) > Date.now();
        firstViewer.delete(hash);
        const ready = track(
          control.attachViewer(
            peer.tenant,
            lease,
            (reason) => {
              diagnosticSessions?.detachViewer(peer.tenant, lease, 'authorization-changed');
              send(ws, { type: 'lease', status: 'revoked', reason });
              ws.close(4001, reason);
            },
            { identity: hash, valid: () => control.store.accounts.identity(token)?.tenantId === peer.tenant },
            initialUnlocked,
          ),
        );
        void ready.catch(() => ws.close(1011, 'Viewer unavailable'));
        ws.on('pong', () => {
          peer.alive = true;
        });
        ws.on('error', () => {});
        ws.on('close', () => {
          diagnosticSessions?.detachViewer(peer.tenant, lease, 'disconnected');
          if (peers.delete(ws)) void track(control.detachViewer(peer.tenant, lease)).catch(() => {});
        });
        ws.on('message', (data, binary) => {
          if (closing) return;
          let request: any;
          const raw = data.toString();
          try {
            if (binary) throw new RemoteKitError('invalid_request', '无效的 WebSocket 请求');
            request = JSON.parse(raw);
            if (
              !request ||
              typeof request.id !== 'string' ||
              !request.id ||
              request.id.length > 128 ||
              typeof request.method !== 'string' ||
              pending.has(request.id) ||
              pending.size >= 32
            )
              throw new RemoteKitError('invalid_request', '无效的 WebSocket 请求');
          } catch {
            send(ws, {
              type: 'error',
              id: typeof request?.id === 'string' ? request.id : '',
              error: { code: 'invalid_request', message: '无效的 WebSocket 请求' },
            });
            return;
          }
          const diagnosticRequest = request.method.startsWith('diagnostics.');
          if (diagnosticRequest && Buffer.byteLength(raw) > diagnosticMessageLimit) {
            send(ws, {
              type: 'error',
              id: request.id,
              error: { code: 'limit_exceeded', message: '诊断请求过大' },
            });
            return;
          }
          pending.add(request.id);
          const immediate = request.method.startsWith('auth.') || request.method === 'clock.ping';
          void track(
            (immediate ? Promise.resolve() : ready)
              .then(async () => {
                const currentIdentity = control.store.accounts.identity(token);
                if (!currentIdentity) throw new RemoteKitError('unauthenticated', '登录已过期');
                const maintenance =
                  immediate || ['rtc.offer', 'rtc.ice', 'rtc.close'].includes(request.method);
                const epoch = control.productEpoch(peer.tenant, lease);
                let result: unknown;
                if (diagnosticRequest) {
                  if (!diagnosticSessions) throw new RemoteKitError('not_found', '诊断采集未配置');
                  const allowed = () =>
                    !closing &&
                    peers.has(ws) &&
                    control.productAllowed(peer.tenant, lease) &&
                    control.productEpoch(peer.tenant, lease) === epoch;
                  if (currentIdentity.tenantId !== peer.tenant || epoch === undefined || !allowed())
                    throw new RemoteKitError('locked', 'Viewer 已锁定');
                  result = await diagnosticSessions.request(
                    { tenant: peer.tenant, lease, epoch, identity: hash, allowed },
                    request.method,
                    request.params,
                  );
                } else {
                  result = await control.viewerRequest(peer.tenant, lease, request.method, request.params);
                }
                if (
                  !maintenance &&
                  (!control.productAllowed(peer.tenant, lease) ||
                    control.productEpoch(peer.tenant, lease) !== epoch)
                )
                  throw new RemoteKitError('locked', 'Viewer 已锁定');
                send(ws, { type: 'result', id: request.id, result });
              })
              .catch((error) =>
                send(ws, {
                  type: 'error',
                  id: request.id,
                  error: {
                    code: toRemoteKitError(error).code,
                    message: toRemoteKitError(error).message,
                  },
                }),
              )
              .finally(() => pending.delete(request.id)),
          );
        });
      });
    } catch (error) {
      const status = httpStatus[toRemoteKitError(error).code];
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  const facePoll = setInterval(() => {
    if (!closing) void track(control.pollFaceAuth());
  }, 500);
  facePoll.unref();
  const heartbeat = setInterval(() => {
    for (const [ws, peer] of peers) {
      if (!peer.alive || !control.store.accounts.identity(peer.token)) {
        ws.terminate();
        continue;
      }
      peer.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();
  const originalClose = server.close.bind(server);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    const archivesClosed = diagnosticSessions?.shutdown();
    // Fail remote management requests before draining handlers waiting on them.
    options.endpointNode?.stop();
    clearInterval(heartbeat);
    clearInterval(facePoll);
    control.off('auth', auth);
    control.off('state', push);
    control.off('rtc.signal', signal);
    const httpClosed = new Promise<void>((resolve, reject) =>
      originalClose((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }),
    );
    for (const [ws, peer] of peers) {
      peers.delete(ws);
      void track(control.detachViewer(peer.tenant, peer.lease)).catch(() => {});
      ws.terminate();
    }
    sockets.close();
    // Abort owned streams/sockets; keep their async finalizers tracked until
    // detach/write/RPC cleanup settles before SQLite can close.
    for (const socket of connections) socket.destroy();
    shutdownPromise = (async () => {
      await httpClosed;
      while (inflight.size) await Promise.allSettled([...inflight]);
      await archivesClosed;
      control.clearSignals?.();
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
