import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { launchTestBrowser } from '../../../tests/e2e/kit/browser.mjs';
import { summarize } from './summarize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '../../..');
export const outputRoot = join(root, 'develop/tmp/schedlab');
const require = createRequire(join(root, 'control/package.json'));
const { WebSocketServer } = require('ws');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const videoParameters = {
  generator: 'schedlab-mf-v1',
  width: 1920,
  height: 1080,
  fps: 60,
  seconds: 60,
  bitrate: 20000000,
  profile: 'High',
  gop: 120,
  seed: '0x31415926',
  encoder: 'Windows Media Foundation system H264 MFT',
};
export function argsOf(args) {
  const result = {};
  for (let i = 0; i < args.length; ++i) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--')) throw Error(`Invalid argument: ${args[i]}`);
    if (['keep-traces', 'no-idle-gate', 'dry-run'].includes(key)) result[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value: ${args[i]}`);
      result[key] = args[++i];
    }
  }
  return result;
}
export function defaultMix(count) {
  return Array.from({ length: count }, (_, i) => ['S4', 'V', 'V', 'U10', 'static'][i % 5]);
}
export function geometry(value = 'F') {
  const text = { F: '1920x1080@1', T: '1280x800@2' }[value] ?? value;
  const match = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) throw Error(`Invalid geometry: ${value}`);
  const [, w, h, scale] = match;
  const [width, height, dpr] = [w, h, scale].map(Number);
  if (!width || !height || !dpr || width * dpr > 16384 || height * dpr > 16384)
    throw Error(`Invalid geometry: ${value}`);
  return { width, height, dpr };
}
async function binaryIdentity(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const stat = statSync(path);
  return { path: resolve(path), bytes: stat.size, modifiedMs: stat.mtimeMs, sha256: hash.digest('hex') };
}
async function until(predicate, timeout, description, failure) {
  const start = Date.now();
  while (!predicate()) {
    if (failure?.()) throw failure();
    if (Date.now() - start > timeout) throw Error(`Timed out: ${description}`);
    await sleep(100);
  }
  if (failure?.()) throw failure();
}
async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((done, reject) => {
    ws.onopen = done;
    ws.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Error(message.error.message));
    else waiter.resolve(message.result);
  };
  ws.onclose = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(Error('CDP closed'));
    }
    pending.clear();
  };
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`CDP timeout: ${method}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}
function isInside(parent, path) {
  const name = relative(parent, path);
  return name && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name);
}
async function removeProfile(out, path) {
  if (!isInside(out, path)) throw Error(`Cleanup path outside run: ${path}`);
  if (existsSync(path) && !isInside(realpathSync(out), realpathSync(path)))
    throw Error(`Cleanup path escapes run: ${path}`);
  await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
}
function killOwned(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
function gateSample(sample, adapter) {
  const [high, low] = adapter.split(',').map(Number);
  const luid = `luid_0x${(high >>> 0).toString(16).padStart(8, '0')}_0x${(low >>> 0).toString(16).padStart(8, '0')}`;
  const engines = {};
  for (const engine of ['3D', 'VideoDecode', 'VideoProcessing']) {
    const rows = sample.gpu.filter(
      (row) => row.instance.toLowerCase().includes(luid) && row.engine === engine,
    );
    engines[engine] = sample.gpuValid && rows.length ? rows.reduce((n, row) => n + row.percent, 0) : null;
  }
  return {
    epochMs: sample.epochMs,
    ...engines,
    idle:
      engines['3D'] !== null &&
      engines['3D'] < 0.5 &&
      engines.VideoDecode !== null &&
      engines.VideoDecode < 0.1 &&
      engines.VideoProcessing !== null &&
      engines.VideoProcessing < 0.1,
  };
}
async function generateVideo(exe, path) {
  mkdirSync(dirname(path), { recursive: true });
  const partial = path + '.partial.mp4';
  const child = spawn(exe, ['make-video', '--out', partial], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const interrupt = () => killOwned(child);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await new Promise((done, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? done() : reject(Error(`Video generator exited ${code}`))));
    });
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  renameSync(partial, path);
}
function defaultReceiver() {
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (!base) continue;
    const path = join(base, 'Microsoft/Edge/Application/msedge.exe');
    if (existsSync(path)) return path;
  }
  throw Error('Edge not found; pass --receiver <exe>');
}
export async function run(options = {}) {
  const shape = geometry(options.geometry);
  const kinds = options.mix ? options.mix.split(',') : defaultMix(Number(options.tenants ?? 1));
  const count = kinds.length;
  if (
    !count ||
    kinds.some(
      (kind) =>
        !/^(S(?:\d+(?:\.\d+)?)|U(?:\d+(?:\.\d+)?)|V|static)$/.test(kind) || /^[SU]0(?:\.0*)?$/.test(kind),
    )
  )
    throw Error('Invalid workload mix');
  if (options.tenants && Number(options.tenants) !== count) throw Error('Tenant count and mix differ');
  const warmup = Number(options.warmup ?? 10),
    duration = Number(options.duration ?? 60);
  if (!Number.isFinite(warmup) || !Number.isFinite(duration) || warmup < 0 || duration <= 0)
    throw Error('Invalid duration or warmup');
  const label = String(options.label ?? `${options.geometry ?? 'F'}-n${count}`).replace(
    /[^a-zA-Z0-9_-]/g,
    '-',
  );
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const out = resolve(options.out ?? join(outputRoot, `${stamp}-${label}`));
  if (!isInside(outputRoot, out)) throw Error('Output must be under develop/tmp/schedlab');
  if (existsSync(join(out, 'run.json'))) throw Error(`Run exists: ${out}`);
  mkdirSync(out, { recursive: true });
  const build = resolve(options['endpoint-build'] ?? join(root, 'build/endpoint'));
  const exe = join(build, 'endpoint/schedlab.exe');
  let browser = resolve(options.browser ?? 'C:/src/chromium/src/out/rel');
  if (statSync(browser).isDirectory()) browser = join(browser, 'remotekit_browser.exe');
  const receiverExe = resolve(options.receiver ?? defaultReceiver());
  const video = resolve(options.video ?? join(outputRoot, 'assets/video.mp4'));
  if (!existsSync(video)) {
    if (options.video) throw Error(`Video not found: ${video}`);
    await generateVideo(exe, video);
  }
  const streams = Object.fromEntries(
    ['receiver.jsonl', 'fixtures.jsonl', 'bench.jsonl', 'bench.stderr.log', 'receiver.stderr.log'].map(
      (name) => [name, createWriteStream(join(out, name))],
    ),
  );
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path =
      url.pathname === '/video.mp4' ? video : resolve(here, 'web', '.' + decodeURIComponent(url.pathname));
    if (path !== video && !isInside(join(here, 'web'), path)) return response.writeHead(403).end();
    if (!existsSync(path) || !statSync(path).isFile()) return response.writeHead(404).end();
    const bytes = statSync(path).size;
    const headers = {
      'Content-Type':
        { '.html': 'text/html', '.mjs': 'text/javascript', '.png': 'image/png', '.mp4': 'video/mp4' }[
          extname(path)
        ] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Accept-Ranges': 'bytes',
    };
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]),
        end = Math.min(bytes - 1, range[2] ? Number(range[2]) : bytes - 1);
      if (start > end) return response.writeHead(416).end();
      response.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${bytes}`,
        'Content-Length': end - start + 1,
      });
      createReadStream(path, { start, end }).pipe(response);
    } else {
      response.writeHead(200, { ...headers, 'Content-Length': bytes });
      createReadStream(path).pipe(response);
    }
  });
  const wss = new WebSocketServer({ server });
  const receivers = new Map(),
    fixtures = new Map(),
    delivered = new Set(),
    flushed = new Set();
  let bench,
    receiver,
    cdp,
    ready,
    epochReady = false,
    stopped = false,
    shuttingDown = false,
    failure;
  const loadedModules = new Set();
  const browserPids = [];
  const gate = { samples: [], consecutive: 0, skipped: Boolean(options['no-idle-gate']) };
  const fail = (value) => {
    failure ??= value instanceof Error ? value : Error(String(value));
  };
  const send = (value) => {
    if (bench?.stdin.writable) bench.stdin.write(JSON.stringify(value) + '\n');
  };
  const onSignal = () => fail('Run interrupted');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const metadata = {
    schema: 'schedlab-v1',
    label,
    out,
    options,
    ...shape,
    count,
    warmup,
    duration,
    started: Date.now(),
    status: 'starting',
    idleGate: gate,
    media: {
      minBitrate: 500000,
      bitrate: 24000000,
      maxBitrate: 48000000,
      idleIdrMs: 150,
      maxEncodeWidth: 4096,
      maxEncodeHeight: 4096,
    },
    browser,
  };
  const save = () => writeFileSync(join(out, 'run.json'), JSON.stringify(metadata, null, 2) + '\n');
  wss.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const tenant = Number(url.searchParams.get('tenant'));
    if (url.pathname === '/receiver') receivers.set(tenant, socket);
    socket.on('message', (bytes) => {
      try {
        const message = { ...JSON.parse(bytes), tenant };
        if (url.pathname === '/receiver') {
          streams['receiver.jsonl'].write(JSON.stringify(message) + '\n');
          if (message.type === 'offer') send(message);
          if (message.type === 'frames' && message.frames.length) delivered.add(tenant);
          if (message.type === 'receiverError' && !shuttingDown) fail(message.message);
          if (message.type === 'flushed') flushed.add(tenant);
        } else {
          streams['fixtures.jsonl'].write(JSON.stringify(message) + '\n');
          if (message.type === 'scrollStart' || message.type === 'inputStart')
            send({ type: 'activity', tenant, epochMs: message.start ?? message.epochMs });
          if (message.type === 'fixtureReady') fixtures.set(tenant, message.t0);
          if (message.type === 'fixtureError') fail(message.message);
        }
      } catch (error) {
        fail(error);
      }
    });
  });
  try {
    metadata.commit = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).stdout.trim();
    metadata.dirty = Boolean(
      spawnSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      }).stdout.trim(),
    );
    metadata.binaries = await Promise.all(
      [exe, browser, join(dirname(browser), 'remotekit_sdk.dll'), receiverExe].map(binaryIdentity),
    );
    metadata.video = {
      ...(await binaryIdentity(video)),
      parameters: options.video ? { source: 'override' } : videoParameters,
    };
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    metadata.origin = origin;
    metadata.tenants = kinds.map((kind, tenant) => ({
      tenant,
      kind,
      ...shape,
      phase: 0.5 + tenant * 0.5,
      url: `${origin}/fixture.html?tenant=${tenant}&kind=${kind}&phase=${0.5 + tenant * 0.5}&offset=${(tenant * 10) % 60}`,
    }));
    writeFileSync(
      join(out, 'config.json'),
      JSON.stringify({ out, browser, media: metadata.media, tenants: metadata.tenants }, null, 2),
    );
    save();
    bench = spawn(exe, [join(out, 'config.json')], {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    bench.stderr.pipe(streams['bench.stderr.log']);
    bench.on('error', fail);
    bench.stdin.on('error', (error) => {
      if (!shuttingDown) fail(error);
    });
    bench.on('exit', (code) => {
      if (!shuttingDown && !stopped) fail(`Bench exited ${code}`);
    });
    createInterface({ input: bench.stdout }).on('line', (line) => {
      streams['bench.jsonl'].write(line + '\n');
      try {
        const message = JSON.parse(line);
        for (const path of message.modules ?? []) loadedModules.add(path);
        if (message.type === 'ready') {
          ready = message;
          metadata.adapter = message.adapter;
          metadata.encoder = message.encoder;
        }
        if (message.type === 'tenant') browserPids.push(message.pid);
        if (message.type === 'epoch') epochReady = true;
        if (message.type === 'stopped') stopped = true;
        if (message.type === 'fatal' || message.type === 'shutdown_error') fail(message.message);
        if (message.type === 'answer') receivers.get(message.tenant)?.send(JSON.stringify(message));
        if (message.type === 'resources' && ready && !gate.passed) {
          const sample = gateSample(message, ready.adapter);
          gate.samples.push(sample);
          gate.consecutive = sample.idle ? gate.consecutive + 1 : 0;
          gate.passed = gate.consecutive >= 3;
        }
      } catch (error) {
        fail(error);
      }
    });
    await until(
      () => ready,
      90000,
      'native tenants ready',
      () => failure,
    );
    if (!gate.skipped) {
      console.log(`Waiting for idle adapter ${ready.adapter}`);
      try {
        await until(
          () => gate.passed,
          60000,
          'three idle GPU samples',
          () => failure,
        );
      } catch (error) {
        throw Error(`${error.message}; idle samples: ${JSON.stringify(gate.samples)}`);
      }
    }
    const profile = join(out, 'receiver-profile');
    const version = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${receiverExe.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).stdout.trim();
    metadata.receiverVersion = version;
    const chrome89 = Number(version.split('.')[0]) === 89;
    const receiverPage = chrome89 ? 'receiver89.html' : 'receiver.html';
    const receiverFlags = [
      chrome89 ? '--headless' : '--headless=new',
      '--disable-gpu',
      '--disable-accelerated-video-decode',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `${origin}/${receiverPage}?tenant=0`,
    ];
    metadata.receiverFlags = receiverFlags;
    receiver = await launchTestBrowser({
      profile,
      executablePath: receiverExe,
      args: receiverFlags,
      spawnOptions: { stdio: ['ignore', 'ignore', 'pipe'] },
    });
    receiver.stderr.pipe(streams['receiver.stderr.log']);
    receiver.on('error', fail);
    receiver.on('exit', (code) => {
      if (!shuttingDown) fail(`Receiver exited ${code}`);
    });
    metadata.receiverPid = receiver.pid;
    metadata.benchPid = bench.pid;
    send({ type: 'receiver', pid: receiver.pid });
    let endpoint;
    await until(
      () => {
        const path = join(profile, 'DevToolsActivePort');
        try {
          const [port, browserPath] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
          if (!port || !browserPath) return false;
          endpoint = `ws://127.0.0.1:${port}${browserPath}`;
          return true;
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'EBUSY') return false;
          throw error;
        }
      },
      20000,
      'receiver CDP port',
      () => failure,
    );
    cdp = await cdpConnect(endpoint);
    metadata.receiverCdpVersion = await cdp.send('Browser.getVersion');
    for (let tenant = 1; tenant < count; ++tenant)
      await cdp.send('Target.createTarget', { url: `${origin}/${receiverPage}?tenant=${tenant}` });
    await until(
      () => delivered.size === count,
      60000,
      'all tenants delivering',
      () => failure,
    );
    metadata.browserPids = browserPids;
    const moduleIds = [bench.pid, receiver.pid, ...browserPids];
    const moduleResult = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(${moduleIds.join(',')}) | ForEach-Object { (Get-Process -Id $_ -ErrorAction Stop).Modules | ForEach-Object { $_.FileName } } | Sort-Object -Unique | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (moduleResult.status !== 0)
      throw Error('Cannot inventory loaded runtime DLLs: ' + moduleResult.stderr);
    const modulePaths = JSON.parse(moduleResult.stdout);
    for (const path of Array.isArray(modulePaths) ? modulePaths : [modulePaths]) loadedModules.add(path);
    const t0 = Date.now() + 4000;
    Object.assign(metadata, {
      t0,
      measurementStart: t0 + warmup * 1000,
      measurementEnd: t0 + (warmup + duration) * 1000,
    });
    send({ type: 't0', t0 });
    for (const socket of receivers.values()) socket.send(JSON.stringify({ type: 't0', t0 }));
    await until(
      () => epochReady && [...fixtures.values()].filter((value) => value === t0).length === count,
      20000,
      'fixture epoch',
      () => failure,
    );
    metadata.status = 'running';
    save();
    console.log(`Running ${options.geometry ?? 'F'} ${kinds.join(',')}: ${out}`);
    await until(
      () => Date.now() >= metadata.measurementEnd,
      (warmup + duration + 10) * 1000,
      'measurement',
      () => failure,
    );
    send({ type: 'drain' });
    await sleep(3000);
    for (const socket of receivers.values()) socket.send(JSON.stringify({ type: 'flush' }));
    await until(
      () => flushed.size === count,
      5000,
      'receiver flush',
      () => failure,
    );
    metadata.status = 'complete';
  } catch (error) {
    fail(error);
    metadata.status = 'failed';
    metadata.error = String(error.stack ?? error);
  } finally {
    shuttingDown = true;
    const cleanupErrors = [];
    const cleanup = async (action) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    };
    await cleanup(async () => {
      if (bench?.exitCode === null) {
        send({ type: 'stop' });
        await until(() => bench.exitCode !== null, Math.max(40000, count * 20000), 'bench shutdown');
      }
      if (bench && (!stopped || bench.exitCode !== 0)) throw Error('Bench shutdown failed');
    });
    await cleanup(async () => {
      if (cdp) {
        cdp.send('Browser.close').catch(() => {});
        await sleep(1000);
        cdp.close();
      }
    });
    killOwned(bench);
    killOwned(receiver);
    await cleanup(async () => {
      if (bench) await until(() => bench.exitCode !== null || bench.signalCode !== null, 10000, 'bench exit');
      if (receiver)
        await until(() => receiver.exitCode !== null || receiver.signalCode !== null, 10000, 'receiver exit');
    });
    await cleanup(async () => {
      for (const path of [join(out, 'receiver-profile'), ...kinds.map((_, i) => join(out, `browser-${i}`))])
        await removeProfile(out, path);
    });
    for (const client of wss.clients) client.terminate();
    await new Promise((done) => wss.close(done));
    server.closeAllConnections();
    if (server.listening) await new Promise((done) => server.close(done));
    await Promise.all(Object.values(streams).map((stream) => new Promise((done) => stream.end(done))));
    await cleanup(async () => {
      metadata.loadedRuntimeDlls = await Promise.all(
        [...loadedModules].filter((path) => /\.dll$/i.test(path)).map(binaryIdentity),
      );
    });
    metadata.cleanup = {
      profilesRemoved: !readdirSync(out).some(
        (name) => name === 'receiver-profile' || /^browser-\d+$/.test(name),
      ),
      benchExited: !bench || bench.exitCode !== null || bench.signalCode !== null,
      receiverExited: !receiver || receiver.exitCode !== null || receiver.signalCode !== null,
      errors: cleanupErrors,
    };
    if (cleanupErrors.length) fail(cleanupErrors.join('; '));
    if (failure) {
      metadata.status = 'failed';
      metadata.error = String(failure.stack ?? failure);
    }
    metadata.finished = Date.now();
    save();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  let summary;
  if (metadata.measurementStart) {
    summary = summarize(out);
    if (!options['keep-traces']) {
      for (const name of readdirSync(out).filter(
        (name) =>
          /^(server-|frames-|encoded-|snapshots-)/.test(name) ||
          ['receiver.jsonl', 'fixtures.jsonl', 'resources.jsonl', 'bench.jsonl'].includes(name),
      ))
        await rm(join(out, name));
    }
  }
  if (failure) throw failure;
  console.log(JSON.stringify(summary.aggregate));
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(argsOf(process.argv.slice(2))).catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
