import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { RemoteKitError, httpStatus, toRemoteKitError } from '../../shared/errors';
import type { ProductState } from '../../shared/product';
import type { DomainServices } from '../application';
import { DiagnosticSessions, diagnosticMessageLimit } from '../diagnostics/sessions';
import type { RemoteNodeLink } from '../endpoint/remote-node';
import type { ViewerAuthority } from '../viewers/viewer-hub';

type DiagnosticAuthority = { sessions?: DiagnosticSessions; identity: string; allowed: () => boolean };
type RequestContext = {
  services: DomainServices;
  authority: ViewerAuthority;
  diagnostics?: DiagnosticAuthority;
};
type Handler = (ctx: RequestContext, params: any) => unknown;
const product =
  (handler: Handler): Handler =>
  (ctx, params) => {
    const { tenantId, leaseId, epoch } = ctx.authority;
    ctx.services.viewers.assertProductViewer(tenantId, leaseId, epoch);
    return handler(ctx, params);
  };
const auth: Handler = async ({ services, authority }, params) => {
  const viewer = services.tenants.get(authority.tenantId).viewer!.security;
  await services.security.request(authority.tenantId, viewer, params.method, params.value);
  services.viewers.assertViewer(authority.tenantId, authority.leaseId);
  return services.viewers.authState(authority.tenantId, viewer);
};
const library: Handler = product(({ services, authority }, params) =>
  services.library.request(
    authority.tenantId,
    params.method,
    params.value,
    () => services.viewers.assertProductViewer(authority.tenantId, authority.leaseId, authority.epoch),
    (id) => services.tenants.get(authority.tenantId).pageRequests.files?.find((request) => request.id === id),
  ),
);
const handlers: Record<string, Handler> = {
  'clock.ping': ({ services }, params) => ({
    serverTime: services.clock.wallMs(),
    ...(typeof params.clientTime === 'number' ? { clientTime: params.clientTime } : {}),
  }),
  'rtc.offer': ({ services, authority }, params) =>
    services.rtc.offer(authority.tenantId, params, authority.leaseId),
  'rtc.ice': ({ services, authority }, params) => services.rtc.ice(authority.tenantId, params),
  'rtc.close': ({ services, authority }, params) =>
    services.rtc.closeRtc(authority.tenantId, params, authority.leaseId),
  'operation.status': product(({ services, authority }, params) =>
    services.operations.operationStatus(authority.tenantId, params),
  ),
  action: product(({ services, authority }, params) => {
    if (params.type !== 'settings.update')
      throw new RemoteKitError('invalid_request', '产品操作必须通过WebRTC数据通道');
    return services.operations.productAction(authority.tenantId, params, authority.leaseId);
  }),
  viewport: product(({ services, authority }, params) =>
    services.viewers.viewport(authority.tenantId, params, authority.leaseId, authority.epoch),
  ),
  feedback: product(({ services, authority }, params) => services.viewers.feedback(authority, params)),
  'admin.get': product(({ services, authority }) => {
    if (!services.store.accounts.userForTenant(authority.tenantId)?.isAdmin)
      throw new RemoteKitError('forbidden', '需要管理员权限');
    return services.accounts.adminStatus();
  }),
  'admin.setRegistrationCredential': product(({ services, authority }, params) =>
    services.accounts.setRegistrationCredential(authority.tenantId, params.serverCredential, () =>
      services.viewers.assertProductViewer(authority.tenantId, authority.leaseId, authority.epoch),
    ),
  ),
};
for (const method of [
  'auth.get',
  'auth.lock',
  'auth.face.cancel',
  'auth.verify',
  'auth.face.begin',
  'auth.settings',
  'auth.password',
  'auth.face.remove',
])
  handlers[method] = (ctx, params) => auth(ctx, { method, value: params });
for (const method of [
  'library.get',
  'library.import',
  'library.replace',
  'library.prepare',
  'library.finish',
  'library.basket',
  'library.group',
  'library.move',
  'library.delete',
])
  handlers[method] = (ctx, params) => library(ctx, { method, value: params });
for (const method of ['diagnostics.start', 'diagnostics.sample', 'diagnostics.stop', 'diagnostics.status'])
  handlers[method] = ({ authority, diagnostics }, params) => {
    if (!diagnostics?.sessions) throw new RemoteKitError('not_found', '诊断采集未配置');
    if (authority.epoch === undefined || !diagnostics.allowed())
      throw new RemoteKitError('locked', 'Viewer 已锁定');
    return diagnostics.sessions.request(
      {
        tenant: authority.tenantId,
        lease: authority.leaseId,
        epoch: authority.epoch,
        identity: diagnostics.identity,
        allowed: diagnostics.allowed,
      },
      method,
      params,
    );
  };
