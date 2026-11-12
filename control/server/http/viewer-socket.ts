import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { RemoteKitError, httpStatus, toRemoteKitError, wireError } from '../../shared/errors';
import type { ProductState } from '../../shared/product';
import type { DomainServices } from '../application';
import type { NodeRegistry } from '../cluster/node-link';
import { findError } from '../diagnostics/error-search';
import { DiagnosticSessions, diagnosticMessageLimit } from '../diagnostics/sessions';
import { viewerErrorReports } from '../diagnostics/viewer-errors';
import { learningMethods } from '../learning/service';
import { log, reportError } from '../log';
import type { ViewerAuthority } from '../viewers/viewer-hub';

type DiagnosticAuthority = { sessions?: DiagnosticSessions; identity: string; allowed: () => boolean };
type RequestContext = {
  host?: string;
  logs?: { directory?: string; nodes: Pick<NodeRegistry, 'all'> };
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
  'clipboard.set': product(({ services, authority }, params) => services.clipboard.set(authority, params)),
  'clipboard.get': product(({ services, authority }) => services.clipboard.get(authority)),
  'library.copySnippet': product(({ services, authority }, params) =>
    services.clipboard.copySnippet(authority, params.id),
  ),
  'sessionImport.state': product(({ services, authority }) =>
    services.sessionImporter.state(authority.tenantId),
  ),
  'sessionImport.pairing': product(({ services, authority }, params) =>
    services.sessionImporter.pairing(authority.tenantId, params.open),
  ),
  'sessionImport.removeDevice': product(({ services, authority }, params) =>
    services.sessionImporter.removeDevice(authority.tenantId, params.keyId),
  ),
  'sessionImport.discard': product(({ services, authority }, params) =>
    services.sessionImporter.discard(authority.tenantId, params.id),
  ),
  'clock.ping': ({ services }, params) => ({
    serverTime: services.clock.wallMs(),
    ...(typeof params.clientTime === 'number' ? { clientTime: params.clientTime } : {}),
  }),
  'service.offer': ({ services, authority }, params) =>
    services.servicePeers.offer(authority.tenantId, params, authority.leaseId),
  'service.ice': ({ services, authority }, params) =>
    services.servicePeers.ice(authority.tenantId, params, authority.leaseId),
  'service.close': ({ services, authority }, params) =>
    services.servicePeers.close(authority.tenantId, params.connectionId, authority.leaseId),
  'rtc.offer': ({ services, authority }, params) =>
    services.rtc.offer(authority.tenantId, params, authority.leaseId),
  'rtc.ice': ({ services, authority }, params) => services.rtc.ice(authority.tenantId, params),
  'rtc.close': ({ services, authority }, params) =>
    services.rtc.closeRtc(authority.tenantId, params, authority.leaseId),
  'operation.status': product(({ services, authority }, params) =>
    services.operations.operationStatus(authority.tenantId, params),
  ),
  'operation.submit': product(({ services, authority }, params) =>
    services.operations.submitOperation(authority.tenantId, params, authority.leaseId, authority.epoch),
  ),
  'usage.record': product(({ services, authority }, params) =>
    services.workspace.recordFile(authority.tenantId, params),
  ),
  'announcement.read': product(({ services, authority }, params) =>
    services.announcements.markRead(authority.tenantId, params.id),
  ),
  'usage.clear': product(({ services, authority }, params) =>
    services.workspace.clearUsage(authority.tenantId, params.scope),
  ),
  'page.preview': product(({ services, authority }, params) =>
    services.workspace.savePreview(authority.tenantId, params),
  ),
  'launcher.get': product(({ services, authority }, params) =>
    services.workspace.launcher(authority.tenantId, params.query),
  ),
  'app.inspect': product(({ services, authority }, params) =>
    services.workspace.inspect(authority.tenantId, params.tabId),
  ),
  viewport: product(({ services, authority }, params) =>
    services.viewers.viewport(authority.tenantId, params, authority.leaseId, authority.epoch),
  ),
  feedback: product(({ services, authority }, params) => services.viewers.feedback(authority, params)),
};
for (const method of learningMethods)
  handlers[method] = product(({ services, authority }, params) =>
    services.learning.request(authority.tenantId, method, params),
  );
const admin = (handler: Handler): Handler =>
  product((ctx, params) => {
    if (!ctx.services.store.accounts.userForTenant(ctx.authority.tenantId)?.isAdmin)
      throw new RemoteKitError('forbidden', '需要管理员权限');
    return handler(ctx, params);
  });
