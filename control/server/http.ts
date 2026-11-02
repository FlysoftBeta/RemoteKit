import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ApiError, Control } from './control';
import type { ProductState } from '../shared/product';

export function createHttp(control: Control, options: { origins: string[]; clientDir: string; metricsDir: string; diagnostics?: boolean; tls?: { key: Buffer; cert: Buffer } }) {
  let metricsWrite: Promise<void> = Promise.resolve();
  const cookie = (token: string, clear = false) => `rk_session=${token}; HttpOnly; SameSite=Strict; Path=/${options.tls ? '; Secure' : ''}${clear ? '; Max-Age=0' : '; Max-Age=2592000'}`;
  const checkOrigin = (req: IncomingMessage) => { if (!req.headers.origin || !options.origins.includes(req.headers.origin)) throw new ApiError(403, '请求来源不允许'); };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    try {
      const address = new URL(req.url ?? '/', 'http://localhost'), path = address.pathname, token = readToken(req);
      const diagnostic = options.diagnostics === true;
      if (path === '/api/auth/registration' && req.method === 'GET') return json(res, 200, control.store.registrationStatus());
      if (path === '/api/auth/me' && req.method === 'GET') { const identity = control.store.identity(token); if (!identity) throw new ApiError(401, '请先登录'); return json(res, 200, { authenticated: true, user: identity.user }); }
      if (path === '/api/state' && req.method === 'GET') {
        if (!diagnostic) throw new ApiError(404, '正常 Viewer 请使用 WebSocket');
        const identity = control.store.identity(token); if (identity && !identity.legacy) throw new ApiError(409, '请在独立会话打开诊断页面');
        const session = control.store.session(token); if (session.fresh) res.setHeader('Set-Cookie', cookie(session.token));
        return json(res, 200, await control.getState(session.tenantId));
      }
      if (path.startsWith('/api/')) {
        if (req.method !== 'POST') throw new ApiError(405, '不支持的方法'); checkOrigin(req);
        if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, '需要 JSON 请求');
        const body = await readBody(req); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, '需要 JSON 对象');
        if (['tenantId', 'tenant', 'userId', 'user'].some(key => key in body)) throw new ApiError(400, '客户端不能指定用户或租户');
        if (path === '/api/auth/register' || path === '/api/auth/login') {
          let session; try { session = path.endsWith('register') ? await control.store.register(body.username, body.password, body.serverCredential) : await control.store.login(body.username, body.password); } catch (error) { throw new ApiError(path.endsWith('login') ? 401 : 400, error instanceof Error ? error.message : String(error)); }
          const previous = control.store.identity(token); if (previous) { control.store.revoke(token); await control.logout(previous.tenantId, authenticationIdentity(token!)); }
          res.setHeader('Set-Cookie', cookie(session.token)); return json(res, 200, { authenticated: true, user: session.user });
        }
        if (path === '/api/auth/logout') { const previous = control.store.identity(token); control.store.revoke(token); if (previous) await control.logout(previous.tenantId, authenticationIdentity(token!)); res.setHeader('Set-Cookie', cookie('', true)); return json(res, 200, { loggedOut: true }); }
        const identity = control.store.identity(token); if (!identity) throw new ApiError(401, '请先登录'); const tenant = identity.tenantId;
        if (path === '/api/metrics') {
          const record = JSON.stringify({ receivedAt: new Date().toISOString(), tenantId: tenant, metrics: body }) + '\n';
          const write = metricsWrite.then(async () => { await mkdir(options.metricsDir, { recursive: true }); await appendFile(resolve(options.metricsDir, 'client-metrics.jsonl'), record); });
          metricsWrite = write.catch(() => {}); await write; return json(res, 200, { stored: true });
        }
        if (!diagnostic || !identity.legacy) throw new ApiError(404, '正常 Viewer 请使用 WebSocket');
        if (path === '/api/actions') return json(res, 200, await control.action(tenant, body));
        if (path === '/api/rtc/offer') return json(res, 200, await control.offer(tenant, body));
        if (path === '/api/rtc/ice') return json(res, 200, await control.ice(tenant, body));
        if (path === '/api/rtc/close') return json(res, 200, await control.closeRtc(tenant, body));
        if (path === '/api/rtc/network') return json(res, 200, control.networkStats(tenant, body));
        throw new ApiError(404, '接口不存在');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, '不支持的方法');
      const root = resolve(options.clientDir), appEntry = ['/', '/diagnostics', '/automation'].includes(path), file = resolve(root, appEntry ? 'index.html' : `.${path}`);
      if (!file.startsWith(root + sep)) throw new ApiError(403, '无效路径');
      const content = await readFile(file).catch(() => { throw new ApiError(404, '文件不存在，请先 npm run build'); });
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { json(res, error instanceof ApiError ? error.status : 502, { error: { message: error instanceof Error ? error.message : String(error) } }); }
  };
  const server = options.tls ? createHttpsServer(options.tls, handler) : createServer(handler);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const peers = new Map<WebSocket, { tenant: string; lease: string; token: string; alive: boolean }>();
  const send = (ws: WebSocket, message: unknown) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 2 * 1024 * 1024) ws.terminate(); else ws.send(JSON.stringify(message)); } };
  const push = (tenant: string, state: ProductState) => { for (const [ws, peer] of peers) if (peer.tenant === tenant) send(ws, { type: 'state', revision: state.workspace.revision, state }); };
  control.on('state', push);
  const signal = (tenant: string, lease: string, message: unknown) => { for (const [ws, peer] of peers) if (peer.tenant === tenant && peer.lease === lease) send(ws, message); };
  control.on('rtc.signal', signal);
  server.on('upgrade', (req, socket, head) => {
    try {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/socket') throw new ApiError(404, '接口不存在'); checkOrigin(req);
      const token = readToken(req), identity = control.store.identity(token); if (!identity || !token) throw new ApiError(401, '请先登录');
      sockets.handleUpgrade(req, socket, head, ws => {
        const lease = randomUUID(), peer = { tenant: identity.tenantId, lease, token, alive: true }; peers.set(ws, peer);
        const pending = new Set<string>();
        const ready = control.attachViewer(peer.tenant, lease, reason => { send(ws, { type: 'lease', status: 'revoked', reason }); ws.close(4001, reason); }, { identity: authenticationIdentity(token), valid: () => control.store.identity(token)?.tenantId === peer.tenant });
        void ready.then(state => send(ws, { type: 'state', revision: state.workspace.revision, state })).catch(() => ws.close(1011, 'Viewer unavailable'));
        ws.on('pong', () => { peer.alive = true; }); ws.on('error', () => {});
        ws.on('close', () => { peers.delete(ws); void control.detachViewer(peer.tenant, lease).catch(() => {}); });
        ws.on('message', (data, binary) => {
          let request: any;
          try { if (binary) throw new Error(); request = JSON.parse(data.toString()); if (!request || typeof request.id !== 'string' || !request.id || request.id.length > 128 || typeof request.method !== 'string' || pending.has(request.id) || pending.size >= 32) throw new Error(); }
          catch { send(ws, { type: 'error', id: typeof request?.id === 'string' ? request.id : '', error: { code: 400, message: '无效的 WebSocket 请求' } }); return; }
          pending.add(request.id);
          void ready.then(async () => {
            if (!control.store.identity(token)) throw new ApiError(401, '登录已过期');
            const result = await control.viewerRequest(peer.tenant, lease, request.method, request.params); send(ws, { type: 'result', id: request.id, result });
          }).catch(error => send(ws, { type: 'error', id: request.id, error: { code: error instanceof ApiError ? error.status : 502, message: error instanceof Error ? error.message : String(error) } })).finally(() => pending.delete(request.id));
        });
      });
    } catch (error) { const status = error instanceof ApiError ? error.status : 500; socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
  });
  const heartbeat = setInterval(() => { for (const [ws, peer] of peers) { if (!peer.alive || !control.store.identity(peer.token)) { ws.terminate(); continue; } peer.alive = false; ws.ping(); } }, 30000); heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); control.off('state', push); for (const ws of peers.keys()) ws.terminate(); sockets.close(); });
  return server;
}
function readToken(req: IncomingMessage) { return req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('rk_session='))?.slice(11); }
function json(res: ServerResponse, status: number, body: unknown) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); }
async function readBody(req: IncomingMessage) { let size = 0; const chunks: Buffer[] = []; for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new ApiError(413, '请求过大'); chunks.push(Buffer.from(chunk)); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'JSON 格式错误'); } }

function authenticationIdentity(token: string) { return createHash('sha256').update(token).digest('hex'); }
