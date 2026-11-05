// Isolated production Viewer functional fixture; no policy/backend override.
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../control/server/store.ts';
import { Control } from '../control/server/control.ts';
import { EndpointProcess } from '../control/server/endpoint.ts';
import { createHttp } from '../control/server/http.ts';
const root = resolve('.'),
  run = resolve(process.argv[2] ?? 'develop/tmp/video-input-qa');
await mkdir(run, { recursive: true });
const store = new Store(`${run}/control.db`),
  endpoint = new EndpointProcess(`${root}/build/endpoint-package/endpoint/endpoint_service.exe`, [
    '--browser=C:/src/chromium/src/out/dev/remotekit_browser.exe',
    `--data-path=${run}/endpoint`,
  ]);
const control = new Control(store, endpoint),
  events: any[] = await readFile(`${run}/fixture-events.json`, 'utf8')
    .then(JSON.parse)
    .catch(() => []);
endpoint.on('ready', () => void control.reconcileAll());
const server = createHttp(control, {
  origins: ['http://127.0.0.1:33371'],
  clientDir: process.env.VIDEO_INPUT_CLIENT_DIR ?? `${root}/control/dist/client`,
  metricsDir: `${run}/metrics`,
  diagnostics: false,
});
const fixture = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1:33372');
  if (url.pathname === '/shutdown') {
    res.end('stopping');
    setTimeout(() => void close(), 100);
    return;
  }
  if (url.pathname === '/inspect') {
    const user = store.db.prepare('SELECT tenant FROM users WHERE username=?').get('video-input') as any;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        state: user ? control.productState(user.tenant) : null,
        events,
        snapshot: user
          ? await endpoint.request('session.snapshot', user.tenant, { outputDiagnostics: true })
          : null,
      }),
    );
    return;
  }
  if (url.pathname === '/event' && req.method === 'POST') {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 65536) {
        res.writeHead(413).end();
        return;
      }
    }
    events.push(JSON.parse(text));
    if (events.length > 1024) events.shift();
    await writeFile(`${run}/fixture-events.json`, JSON.stringify(events, null, 2));
    res.end('ok');
    return;
  }
  const label = url.searchParams.get('label') === 'B' ? 'B' : 'A';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;font:18px system-ui;background:${label === 'A' ? '#e4efff' : '#ffebd8'}}header{position:sticky;top:0;background:#173b63;color:white;padding:14px;z-index:1}main{padding:24px}input{height:40px}#nested{width:75%;height:230px;overflow:auto;border:4px solid #d75;background:white}#inner{height:1300px;padding:12px;background:linear-gradient(white,#9dcfff)}.row{height:240px;border-bottom:2px solid #345;padding:24px}</style><header>Window ${label} · native scrolling · <span id="status"></span></header><main><input id="focus" placeholder="Focus typing target"><div id="nested"><div id="inner">Nested native scrollbar and wheel target</div></div></main><script>
 const label='${label}',report=(type,data={})=>fetch('/event',{method:'POST',body:JSON.stringify({type,label,at:performance.now(),...data})});
 for(let n=0;n<22;n++){let d=document.createElement('div');d.className='row';d.textContent='Native page row '+n;document.body.append(d)}
 const snapshot=()=>({scrollY,scrollX,nested:document.querySelector('#nested').scrollTop,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,active:document.activeElement?.id});
 const update=()=>{document.querySelector('#status').textContent='page '+Math.round(scrollY)+' / nested '+document.querySelector('#nested').scrollTop};
 for(const kind of ['pointerdown','pointerup','wheel','focusin','keydown'])document.addEventListener(kind,e=>report('input',{kind,target:e.target.id,x:e.clientX,y:e.clientY,deltaY:e.deltaY,...snapshot()}),{capture:true});
 let timer;const scroll=()=>{update();clearTimeout(timer);timer=setTimeout(()=>report('scroll',snapshot()),80)};addEventListener('scroll',scroll);document.querySelector('#nested').addEventListener('scroll',scroll);onresize=()=>report('geometry',snapshot());update();report('ready',snapshot());document.title='Scroll '+label+' '+location.search;</script>`);
});
await new Promise<void>((r) => fixture.listen(33372, '127.0.0.1', r));
await new Promise<void>((r) => server.listen(33371, '127.0.0.1', r));
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
