import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startStack, until } from './kit/stack.mjs';
import { launch } from './kit/viewer.mjs';
import { runCleanups } from './kit/cleanup.mjs';
import { matchGeometry } from './geometry-observations.mjs';

const run = resolve(process.env.E2E_RUN ?? 'develop/tmp/codex-1120/measure/baseline');
const count = Number(process.env.GEOMETRY_SAMPLES ?? 30);
const clients = process.env.GEOMETRY_CLIENTS?.split(',') ?? ['source'];
const rounds = Number(process.env.GEOMETRY_ROUNDS ?? 1);
let variant = clients[0];
mkdirSync(run, { recursive: true });
const events = [];
const samples = [];
let stack;
let viewer;
const fixture = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const event = JSON.parse(body);
    events.push(event);
    appendFileSync(join(run, 'fixture.jsonl'), JSON.stringify(event) + '\n');
    return res.end('ok');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(readFileSync(new URL('./fixtures/geometry-latency.html', import.meta.url)));
});
await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;

function instrumentation() {
  const q = (window.geometryQA = {
    wire: [],
    frames: [],
    inputs: [],
    stats: [],
    costs: [],
    scheduling: [],
    errors: [],
    peers: [],
    active: false,
    start: 0,
  });
  window.addEventListener('unhandledrejection', (event) => {
    const error = String(event.reason?.stack ?? event.reason);
    q.errors.push({ at: performance.now(), error });
    console.error('QA rejection ' + error);
  });
  let previousRaf = performance.now();
  function tick(at) {
    q.scheduling.push({
      at: performance.now(),
      interval: at - previousRaf,
      visibility: document.visibilityState,
      focus: document.hasFocus(),
    });
    previousRaf = at;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  for (const event of ['visibilitychange', 'focus', 'blur'])
    window.addEventListener(event, () =>
      q.scheduling.push({
        at: performance.now(),
        event,
        visibility: document.visibilityState,
        focus: document.hasFocus(),
      }),
    );
  const record = (transport, direction, raw) => {
    try {
      const message = JSON.parse(raw);
      q.wire.push({ at: performance.now(), transport, direction, message });
    } catch {}
  };
  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (raw) {
    record('ws', 'out', raw);
    return nativeSend.call(this, raw);
  };
  const nativeChannel = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    if (!q.peers.includes(this)) q.peers.push(this);
    const channel = nativeChannel.apply(this, args);
    const send = channel.send.bind(channel);
    channel.send = (raw) => {
      record('dc', 'out', raw);
      return send(raw);
    };
    channel.addEventListener('message', (e) => record('dc', 'in', e.data));
    return channel;
  };
  q.inspect = (at = performance.now()) => {
    if (!q.active) return;
    const state = window.__remotekitTest?.geometry.inspect();
    if (!state) return;
    const value = JSON.stringify(state.input);
    if (q.lastInput !== value) {
      q.lastInput = value;
      q.inputs.push({ at, input: state.input });
    }
    return state;
  };
  const nativeFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    return nativeFrame.call(this, (now, metadata) => {
      callback(now, metadata);
      if (!q.active) return;
      const state = q.inspect();
      const viewId = this.closest('.remote-viewport')?.dataset.viewId;
      q.frames.push({
        at: performance.now(),
        expectedDisplayTime: metadata.expectedDisplayTime,
        presentationTime: metadata.presentationTime,
        receiveTime: metadata.receiveTime,
        processingDuration: metadata.processingDuration,
        rtp: metadata.rtpTimestamp,
        viewId,
        layout: state?.snapshot?.layout,
        width: this.videoWidth,
        height: this.videoHeight,
      });
    });
  };
  window.addEventListener('remotekit-test-input', (event) => q.inspect(event.detail.at));
  setInterval(async () => {
    if (!q.active) return;
    const stats = await Promise.all(q.peers.map((peer) => peer.getStats()));
    q.stats.push({
      at: performance.now(),
      reports: stats.flatMap((s) =>
        [...s.values()].filter(
          (r) =>
            r.type === 'inbound-rtp' &&
            (r.kind === 'video' || r.mediaType === 'video' || r.framesDecoded !== undefined),
        ),
      ),
    });
  }, 100);
  for (const [prototype, name] of [
    [CanvasRenderingContext2D.prototype, 'drawImage'],
    [HTMLCanvasElement.prototype, 'toDataURL'],
  ]) {
    const native = prototype[name];
    prototype[name] = function (...args) {
      const start = performance.now();
      const result = native.apply(this, args);
      if (q.active) q.costs.push({ at: start, name, duration: performance.now() - start });
      return result;
    };
  }
  q.begin = (kind) => {
    q.kind = kind;
    q.marked = false;
    q.start = performance.now();
    q.active = true;
    q.lastInput = null;
    q.inspect();
  };
  const mark = (kind) => {
    if (!q.active || q.kind !== kind || q.marked) return;
    q.start = performance.now();
    q.marked = true;
  };
  document.addEventListener('pointerup', () => mark('split'), true);
  document.addEventListener(
    'click',
    () => {
      mark('group');
      mark('narrow-window');
    },
    true,
  );
  window.addEventListener('resize', () => mark('resize'), true);
  q.result = () => {
    const requests = q.wire.filter((e) => e.at >= q.start && e.message.method === 'viewport');
    const request = requests.at(-1);
    if (!request) return;
    const state = window.__remotekitTest.state();
    const views = request.message.params.windows
      .filter((w) => w.visible)
      .map((window) => {
        const win = state.workspace.windows.find((w) => w.id === window.windowId);
        const tab = state.workspace.tabs.find((t) => t.id === win?.activeTabId);
        return { viewId: tab?.webviewId, window };
      });
    return window.matchGeometry(q, { start: q.start, request, views });
  };
}

