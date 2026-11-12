import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { until } from './kit/stack.mjs';

// Input-owned source Viewer launcher. Loading images do not gate UI interaction.
export async function launch({ browser: engine, pointer: pointerType, stack, out }) {
  mkdirSync(out, { recursive: true });
  const { chromium } = createRequire(import.meta.url)(
    process.env.REMOTEKIT_PLAYWRIGHT ??
      join(
        homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
      ),
  );
  const browser = await chromium.launch({
    executablePath:
      engine === 'chrome89'
        ? 'C:/src/tmp/chrome89-google/app/chrome.exe'
        : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    hasTouch: pointerType === 'touch',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack));
  const cdp = await context.newCDPSession(page);
  const at = { x: 0, y: 0, down: false };
  const touch = pointerType === 'touch';
  const dispatch = (type) =>
    cdp.send(
      touch ? 'Input.dispatchTouchEvent' : 'Input.dispatchMouseEvent',
      touch
        ? {
            type,
            touchPoints:
              type === 'touchEnd' ? [] : [{ x: at.x, y: at.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
          }
        : {
            type,
            x: at.x,
            y: at.y,
            button: type === 'mouseMoved' && !at.down ? 'none' : 'left',
            buttons: at.down ? 1 : 0,
            clickCount: type === 'mouseMoved' ? 0 : 1,
          },
    );
  const pointer = {
    async move(x, y, { steps = 1 } = {}) {
      const from = { ...at };
      for (let i = 1; i <= steps; i++) {
        at.x = from.x + ((x - from.x) * i) / steps;
        at.y = from.y + ((y - from.y) * i) / steps;
        if (!touch || at.down) await dispatch(touch ? 'touchMove' : 'mouseMoved');
      }
    },
    async down() {
      at.down = true;
      await dispatch(touch ? 'touchStart' : 'mousePressed');
    },
    async up() {
      if (!at.down) return;
      at.down = false;
      await dispatch(touch ? 'touchEnd' : 'mouseReleased');
    },
  };
  const unlocked = () =>
    page.getByRole('button', { name: '开始', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
  async function unlock() {
    if (await page.getByRole('button', { name: '开始', exact: true }).isVisible()) return;
    await page.locator('.viewer-lock-blank').waitFor();
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__remotekitTest.unlock());
    const password = page.getByLabel(/^账户密码/);
    await password.waitFor();
    const box = await password.boundingBox();
    await pointer.move(box.x + box.width / 2, box.y + box.height / 2);
    await pointer.down();
    await pointer.up();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(stack.password);
    const submit = await page.getByRole('button', { name: '解锁', exact: true }).boundingBox();
    await pointer.move(submit.x + submit.width / 2, submit.y + submit.height / 2);
    await pointer.down();
    await pointer.up();
    await unlocked();
  }
  try {
    const response = await page.request.post(stack.origin + '/api/auth/login', {
      data: { username: stack.username, password: stack.password },
      headers: { Origin: stack.origin },
    });
    if (!response.ok()) throw Error(await response.text());
    await page.goto(stack.origin, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => !!window.__remotekitTest, undefined, { timeout: 90000 });
    await unlocked();
    await until(() => page.evaluate(() => !!window.__remotekitTest.state()), 'product state', 90000);
  } catch (error) {
    await page.screenshot({ path: join(out, 'launch-failure.png') }).catch(() => {});
    await browser.close();
    throw error;
  }
  return { browser, context, page, pointer, errors, out, unlock, close: () => browser.close() };
}
