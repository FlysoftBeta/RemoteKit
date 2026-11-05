// Isolated production Viewer measurement service. No diagnostics routes or policy overrides.
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../control/server/store.ts';
import { Control } from '../control/server/control.ts';
import { EndpointProcess } from '../control/server/endpoint.ts';
import { createHttp } from '../control/server/http.ts';
const root = resolve('.'),
  run = resolve(process.argv[2] ?? 'develop/tmp/viewer-presentation-baseline');
await mkdir(run, { recursive: true });
const store = new Store(`${run}/control.db`);
const endpoint = new EndpointProcess(`${root}/build/endpoint-package/endpoint/endpoint_service.exe`, [
  '--browser=C:/src/chromium/src/out/dev/remotekit_browser.exe',
  `--data-path=${run}/endpoint`,
]);
const control = new Control(store, endpoint);
// Optional functional-quality fixture: persist desired high-DPR geometry before
// the first Viewer attaches, so its first source is genuinely cold and full-size.
if (process.argv[3] === 'quality') {
  const existing = store.db.prepare('SELECT tenant FROM users WHERE username=?').get('baseline') as
    { tenant: string } | undefined;
  const tenant =
    existing?.tenant ?? (await store.register('baseline', 'independent-local-baseline-2026')).tenantId;
  await control.productAction(tenant, {
    type: 'settings.update',
    settings: { qualityPreference: 'quality', clientScaleOverride: 2 },
  });
  if (!store.workspace(tenant).windows.length)
    await control.productAction(tenant, { type: 'window.create', url: 'http://127.0.0.1:33272/animation' });
}
endpoint.on('ready', () => void control.reconcileAll());
const server = createHttp(control, {
  origins: ['http://127.0.0.1:33271'],
  clientDir: `${root}/control/dist/client`,
  metricsDir: `${run}/metrics`,
  diagnostics: false,
});
const fixture = createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://127.0.0.1:33272');
  if (u.pathname === '/shutdown') {
    res.end('stopping');
    setTimeout(() => void close(), 100);
    return;
  }
  if (u.pathname === '/inspect') {
    const user = store.db
      .prepare('SELECT tenant FROM users WHERE username=?')
      .get(u.searchParams.get('user')) as any;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        state: user ? control.productState(user.tenant) : null,
        snapshot: user ? await endpoint.request('session.snapshot', user.tenant) : null,
      }),
    );
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><meta name="viewport" content="width=device-width"><style>html,body{margin:0;overflow:hidden;background:#eee}canvas{width:100vw;height:100vh}</style><canvas></canvas><script>const c=document.querySelector('canvas'),g=c.getContext('2d');let n=0;function size(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;document.title=JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})}onresize=size;size();function f(){n++;g.fillStyle='#edf2f8';g.fillRect(0,0,c.width,c.height);g.fillStyle='#2463a8';g.fillRect((n*9)%(c.width+300)-300,0,300,c.height);g.fillStyle='#111';g.font='40px sans-serif';g.fillText('RemoteKit frame '+n,50,80);requestAnimationFrame(f)}f()</script>`,
  );
});
await new Promise<void>((r) => fixture.listen(33272, '127.0.0.1', r));
await new Promise<void>((r) => server.listen(33271, '127.0.0.1', r));
endpoint.start();
const timer = setInterval(() => void control.tick(), 1500);
await writeFile(
  `${run}/service.json`,
  JSON.stringify({ pid: process.pid, run, started: new Date().toISOString() }),
);
console.log(`READY ${run}`);
async function close() {
  clearInterval(timer);
  server.close();
  fixture.close();
  control.closeRelays();
  await endpoint.stop();
  store.db.close();
  process.exit(0);
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