try {
  stack = await startStack({
    run: join(run, 'stack'),
    browserBuild: 'dev',
    dev: clients[0] === 'source',
    endpoint: resolve(process.env.GEOMETRY_ENDPOINT ?? 'build/endpoint/endpoint/endpoint_service.exe'),
    fixtures: false,
  });
  console.log('Stack ready ' + stack.origin);
  viewer = await launch({
    stack,
    dpr: 1,
    out: join(run, 'shots'),
    initialAuth: false,
    browserOptions: {
      channel: undefined,
      executablePath: resolve('develop/tmp/codex-1120/measure/chrome/chrome-win64/chrome.exe'),
      headless: false,
      args: [
        '--enable-automation',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--window-position=0,0',
        '--window-size=1400,1060',
      ],
    },
  });
  const { page, context } = viewer;
  console.log('Chrome ready');
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('Viewer console: ' + message.text());
  });
  page.on('requestfailed', (request) => console.log('Viewer request failed: ' + request.url() + ' ' + request.failure()?.errorText));
  page.on('websocket', (socket) => {
    console.log('Viewer WebSocket: ' + socket.url());
    socket.on('socketerror', (error) => console.log('Viewer WebSocket error: ' + error));
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  for (const event of ['webSocketCreated', 'webSocketWillSendHandshakeRequest', 'webSocketHandshakeResponseReceived', 'webSocketFrameError'])
    cdp.on('Network.' + event, (detail) => appendFileSync(join(run, 'socket-boot.jsonl'), JSON.stringify({ event, detail }) + '\n'));
  const browserCdp = await viewer.browser.newBrowserCDPSession();
  await page.bringToFront();
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  const browserProcess = processInfo.find((entry) => entry.type === 'browser').id;
  async function setViewport(size) {
    await page.setViewportSize(size);
    const window = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId: window.windowId,
      bounds: { left: 0, top: 0, width: 1300, height: 780, windowState: 'normal' },
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...size, mobile: false, deviceScaleFactor: 1, scale: .65,
    });
  }
  function nativeWindow() {
    return JSON.parse(execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', resolve('develop/tmp/codex-1120/measure/window-state.ps1'),
      '-BrowserProcess', String(browserProcess),
    ], { encoding: 'utf8', windowsHide: true }));
  }
  await setViewport({ width: 1280, height: 960 });
  writeFileSync(
    join(run, 'browser.json'),
    JSON.stringify(
      {
        version: await browserCdp.send('Browser.getVersion'),
        command: await browserCdp.send('Browser.getBrowserCommandLine'),
      },
      null,
      2,
    ),
  );
  if (clients[0] !== 'source') {
    const serve = async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== stack.origin || (url.pathname !== '/' && !url.pathname.startsWith('/assets/')))
        return route.continue();
      const path = join(
        resolve('develop/tmp/codex-1120/measure/clients', variant),
        url.pathname === '/' ? 'index.html' : url.pathname,
      );
      const type =
        { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[
          extname(path)
        ] ?? 'application/octet-stream';
      await route.fulfill({ body: readFileSync(path), contentType: type });
    };
    await page.route(stack.origin + '/', serve);
    await page.route(stack.origin + '/assets/**', serve);
  }
  await context.addInitScript({ content: 'window.matchGeometry = ' + matchGeometry.toString() });
  await context.addInitScript(instrumentation);
  const login = await page.request.post(stack.origin + '/api/auth/login', {
    data: { username: stack.username, password: stack.password },
    headers: { Origin: stack.origin },
  });
  assert(login.ok(), 'login');
  console.log('Login ready');
  await page.goto(stack.origin, { waitUntil: 'domcontentloaded' });
  console.log('Document ready');
  await page.waitForFunction(() => window.__remotekitTest?.geometry);
  console.log('Hooks ready');
  console.log('Identity ' + JSON.stringify(await page.evaluate(async () => ({
    me: await fetch('/api/auth/me').then(async (r) => ({ status: r.status, data: await r.json() })),
    text: document.body.innerText,
    visibility: document.visibilityState,
  }))));
  await viewer.unlock();
  console.log('Viewer unlocked');
  const action = (command) => page.evaluate((command) => window.__remotekitTest.action(command), command);
  async function open(url, placement) {
    const windowId = randomUUID();
    await action({
      type: 'window.open',
      appId: 'browser',
      windowId,
      tabId: randomUUID(),
      spaceId: randomUUID(),
      url,
      placement,
    });
    await page.waitForFunction(
      ({ windowId, url }) => {
        const state = window.__remotekitTest.state();
        const win = state?.workspace.windows.find((w) => w.id === windowId);
        const tab = state?.workspace.tabs.find((t) => t.id === win?.activeTabId);
        return tab?.url === url && tab.kind === 'remote' && !tab.loading;
      },
      { windowId, url },
    );
    return windowId;
  }
  async function ready() {
    await page.waitForFunction(
      () => {
        const s = window.__remotekitTest.geometry.inspect();
        return (
          s.snapshot?.layout?.views.length &&
          Object.values(s.input).every(Boolean) &&
          !document.querySelector('.resize-waiting')
        );
      },
      undefined,
      { timeout: 30000 },
    );
    await page.waitForTimeout(250);
  }
  async function validate(label) {
    console.log('Validate ' + label);
    await ready();
    const pixelsHandle = await page.waitForFunction(() => {
      const s = window.__remotekitTest.geometry.inspect();
      const pixels = [...document.querySelectorAll('.remote-viewport')].flatMap((node) => {
        if (node.getBoundingClientRect().width <= 0) return [];
        const video = node.querySelector('video');
        const view = s.snapshot.layout.views.find((v) => v.id === node.dataset.viewId);
        if (!video || !view) return [];
        const authority = s.input[view.id];
        if (!authority) return [{ waiting: true }];
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const scale = view.deviceScaleFactor * (view.mediaScaleY ?? view.mediaScale ?? 1);
        const h = authority.pageHeight ?? view.height / scale;
        const pixel = (x, y) => {
          ctx.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        };
        return [
          {
            viewId: view.id,
            footer: pixel(view.x + view.width / 2, view.y + (h - 6) * scale),
            right: pixel(view.x + view.width - 2, view.y + 160 * scale),
            blank:
              h < view.height / scale - 2 ? pixel(view.x + view.width / 2, view.y + view.height - 12) : null,
          },
        ];
      });
      return pixels.length && !pixels.some((p) => p.waiting) ? pixels : null;
    });
    const pixels = await pixelsHandle.jsonValue();
    await pixelsHandle.dispose();
    for (const p of pixels) {
      assert(
        p.footer[0] > 170 && p.footer[1] < 70 && p.footer[2] > 120,
        `${label}: footer ${JSON.stringify(p)}`,
      );
      assert(p.right[1] > 150 && p.right[0] < 90, `${label}: right edge`);
      if (p.blank)
        assert(
          p.blank.slice(0, 3).every((v) => v > 235),
          `${label}: blank band`,
        );
    }
    const nodes = page.locator('.remote-viewport');
    for (let index = 0; index < (await nodes.count()); index++) {
      const box = await nodes.nth(index).boundingBox();
      if (!box?.width) continue;
      const before = events.length;
      await page.mouse.click(box.x + 100, box.y + 160);
      await until(
        () => events.slice(before).some((event) => event.type === 'pointer'),
        `${label}: remote pointer delivery`,
        5000,
      );
      const event = events.slice(before).find((e) => e.type === 'pointer');
      assert(
        event && Math.abs(event.x - 100) <= 1 && Math.abs(event.y - 160) <= 1,
        `${label}: input coordinates ${JSON.stringify(event)}`,
      );
    }
    await viewer.shot(label);
    if (label.startsWith('dynamic')) {
      const motion = await page.evaluate(async () => {
        const video = [...document.querySelectorAll('.remote-viewport')]
          .find((n) => n.getBoundingClientRect().width > 0)
          .querySelector('video');
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const next = () =>
          new Promise((done) =>
            video.requestVideoFrameCallback(() => {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let hash = 0;
              for (let i = 0; i < pixels.length; i++) hash = (Math.imul(hash, 31) + pixels[i]) | 0;
              done(hash);
            }),
          );
        return Promise.race([
          (async () => [await next(), await next(), await next()])(),
          new Promise((_, reject) => setTimeout(() => reject(Error('animation frozen')), 3000)),
        ]);
      });
      assert(new Set(motion).size > 1, `${label}: animation frozen`);
    }
    appendFileSync(join(run, 'functional.jsonl'), JSON.stringify({ label, pixels, ok: true }) + '\n');
  }
  async function measure(name, mode, perform) {
    console.log('Measure ' + mode + '/' + name);
    await page.bringToFront();
    const window = await cdp.send('Browser.getWindowForTarget');
    assert.equal(window.bounds.windowState, 'normal', 'measurement window is not minimized');
    await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus());
    await page.evaluate((name) => geometryQA.begin(name), name);
    await perform();
    await page.waitForFunction(() => geometryQA.result(), undefined, { timeout: 15000, polling: 10 });
    const result = await page.evaluate(() => {
      const result = geometryQA.result();
      const scheduling = geometryQA.scheduling.filter((entry) => entry.at >= geometryQA.start);
      geometryQA.active = false;
      return {
        ...result,
        scheduling,
        timeOrigin: performance.timeOrigin,
        visibility: document.visibilityState,
        focus: document.hasFocus(),
      };
    });
    const sample = {
      name,
      mode,
      variant,
      window,
      ...result,
      totalMs: result.end - result.start,
      inputMs: result.inputAt - result.start,
    };
    const intervals = result.scheduling.map((entry) => entry.interval).filter(Number.isFinite);
    sample.rafMaxMs = Math.max(0, ...intervals);
    sample.throttled =
      result.visibility !== 'visible' ||
      !result.focus ||
      result.scheduling.some((entry) => entry.visibility !== 'visible' || !entry.focus) ||
      sample.rafMaxMs > 100;
    samples.push(sample);
    appendFileSync(join(run, 'samples.jsonl'), JSON.stringify(sample) + '\n');
    await page.waitForTimeout(180);
    return sample;
  }
  for (let round = 0; round < rounds; round++)
    for (const client of round % 2 ? [...clients].reverse() : clients) {
      variant = client;
      if (clients[0] !== 'source') {
        if (round || client !== clients[0]) {
          const raw = await page.evaluate(() => ({ ...geometryQA, timeOrigin: performance.timeOrigin }));
          writeFileSync(join(run, `viewer-${round}-${client}-previous.json`), JSON.stringify(raw));
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => window.__remotekitTest?.geometry);
          await viewer.unlock();
        }
      }
      for (const mode of ['static', 'dynamic']) {
    await setViewport({ width: 1280, height: 960 });
        const url = `${fixtureOrigin}/${mode}`;
        const first = await open(url, { mode: 'space' });
        await ready();
    await page.bringToFront();
    appendFileSync(join(run, 'native-windows.jsonl'), JSON.stringify({ variant, mode, ...nativeWindow() }) + '\n');
        await validate(`${mode}-initial`);
        const keyboard = async (bottom) =>
          page.evaluate((bottom) => {
            const editor = document.querySelector('.remote-viewport .remote-input');
            editor.inputMode = 'text';
            editor.focus();
            geometryQA.start = performance.now();
            window.__remotekitTest.geometry.occlude(bottom);
          }, bottom);
        await measure('keyboard-open', mode, () => keyboard(300));
        await validate(`${mode}-keyboard-open`);
        await measure('keyboard-close', mode, () => keyboard(0));
        await validate(`${mode}-keyboard-close`);
        for (let i = 1; i < count; i++) {
          await measure('keyboard-open', mode, () => keyboard(300));
          await measure('keyboard-close', mode, () => keyboard(0));
        }
        for (let i = 0; i < count; i++)
          await measure('resize', mode, () =>
        setViewport({ width: i % 2 ? 1280 : 1160, height: i % 2 ? 960 : 880 }),
          );
        await validate(`${mode}-resize`);
        const second = await open(url, { mode: 'split', besideWindowId: first, side: 'right' });
        await ready();
        for (let i = 0; i < count; i++) {
          const divider = await page.getByRole('separator', { name: '调整分屏比例' }).boundingBox();
          await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
          await page.mouse.down();
          await page.mouse.move(i % 2 ? 640 : 500, divider.y + divider.height / 2, { steps: 5 });
          await measure('split', mode, () => page.mouse.up());
        }
        await validate(`${mode}-split`);
        const state = await page.evaluate(() => window.__remotekitTest.state());
        const firstSpace = state.workspace.activeSpaceId;
        await open(url, { mode: 'space' });
        await ready();
        const secondSpace = (await page.evaluate(() => window.__remotekitTest.state())).workspace
          .activeSpaceId;
        for (let i = 0; i < count; i++) {
          await viewer.openStart();
          await measure('group', mode, () =>
            page.locator(`[data-space-card="${i % 2 ? secondSpace : firstSpace}"]`).click(),
          );
        }
        await validate(`${mode}-group`);
        await action({ type: 'space.activate', spaceId: firstSpace });
    await setViewport({ width: 600, height: 960 });
        await ready();
        for (let i = 0; i < count; i++) {
          const current = await page.evaluate(() => window.__remotekitTest.state());
          const focused = current.workspace.spaces.find((s) => s.id === firstSpace).focusedWindowId;
          const windowId = focused === first ? second : first;
          const space = current.workspace.spaces.find((s) => s.id === firstSpace);
          await measure('narrow-window', mode, () =>
            page.locator('.narrow-window-switcher button').nth(space.windowIds.indexOf(windowId)).click(),
          );
        }
        await validate(`${mode}-narrow`);
        await viewer.assertNoBrowserRestart();
        for (const space of (await page.evaluate(() => window.__remotekitTest.state())).workspace.spaces)
          await action({ type: 'space.close', spaceIds: [space.id] });
        console.log(`Completed ${mode}: ${samples.length} samples`);
      }
    }
} catch (error) {
  writeFileSync(join(run, 'failure.txt'), String(error.stack ?? error));
  if (viewer) {
    await viewer.shot('failure').catch(() => {});
    writeFileSync(join(run, 'failure-dom.html'), await viewer.page.content().catch(() => ''));
  }
  throw error;
} finally {
  if (viewer) {
    const raw = await viewer.page
      .evaluate(() => ({
        ...geometryQA,
        inspection: window.__remotekitTest.geometry.inspect(),
        timeOrigin: performance.timeOrigin,
      }))
      .catch(() => null);
    writeFileSync(join(run, 'viewer.json'), JSON.stringify(raw));
  }
  await runCleanups([
    () => viewer?.close(),
    () => stack?.stop(),
    () => new Promise((done) => fixture.close(done)),
  ]);
}
