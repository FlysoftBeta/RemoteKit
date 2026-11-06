import { createClusterControl } from './cluster-control.mts';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createHttp } from '../../control/server/http/server.ts';
const root = fileURLToPath(new URL('../../', import.meta.url)),
  run = process.env.REMOTEKIT_TOUCH_QA_RUN ?? `${root}/develop/tmp/touch-source-qa-${Date.now()}`;
await mkdir(run, { recursive: true });
const { store, endpoint, control } = await createClusterControl({
  run,
  executable: `${root}/build/endpoint/endpoint/endpoint_service.exe`,
  browser: 'C:/src/chromium/src/out/dev/remotekit_browser.exe',
  port: 33281,
});
const latest = new Map<string, any>();
const server = createHttp(control, {
  origins: ['http://127.0.0.1:33281'],
  clientDir: `${root}/control/dist/client`,
  nodes: endpoint,
});
const fixture = createServer(async (req, res) => {
  try {
    res.setHeader('Access-createApplication-Allow-Origin', '*');
    res.setHeader('Access-createApplication-Allow-Headers', 'content-type');
    res.setHeader('Cache-createApplication', 'no-store');
    if (req.method === 'OPTIONS') {
      res.end();
      return;
    }
    const url = new URL(req.url!, 'http://127.0.0.1:33282');
    if (url.pathname === '/telemetry') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1000000) throw Error('telemetry too large');
      }
      const value = JSON.parse(body);
      latest.set(`${value.id}:${value.child ? 'child' : 'root'}`, value);
      await appendFile(`${run}/telemetry.jsonl`, body + '\n');
      res.end('ok');
      return;
    }
    if (url.pathname === '/inspect') {
      const user = store.db.prepare('SELECT tenant FROM users LIMIT 1').get() as any;
      const snapshot = user ? await control.endpoint.snapshot(user.tenant) : null;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          run,
          telemetry: Object.fromEntries(latest),
          state: user ? control.viewers.productState(user.tenant) : null,
          snapshot,
        }),
      );
      return;
    }
    if (url.pathname === '/record') {
      let body = '';
      for await (const chunk of req) body += chunk;
      await writeFile(`${run}/result.json`, body);
      res.end('saved');
      return;
    }
    if (url.pathname === '/shutdown') {
      res.end('stopping');
      setTimeout(() => void close(), 100);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(await readFile(`${root}/tests/e2e/fixtures/touch-scroll.html`));
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});
await new Promise<void>((r) => fixture.listen(33282, '0.0.0.0', r));
await new Promise<void>((r) => server.listen(33281, '127.0.0.1', r));
endpoint.start();
const timer = setInterval(() => void control.reconciler.tick().catch(console.error), 1500);
await writeFile(`${root}/develop/tmp/touch-source-qa-active.json`, JSON.stringify({ run, pid: process.pid }));
console.log('TOUCH QA READY ' + run);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await server.shutdown();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await control.close();
  await endpoint.stop();
  store.db.close();
  process.exitCode = 0;
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
