import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startStack, until } from './stack.mjs';
export { until } from './stack.mjs';

export function cliOptions() {
  const { values } = parseArgs({
    options: {
      browser: { type: 'string', default: 'edge' },
      dpr: { type: 'string', default: '1' },
      pointer: { type: 'string', default: 'mouse' },
      out: { type: 'string' },
      'browser-path': { type: 'string' },
      port: { type: 'string', default: '34790' },
    },
  });
  if (!['edge', 'chrome89'].includes(values.browser)) throw Error('Expected --browser edge|chrome89');
  if (!['mouse', 'touch'].includes(values.pointer)) throw Error('Expected --pointer mouse|touch');
  if (!(Number(values.dpr) > 0)) throw Error('Expected positive --dpr');
  return { ...values, dpr: Number(values.dpr) };
}

export async function launch({
  browser: browserName = 'edge',
  dpr = 1,
  pointer: pointerType = 'mouse',
  out,
  stack,
} = {}) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(
    process.env.REMOTEKIT_PLAYWRIGHT ??
      join(
        homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
      ),
  );
  out = resolve(out ?? join(stack.run, 'shots'));
  mkdirSync(out, { recursive: true });
  const chrome89 = browserName === 'chrome89';
  const touch = pointerType === 'touch';
  const browser = await chromium.launch(
    chrome89
      ? { executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: true }
      : { channel: 'msedge', headless: true },
  );
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: dpr,
    hasTouch: touch,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
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
    await page.getByRole('button', { name: '主页条', exact: true }).click();
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
  const waitUnlocked = () => page.getByRole('button', { name: '主页条', exact: true }).waitFor();
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
    await page.getByRole('button', { name: '主页条', exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.viewer-lock-blank').waitFor();
    await page.waitForTimeout(400);
  }
  async function unlock() {
    if (await page.getByRole('button', { name: '主页条', exact: true }).isVisible()) return;
    await page.locator('.viewer-lock-blank').waitFor();
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__remotekitTest.unlock());
    await authenticate();
  }
  try {
    const response = await page.request.post(stack.origin + '/api/auth/login', {
      data: { username: stack.username, password: stack.password },
      headers: { Origin: stack.origin },
    });
    if (!response.ok()) throw Error('Login failed: ' + (await response.text()));
    await page.goto(stack.origin);
    await page.waitForFunction(() => !!window.__remotekitTest);
    await waitUnlocked();
    await wait(() => state, 'product state');
  } catch (error) {
    await shot('fail-launch').catch(() => {});
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
  const stack = await startStack({ scenario: name, browser: options['browser-path'] });
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
