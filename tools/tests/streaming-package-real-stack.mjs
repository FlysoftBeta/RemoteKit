// node streaming-package-real-stack.mjs <deployment root> <playwright module> <viewer exe> <new evidence dir>
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { registerViewer } from '../../tests/e2e/product-stack.mjs';

const [packagePath, playwright, viewer, evidence] = process.argv.slice(2);
assert(
  packagePath && playwright && viewer && evidence,
  'Expected package, Playwright, Viewer and evidence paths',
);
const runtime = resolve(packagePath),
  run = resolve(evidence);
const buildId = (await readFile(join(runtime, 'current'), 'utf8')).trim();
const version = join(runtime, 'versions', buildId);
const { chromium } = createRequire(import.meta.url)(resolve(playwright));
await mkdir(run, { recursive: true });
const events = [];
const fixture = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    events.push(JSON.parse(body));
    res.end('ok');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Packaged runtime input fixture</title>
    <style>body{margin:0;background:#cde7ff;height:4000px}button{position:absolute;top:100px;left:100px;width:180px;height:80px}canvas{position:fixed;right:10px;top:10px}</style>
    <button>Remote click</button><canvas width="32" height="32"></canvas><script>
    const report=(type,extra={})=>fetch('/event',{method:'POST',body:JSON.stringify({type,width:innerWidth,height:innerHeight,scrollY,...extra})});
    document.querySelector('button').onclick=e=>report('click',{trusted:e.isTrusted});
    addEventListener('scroll',()=>report('scroll'));
    let tick=0;setInterval(()=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle=tick++%2?'red':'blue';c.fillRect(0,0,32,32)},80);
    report('ready');</script>`);
});
await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
const fixtureOrigin = 'http://127.0.0.1:' + fixture.address().port;
const reserve = createServer();
await new Promise((done) => reserve.listen(0, '127.0.0.1', done));
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));
const origin = 'http://127.0.0.1:' + port;
await mkdir(join(runtime, 'config'), { recursive: true });
await writeFile(
  join(runtime, 'config/control.json'),
  JSON.stringify({
    http: { listen: '127.0.0.1:' + port, origins: [origin] },
    storage: { database: '../data/control.db', diagnostics: '../data/diagnostics' },
    nodes: { local: { local: { root: '../data/node' } } },
  }),
);
const env = { ...process.env };
for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'REMOTEKIT_CONTROL_CONFIG']) delete env[name];
await writeFile(
  join(runtime, 'config/manager.json'),
  JSON.stringify({ manifest: origin + '/control.manifest' }),
);
await writeFile(join(runtime, 'config/release.key'), randomBytes(32).toString('base64'));
const child = spawn(join(runtime, 'remotekit_control.exe'), ['run', '--root=' + runtime], {
  cwd: runtime,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (data) => void appendFile(join(run, 'stdout.log'), data));
child.stderr.on('data', (data) => void appendFile(join(run, 'stderr.log'), data));
async function until(probe, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(message);
}
const result = { passed: false, package: runtime, origin, version, supervisor: 'remotekit_control.exe' };
let context;
try {
  await until(
    () =>
      fetch(origin + '/api/auth/setup')
        .then((r) => r.ok)
        .catch(() => false),
    'Control did not start',
  );
  context = await chromium.launchPersistentContext(join(run, 'viewer'), {
    executablePath: resolve(viewer),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required'],
  });
  await context.addInitScript(() => {
    window.packagePeers = [];
    const Native = RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.packagePeers.push(this);
      }
    };
  });
  const page = context.pages()[0];
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  await page.locator('.viewer-lock-blank').waitFor();
  for (const key of [
    'ArrowUp',
    'ArrowUp',
    'ArrowDown',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowLeft',
    'ArrowRight',
  ])
    await page.keyboard.press(key);
  await registerViewer({
    click: (selector, name) => page.locator(selector).filter({ hasText: name }).click(),
    fill: (selector, value) => page.locator(selector).fill(value),
    username: 'package-qa',
    password: randomBytes(18).toString('hex'),
  });
  result.registered = true;
  await page.getByRole('button', { name: '新建窗口', exact: true }).click();
  await page.locator('.address-form input').fill(fixtureOrigin);
  await page.locator('.address-form input').press('Enter');
  const ready = await until(() => events.find((e) => e.type === 'ready'), 'Remote page did not load');
  result.windowOpened = true;
  const media = () =>
    page.evaluate(async () => {
      const values = [];
      for (const peer of window.packagePeers) {
        const stats = await peer.getStats();
        for (const row of stats.values())
          if (row.type === 'inbound-rtp' && (row.kind || row.mediaType) === 'video')
            values.push({
              codec: stats.get(row.codecId)?.mimeType,
              framesDecoded: row.framesDecoded,
              bytesReceived: row.bytesReceived,
            });
      }
      return values.find((row) => row.codec?.toLowerCase() === 'video/h264' && row.framesDecoded > 0);
    });
  result.mediaBefore = await until(media, 'No decoded H.264 frames');
  await page.waitForFunction(() => {
    const pane = document.querySelector('.remote-viewport'),
      video = pane?.querySelector('video');
    return video?.videoWidth > 0 && !pane.classList.contains('resize-waiting');
  });
  const pane = await page.locator('.remote-viewport').boundingBox();
  await page.mouse.click(
    pane.x + (190 * pane.width) / ready.width,
    pane.y + (140 * pane.height) / ready.height,
  );
  result.click = await until(
    () => events.find((e) => e.type === 'click' && e.trusted),
    'Remote click not delivered',
  );
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.wheel(0, 600);
  result.scroll = await until(
    () => events.find((e) => e.type === 'scroll' && e.scrollY > 0),
    'Remote scroll not delivered',
  );
  result.mediaAfter = await until(async () => {
    const next = await media();
    return next?.framesDecoded > result.mediaBefore.framesDecoded && next;
  }, 'H.264 decoding did not advance after input');
  await page.screenshot({ path: join(run, 'viewer.png') });
  result.passed = true;
} catch (error) {
  result.error = error.stack;
} finally {
  await context?.close();
  if (child.exitCode === null) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'pipe',
      });
    } catch (error) {
      result.cleanupError = String(error);
      result.passed = false;
    }
  }
  await new Promise((done) => fixture.close(done));
  await writeFile(join(run, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 1;