export async function dispatchViewerRequest(
  services: DomainServices,
  authority: ViewerAuthority,
  method: string,
  params: any,
  diagnostics?: DiagnosticAuthority,
): Promise<any> {
  services.viewers.assertViewer(authority.tenantId, authority.leaseId);
  if (!params || typeof params !== 'object' || Array.isArray(params))
    throw new RemoteKitError('invalid_request', '需要参数对象');
  if (['tenantId', 'tenant', 'userId', 'user'].some((key) => key in params))
    throw new RemoteKitError('invalid_request', '客户端不能指定用户或租户');
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined;
  if (!handler) throw new RemoteKitError('invalid_request', '未知 WebSocket 方法');
  try {
    return await handler({ services, authority, diagnostics }, params);
  } catch (error) {
    throw toRemoteKitError(error);
  }
}

export function attachViewerSocket(
  control: DomainServices,
  server: Server,
  options: { endpointNode?: RemoteNodeLink },
  helpers: {
    diagnosticSessions?: DiagnosticSessions;
    firstViewer: Map<string, number>;
    checkOrigin: (req: IncomingMessage) => void;
    readToken: (req: IncomingMessage) => string | undefined;
    authenticationIdentity: (token: string) => string;
    track: <T>(promise: Promise<T>) => Promise<T>;
    isClosing: () => boolean;
  },
) {
  const {
    diagnosticSessions,
    firstViewer,
    checkOrigin,
    readToken,
    authenticationIdentity,
    track,
    isClosing,
  } = helpers;
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
      if (peer.tenant === tenant && control.viewers.productAllowed(tenant, peer.lease))
        send(ws, { type: 'state', revision: state.workspace.revision, state });
  };
  control.events.on('state', push);
  const signal = (tenant: string, lease: string, message: unknown) => {
    for (const [ws, peer] of peers) if (peer.tenant === tenant && peer.lease === lease) send(ws, message);
  };
  control.events.on('rtc.signal', signal);
  const auth = (tenant: string, lease: string, state: unknown) => {
    diagnosticSessions?.checkViewer(tenant, lease);
    signal(tenant, lease, { type: 'auth', auth: state });
  };
  control.events.on('auth', auth);
  server.on('upgrade', (req, socket, head) => {
    try {
      if (isClosing()) throw new RemoteKitError('unavailable', '服务正在关闭');
      if (options.endpointNode?.handleUpgrade(req, socket, head)) return;
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/socket')
        throw new RemoteKitError('not_found', '接口不存在');
      checkOrigin(req);
      const token = readToken(req),
        identity = control.accounts.identity(token);
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
          control.viewers.attachViewer(
            peer.tenant,
            lease,
            (reason) => {
              diagnosticSessions?.detachViewer(peer.tenant, lease, 'authorization-changed');
              send(ws, { type: 'lease', status: 'revoked', reason });
              ws.close(4001, reason);
            },
            { identity: hash, valid: () => control.accounts.identity(token)?.tenantId === peer.tenant },
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
          if (peers.delete(ws)) void track(control.viewers.detachViewer(peer.tenant, lease)).catch(() => {});
        });
        ws.on('message', (data, binary) => {
          if (isClosing()) return;
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
                const currentIdentity = control.accounts.identity(token);
                if (!currentIdentity) throw new RemoteKitError('unauthenticated', '登录已过期');
                const maintenance =
                  immediate || ['rtc.offer', 'rtc.ice', 'rtc.close'].includes(request.method);
                const epoch = control.viewers.productEpoch(peer.tenant, lease);
                const result = await dispatchViewerRequest(
                  control,
                  { tenantId: peer.tenant, leaseId: lease, epoch: epoch! },
                  request.method,
                  request.params,
                  {
                    sessions: diagnosticSessions,
                    identity: hash,
                    allowed: () =>
                      currentIdentity.tenantId === peer.tenant &&
                      !isClosing() &&
                      peers.has(ws) &&
                      control.viewers.productAllowed(peer.tenant, lease) &&
                      control.viewers.productEpoch(peer.tenant, lease) === epoch,
                  },
                );
                if (
                  !maintenance &&
                  (!control.viewers.productAllowed(peer.tenant, lease) ||
                    control.viewers.productEpoch(peer.tenant, lease) !== epoch)
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
    if (!isClosing()) void track(control.viewers.pollFaceAuth());
  }, 500);
  facePoll.unref();
  const heartbeat = setInterval(() => {
    for (const [ws, peer] of peers) {
      if (!peer.alive || !control.accounts.identity(peer.token)) {
        ws.terminate();
        continue;
      }
      peer.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      clearInterval(facePoll);
      control.events.off('auth', auth);
      control.events.off('state', push);
      control.events.off('rtc.signal', signal);
      for (const [ws, peer] of peers) {
        peers.delete(ws);
        void track(control.viewers.detachViewer(peer.tenant, peer.lease)).catch(() => {});
        ws.terminate();
      }
      sockets.close();
    },
  };
}
