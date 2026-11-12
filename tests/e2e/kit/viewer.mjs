import { launchTestBrowser } from './browser.mjs';
import { cameraFixtures } from './fixtures.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runPath, startStack, until } from './stack.mjs';

export { until } from './stack.mjs';

export function cliOptions() {
  const { values } = parseArgs({
    options: {
      browser: { type: 'string', default: 'edge' },
      dpr: { type: 'string', default: '1' },
      pointer: { type: 'string', default: 'mouse' },
      out: { type: 'string' },
      'browser-path': { type: 'string' },
      port: { type: 'string' },
      viewport: { type: 'string' },
    },
  });
  if (!['edge', 'chrome89'].includes(values.browser)) throw Error('Expected --browser edge|chrome89');
  if (!['mouse', 'touch'].includes(values.pointer)) throw Error('Expected --pointer mouse|touch');
  if (!(Number(values.dpr) > 0)) throw Error('Expected positive --dpr');
  return { ...values, dpr: Number(values.dpr) };
}

export async function launch({
  browser: browserName = process.env.E2E_BROWSER ?? 'edge',
  dpr = Number(process.env.E2E_DPR ?? 1),
  pointer: pointerType = process.env.E2E_POINTER ?? 'mouse',
  out,
  stack,
  initialAuth = true,
} = {}) {
  out = resolve(out ?? join(stack.run, 'shots'));
  mkdirSync(out, { recursive: true });
  const chrome89 = browserName === 'chrome89';
  const touch = pointerType === 'touch';
  const browser = await launchBrowser(
    chrome89
      ? { executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: true }
      : { channel: 'msedge', headless: true },
  );
  const context = await createViewerContext(browser, {
    viewport: parseViewport(process.env.E2E_VIEWPORT) ?? { width: 1600, height: 1000 },
    deviceScaleFactor: dpr,
    hasTouch: touch,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  // Playwright's mouse drags call Input.setInterceptDrags, which Chrome 89 lacks.
  const cdp = touch || chrome89 ? await context.newCDPSession(page) : undefined;
  const mouseEvent = (type) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: type === 'mouseMoved' && !at.down ? 'none' : 'left',
      buttons: at.down ? 1 : 0,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  const at = { x: 0, y: 0, down: false };
  const touchEvent = (type) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: at.x, y: at.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });
  // Mouse, or one touch point that moves like the mouse; touch long-press waits before the first move.
  const pointer = {
    async move(x, y, { steps = 1 } = {}) {
      if (!touch && !chrome89) return page.mouse.move(x, y, { steps });
      const from = { ...at };
      for (let index = 1; index <= steps; index++) {
        at.x = from.x + ((x - from.x) * index) / steps;
        at.y = from.y + ((y - from.y) * index) / steps;
        if (!touch) await mouseEvent('mouseMoved');
        else if (at.down) await touchEvent('touchMove');
      }
    },
    async down() {
      if (!touch && !chrome89) return page.mouse.down();
      at.down = true;
      await (touch ? touchEvent('touchStart') : mouseEvent('mousePressed'));
    },
    async up() {
      if (!touch && !chrome89) return page.mouse.up();
      if (!at.down) return;
      at.down = false;
      await (touch ? touchEvent('touchEnd') : mouseEvent('mouseReleased'));
    },
  };

  const errors = [];
  const uploads = [];
  const viewports = [];
  const log = [];
  let state;
  let logOffset = 0;
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      try {
        const data = JSON.parse(String(frame.payload));
        if (data.method === 'page.preview') uploads.push(data.params);
        if (data.method === 'viewport') viewports.push(data.params);
      } catch {}
    });
  });
  const refresh = async () => {
    state = await page.evaluate(() => window.__remotekitTest.state());
    return state;
  };
  const wait = (check, label, timeout) =>
    until(
      async () => {
        await refresh();
        return check();
      },
      label,
      timeout,
    );
  const startDialog = () => page.getByRole('dialog', { name: '开始屏幕' });
  const tile = (name) =>
    startDialog()
      .locator('[data-tile-key]')
      .filter({ has: page.getByText(name, { exact: true }) })
      .first();
  const shot = (name) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw Error('Screenshot name must be a filename stem');
    return page.screenshot({ path: join(out, name + '.png') });
  };
  async function openStart() {
    if (await startDialog().isVisible()) {
      await page.locator('.launcher.overlay-exiting').waitFor({ state: 'hidden' });
      if (await startDialog().isVisible()) return;
    }
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await startDialog().waitFor();
    await page.waitForTimeout(400);
  }
  async function closeStart() {
    await page.getByRole('button', { name: '关闭开始屏幕', exact: true }).click();
    await startDialog().waitFor({ state: 'hidden' });
  }
  async function navigate(url) {
    const address = page.getByRole('textbox', { name: '搜索或输入网址', exact: true }).first();
    await address.fill(url);
    await address.press('Enter');
    await wait(
      () => state.workspace.tabs.some((tab) => tab.url === url && !tab.loading),
      'navigation ' + url,
    );
  }
  const endpointLog = () => readFileSync(stack.logs.endpoint, 'utf8');
  async function assertNoBrowserRestart() {
    const added = endpointLog().slice(logOffset);
    if (added.includes('browser replacement reason=process_exited'))
      throw Error('Browser process exited: ' + stack.logs.endpoint);
  }
  async function step(name, run) {
    logOffset = endpointLog().length;
    try {
      await refresh();
      await run();
      log.push('ok   ' + name);
    } catch (error) {
      log.push('FAIL ' + name + ': ' + String(error).split('\n')[0]);
      writeFileSync(join(out, 'fail-' + name + '.txt'), String(error.stack ?? error));
      await shot('fail-' + name).catch(() => {});
      await pointer.up().catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      process.exitCode = 1;
    }
    console.log(log.at(-1));
    writeFileSync(join(out, 'log.json'), JSON.stringify({ log, errors }, null, 2));
  }
  const waitUnlocked = () => page.getByRole('button', { name: '开始', exact: true }).waitFor();
  async function authenticate() {
    await page.getByRole('heading', { name: '解锁', exact: true }).waitFor();
    await page.getByLabel(/^账户密码/).fill(stack.password);
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await waitUnlocked();
    await wait(() => state, 'unlocked product state');
  }
  const sequence = ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'];
  async function unlockByKeys() {
    for (const direction of sequence) await page.keyboard.press('Arrow' + direction);
    await authenticate();
  }
  async function unlockByTaps() {
    const { width, height } = page.viewportSize();
    // lockDirection normalizes around (0.5, 0.5), chooses the dominant axis,
    // and excludes the central 10% square. These are the four region centres.
    const centres = { Up: [0.5, 0.25], Down: [0.5, 0.75], Left: [0.25, 0.5], Right: [0.75, 0.5] };
    for (const direction of sequence) {
      const [x, y] = centres[direction];
      await pointer.move(x * width, y * height);
      await pointer.down();
      await pointer.up();
    }
    await authenticate();
  }
  async function lock() {
    await openStart();
    await page.getByRole('button', { name: '锁定', exact: true }).click();
    await page.getByRole('button', { name: '开始', exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.viewer-lock-blank').waitFor();
    await page.waitForTimeout(400);
  }
  async function unlock() {
    if (await page.getByRole('button', { name: '开始', exact: true }).isVisible()) return;
    await page.locator('.viewer-lock-blank').waitFor();
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__remotekitTest.unlock());
    await authenticate();
  }
  try {
    if (initialAuth) {
      const response = await page.request.post(stack.origin + '/api/auth/login', {
        data: { username: stack.username, password: stack.password },
        headers: { Origin: stack.origin },
      });
      if (!response.ok()) throw Error('Login failed: ' + (await response.text()));
      await page.goto(stack.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__remotekitTest);
      await unlock();
      await wait(() => state, 'product state');
    }
  } catch (error) {
    await shot('fail-launch').catch(() => {});
    writeFileSync(
      join(out, 'fail-launch.json'),
      JSON.stringify(
        {
          errors,
          page: await page.evaluate(() => ({
            text: document.body.innerText,
            html: document.querySelector('#root')?.innerHTML,
            state: window.__remotekitTest?.state(),
          })),
        },
        null,
        2,
      ),
    );
    writeFileSync(join(out, 'fail-launch.txt'), String(error.stack ?? error));
    await browser.close();
    throw error;
  }
  return {
    browser,
    context,
    page,
    pointer,
    touch,
    errors,
    uploads,
    viewports,
    log,
    out,
    get state() {
      return state;
    },
    refresh,
    until: wait,
    step,
    shot,
    openStart,
    closeStart,
    tile,
    navigate,
    lock,
    unlock,
    unlockByKeys,
    unlockByTaps,
    waitUnlocked,
    assertNoBrowserRestart,
    async close() {
      writeFileSync(join(out, 'log.json'), JSON.stringify({ log, errors }, null, 2));
      if (errors.length || log.some((line) => line.startsWith('FAIL'))) process.exitCode = 1;
      await browser.close();
    },
  };
}

