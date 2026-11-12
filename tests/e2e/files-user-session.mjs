import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fakeLearningProvider } from './files-learning-provider.mjs';
import { startStack, runPath, until } from './files-stack.mjs';
import { instrumentViewer } from './cluster-test-support.mjs';
export async function startJourney(browserName = 'edge', pointer = 'mouse') {
  const run = runPath(`journey-${browserName}-${pointer}`);
  mkdirSync(run, { recursive: true });
  process.env.FILES_CAPTCHA = '0';
  const provider = await fakeLearningProvider(run, 'C:/src/chromium/src/out/rel/remotekit_browser.exe');
  Object.assign(process.env, provider.env);
  const stack = await startStack({ run, scenario: 'files-user', browser: provider.launcher });
  const { chromium } = createRequire(import.meta.url)(
    process.env.REMOTEKIT_PLAYWRIGHT ??
      join(
        homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
      ),
  );
  const browser = await chromium.launch({
    executablePath:
      browserName === 'edge'
        ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
        : 'C:/src/tmp/chrome89-google/app/chrome.exe',
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      ...(process.env.REMOTEKIT_CAMERA_FIXTURE
        ? [`--use-file-for-fake-video-capture=${resolve(process.env.REMOTEKIT_CAMERA_FIXTURE)}`]
        : []),
    ],
  });
  const touch = pointer === 'touch';
  const context = await browser.newContext({
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
      await provider.close();
    },
  };
}
