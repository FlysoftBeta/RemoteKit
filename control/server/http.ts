import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { ApiError, Control } from './control';

export function createHttp(control: Control, options: { origins: string[]; clientDir: string; metricsDir: string; tls?: { key: Buffer; cert: Buffer } }) {
  // appendFile may split a large record into several writes. Serialize whole
  // records across tenants, and retain a usable queue after a failed write.
  let metricsWrite: Promise<void> = Promise.resolve();
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const token = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('rk_session='))?.slice(11);
      if (path === '/api/state' && req.method === 'GET') {
        const session = control.store.session(token);
        if (session.fresh) res.setHeader('Set-Cookie', `rk_session=${session.token}; HttpOnly; SameSite=Strict; Path=/${options.tls ? '; Secure' : ''}`);
        return json(res, 200, await control.getState(session.tenantId));
      }
      if (path.startsWith('/api/')) {
        if (req.method !== 'POST') throw new ApiError(405, '不支持的方法');
        if (!req.headers.origin || !options.origins.includes(req.headers.origin)) throw new ApiError(403, '请求来源不允许');
        const tenant = control.store.authenticated(token); if (!tenant) throw new ApiError(401, '请先加载工作台');
        if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, '需要 JSON 请求');
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, '需要 JSON 对象');
        if ('tenantId' in body || 'tenant' in body) throw new ApiError(400, '客户端不能指定租户');
        if (path === '/api/actions') return json(res, 200, await control.action(tenant, body));
        if (path === '/api/rtc/offer') return json(res, 200, await control.offer(tenant, body));
        if (path === '/api/rtc/ice') return json(res, 200, await control.ice(tenant, body));
        if (path === '/api/rtc/close') return json(res, 200, await control.closeRtc(tenant, body));
        if (path === '/api/rtc/network') return json(res, 200, control.networkStats(tenant, body));
        if (path === '/api/metrics') {
          const record = JSON.stringify({ receivedAt: new Date().toISOString(), tenantId: tenant, metrics: body }) + '\n';
          const write = metricsWrite.then(async () => {
            await mkdir(options.metricsDir, { recursive: true });
            await appendFile(resolve(options.metricsDir, 'client-metrics.jsonl'), record);
          });
          metricsWrite = write.catch(() => {});
          await write;
          return json(res, 200, { stored: true });
        }
        throw new ApiError(404, '接口不存在');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, '不支持的方法');
      const root = resolve(options.clientDir); const file = resolve(root, path === '/' ? 'index.html' : `.${path}`);
      if (!file.startsWith(root + sep)) throw new ApiError(403, '无效路径');
      const content = await readFile(file).catch(() => { throw new ApiError(404, '文件不存在，请先 npm run build'); });
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { json(res, error instanceof ApiError ? error.status : 502, { error: { message: error instanceof Error ? error.message : String(error) } }); }
  };
  return options.tls ? createHttpsServer(options.tls, handler) : createServer(handler);
}
function json(res: ServerResponse, status: number, body: unknown) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); }
async function readBody(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new ApiError(413, '请求过大'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'JSON 格式错误'); }
}