export async function runScenario(name, run) {
  const options = cliOptions();
  const runRoot = resolve(options.out ?? runPath(name));
  const stack = await startStack({
    scenario: name,
    browser: options['browser-path'],
    port: options.port,
    run: join(runRoot, 'stack'),
  });
  if (options.viewport) process.env.E2E_VIEWPORT = options.viewport;
  options.out = join(runRoot, 'shots');
  console.log('RUN ' + stack.run);
  let viewer;
  try {
    viewer = await launch({ ...options, stack });
    console.log('SHOTS ' + viewer.out);
    await run(viewer, stack);
  } finally {
    await viewer?.close();
    await stack.stop();
  }
}

export async function instrumentViewer(context, evidence, name) {
  await context.addInitScript(() => {
    const qa = (window.clusterQA = {
      peers: [],
      pending: new Map(),
      channels: [],
      fileWire: [],
      authFrames: 0,
      authGrants: 0,
    });
    const receive = ({ data }) => {
      if (typeof data !== 'string') return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type === 'state') qa.state = message.state;
      if (message.type === 'layout') qa.layout = message;
      if (message.type === 'library') qa.library = message.snapshot;
      if (message.type === 'auth') qa.auth = message.auth;
      if (message.type === 'files.result') {
        const { data, ...result } = message.result ?? {};
        qa.fileWire.push({
          at: performance.now(),
          direction: 'in',
          ...message,
          result: { ...result, ...(data ? { dataBytes: data.length } : {}) },
        });
      }
      qa.pending.get(message.id ?? message.requestId)?.(message);
    };
    window.WebSocket = class extends WebSocket {
      constructor(...args) {
        super(...args);
        qa.socket = this;
        this.addEventListener('message', receive);
      }
    };
    window.RTCPeerConnection = class extends RTCPeerConnection {
      constructor(...args) {
        super(...args);
        qa.peers.push(this);
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        const send = channel.send.bind(channel);
        channel.send = (raw) => {
          if (typeof raw === 'string') {
            const message = JSON.parse(raw);
            if (message.type === 'files.request') {
              const { data, ...params } = message.params;
              qa.fileWire.push({
                at: performance.now(),
                direction: 'out',
                ...message,
                params: { ...params, ...(data ? { dataBytes: data.length } : {}) },
              });
            }
          }
          return send(raw);
        };
        qa.channels.push(channel);
        if (channel.label === 'remotekit') {
          const role = this.getTransceivers().length ? 'browser' : 'service';
          qa[role] = { peer: this, channel };
          if (role === 'browser') qa.channel = channel;
        }
        channel.addEventListener('message', receive);
        if (channel.label === 'remotekit-auth') {
          const send = channel.send.bind(channel);
          channel.send = (bytes) => {
            if (bytes instanceof ArrayBuffer && bytes.byteLength >= 68) {
              const header = new DataView(bytes);
              if (header.getUint32(20, true) + bytes.byteLength - 68 === header.getUint32(24, true))
                qa.authFrames++;
            }
            return send(bytes);
          };
          channel.addEventListener('message', ({ data }) => {
            if (typeof data === 'string' && JSON.parse(data).type === 'auth.camera.frame') qa.authGrants++;
          });
        }
        return channel;
      }
    };
    qa.call = (method, params, rtc, id) =>
      new Promise((done, reject) => {
        const timer = setTimeout(() => {
          qa.pending.delete(id);
          reject(Error('Viewer RPC timeout: ' + method));
        }, 20000);
        qa.pending.set(id, (message) => {
          clearTimeout(timer);
          qa.pending.delete(id);
          done(message);
        });
        const message = rtc
          ? {
              type: 'files.request',
              version: 1,
              requestId: id,
              method,
              params,
              authEpoch: method.startsWith('selection.') ? qa.auth.peerEpoch : qa.auth.serviceEpoch,
            }
          : { id, method, params };
        (rtc ? qa[method.startsWith('selection.') ? 'browser' : 'service'].channel : qa.socket).send(
          JSON.stringify(message),
        );
      });
  });
  const page = await context.newPage();
  page.on(
    'console',
    (message) =>
      void appendFile(
        join(evidence, name + '-console.jsonl'),
        JSON.stringify({ type: message.type(), text: message.text() }) + '\n',
      ),
  );
  page.on(
    'pageerror',
    (error) =>
      void appendFile(join(evidence, name + '-console.jsonl'), JSON.stringify({ error: error.stack }) + '\n'),
  );
  const call = async (method, params = {}, rtc = false) => {
    if (rtc)
      await page.waitForFunction((selection) => {
        const role = selection ? 'browser' : 'service';
        const epoch = selection ? clusterQA.auth?.peerEpoch : clusterQA.auth?.serviceEpoch;
        return clusterQA[role]?.channel.readyState === 'open' && epoch > 0;
      }, method.startsWith('selection.'));
    const reply = await page.evaluate(
      ({ method, params, rtc, id }) => clusterQA.call(method, params, rtc, id),
      { method, params, rtc, id: randomUUID() },
    );
    assert(
      !reply.error && reply.ok !== false && Object.hasOwn(reply, 'result'),
      method + ': ' + JSON.stringify(reply),
    );
    return reply.result;
  };
  return {
    context,
    page,
    call,
    state: () => page.evaluate(() => clusterQA.state),
    async action(action) {
      const operationId = randomUUID();
      const { operationGeneration } = await this.state();
      const receipt = await call('operation.submit', { operationId, operationGeneration, action });
      assert(receipt.status !== 'failed', JSON.stringify(receipt));
      if (receipt.status === 'committed') return;
      await until(async () => {
        const receipt = await call('operation.status', { operationId, operationGeneration });
        assert(receipt.status !== 'failed', JSON.stringify(receipt));
        return receipt.status === 'committed';
      }, 'action ' + action.type);
    },
    async ready(timeout = 45000) {
      await page.waitForFunction(
        () =>
          clusterQA.socket?.readyState === WebSocket.OPEN &&
          clusterQA.state &&
          clusterQA.auth?.locked === false,
        undefined,
        { timeout },
      );
    },
    service: () =>
      page.waitForFunction(
        () => clusterQA.service?.channel.readyState === 'open' && clusterQA.auth?.serviceEpoch > 0,
      ),
    async media() {
      if (!(await page.evaluate(() => document.hasFocus()))) await page.bringToFront();
      await page.waitForFunction(() => document.hasFocus());
      return until(
        () =>
          page.evaluate(async () => {
            const peer = clusterQA.browser?.peer;
            if (peer?.connectionState !== 'connected') return false;
            const stats = await peer.getStats();
            const video = [...stats.values()].find(
              (s) => s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > 0,
            );
            return (
              video &&
              /h264/i.test(stats.get(video.codecId)?.mimeType) && {
                framesDecoded: video.framesDecoded,
                codec: stats.get(video.codecId).mimeType,
                stats: [...stats.values()],
              }
            );
          }),
        'H264 decoded',
      );
    },
  };
}

