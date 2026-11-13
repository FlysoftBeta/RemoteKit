import { createCdpInteraction } from './kit/cdp-interaction.mjs';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { startFixture } from './kit/fixtures.mjs';
import { startStack } from './kit/stack.mjs';
import { launchPersistentViewer, registerViewer } from './kit/viewer.mjs';

import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
/**
 * Real H.264 diagnostic-collection regression on an isolated loopback instance.
 * node tests/e2e/test-diagnostic-collection.mjs <playwright module> <viewer exe> <endpoint exe> <remote browser exe> <unused output dir> [port]
 */

import assert from 'node:assert/strict';

const [playwright, viewer, endpoint, browser, output, listenPort = '33785'] = process.argv.slice(2);
assert(
  [playwright, viewer, endpoint, browser, output].every(Boolean),
  'Expected Playwright, Viewer, Endpoint, Browser and output paths',
);

const run = resolve(output);
const port = Number(listenPort);
const origin = 'http://127.0.0.1:' + port;
const fixtureOrigin = 'http://127.0.0.1:' + (port + 1);
await mkdir(run, { recursive: true });
const log = async (stage, value) => {
  await appendFile(join(run, 'diagnostic-collection-results.jsonl'), JSON.stringify({ stage, value }) + '\n');
  console.log(stage);
};
const archiveDirectory = join(run, 'diagnostics');
let fixtureVisits = 0;
// Keep fixture traffic available while Control restarts.
const fixture = await startFixture('test-diagnostic-collection', port + 1, {
  onVisit: () => fixtureVisits++,
});

function readArchive(compressed) {
  assert.equal(compressed.subarray(0, 4).toString('hex'), '28b52ffd', 'Expected Zstandard frame');
  const tar = zstdDecompressSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
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
      name.startsWith('logs/')
        ? body
        : name.endsWith('.jsonl')
          ? body.split('\n').map((line) => JSON.parse(line))
          : JSON.parse(body),
    );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error('Missing tar terminator');
}
const stackOptions = {
  seed: false,
  fixtures: false,
  ports: { control: port + 3, viewer: port, fixture: port + 1, peer: port + 2 },
  run,
  dev: true,
  port,
  endpoint,
  browser,
  configOverrides: {
    storage: { database: join(run, 'control.db'), diagnostics: archiveDirectory },
  },
};
let stack = await startStack(stackOptions);

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
    const response = await fetch(origin + '/api/auth/setup', {
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined);
    return response?.ok && (await response.json()).setupRequired === true;
  }, 'Fresh isolated Control did not start');
  context = await launchPersistentViewer(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer),
    headless: true,
    viewport: { width: 1152, height: 820 },
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
  page.on('pageerror', (error) => void log('client-error', { message: error.message, stack: error.stack }));
  page.setDefaultTimeout(5000);

  await page.addInitScript(() => {
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
        if (this.getTransceivers().length) probe.channels.push(channel);
        return channel;
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
      const peer = probe.peers.find((candidate) => candidate.getTransceivers().length > 0);
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
        count: probe.peers.filter((candidate) => candidate.getTransceivers().length > 0).length,
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
  });
  const downloads = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const cdp = await context.newCDPSession(page);
  const { read, click, find, fill, unlock } = createCdpInteraction({ cdp, page, until, sleep });
  const accountPassword = randomBytes(18).toString('hex');

  await page.goto(origin, { timeout: 12000 });
  await find('.viewer-lock-blank');
  await unlock();
  await registerViewer({ click, fill, username: 'diagnostic-qa', password: accountPassword });
  const startScreen = page.getByRole('dialog', { name: '开始屏幕' });
  if (!(await startScreen.isVisible())) await page.getByRole('button', { name: '开始', exact: true }).click();
  await startScreen
    .locator('[data-tile-key]')
    .filter({ has: page.getByText('浏览器', { exact: true }) })
    .first()
    .click({ timeout: 120000 });

  const media = () => read('diagnosticQA.media()');

  await fill('.address-form input', fixtureOrigin);
  await page.keyboard.press('Enter');

  const baseline = await until(async () => {
    const state = await media();
    return (
      state.connected === 'connected' &&
      state.channels.filter((channel) => channel[2] === 'open').length === 1 &&
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
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await startScreen
    .locator('[data-tile-key]')
    .filter({ has: page.getByText('设置', { exact: true }) })
    .first()
    .click({ timeout: 30000 });
  await click('[role=button]', '诊断');
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
  await page.screenshot({ path: join(run, 'collecting.png') });
  await until(
    () =>
      read(
        "diagnosticQA.replies.filter(reply => reply.method === 'diagnostics.sample' && reply.result?.status === 'collecting').length >= 4",
      ),
    'Expected four accepted live samples',
  );

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
    'logs/browser.log',
    'logs/control.jsonl',
    'logs/endpoint.log',
    'manifest.json',
  ]);
  const manifest = entries.get('manifest.json');
  // Raw logs include history from before the collection started.
  assert.match(entries.get('logs/browser.log'), /RemoteKit startup InitLogging/);
  assert.match(entries.get('logs/browser.log'), /CONSOLE.*diagnostic-fixture-console-marker/);
  assert.match(entries.get('logs/endpoint.log'), /"ev":"browser\.launched"/);
  assert.match(entries.get('logs/control.jsonl'), /"ev":"control\.started"/);
  assert.equal(manifest.logs.browser.exists, true);
  assert.equal(manifest.logs.endpoint.exists, true);
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

  assert.deepEqual(downloads, []);
  await page.goto('about:blank');
  await stack.stop();
  stack = await startStack(stackOptions);
  await until(async () => {
    const response = await fetch(origin + '/api/auth/setup', {
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined);
    return response?.ok && (await response.json()).setupRequired === false;
  }, 'Control did not restart with the original account');
  await page.goto(origin, { timeout: 12000 });
  await until(
    () =>
      read(`Boolean(document.querySelector('.viewer-shell') ||
        (document.querySelector('.viewer-lock-blank') &&
          diagnosticQA.controlSocket?.readyState === WebSocket.OPEN &&
          diagnosticQA.channels.filter(channel => channel.readyState === 'open').length === 1))`),
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
    await stack.stop();
  }
}
