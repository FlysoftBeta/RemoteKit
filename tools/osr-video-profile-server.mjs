// Usage: node tools/osr-video-profile-server.mjs --package <unpacked streaming runtime>
//   --evidence develop/tmp/<new-directory> [--live-build] [--port 33623]
//   [--viewer <chrome.exe>] [--rtc-playout-max-ms 50]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  package: { type: 'string' }, evidence: { type: 'string' },
  port: { type: 'string', default: '33623' }, viewer: { type: 'string', default: 'C:/src/chromium/src/out/rel/chrome.exe' },
  'live-build': { type: 'boolean' }, 'rtc-playout-max-ms': { type: 'string' },
} });
if (!options.package || !options.evidence) throw Error('--package and --evidence are required');
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1024 || port > 65534) throw Error('Invalid Control port');
const maxPlayout = options['rtc-playout-max-ms'];
if (maxPlayout !== undefined && maxPlayout !== '50') throw Error('Only the 50 ms contrast is supported');
const fixturePort = port + 1;
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(options.evidence);
const scope = relative(join(root, 'develop', 'tmp'), evidence);
if (!scope || scope.startsWith('..') || isAbsolute(scope)) throw Error('Use a new directory under develop/tmp');
const pkg = resolve(options.package);
const node = join(pkg, 'bin', 'node.exe');
const viewer = resolve(options.viewer);
const endpoint = options['live-build'] ? join(root, 'build', 'endpoint-package', 'endpoint', 'endpoint_service.exe') :
  join(pkg, 'bin', 'endpoint_service.exe');
const browser = options['live-build'] ? resolve('C:/src/chromium/src/out/dev/remotekit_browser.exe') :
  join(pkg, 'bin', 'remotekit_browser.exe');
const control = join(options['live-build'] ? root : pkg, 'control', 'dist', 'server.mjs');

async function fingerprint(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const info = await stat(path);
  return { path, sha256: hash.digest('hex'), bytes: info.size, modifiedUtc: info.mtime.toISOString() };
}

const fingerprints = await Promise.all([
  node, viewer, endpoint, browser, control,
  join(dirname(browser), 'remotekit_sdk.dll'), join(dirname(browser), 'components_viz_service.dll'),
].map(fingerprint));
await mkdir(dirname(evidence), { recursive: true });
await mkdir(evidence);
await writeFile(join(evidence, 'artifact-hashes.json'), JSON.stringify(fingerprints, null, 2));
await copyFile(join(root, 'tools', 'osr-video-profile-browser.js'), join(evidence, 'driver.js'));
if (!options['live-build']) await copyFile(join(pkg, 'manifest.json'), join(evidence, 'package-manifest.json'));

const original = await readFile(join(root, 'control', 'public', 'test-pattern.html'), 'utf8');
const fixture = original.replace('function tick(now)', `
addEventListener('pointerdown', event => {
  if (!event.isTrusted || event.clientY < innerHeight * 0.5) return;
  const handlerAt = performance.now(), handlerWall = Date.now();
  stimulus = Math.floor(event.clientX * 20 / innerWidth) + 1;
  render(performance.now());
  fetch('/event', { method: 'POST', body: JSON.stringify({ stimulus, frame, handlerAt, handlerWall, pointerType: event.pointerType,
    at: performance.now(), wall: Date.now(), x: event.clientX, y: event.clientY,
    dpr: devicePixelRatio, width: innerWidth, height: innerHeight }) }).catch(() => {});
});
for (const type of ['touchstart', 'touchend']) addEventListener(type, event => {
  fetch('/touch-event', { method: 'POST', body: JSON.stringify({ type, trusted: event.isTrusted,
    active: event.touches.length, changed: event.changedTouches.length, wall: Date.now() }) }).catch(() => {});
}, { passive: true });
function tick(now)`);
if (fixture === original) throw Error('Marker fixture hook is missing');
const codec = await readFile(join(root, 'control', 'public', 'marker-codec.js'));
const sinks = {
  '/event': 'remote-input.jsonl', '/health': 'health.jsonl',
  '/report': 'video-profile.json', '/clean-report': 'video-profile-clean.json', '/stats-report': 'stats-overlay.json',
  '/touch-event': 'remote-touch.jsonl', '/touch-report': 'touch-compatibility.json',
};
const server = createServer(async (req, res) => {
  try {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && route === '/fixture') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture);
    } else if (req.method === 'GET' && route === '/marker-codec.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(codec);
    } else if (req.method === 'POST' && route === '/shutdown') {
      res.end('stopping');
      close();
    } else if (req.method === 'POST' && Object.hasOwn(sinks, route)) {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 12000000) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      const sink = join(evidence, sinks[route]);
      if (sink.endsWith('.jsonl')) {
        await appendFile(sink, JSON.stringify({ ...data, receivedWall: Date.now() }) + '\n');
      } else {
        await writeFile(sink, JSON.stringify(data, null, 2));
      }
      res.end('ok');
    } else {
      res.writeHead(404).end();
    }
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
await new Promise((ready, reject) => {
  server.once('error', reject);
  server.listen(fixturePort, '127.0.0.1', ready);
});
const endpointArgs = [`--browser=${browser}`, `--data-path=${join(evidence, 'endpoint')}`];
if (maxPlayout) endpointArgs.push(`--rtc-playout-max-ms=${maxPlayout}`);
const child = spawn(node, [control], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
  ...process.env, PORT: String(port), REMOTEKIT_CONTROL_HOST: '127.0.0.1',
  REMOTEKIT_CONTROL_DB: join(evidence, 'control.db'), REMOTEKIT_METRICS_DIR: join(evidence, 'metrics'),
  REMOTEKIT_SERVER_TRACE: join(evidence, 'server-trace'), REMOTEKIT_MEDIA_TRACE: join(evidence, 'browser-trace'),
  REMOTEKIT_ENDPOINT: endpoint, REMOTEKIT_ENDPOINT_ARGS: JSON.stringify(endpointArgs),
  REMOTEKIT_CONTROL_ORIGINS: `http://127.0.0.1:${port}`,
} });
child.stdout.pipe(createWriteStream(join(evidence, 'server.stdout.log')));
const stderr = createWriteStream(join(evidence, 'server.stderr.log'));
child.stderr.pipe(stderr, { end: false });
let closing = false;
const watchdog = setTimeout(close, 150000);
watchdog.unref();
function close() {
  if (closing) return;
  closing = true;
  clearTimeout(watchdog);
  if (child.connected) child.disconnect();
  server.close();
}
child.on('error', error => {
  process.exitCode = 1;
  stderr.end(String(error) + '\n');
  close();
});
child.on('close', (code, signal) => {
  if (code) process.exitCode = code;
  if (!stderr.writableEnded) stderr.end(`control exit ${code}/${signal}\n`);
  close();
});
process.on('SIGINT', close);
process.on('SIGTERM', close);
await writeFile(join(evidence, 'service.json'), JSON.stringify({
  supervisorPid: process.pid, controlPid: child.pid, port, fixturePort, pkg, endpoint, browser, control,
  endpointArgs, maxPlayout: maxPlayout ?? null, startedUtc: new Date().toISOString(),
}, null, 2));
console.log(`Control port ${port}, fixture port ${fixturePort}, evidence ${evidence}`);
