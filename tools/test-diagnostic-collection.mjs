/**
 * Real H.264 diagnostic-collection regression on an isolated loopback instance.
 * node tools/test-diagnostic-collection.mjs <playwright module> <viewer exe> <endpoint exe> <remote browser exe> <unused output dir> [port] [local scenario module]
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import assert from 'node:assert/strict';

const [playwright, viewer, endpoint, browser, output, listenPort = '33785', scenarioPath] =
  process.argv.slice(2);
assert(
  [playwright, viewer, endpoint, browser, output].every(Boolean),
  'Expected Playwright, Viewer, Endpoint, Browser and output paths',
);
const scenarioModule = scenarioPath && (await import(pathToFileURL(resolve(scenarioPath)).href));
const scenario = scenarioModule ? scenarioModule.createScenario() : undefined;
const receiverAudio = scenarioModule?.receiverAudio ?? 'recvonly';
assert(['recvonly', 'inactive'].includes(receiverAudio), 'Invalid experiment audio direction');
const { chromium } = createRequire(import.meta.url)(resolve(playwright));
const root = fileURLToPath(new URL('../', import.meta.url));
const run = resolve(output);
const port = Number(listenPort);
const origin = 'http://127.0.0.1:' + port;
const fixtureOrigin = 'http://127.0.0.1:' + (port + 1);
await mkdir(run);
const log = async (stage, value) => {
  await appendFile(join(run, 'diagnostic-collection-results.jsonl'), JSON.stringify({ stage, value }) + '\n');
  console.log(stage);
};
const archiveDirectory = join(run, 'diagnostics');
let fixtureVisits = 0;
const fixture = createServer((request, response) => {
  if (request.url === '/') fixtureVisits++;
  if (scenario) return scenario.fixture(request, response);
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><meta charset="utf-8"><title>Diagnostic collection fixture</title>
    <style>body { margin:24px; font:16px Arial; background:#d0e5fc; }</style>
    <h1>Diagnostic collection fixture</h1><canvas width="24" height="24"></canvas>
    <script>
      const ctx = document.querySelector('canvas').getContext('2d');
      let frame = 0;
      setInterval(() => {
        ctx.fillStyle = frame++ % 2 ? '#ef512a' : '#0463aa';
        ctx.fillRect(0, 0, 24, 24);
      }, 80);
    </script>`);
});
await new Promise((accept, reject) => {
  fixture.once('error', reject);
  fixture.listen(port + 1, '127.0.0.1', accept);
});

function readArchive(compressed) {
  assert.equal(compressed.subarray(0, 4).toString('hex'), '28b52ffd', 'Expected Zstandard frame');
  const tar = zstdDecompressSync(compressed, { maxOutputLength: 32 * 1024 * 1024 });
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (!header[0]) {
      assert(
        tar.length - offset >= 1024 && tar.subarray(offset).every((byte) => byte === 0),
        'Invalid tar terminator',
      );
      return entries;
    }
    assert.equal(header.subarray(257, 262).toString('ascii'), 'ustar');
    const field = (start, end) => header.subarray(start, end).toString('ascii').split('\0')[0];
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(checksum, Number.parseInt(field(148, 156), 8), 'Invalid tar checksum');
    const name = field(0, 100);
    const size = Number.parseInt(field(124, 136), 8);
    assert(size > 0 && offset + 512 + size <= tar.length && !entries.has(name), 'Invalid tar member');
    const body = tar
      .subarray(offset + 512, offset + 512 + size)
      .toString('utf8')
      .trim();
    entries.set(
      name,
      name.endsWith('.jsonl') ? body.split('\n').map((line) => JSON.parse(line)) : JSON.parse(body),
    );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error('Missing tar terminator');
}
function startControl() {
  const control = spawn(process.execPath, [join(root, 'control/dist/server.mjs')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      PORT: String(port),
      REMOTEKIT_CONTROL_HOST: '127.0.0.1',
      REMOTEKIT_CONTROL_ORIGINS: origin,
      REMOTEKIT_CONTROL_DB: join(run, 'control.db'),
      REMOTEKIT_DIAGNOSTICS: '0',
      REMOTEKIT_DIAGNOSTICS_DIR: archiveDirectory,
      REMOTEKIT_ENDPOINT: resolve(endpoint),
      REMOTEKIT_ENDPOINT_ARGS: JSON.stringify([
        '--browser=' + resolve(browser),
        '--data-path=' + join(run, 'endpoint'),
        ...(scenarioModule?.endpointArgs ?? []),
      ]),
      ...scenarioModule?.controlEnvironment,
    },
  });
  control.stdout.on('data', (data) => void appendFile(join(run, 'control.stdout.log'), data));
  control.stderr.on('data', (data) => void appendFile(join(run, 'control.stderr.log'), data));
  const stopped = new Promise((accept, reject) => {
    control.once('exit', accept);
    control.once('error', reject);
  });
  void stopped.catch(() => {});
  return async () => {
    if (control.connected) control.disconnect();
    await stopped;
  };
}
let stopControl = startControl();

const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(75);
  }
  throw Error(message);
}
let context, page;
const deadline = setTimeout(() => void context?.close().catch(() => {}), 150000);
try {
  await until(async () => {
    const response = await fetch(origin + '/api/auth/registration', {
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined);
    return response?.ok && (await response.json()).hasAdmin === false;
  }, 'Fresh isolated Control did not start');
  context = await chromium.launchPersistentContext(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer),
    headless: process.env.REMOTEKIT_QA_HEADLESS === '1',
    viewport: scenarioModule?.viewport ?? { width: 1152, height: 820 },
    deviceScaleFactor: 1,
    timeout: 15000,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(5000);

  await page.addInitScript(
    ({ receiverAudio }) => {
      const probe = (window.diagnosticQA = { peers: [], channels: [], replies: [], exposedEarly: false });
      const ids = new WeakMap();
      let nextId = 0;
      const id = (value) => {
        if (!value) return null;
        if (!ids.has(value)) ids.set(value, ++nextId);
        return ids.get(value);
      };
      const NativePeer = RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor(...args) {
          super(...args);
          probe.peers.push(this);
        }
        createDataChannel(...args) {
          const channel = super.createDataChannel(...args);
          probe.channels.push(channel);
          return channel;
        }
        addTransceiver(trackOrKind, init) {
          // Experiment-only negotiation isolation; muting a media element does
          // not remove its RTP stream or WebRTC synchronization relationship.
          return super.addTransceiver(
            trackOrKind,
            trackOrKind === 'audio' && receiverAudio === 'inactive'
              ? { ...init, direction: 'inactive' }
              : init,
          );
        }
      };
      const NativeSocket = WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          const methods = new Map();
          this.addEventListener('message', (event) => {
            const reply = JSON.parse(event.data);
            const method = methods.get(reply.id);
            if (!method) return;
            methods.delete(reply.id);
            probe.replies.push({ method, result: reply.result, error: reply.error });
          });
          this.addEventListener('open', () => {
            if (new URL(this.url).pathname === '/api/socket') probe.controlSocket = this;
          });
          this.observeDiagnostic = ({ id, method }) => methods.set(id, method);
        }
        send(data) {
          if (typeof data === 'string' && new URL(this.url).pathname === '/api/socket') {
            const message = JSON.parse(data);
            if (message.method?.startsWith('diagnostics.')) this.observeDiagnostic(message);
            if (message.method === 'diagnostics.sample') probe.latestLayout = message.params?.data?.layout;
          }
          return super.send(data);
        }
      };
      new MutationObserver(() => {
        const started = probe.replies.find((reply) => reply.method === 'diagnostics.start')?.result;
        const complete = probe.replies.some((reply) => reply.result?.status === 'complete');
        if (
          started &&
          !complete &&
          (document.body?.innerText.includes(started.id) ||
            [...document.querySelectorAll('input')].some((input) => input.value === started.id))
        )
          probe.exposedEarly = true;
      }).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['value'],
      });
      probe.media = async () => {
        const peer = probe.peers[0];
        const stats = peer && (await peer.getStats());
        const codecs =
          stats &&
          [...stats.values()]
            .filter(
              (stat) =>
                stat.type === 'inbound-rtp' &&
                (stat.kind || stat.mediaType) === 'video' &&
                stat.framesDecoded > 0,
            )
            .map((stat) => stats.get(stat.codecId)?.mimeType?.toLowerCase());
        return {
          peer: id(peer),
          count: probe.peers.length,
          connected: peer?.connectionState,
          tracks: peer?.getReceivers().map((receiver) => id(receiver.track)),
          transceivers: peer?.getTransceivers().map((transceiver) => ({
            kind: transceiver.receiver.track.kind,
            direction: transceiver.currentDirection,
          })),
          channels: probe.channels.map((channel) => [id(channel), channel.label, channel.readyState]),
          videoReady: [...document.querySelectorAll('.remote-video-plane video')].some(
            (video) => video.videoWidth > 0,
          ),
          codecs,
        };
      };
    },
    { receiverAudio },
  );
  const downloads = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const cdp = await context.newCDPSession(page);
  const read = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      userGesture: false,
      awaitPromise: true,
    });
    assert(!exceptionDetails, exceptionDetails?.exception?.description || exceptionDetails?.text);
    return result.value;
  };
  const click = async (selector, name) => {
    const locate = () =>
      read(`(() => {
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = elements.find(candidate => candidate.getClientRects().length &&
        !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true' &&
        (${JSON.stringify(name ?? null)} === null ||
          (candidate.getAttribute('aria-label') || candidate.textContent.trim()) === ${JSON.stringify(name ?? null)}));
      if (!el) return null;
      el.scrollIntoView({block:'nearest', inline:'nearest'});
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      return el.contains(document.elementFromPoint(x, y)) ? {x, y} : null;
    })()`);
    const point = await until(
      async () => {
        const first = await locate();
        if (!first) return false;
        await sleep(90);
        const settled = await locate();
        return settled && Math.abs(first.x - settled.x) < 1 && Math.abs(first.y - settled.y) < 1 && settled;
      },
      'Missing stable control ' + (name ?? selector),
    );
    await page.mouse.click(point.x, point.y);
  };
  const find = (selector, index = 0) =>
    until(
      () => read(`Boolean(document.querySelectorAll(${JSON.stringify(selector)})[${index}])`),
      'Missing element ' + selector,
    );
  const fill = async (selector, value, index = 0) => {
    await until(async () => {
      const point = await read(`(() => {
        const input = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!input || input.disabled || input.readOnly) return null;
        const box = input.getBoundingClientRect();
        return box.width && {x:box.x + box.width / 2, y:box.y + box.height / 2};
      })()`);
      if (!point) return false;
      await page.mouse.click(point.x, point.y);
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(value);
      return await read(`document.activeElement === document.querySelectorAll(${JSON.stringify(selector)})[${index}] &&
        document.activeElement?.value === ${JSON.stringify(value)}`);
    }, 'Could not fill ' + selector);
  };

  const unlock = async () => {
    await until(
      async () => {
        if (!(await read('Boolean(document.querySelector(".viewer-lock-blank"))'))) return true;
        for (const key of [
          'ArrowUp',
          'ArrowUp',
          'ArrowDown',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'ArrowLeft',
          'ArrowRight',
        ]) {
          await page.keyboard.press(key);
        }
        await sleep(200);
        return !(await read('Boolean(document.querySelector(".viewer-lock-blank"))'));
      },
      'Trusted reveal sequence did not open the authentication panel',
      5000,
    );
  };
  const accountPassword = randomBytes(18).toString('hex');

  await page.goto(origin, { timeout: 12000 });
  await find('.viewer-lock-blank');
  await unlock();
  await click('button', '创建账户');
  await fill('input[autocomplete="username"]', 'diagnostic-qa');
  await fill('input[autocomplete="new-password"]', accountPassword);
  await click('button[type="submit"]', '创建账户');
  await click('button', '新建窗口');

  const media = () => read('diagnosticQA.media()');
  if (scenario) {
    // The scenario deliberately starts on a blank window. Wait for its initial
    // connection and channels before sending the first remote navigation.
    await until(async () => {
      const state = await media();
      return (
        state.connected === 'connected' &&
        state.channels.filter((channel) => channel[2] === 'open').length === 2
      );
    }, 'Scenario could not open its RTC channels');
  }
  await fill('.address-form input', fixtureOrigin);
  await page.keyboard.press('Enter');
  if (scenario) await until(() => fixtureVisits > 0, 'Scenario navigation did not reach the fixture');
  const baseline = await until(async () => {
    const state = await media();
    return (
      state.connected === 'connected' &&
      state.channels.filter((channel) => channel[2] === 'open').length === 2 &&
      fixtureVisits > 0 &&
      state.videoReady &&
      state.codecs?.includes('video/h264') &&
      state
    );
  }, 'No decoded H.264 or open DataChannels');
  assert.equal(baseline.count, 1);
  assert(baseline.tracks.length > 0);
  const sameMedia = async () => {
    const current = await media();
    for (const key of ['peer', 'count', 'connected', 'tracks', 'channels']) {
      assert.deepEqual(current[key], baseline[key], 'Media ' + key + ' changed');
    }
    assert(current.videoReady && current.codecs?.includes('video/h264'));
  };
  await log('h264-ready', baseline);
  await click('button', '更多');
  await click('[role=menuitem]', '设置');
  await until(
    () =>
      read(`[...document.querySelectorAll('button')].some(button =>
    button.getClientRects().length && button.textContent.trim() === '开始诊断')`),
    'Diagnostic setting did not appear',
  );
  await read(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '开始诊断')
    .scrollIntoView({block:'center'})`);
  await page.screenshot({ path: join(run, 'settings.png') });
  await click('button', '开始诊断');
  const start = await until(
    () => read("diagnosticQA.replies.find(reply => reply.method === 'diagnostics.start')?.result"),
    'Missing diagnostics.start reply',
  );
  assert.equal(start.status, 'collecting');
  assert.equal(start.maxDurationMs, 600000);
  assert.match(start.id, /^[0-9a-f-]{36}$/);
  await until(
    () =>
      read(`[...document.querySelectorAll('button')].some(button =>
    button.getClientRects().length &&
    (button.getAttribute('aria-label') || button.textContent.trim()) === '停止数据收集')`),
    'Floating stop action did not appear',
  );
  assert.equal(await read(`document.body.innerText.includes(${JSON.stringify(start.id)})`), false);
  assert.equal(
    await read(
      `[...document.querySelectorAll('input')].some(input => input.value === ${JSON.stringify(start.id)})`,
    ),
    false,
  );
  await sameMedia();
  if (scenario) await scenario.start({ page });
  else await page.screenshot({ path: join(run, 'collecting.png') });
  await until(
    () =>
      read(
        "diagnosticQA.replies.filter(reply => reply.method === 'diagnostics.sample' && reply.result?.status === 'collecting').length >= 4",
      ),
    'Expected four accepted live samples',
  );
  if (scenario) await scenario.measure({ read, log, sleep, page, run });
  const preStop = await readdir(archiveDirectory).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  assert.deepEqual(preStop, [], 'Unexpected archive before stop');
  await click('button', '停止数据收集');
  const complete = await until(
    () => read("diagnosticQA.replies.find(reply => reply.result?.status === 'complete')?.result"),
    'Missing complete reply',
  );
  assert.equal(complete.id, start.id);
  assert.equal(complete.reason, 'user');
  await until(
    () =>
      read(`[...document.querySelectorAll('[role=dialog] input')].some(input =>
    input.value === ${JSON.stringify(complete.id)} && input.readOnly && input.getClientRects().length)`),
    'Completed ID did not appear',
  );
  assert.equal(await read('diagnosticQA.exposedEarly'), false);
  await sameMedia();
  await page.screenshot({ path: join(run, 'complete.png') });

  const ownerDirs = await readdir(archiveDirectory, { withFileTypes: true });
  assert.equal(ownerDirs.length, 1);
  assert(ownerDirs[0].isDirectory());
  const owner = join(archiveDirectory, ownerDirs[0].name);
  assert.deepEqual((await readdir(owner)).sort(), [complete.id + '.reason', complete.id + '.tar.zst']);
  const compressed = await readFile(join(owner, complete.id + '.tar.zst'));
  assert.equal(compressed.length, complete.bytes);
  const entries = readArchive(compressed);
  assert.deepEqual([...entries.keys()].sort(), [
    'client.jsonl',
    'control.jsonl',
    'endpoint.jsonl',
    'events.jsonl',
    'manifest.json',
  ]);
  const manifest = entries.get('manifest.json');
  assert.equal(manifest.id, complete.id);
  assert.equal(manifest.reason, 'user');
  assert.equal(manifest.interrupted, false);
  assert.equal(manifest.limits.maxDurationMs, 600000);
  for (const name of ['client', 'control', 'endpoint', 'events']) {
    assert.equal(manifest.sources[name].records, entries.get(name + '.jsonl').length);
  }
  assert.deepEqual(
    entries.get('events.jsonl').map((row) => row.event),
    ['started', 'stopped'],
  );
  const client = entries.get('client.jsonl').map((row) => row.data);
  const endpointSamples = entries.get('endpoint.jsonl').map((row) => row.data);
  const inbound = client.find(
    (sample) => sample.rtc?.inboundVideo?.framesDecoded > 0 && sample.rtc.inboundVideo.bytesReceived > 0,
  );
  const presentation = client.find(
    (sample) =>
      sample.presentation?.backend === 'video' &&
      sample.media?.media?.width > 0 &&
      sample.media.media.height > 0 &&
      sample.presentation.frames?.some(
        (frame) =>
          frame.presentedFrames > 0 &&
          Number.isFinite(frame.atMs) &&
          Number.isFinite(frame.presentationTimeMs) &&
          Number.isFinite(frame.expectedDisplayTimeMs),
      ),
  );
  const matchedRtpFrames = client.flatMap((sample) =>
    (sample.presentation?.frames ?? []).filter(
      (frame) =>
        Number.isFinite(frame.rtpTimestamp) &&
        Number.isFinite(frame.receiveTimeMs) &&
        sample.presentation.metadata?.some((metadata) => metadata.rtpTimestamp === frame.rtpTimestamp),
    ),
  );
  const sender = endpointSamples.find((sample) =>
    sample.stats?.senderRtcStats?.outbound?.some(
      (stream) => stream.kind === 'video' && stream.packetsSent > 0 && stream.bytesSent > 0,
    ),
  );
  const outputStats = endpointSamples.find(
    (sample) =>
      sample.browserOutputAvailable === true &&
      sample.stats?.encodeCompleted > 0 &&
      Object.keys(sample.browserOutput ?? {}).length > 0,
  );
  await log('archive', {
    bytes: compressed.length,
    manifest,
    clientKeys: Object.keys(client.at(-1)),
    endpointKeys: Object.keys(endpointSamples.at(-1)),
    inboundFrames: inbound?.rtc.inboundVideo.framesDecoded,
    presentationSize: presentation && [presentation.media.media.width, presentation.media.media.height],
    presentationFrames: presentation?.presentation.frames.length,
    matchedRtpFrames: matchedRtpFrames.length,
    firstMatchedRtpFrame: matchedRtpFrames[0],
    outboundPackets: sender?.stats.senderRtcStats.outbound.find((stream) => stream.kind === 'video')
      ?.packetsSent,
    encodeCompleted: outputStats?.stats.encodeCompleted,
    browserOutputKeys: outputStats && Object.keys(outputStats.browserOutput),
    archivePath: join(owner, complete.id + '.tar.zst'),
  });
  assert(inbound, 'No real inbound video counters in client samples');
  assert(presentation, 'No real video presentation sample');
  if (manifest.environment.browserMajorVersion >= 157)
    assert(matchedRtpFrames.length > 0, 'No presented frame with receive time and matching RTP metadata');
  assert(sender, 'No real outbound video counters in Endpoint samples');
  assert(outputStats, 'No Browser output and Endpoint encode stats');
  if (scenario?.validateArchive) await scenario.validateArchive({ client, endpointSamples, log });
  assert.deepEqual(downloads, []);
  if (process.env.REMOTEKIT_QA_DIAGNOSTICS_RESTART === '1') {
    await page.goto('about:blank');
    await stopControl();
    stopControl = startControl();
    await until(async () => {
      const response = await fetch(origin + '/api/auth/registration', {
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined);
      return response?.ok && (await response.json()).hasAdmin === true;
    }, 'Control did not restart with the original account');
    await page.goto(origin, { timeout: 12000 });
    await until(
      () => read('Boolean(document.querySelector(".viewer-shell, .viewer-lock-blank"))'),
      'Viewer did not reattach',
    );
    if (await read('Boolean(document.querySelector(".viewer-lock-blank"))')) {
      await unlock();
      await fill('input[autocomplete="current-password"]', accountPassword);
      await page.keyboard.press('Enter');
    }
    await until(
      () =>
        read(
          'diagnosticQA.controlSocket?.readyState === WebSocket.OPEN && !!document.querySelector(".viewer-shell")',
        ),
      'Viewer did not unlock after restart',
    );
    await read(`diagnosticQA.controlSocket.send(JSON.stringify({
      id:'qa-after-restart', method:'diagnostics.status', params:{id:${JSON.stringify(complete.id)}}
    }))`);
    const reply = await until(
      () => read("diagnosticQA.replies.find(reply => reply.method === 'diagnostics.status')"),
      'No durable diagnostics.status reply after restart',
    );
    assert.deepEqual(reply.result, complete);
    await log('restart', reply.result);
  }
  await log('success', { sameRtcPeerTrackAndChannels: true, downloads, idExposedOnlyAfterComplete: true });
} catch (error) {
  await log('failure', { message: error.message, stack: error.stack });
  const state = await page?.evaluate(() => window.diagnosticQA?.media()).catch(() => undefined);
  if (state) await log('failure-media', state);
  await page?.screenshot({ path: join(run, 'failure.png'), timeout: 3000 }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try {
    await context?.close();
  } finally {
    fixture.closeAllConnections();
    await new Promise((accept) => fixture.close(accept));
    await stopControl();
  }
}