export async function registerViewer({ click, fill, username, password }) {
  await fill('input[autocomplete="username"]', username);
  await fill('input[autocomplete="new-password"]', password);
  await click('button[type="submit"]', '创建并登录');
}

export async function startJourney(browserName = 'edge', pointer = 'mouse') {
  const run = runPath(`journey-${browserName}-${pointer}`);
  mkdirSync(run, { recursive: true });
  const stack = await startStack({ run, scenario: 'files-user', learning: { captcha: false } });
  const provider = stack.provider;
  const camera = (await cameraFixtures(run, [3])).get(3);
  const browser = await launchBrowser({
    executablePath:
      browserName === 'edge'
        ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
        : 'C:/src/tmp/chrome89-google/app/chrome.exe',
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${camera}`,
    ],
  });
  const touch = pointer === 'touch';
  const context = await createViewerContext(browser, {
    viewport: touch ? { width: 390, height: 844 } : { width: 1600, height: 1000 },
    hasTouch: touch,
  });
  const reply = await context.request.post(stack.origin + '/api/auth/login', {
    headers: { Origin: stack.origin },
    data: { username: stack.username, password: stack.password },
  });
  if (!reply.ok()) throw Error(await reply.text());
  const viewer = await instrumentViewer(context, run, 'user');
  const page = viewer.page;
  page.setDefaultTimeout(30000);
  const cdp = await context.newCDPSession(page);
  await page.goto(stack.origin);
  await viewer.ready(90000);
  const log = (value) =>
    appendFileSync(
      join(run, 'actions.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n',
    );
  const click = async (locator, twice = false) => {
    await locator.waitFor({ state: 'visible' });
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw Error('No target box');
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    log({ click: await locator.innerText().catch(() => ''), x, y, pointer, twice });
    for (let n = 0; n < (twice ? 2 : 1); n++) {
      if (touch) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
        });
        await page.waitForTimeout(65);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else await page.mouse.click(x, y, { clickCount: n + 1 });
    }
    await page.waitForTimeout(400);
  };
  const tapAt = async (x, y) => {
    log({ tapAt: { x, y }, pointer });
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
      });
      await page.waitForTimeout(70);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(500);
  };
  const drag = async (from, to) => {
    const a = await from.boundingBox(),
      b = await to.boundingBox();
    const x = a.x + a.width / 2,
      y = a.y + a.height / 2;
    const endX = b.x + b.width / 2,
      endY = b.y + b.height / 2;
    const event = (type, px, py) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
      });
    if (touch) {
      await event('touchStart', x, y);
      await page.waitForTimeout(650);
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
    }
    for (let n = 1; n <= 20; n++) {
      const px = x + ((endX - x) * n) / 20,
        py = y + ((endY - y) * n) / 20;
      if (touch) await event('touchMove', px, py);
      else
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: px,
          y: py,
          button: 'left',
          buttons: 1,
        });
      await page.waitForTimeout(25);
    }
    if (touch) await event('touchEnd', endX, endY);
    else await page.mouse.up();
    await page.waitForTimeout(600);
  };
  const type = async (locator, value) => {
    await click(locator);
    await page.keyboard.press('Control+A');
    await page.keyboard.type(value, { delay: 45 });
    await page.waitForTimeout(400);
    if ((await locator.inputValue()) !== value) {
      log({ correction: 'Input lost focus during a transition; clicking and retyping' });
      await click(locator);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(value, { delay: 45 });
    }
  };
  const shot = async (name) => {
    await page.screenshot({ path: join(run, name + '.png') });
    writeFileSync(join(run, name + '-state.json'), JSON.stringify(await viewer.state(), null, 2));
    writeFileSync(join(run, name + '-dom.txt'), await page.locator('body').innerText());
    writeFileSync(
      join(run, name + '-surface.json'),
      JSON.stringify(
        await page.evaluate(() => ({
          auth: window.clusterQA?.auth,
          lockBlank: !!document.querySelector('.viewer-lock-blank'),
          startVisible: [...document.querySelectorAll('button')].some(
            (n) => n.getAttribute('aria-label') === '开始' && !!n.getBoundingClientRect().width,
          ),
          viewport: { width: innerWidth, height: innerHeight },
        })),
        null,
        2,
      ),
    );
    return join(run, name + '.png');
  };
  const button = (name) => page.getByRole('button', { name, exact: true }).last();
  const menu = (name) => page.getByRole('menuitem', { name, exact: true });
  const open = async (name) => {
    await page.locator('.launcher.overlay-exiting').waitFor({ state: 'hidden' });
    if (!(await page.getByRole('dialog', { name: '开始屏幕' }).isVisible())) await click(button('开始'));
    await click(
      page
        .getByRole('dialog', { name: '开始屏幕' })
        .locator('[data-tile-key]')
        .filter({ has: page.getByText(name, { exact: true }) })
        .first(),
    );
    await page.getByRole('dialog', { name: '开始屏幕' }).waitFor({ state: 'hidden' });
    await page.locator('.launcher.overlay-exiting').waitFor({ state: 'hidden' });
    await page.waitForTimeout(300);
  };
  return {
    run,
    provider,
    stack,
    browser,
    context,
    viewer,
    page,
    cdp,
    click,
    tapAt,
    drag,
    type,
    shot,
    button,
    menu,
    open,
    until,
    close: async () => {
      await browser.close();
      await stack.stop();
    },
  };
}

export function parseViewport(value) {
  if (!value) return undefined;
  const [width, height] = value.split('x').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw Error('Expected viewport WIDTHxHEIGHT');
  return { width, height };
}
export async function launchBrowser(options = {}) {
  const browserName = process.env.E2E_BROWSER;
  if (browserName) {
    delete options.channel;
    options.executablePath =
      browserName === 'chrome89'
        ? 'C:/src/tmp/chrome89-google/app/chrome.exe'
        : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  }
  const context = await launchTestBrowser(options);
  return context.browser();
}
export function createViewerContext(browser, options = {}) {
  const viewport = parseViewport(process.env.E2E_VIEWPORT);
  return browser.newContext({
    ...options,
    ...(viewport ? { viewport } : {}),
    ...(process.env.E2E_DPR ? { deviceScaleFactor: Number(process.env.E2E_DPR) } : {}),
    ...(process.env.E2E_POINTER ? { hasTouch: options.hasTouch || process.env.E2E_POINTER === 'touch' } : {}),
  });
}
export function launchPersistentViewer(profile, options) {
  const viewport = parseViewport(process.env.E2E_VIEWPORT);
  return launchTestBrowser({
    profile,
    ...options,
    headless: true,
    ...(viewport ? { viewport } : {}),
    ...(process.env.E2E_DPR ? { deviceScaleFactor: Number(process.env.E2E_DPR) } : {}),
    ...(process.env.E2E_POINTER ? { hasTouch: options.hasTouch || process.env.E2E_POINTER === 'touch' } : {}),
  });
}

export async function prepareNativeViewer(host) {
  const qa = (host._robustViewerQA = { contexts: [], page: null, run: null });
  // Chrome89 cannot use recent Playwright utility-world checkVisibility calls.
  // Select attached DOM in the page world, then send real host mouse/keyboard input.
  // No app click handlers or product action APIs are invoked by these helpers.
  qa.uiCount = async (spec) =>
    qa.page.evaluate(
      (spec) =>
        Array.from(document.querySelectorAll(spec.css)).filter(
          (element) => spec.text === undefined || element.textContent.trim() === spec.text,
        ).length,
      spec,
    );
  qa.uiPoint = async (spec) => {
    await qa.page.waitForFunction(
      (spec) =>
        Array.from(document.querySelectorAll(spec.css)).some(
          (element) => spec.text === undefined || element.textContent.trim() === spec.text,
        ),
      spec,
      { timeout: 5000 },
    );
    await qa.page.evaluate((spec) => {
      const matches = Array.from(document.querySelectorAll(spec.css)).filter(
        (element) => spec.text === undefined || element.textContent.trim() === spec.text,
      );
      const element = matches[spec.index === 'last' ? matches.length - 1 : (spec.index ?? 0)];
      if (!element) throw Error('UI target missing');
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, spec);
    await qa.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await qa.page.waitForFunction(
      (spec) => {
        const matches = Array.from(document.querySelectorAll(spec.css)).filter(
            (element) => spec.text === undefined || element.textContent.trim() === spec.text,
          ),
          element = matches[spec.index === 'last' ? matches.length - 1 : (spec.index ?? 0)];
        if (!element) return false;
        const style = getComputedStyle(element),
          box = element.getBoundingClientRect();
        if (
          style.display === 'none' ||
          style.visibility !== 'visible' ||
          Number(style.opacity) === 0 ||
          element.disabled
        )
          return false;
        const left = Math.max(0, box.left),
          right = Math.min(innerWidth, box.right),
          top = Math.max(0, box.top),
          bottom = Math.min(innerHeight, box.bottom);
        if (right <= left || bottom <= top) return false;
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return !!hit && (hit === element || element.contains(hit));
      },
      spec,
      { timeout: 5000 },
    );
    return qa.page.evaluate((spec) => {
      const matches = Array.from(document.querySelectorAll(spec.css)).filter(
          (element) => spec.text === undefined || element.textContent.trim() === spec.text,
        ),
        element = matches[spec.index === 'last' ? matches.length - 1 : (spec.index ?? 0)];
      if (!element) throw Error('UI target disappeared');
      const style = getComputedStyle(element),
        box = element.getBoundingClientRect();
      if (
        style.display === 'none' ||
        style.visibility !== 'visible' ||
        Number(style.opacity) === 0 ||
        box.width <= 0 ||
        box.height <= 0 ||
        element.disabled
      )
        throw Error('UI target is not visible and enabled');
      const left = Math.max(0, box.left),
        right = Math.min(innerWidth, box.right),
        top = Math.max(0, box.top),
        bottom = Math.min(innerHeight, box.bottom);
      if (right <= left || bottom <= top) throw Error('UI target is outside viewport');
      const x = (left + right) / 2,
        y = (top + bottom) / 2,
        hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === element || element.contains(hit))) throw Error('UI target is obscured');
      return {
        x,
        y,
        width: box.width,
        height: box.height,
        text: element.textContent.trim(),
        tag: element.tagName,
      };
    }, spec);
  };
  qa.uiClick = async (spec) => {
    const point = await qa.uiPoint(spec);
    await qa.page.mouse.click(point.x, point.y);
    return point;
  };
  qa.uiFill = async (spec, text) => {
    const focused = () =>
      qa.page.evaluate((spec) => {
        const matches = Array.from(document.querySelectorAll(spec.css)).filter(
          (element) => spec.text === undefined || element.textContent.trim() === spec.text,
        );
        return (
          document.activeElement === matches[spec.index === 'last' ? matches.length - 1 : (spec.index ?? 0)]
        );
      }, spec);
    await qa.uiClick(spec);
    await qa.page.waitForTimeout(80);
    if (!(await focused())) {
      await qa.uiClick(spec);
      await qa.page.waitForTimeout(80);
    }
    if (!(await focused())) throw Error('UI textbox did not retain actual keyboard focus');
    await qa.page.keyboard.press('Control+A');
    await qa.page.keyboard.insertText(text);
  };
  qa.openViewer = async ({
    version = 157,
    run,
    port,
    fixturePort,
    viewport = { width: 1440, height: 900 },
    dpr = 1,
    username = 'robust-' + version,
    password,
    camera = false,
  } = {}) => {
    if (!run || !password) throw Error('Explicit isolated run path and disposable password required');
    qa.run = run;
    qa.port = port;
    qa.fixturePort = fixturePort;
    const context = await launchPersistentViewer(run + '/client-' + version + '-' + Date.now(), {
      executablePath: host.viewerExe,
      headless: true,
      viewport,
      deviceScaleFactor: dpr,
      permissions: camera ? ['camera'] : [],
      args: [
        '--fake-vsync-rate=60',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        ...(camera ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
      ],
    });
    qa.contexts.push(context);
    qa.context = context;
    qa.version = version;
    await context.addInitScript(() => {
      const q = (window.robustQA = {
        events: [],
        wsSent: [],
        dcSent: [],
        peers: [],
        channels: [],
        snapshots: [],
        state: null,
        holdSnapshots: false,
        heldSnapshots: [],
        holdAck: false,
        heldAcks: [],
        draws: 0,
        mstp: 0,
        ids: new WeakMap(),
        nextId: 0,
      });
      const record = (type, data = {}) => {
        q.events.push({ type, at: performance.now(), ...data });
        if (q.events.length > 2000) q.events.shift();
      };
      q.record = record;
      const push = (array, value) => {
        array.push(value);
        if (array.length > 2000) array.shift();
      };
      q.id = (value) => {
        if (!value) return null;
        if (!q.ids.has(value)) q.ids.set(value, ++q.nextId);
        return q.ids.get(value);
      };
      const WS = window.WebSocket;
      window.WebSocket = class extends WS {
        constructor(...args) {
          super(...args);
          q.socket = this;
          const send = this.send.bind(this);
          this.send = (data) => {
            try {
              push(q.wsSent, JSON.parse(data));
            } catch {}
            return send(data);
          };
          this.addEventListener('message', (event) => {
            let message;
            try {
              message = JSON.parse(event.data);
            } catch {
              return;
            }
            if (message.type === 'state') {
              push(q.snapshots, message);
              if (q.holdSnapshots) {
                q.heldSnapshots.push(message);
                event.stopImmediatePropagation();
                return;
              }
              if (
                !q.state ||
                q.state.serverIncarnation !== message.state.serverIncarnation ||
                q.state.snapshotSequence < message.state.snapshotSequence
              )
                q.state = message.state;
            }
          });
        }
      };
      const PC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends PC {
        constructor(...args) {
          super(...args);
          q.peers.push(this);
          record('peer.created', { index: q.peers.length });
        }
        createDataChannel(...args) {
          const channel = super.createDataChannel(...args),
            send = channel.send.bind(channel);
          q.channels.push(channel);
          channel.qaRawSend = send;
          channel.send = (data) => {
            try {
              const message = JSON.parse(data);
              push(q.dcSent, message);
              if (message.type === 'presentation.ready' && q.holdAck) {
                q.heldAcks.push(data);
                return;
              }
            } catch {}
            return send(data);
          };
          channel.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return;
            let message;
            try {
              message = JSON.parse(event.data);
            } catch {
              return;
            }
            if (['input.result', 'layout', 'presentation.prepare', 'clock.pong'].includes(message.type))
              record('dc.receive', { message });
          });
          return channel;
        }
      };
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.closest?.('.remote-viewport')) {
          q.draws++;
          record('viewport.draw', { canvas: q.id(this.canvas) });
        }
        return draw.apply(this, args);
      };
      if (window.MediaStreamTrackProcessor) {
        const Processor = window.MediaStreamTrackProcessor;
        window.MediaStreamTrackProcessor = class extends Processor {
          constructor(...args) {
            super(...args);
            q.mstp++;
          }
        };
      }
      q.transport = () => {
        for (const element of document.querySelectorAll('*')) {
          const key = Object.keys(element).find((k) => k.startsWith('__reactFiber$'));
          for (let fiber = key && element[key]; fiber; fiber = fiber.return)
            for (let hook = fiber.memoizedState; hook; hook = hook.next) {
              const current = hook.memoizedState;
              if (current?.presentation && current?.rtc && current?.endpoint) return current;
            }
        }
        throw Error('Production transport not mounted');
      };
      q.rpc = (method, params) =>
        new Promise((resolve, reject) => {
          const id = 'qa-' + Math.random(),
            socket = q.socket,
            timer = setTimeout(() => {
              socket.removeEventListener('message', on);
              reject(Error('QA RPC timeout'));
            }, 25000);
          function on(event) {
            const message = JSON.parse(event.data);
            if (message.id === id) {
              clearTimeout(timer);
              socket.removeEventListener('message', on);
              message.type === 'error'
                ? reject(Error(JSON.stringify(message.error)))
                : resolve(message.result);
            }
          }
          socket.addEventListener('message', on);
          socket.send(JSON.stringify({ id, method, params }));
        });
      q.operation = (action) => ({
        operationId: crypto.randomUUID?.() ?? 'qa-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        operationGeneration: q.state.operationGeneration,
        action,
      });
      q.action = (action) => q.transport().operations.action(action);
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (...args) {
        if (args[0] instanceof AudioDestinationNode) {
          const mute = this.context.createGain();
          mute.gain.value = 0;
          connect.call(this, mute);
          connect.call(mute, args[0]);
          return args[0];
        }
        return connect.apply(this, args);
      };
    });
    const page = context.pages()[0] ?? (await context.newPage());
    qa.page = page;
    await page.goto('http://127.0.0.1:' + port);
    await page.evaluate(
      async ({ username, password }) => {
        const options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        };
        let response = await fetch('/api/auth/setup', options);
        if (!response.ok) response = await fetch('/api/auth/login', options);
        if (!response.ok) throw Error('Disposable QA account failed');
      },
      { username, password },
    );
    await page.reload();
    await page.waitForSelector('.viewer-lock-blank');
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
    await page.waitForFunction(() => window.robustQA.state && robustQA.socket?.readyState === 1);
    return { version: await context.browser().version(), username, run };
  };
  qa.ready = async () =>
    qa.page.waitForFunction(
      () => {
        try {
          const t = robustQA.transport();
          return (
            t.endpoint.channel?.readyState === 'open' &&
            t.rtc.peer?.connectionState === 'connected' &&
            !document.querySelector('.remote-viewport.resize-waiting') &&
            [...t.presentation.videoPlanes].every(
              ([renderer, plane]) => plane.ready && t.presentation.canInput(renderer.view.id),
            )
          );
        } catch {
          return false;
        }
      },
      null,
      { timeout: 30000 },
    );
  qa.inspect = async () =>
    await (await qa.page.request.get('http://127.0.0.1:' + qa.fixturePort + '/inspect')).json();
  qa.sample = async (name) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw Error('Simple evidence name required');
    const sample = await qa.page.evaluate(async () => {
      const q = robustQA,
        t = q.transport(),
        rect = (element) => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
      return {
        at: performance.now(),
        state: q.state,
        peerCount: q.peers.length,
        connectionId: t.rtc.connectionId,
        peerStates: q.peers.map((peer) => peer.connectionState),
        presentation: t.presentation.getPresentationDiagnostics(true),
        layout: t.presentation.layout,
        barrier: t.presentation.presentationBarrier,
        draws: q.draws,
        mstp: q.mstp,
        inputTrace: t.input.inputTrace,
        planes: [...t.presentation.videoPlanes].map(([renderer, plane]) => ({
          viewId: renderer.view.id,
          videoId: q.id(plane.video),
          streamId: q.id(plane.video.srcObject),
          tracks: plane.video.srcObject?.getTracks().map((track) => track.id),
          ready: plane.ready,
          source: renderer.view,
          canvas: rect(renderer.canvas),
          clip: rect(plane.clip),
          video: rect(plane.video),
          controls: plane.video.controls,
          videoWidth: plane.video.videoWidth,
          videoHeight: plane.video.videoHeight,
        })),
        editors: Array.from(document.querySelectorAll('.remote-viewport textarea')).map((editor) => ({
          active: document.activeElement === editor,
          readOnly: editor.readOnly,
          disabled: editor.disabled,
          box: rect(editor),
        })),
        storage: { local: Object.keys(localStorage), session: Object.keys(sessionStorage) },
        viewport: {
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          scrollWidth: document.documentElement.scrollWidth,
          visual: visualViewport
            ? { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale }
            : null,
        },
        wsSent: q.wsSent,
        dcSent: q.dcSent,
        events: q.events,
      };
    });
    const evidence = { name, version: qa.version, ...sample, fixture: await qa.inspect() };
    await qa.page.screenshot({ path: qa.run + '/' + name + '.png' });
    // Bounded rolling evidence avoids overflowing the production metrics body limit.
    // Keep cumulative counters and mark retained/total counts explicitly.
    const saved = JSON.parse(JSON.stringify(evidence));
    saved.retention = {};
    for (const key of ['events', 'dcSent', 'wsSent']) {
      saved.retention[key] = { total: saved[key].length, retained: Math.min(saved[key].length, 200) };
      saved[key] = saved[key].slice(-200);
    }
    saved.retention.fixtureEvents = {
      total: saved.fixture.events.length,
      retained: Math.min(saved.fixture.events.length, 100),
    };
    saved.fixture.events = saved.fixture.events.slice(-100);
    if (saved.presentation?.raw) {
      saved.retention.presentationRaw = 'omitted; cumulative diagnostics retained';
      delete saved.presentation.raw;
    }
    const response = await qa.page.request.post('http://127.0.0.1:' + qa.fixturePort + '/record', {
      headers: { Origin: 'http://127.0.0.1:' + qa.port },
      data: { kind: 'robust-viewer-qa', ...saved },
    });
    if (!response.ok()) throw Error('Evidence save failed ' + response.status());
    return evidence;
  };
  qa.point = async (viewId, x, y) =>
    qa.page.evaluate(
      ({ viewId, x, y }) => {
        const entry = [...robustQA.transport().presentation.videoPlanes].find(
          ([renderer]) => renderer.view.id === viewId,
        );
        if (!entry) throw Error('Missing plane');
        const renderer = entry[0],
          box = renderer.canvas.getBoundingClientRect(),
          source = renderer.view,
          scale = source.deviceScaleFactor * (source.mediaScale ?? 1);
        return {
          x: box.x + (x / (source.width / scale)) * box.width,
          y: box.y + (y / (source.height / scale)) * box.height,
        };
      },
      { viewId, x, y },
    );
  qa.click = async (viewId, x, y) => {
    const point = await qa.point(viewId, x, y);
    await qa.page.mouse.click(point.x, point.y);
    return point;
  };
  qa.releaseAcks = async () =>
    qa.page.evaluate(() => {
      const q = robustQA;
      q.holdAck = false;
      const channel = q.channels[q.channels.length - 1];
      for (const message of q.heldAcks) channel.qaRawSend(message);
      q.heldAcks = [];
    });
  qa.close = async () => {
    for (const context of qa.contexts) await context.close();
    qa.contexts = [];
  };
}

export function remoteInputReady(viewId) {
  const selected = viewId ?? document.querySelector('.remote-viewport')?.dataset.viewId;
  const viewport = [...document.querySelectorAll('.remote-viewport')].find(
    (element) => element.dataset.viewId === String(selected),
  );
  const canvas = viewport?.querySelector('canvas[data-video-input]');
  if (!canvas) return false;
  const bounds = canvas.getBoundingClientRect();
  if (document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) !== canvas)
    return false;
  for (const element of document.querySelectorAll('*')) {
    const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
    for (let fiber = key && element[key]; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const session = hook.memoizedState;
        if (session?.presentation && session?.rtc && session?.endpoint)
          return !!session.presentation.canInput(selected);
      }
    }
  }
  return false;
}
