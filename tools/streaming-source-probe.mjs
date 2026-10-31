// Optional loopback diagnostic fixture; records actual renderer RAF/render
// timestamps without changing the marker payload or forcing extra damage.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
const argument = (key, fallback) => { const at = process.argv.indexOf(key); return at < 0 ? fallback : process.argv[at + 1]; };
const port = Number(argument('--port', '3013'));
const output = resolve(argument('--output', fileURLToPath(new URL('../develop/tmp/source-probe', import.meta.url))));
const fixtureRoot = resolve(argument('--fixture-root', fileURLToPath(new URL('../control/public', import.meta.url))));
const token = randomBytes(24).toString('hex');
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const run = url.searchParams.get('probeRun') ?? 'source';
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(run)) throw new Error('Invalid probeRun');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && url.pathname === '/timer-policy') {
      try { response.setHeader('Content-Type', 'application/json'); response.end(await readFile(resolve(output, '../timer-policy.json'))); }
      catch { response.statusCode = 404; response.end('{}'); }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/marker-codec.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(resolve(fixtureRoot, 'marker-codec.js'))); return;
    }
    if (request.method === 'GET' && url.pathname === '/test-pattern.html') {
      let html = await readFile(resolve(fixtureRoot, 'test-pattern.html'), 'utf8');
      if (!html.includes('function render(now){')) throw new Error('Fixture instrumentation anchor changed');
      html = html.replace('function render(now){', 'function render(now){window.rkSourceProbe.renders.push(now);');
      const setup = `<script>window.rkSourceProbe={run:${JSON.stringify(run)},timeOrigin:performance.timeOrigin,raf:[],renders:[],visibility:[{at:performance.now(),state:document.visibilityState}],userAgent:navigator.userAgent};document.addEventListener('visibilitychange',()=>window.rkSourceProbe.visibility.push({at:performance.now(),state:document.visibilityState}));requestAnimationFrame(function tick(now){if(window.rkSourceProbe.raf.length<12000)window.rkSourceProbe.raf.push(now);requestAnimationFrame(tick)});setInterval(()=>{fetch('/probe?probeRun='+encodeURIComponent(window.rkSourceProbe.run),{method:'POST',headers:{'Content-Type':'application/json','X-RK-Probe':${JSON.stringify(token)}},body:JSON.stringify({...window.rkSourceProbe,at:performance.now(),wall:Date.now(),viewport:[innerWidth,innerHeight],dpr:devicePixelRatio})}).catch(()=>{})},1000);</script>`;
      html = html.replace('<script type="module">', setup + '<script type="module">');
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return;
    }
    if (request.method === 'POST' && url.pathname === '/probe' && request.headers['x-rk-probe'] === token && request.headers.origin === `http://127.0.0.1:${port}`) {
      let bytes = ''; for await (const chunk of request) { bytes += chunk; if (bytes.length > 1024 * 1024) throw new Error('Probe too large'); }
      const data = JSON.parse(bytes);
      await writeFile(resolve(output, run + '.json'), JSON.stringify(data));
      response.end('ok'); return;
    }
    response.statusCode = 404; response.end();
  } catch (error) { response.statusCode = 400; response.end(String(error)); }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ origin: `http://127.0.0.1:${port}`, output })));
const totals = () => cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
let previousCpu = totals(), previousUsage = process.cpuUsage(), previousTime = process.hrtime.bigint();
const load = [];
const loadTimer = setInterval(async () => {
  const current = totals(), now = process.hrtime.bigint(), usage = process.cpuUsage();
  const intervalMs = Number(now - previousTime) / 1e6;
  const totalDelta = current.total - previousCpu.total;
  load.push([Date.now(), totalDelta > 0 ? 100 * (1 - (current.idle - previousCpu.idle) / totalDelta) : null, ((usage.user - previousUsage.user) + (usage.system - previousUsage.system)) / 1000 / intervalMs, intervalMs]);
  previousCpu = current; previousUsage = usage; previousTime = now;
  await writeFile(resolve(output, 'host-load.json'), JSON.stringify({ kind: 'host-load', logicalCpus: cpus().length, columns: ['wallTimeMs', 'systemCpuPercent', 'probeCpuCores', 'intervalMs'], samples: load })).catch(error => console.error(error.message));
}, 1000);
const stop = () => { clearTimeout(timeout); clearInterval(loadTimer); server.close(); };
const timeout = setTimeout(stop, 180000);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