const archives = (ctx: RequestContext) => {
  if (!ctx.diagnostics?.sessions) throw new RemoteKitError('not_found', '诊断采集未配置');
  return ctx.diagnostics.sessions;
};
const tenants = ({ services }: RequestContext) =>
  new Map(services.store.accounts.users().map((user) => [user.tenant, user.username]));
const nodeId = (params: any) => {
  if (typeof params.nodeId !== 'string') throw new RemoteKitError('invalid_request', '无效的节点');
  return params.nodeId;
};
Object.assign(handlers, {
  'admin.sessionImportDeployment': admin(async ({ services, authority, host }) => {
    const deployment = await services.sessionImporter.deployment(authority.tenantId, host ?? '');
    services.viewers.assertProductViewer(authority.tenantId, authority.leaseId, authority.epoch);
    if (!services.store.accounts.userForTenant(authority.tenantId)?.isAdmin)
      throw new RemoteKitError('forbidden', '需要管理员权限');
    return deployment;
  }),
  'admin.overview': admin(async (ctx) => {
    const { services } = ctx;
    const nodes = services.nodeAdmin.list(),
      users = services.userAdmin.list(),
      storage = services.objects.usage(),
      release = services.endpoint.nodes.options.release?.descriptor;
    return {
      integrity: {
        checkedAt: services.store.integrity.checkedAt,
        problemCount: services.store.integrity.problems.length,
        problems: services.store.integrity.problems.slice(0, 20),
      },
      buildId: services.endpoint.nodes.options.buildId,
      release: release ? { buildId: release.buildId, size: release.size } : null,
      nodes: {
        total: nodes.length,
        ready: nodes.filter((node) => node.state === 'ready').length,
        mismatched: nodes.filter((node) => node.rejected?.code === 'build_mismatch' && node.state !== 'ready')
          .length,
      },
      users: {
        total: users.length,
        online: users.filter((user) => user.online).length,
        disabled: users.filter((user) => user.disabled).length,
      },
      sessions: {
        active: users.filter((user) => user.session.state === 'running').length,
        stopped: users.filter((user) => user.session.state === 'stopped').length,
      },
      storage: {
        bytes: storage.bytes,
        underReplicated: storage.underReplicated,
        pendingSessionDeletions: services.sessionPurge.pending(),
        deletionFailures: services.sessionPurge.failures(),
      },
      diagnostics: ctx.diagnostics?.sessions
        ? (await ctx.diagnostics.sessions.archives(tenants(ctx))).length
        : 0,
      sessionImport: services.sessionImporter.mailbox.status(),
    };
  }),
  'admin.users': admin(({ services }) => services.userAdmin.list()),
  'admin.createUser': admin(({ services }, params) =>
    services.userAdmin.create(params.username, params.password),
  ),
  'admin.resetPassword': admin(({ services, authority }, params) =>
    services.userAdmin.resetPassword(authority.tenantId, params.username, params.password),
  ),
  'admin.clearSecondFactors': admin(({ services, authority }, params) =>
    services.userAdmin.clearSecondFactors(authority.tenantId, params.username),
  ),
  'admin.signOut': admin(({ services, authority }, params) =>
    services.userAdmin.signOut(authority.tenantId, params.username),
  ),
  'admin.setDisabled': admin(({ services, authority }, params) =>
    services.userAdmin.setDisabled(authority.tenantId, params.username, params.disabled),
  ),
  'admin.transferAdmin': admin(({ services, authority }, params) =>
    services.userAdmin.transferAdmin(authority.tenantId, params.username),
  ),
  'admin.transfer': admin(({ services }, params) =>
    services.userAdmin.transfer(params.username, params.nodeId),
  ),
  'admin.stop': admin(({ services }, params) => services.userAdmin.stop(params.username)),
  'admin.resetSession': admin(({ services }, params) => services.userAdmin.resetSession(params.username)),
  'admin.deleteUser': admin(async (ctx, params) => {
    const deleted = await ctx.services.userAdmin.delete(ctx.authority.tenantId, params.username);
    await ctx.diagnostics?.sessions?.deleteOwner(deleted.tenant);
    return deleted.users;
  }),
  'admin.storage': admin(({ services }) => services.userAdmin.storage()),
  'admin.nodes': admin(({ services }) => services.nodeAdmin.list()),
  'admin.removeNode': admin(({ services }, params) => services.nodeAdmin.remove(nodeId(params))),
  'admin.readdNode': admin(({ services }, params) => services.nodeAdmin.readd(nodeId(params))),
  'admin.findError': admin((ctx, params) =>
    findError(params.errorId, ctx.logs?.directory, ctx.logs?.nodes ?? { all: () => [] }),
  ),
  'admin.diagnostics': admin((ctx) => archives(ctx).archives(tenants(ctx))),
  'admin.deleteDiagnostic': admin(async (ctx, params) => {
    await archives(ctx).deleteArchive(params.id);
    return archives(ctx).archives(tenants(ctx));
  }),
  'admin.announcements': admin(({ services }) => services.announcements.list()),
  'admin.publishAnnouncement': admin(({ services, authority }, params) =>
    services.announcements.publish(authority.tenantId, params.title, params.body),
  ),
  'admin.updateAnnouncement': admin(({ services, authority }, params) =>
    services.announcements.update(authority.tenantId, params.id, params.title, params.body, params.republish),
  ),
  'admin.deleteAnnouncement': admin(({ services }, params) => services.announcements.delete(params.id)),
  'admin.downloadDiagnostic': admin(async (ctx, params) => ({
    url: '/api/admin/diagnostics/' + (await archives(ctx).downloadTicket(params.id)),
  })),
} satisfies Record<string, Handler>);
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
  'library.snippet',
  'library.import',
  'library.replace',
  'library.prepare',
  'library.finish',
  'library.basket',
  'library.partition',
  'library.partitionDelete',
  'library.source',
  'library.sourcePurge',
  'library.basketPartition',
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
  host?: string,
  logs?: RequestContext['logs'],
): Promise<any> {
  services.viewers.assertViewer(authority.tenantId, authority.leaseId);
  if (!params || typeof params !== 'object' || Array.isArray(params))
    throw new RemoteKitError('invalid_request', '需要参数对象');
  if (['tenantId', 'tenant', 'userId', 'user'].some((key) => key in params))
    throw new RemoteKitError('invalid_request', '客户端不能指定用户或租户');
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined;
  if (!handler) throw new RemoteKitError('invalid_request', '未知 WebSocket 方法');
  try {
    return await handler({ services, authority, diagnostics, host, logs }, params);
  } catch (error) {
    throw toRemoteKitError(error);
  }
}

export function attachViewerSocket(
  control: DomainServices,
  server: Server,
  options: { nodes?: NodeRegistry; logDir?: string },
  helpers: {
    diagnosticSessions?: DiagnosticSessions;
    firstViewer: Map<string, number>;
    checkOrigin: (origin: string | undefined) => void;
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
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 6 * 1024 * 1024 + 65536,
    perMessageDeflate: false,
  });
  const peers = new Map<WebSocket, { tenant: string; lease: string; token: string; alive: boolean }>();
  const send = (ws: WebSocket, message: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 2 * 1024 * 1024) {
        const peer = peers.get(ws);
        log.warn('viewer.send_buffer_full', {
          tenant: peer?.tenant,
          lease: peer?.lease,
          bufferedAmount: ws.bufferedAmount,
        });
        ws.terminate();
      } else ws.send(JSON.stringify(message));
    }
  };
  const push = (tenant: string, state: ProductState) => {
    for (const [ws, peer] of peers)
      if (peer.tenant === tenant && control.viewers.productAllowed(tenant, peer.lease))
        send(ws, { type: 'state', revision: state.workspace.revision, state });
  };
  control.events.on('state', push);
  const library = (tenant: string, snapshot: unknown) => {
    for (const [ws, peer] of peers)
      if (peer.tenant === tenant && control.viewers.productAllowed(tenant, peer.lease))
        send(ws, { type: 'library', snapshot });
  };
  control.events.on('library', library);
  const clipboard = (tenant: string, message: unknown) => {
    for (const [ws, peer] of peers)
      if (peer.tenant === tenant && control.viewers.productAllowed(tenant, peer.lease)) send(ws, message);
  };
  control.events.on('clipboard', clipboard);
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
      if (options.nodes?.handleUpgrade(req, socket, head)) return;
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/socket')
        throw new RemoteKitError('not_found', '接口不存在');
      checkOrigin(req.headers.origin);
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
              send(ws, { type: 'lease', outcome: reason === 'logout' ? 'logged_out' : 'replaced' });
              ws.close(reason === 'logout' ? 4002 : 4001);
            },
            { identity: hash, valid: () => control.accounts.identity(token)?.tenantId === peer.tenant },
            initialUnlocked,
          ),
        );
        void ready.catch((error) => {
          log.warn('viewer.attach_failed', { tenant: peer.tenant, lease, err: error });
          ws.close(1011, 'Viewer unavailable');
        });
        ws.on('pong', () => {
          peer.alive = true;
        });
        ws.on('error', () => {});
        ws.on('close', () => {
          diagnosticSessions?.detachViewer(peer.tenant, lease, 'disconnected');
          if (peers.delete(ws))
            void track(control.viewers.detachViewer(peer.tenant, lease)).catch((err) =>
              log.warn('viewer.detach_failed', { tenant: peer.tenant, lease, err }),
            );
        });
        ws.on('message', (data, binary) => {
          if (isClosing()) return;
          let request: any;
          const raw = data.toString();
          try {
            if (binary) throw new RemoteKitError('invalid_request', '无效的 WebSocket 请求');
            request = JSON.parse(raw);
            if (request?.type === 'client.error') {
              if (control.accounts.identity(token)?.tenantId === peer.tenant)
                viewerErrorReports.receive(request.report, peer.tenant, lease);
              return;
            }
            if (
              !request ||
              typeof request.id !== 'string' ||
              !request.id ||
              request.id.length > 128 ||
              typeof request.method !== 'string'
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
          if (request.method !== 'clipboard.set' && Buffer.byteLength(raw) > 1024 * 1024) {
            send(ws, {
              type: 'error',
              id: request.id,
              error: { code: 'limit_exceeded', message: '请求过大' },
            });
            return;
          }
          if (diagnosticRequest && Buffer.byteLength(raw) > diagnosticMessageLimit) {
            send(ws, {
              type: 'error',
              id: request.id,
              error: { code: 'limit_exceeded', message: '诊断请求过大' },
            });
            return;
          }
          if (pending.has(request.id) || pending.size >= 32) {
            send(ws, {
              type: 'error',
              id: request.id,
              error: {
                code: pending.has(request.id) ? 'conflict' : 'busy',
                message: pending.has(request.id) ? '请求身份正在使用' : '请求处理繁忙，请稍后重试',
              },
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
                  immediate ||
                  [
                    'rtc.offer',
                    'rtc.ice',
                    'rtc.close',
                    'service.offer',
                    'service.ice',
                    'service.close',
                  ].includes(request.method);
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
                  req.headers.host,
                  { directory: options.logDir, nodes: options.nodes ?? { all: () => [] } },
                );
                if (
                  !maintenance &&
                  (!control.viewers.productAllowed(peer.tenant, lease) ||
                    control.viewers.productEpoch(peer.tenant, lease) !== epoch)
                )
                  throw new RemoteKitError('outcome_unknown', '授权已改变，操作结果请核对当前状态');
                send(ws, { type: 'result', id: request.id, result });
              })
              .catch((error) => {
                const failure = reportError(toRemoteKitError(error), 'viewer.request_failed', {
                  tenant: peer.tenant,
                  lease,
                  method: request.method,
                });
                send(ws, {
                  type: 'error',
                  id: request.id,
                  error: wireError(failure),
                });
              })
              .finally(() => pending.delete(request.id)),
          );
        });
      });
    } catch (error) {
      const failure = reportError(toRemoteKitError(error), 'viewer.upgrade_failed', { route: '/api/socket' });
      log.warn('viewer.upgrade_rejected', {
        url: req.url,
        code: failure.code,
        message: failure.message,
        origin: req.headers.origin,
        remote: req.socket.remoteAddress,
      });
      const status = httpStatus[failure.code];
      const body = JSON.stringify({ error: wireError(failure) });
      const retryAfter =
        failure.retryAfterMs === undefined
          ? ''
          : 'Retry-After: ' + Math.ceil(failure.retryAfterMs / 1000) + '\r\n';
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n${retryAfter}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    }
  });
  const facePoll = setInterval(() => {
    if (!isClosing()) void track(control.viewers.pollFaceAuth());
  }, 500);
  facePoll.unref();
  const heartbeat = setInterval(() => {
    for (const [ws, peer] of peers) {
      if (!peer.alive || !control.accounts.identity(peer.token)) {
        log.warn('viewer.heartbeat_failed', {
          tenant: peer.tenant,
          lease: peer.lease,
          alive: peer.alive,
        });
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
      control.events.off('library', library);
      control.events.off('clipboard', clipboard);
      control.events.off('rtc.signal', signal);
      for (const [ws, peer] of peers) {
        peers.delete(ws);
        void track(control.viewers.detachViewer(peer.tenant, peer.lease)).catch((err) =>
          log.warn('viewer.detach_failed', { tenant: peer.tenant, lease: peer.lease, err }),
        );
        ws.terminate();
      }
      sockets.close();
    },
  };
}
