import { startFixture } from './kit/fixtures.mjs';

import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStack, until } from './kit/stack.mjs';
import { launch } from './kit/viewer.mjs';

const root = resolve(process.env.E2E_RUN ?? 'develop/tmp/e2e/input-journeys');
const telemetry = new Map();
const pendingImages = new Set();
const fixture = await startFixture('input-user-journeys', Number(process.env.E2E_PORT) + 5, {
  pendingImages,
  telemetry,
  root,
});
await mkdir(root, { recursive: true });

try {
  const engine = process.env.E2E_BROWSER ?? 'edge';
  const pointer = process.env.E2E_POINTER ?? 'mouse';

  const id = `journey-${engine}-${pointer}`;
  const run = join(root, id + '-' + Date.now());
  await mkdir(run, { recursive: true });
  let stack, session;
  const results = [];
  try {
    stack = await startStack({ scenario: id, run });
    session = await launch({ browser: engine, pointer, stack, out: join(run, 'shots') });
    const { page, context } = session;
    await page.evaluate(() => {
      window.journeyInput = [];
      for (const element of document.querySelectorAll('*')) {
        const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
        for (let fiber = key && element[key]; fiber; fiber = fiber.return) {
          for (let hook = fiber.memoizedState; hook; hook = hook.next) {
            const current = hook.memoizedState;
            if (current?.presentation && current?.rtc && current?.endpoint) window.journeyTransport = current;
          }
        }
      }
      if (!window.journeyTransport) throw Error('Viewer transport not mounted');
      for (const type of ['pointerdown', 'pointerup', 'focusin', 'focusout', 'keydown', 'beforeinput'])
        document.addEventListener(
          type,
          (event) =>
            window.journeyInput.push({
              type,
              target: event.target.className,
              key: event.key,
              data: event.data,
              x: event.clientX,
              y: event.clientY,
              at: performance.now(),
            }),
          true,
        );
    });
    page.on(
      'pageerror',
      (error) =>
        void appendFile(
          join(run, 'page-errors.jsonl'),
          JSON.stringify({ message: error.message, stack: error.stack }) + '\n',
        ),
    );
    await page.waitForTimeout(1800);
    if (pointer === 'touch') await page.setViewportSize({ width: 390, height: 844 });
    const cdp = await context.newCDPSession(page);
    const pause = (ms) => page.waitForTimeout(ms);
    const latest = () => telemetry.get(id);
    const state = () => page.evaluate(() => window.__remotekitTest.state());
    const shot = (name) => page.screenshot({ path: join(run, 'shots', name + '.png') });
    const click = async (locator) => {
      await locator.waitFor({ state: 'visible', timeout: 45000 });
      await until(() => locator.isEnabled(), 'enabled user control', 45000);
      await pause(200);
      const box = await locator.boundingBox();
      assert(box);
      await session.pointer.move(box.x + box.width / 2, box.y + box.height / 2);
      await session.pointer.down();
      await pause(70);
      await session.pointer.up();
      await pause(300);
    };
    const button = (name) => page.getByRole('button', { name, exact: true });
    const step = async (name, action) => {
      try {
        const detail = await action();
        results.push({ name, status: 'pass', detail });
      } catch (error) {
        process.exitCode = 1;
        results.push({ name, status: 'fail', error: error.stack });
        await shot(name + '-failure').catch(() => {});
        await writeFile(
          join(run, name + '-dom.json'),
          JSON.stringify(
            await page.evaluate(() => ({
              url: location.href,
              text: document.body.innerText,
              html: document.querySelector('#root')?.innerHTML,
              state: window.__remotekitTest?.state(),
              input: window.journeyInput,
            })),
            null,
            2,
          ),
        );
      }
      await writeFile(
        join(run, 'results.json'),
        JSON.stringify({ engine, pointer, results, errors: session.errors }, null, 2),
      );
      console.log(id, name, results.at(-1).status);
    };
    async function start() {
      await page.locator('.launcher.overlay-exiting').waitFor({ state: 'hidden' });
      if (await page.getByRole('dialog', { name: '开始屏幕' }).isVisible()) return;
      await click(button('开始'));
      await page.getByRole('dialog', { name: '开始屏幕' }).waitFor();
      await pause(450);
    }
    async function navigate(url) {
      await start();
      const input = page.locator('.launcher-search input');
      await click(input);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(url, { delay: 25 });
      await page.keyboard.press('Enter');
      await until(() => latest()?.path, 'fixture navigation', 90000);
      await page.locator('canvas[data-video-input]:not(.no-frame)').waitFor({ timeout: 90000 });
      await pause(1500);
    }
    async function project(key) {
      const canvas = await page.locator('canvas[data-video-input]').first().boundingBox();
      const value = latest();
      const r = value.geometry[key];
      assert(canvas && r);
      return {
        x: canvas.x + ((r.x + r.width / 2) * canvas.width) / value.width,
        y: canvas.y + ((r.y + r.height / 2) * canvas.width) / value.width,
      };
    }
    async function remoteClick(key, options) {
      const p = await project(key);
      assert(p.y >= 0 && p.y < page.viewportSize().height, 'Remote target outside viewport: ' + key);
      if (options) await page.mouse.click(p.x, p.y, options);
      else {
        await session.pointer.move(p.x, p.y);
        await session.pointer.down();
        await pause(75);
        await session.pointer.up();
      }
      await pause(350);
    }
    async function hold(key) {
      const p = await project(key);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...p, id: 1, radiusX: 3, radiusY: 3, force: 1 }],
      });
      await pause(750);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await pause(450);
    }
    async function swipe(x, y, dx, dy, duration = 450) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
      });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { x: x + (dx * i) / 12, y: y + (dy * i) / 12, id: 1, radiusX: 4, radiusY: 4, force: 1 },
          ],
        });
        await pause(duration / 12);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await pause(700);
    }
    async function copyOutsideViewer(text) {
      const syncEnabled = (await state()).workspace.settings.workspace.clipboardSync;
      const local = await context.newPage();
      await local.goto(`http://127.0.0.1:${Number(process.env.E2E_PORT) + 5}/device?case=device-${id}`, {
        waitUntil: 'domcontentloaded',
      });
      const box = await local.locator('#name').boundingBox();
      if (pointer === 'touch') await local.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      else await local.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await local.keyboard.type(text, { delay: 30 });
      await local.keyboard.press('Control+A');
      await local.keyboard.press('Control+C');
      await pause(500);
      await local.screenshot({ path: join(run, 'shots', 'device-native-copy-' + syncEnabled + '.png') });
      await local.close();
      await page.bringToFront();
      await pause(900);
      if (await page.locator('.viewer-lock-blank').isVisible()) await session.unlock();
      await page
        .locator('canvas[data-video-input]:not(.no-frame)')
        .first()
        .waitFor({ state: 'visible', timeout: 45000 });
      await pause(500);
    }
    await step('01-open-form', async () => {
      await navigate(`http://127.0.0.1:${Number(process.env.E2E_PORT) + 5}/?case=${id}`);
      await shot('01-form');
      return { platform: await cdp.send('Browser.getVersion'), viewport: page.viewportSize() };
    });
    if (!latest()) throw Error('Fixture did not open; see 01-open-form-dom.json');
    await step('02a-type-immediately-after-tap', async () => {
      await click(page.locator('.address-form input').first());
      const point = await project('name');
      await session.pointer.move(point.x, point.y);
      await session.pointer.down();
      await session.pointer.up();
      assert(
        await page.evaluate(() => document.activeElement?.matches('.remote-input')),
        'Page activation retained local address focus',
      );
      await page.keyboard.type('Tapped quickly', { delay: 5 });
      await until(
        () => latest().values.name === 'Tapped quickly',
        'first characters after page activation',
        30000,
      );
      await shot('02a-immediate-typing');
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await until(() => latest().values.name === '', 'clear immediate typing fixture');
      return { delivered: 'Tapped quickly' };
    });
    await step('02-compose-name', async () => {
      await remoteClick('name');
      await page.waitForFunction(() => document.activeElement?.matches('.remote-input'), undefined, {
        timeout: 45000,
      });
      let composition = true;
      try {
        await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
        await pause(250);
        await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 });
        await pause(300);
        await cdp.send('Input.insertText', { text: '你好' });
      } catch (error) {
        composition = error.message;
        await page.keyboard.insertText('你好');
      }
      await until(() => latest().values.name === '你好', 'Chinese name arrived', 30000);
      await shot('02-chinese-name');
      return { composition, value: latest().values.name };
    });
    await step('03-move-fields-and-edit', async () => {
      await remoteClick('email');
      await page.keyboard.type('person@exmaple.com', { delay: 50 });
      await page.keyboard.press('Control+A');
      await page.keyboard.type('person@example.com', { delay: 25 });
      await remoteClick('notes');
      await page.keyboard.type('Please reserve a window seat. ', { delay: 20 });
      await page.keyboard.insertText('谢谢');
      await page.keyboard.press('Control+Z');
      await pause(250);
      const undone = latest().values.notes;
      await page.keyboard.insertText('谢谢');
      await until(() => latest().values.email === 'person@example.com', 'corrected email', 30000);
      await shot('03-form-edits');
      return { values: latest().values, undone };
    });
    await step('04-keyboard-floating-toggle', async () => {
      if (pointer === 'mouse') return { applicable: false };
      const floating = page.locator('.remote-open-keyboard');
      if ((await floating.getAttribute('aria-label')) === '显示键盘') await click(floating);
      await until(
        async () => (await floating.getAttribute('aria-label')) === '隐藏键盘',
        'keyboard shown',
        30000,
      );
      await shot('04-keyboard-shown');
      await click(floating);
      await pause(700);
      await shot('04-keyboard-hidden');
      await floating.waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await floating.getAttribute('aria-label'), '显示键盘');
      await click(floating);
      await until(
        async () => (await floating.getAttribute('aria-label')) === '隐藏键盘',
        'keyboard reopened',
        30000,
      );
      return { reopened: true };
    });
    await step('05-select-drag-copy', async () => {
      await hold('word');
      await page.locator('.selection-handle-end').waitFor();
      await shot('05-selection');
      const h = await page.locator('.selection-handle-end').boundingBox();
      await swipe(h.x + h.width / 2, h.y + 15, 65, 0, 500);
      await pause(400);
      const selected = latest().selection;
      assert(selected.includes('bravo'));
      await click(page.locator('.selection-menu').getByRole('button', { name: '复制', exact: true }));
      return { selected };
    });
    await step('06-paste-into-start', async () => {
      await start();
      const input = page.locator('.launcher-search input');
      await click(input);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      const b = await input.boundingBox();
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: b.x + 15, y: b.y + b.height / 2, id: 1 }],
      });
      await pause(750);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await click(page.locator('.selection-menu').getByRole('button', { name: '粘贴', exact: true }));
      const pasted = await input.inputValue();
      assert(pasted.includes('bravo'));
      await shot('06-start-paste');
      await page.keyboard.press('Escape');
      return { pasted };
    });
    await step('07-device-paste-shortcuts', async () => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: stack.origin });
      await start();
      const input = page.locator('.launcher-search input');
      await click(input);
      await page.keyboard.press('Control+A');
      await page.keyboard.type('Device side clipboard text', { delay: 40 });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+C');
      await pause(700);
      const device = await page.evaluate(() => navigator.clipboard.readText());
      await writeFile(join(run, 'device-copy.json'), JSON.stringify({ device }, null, 2));
      assert.equal(device, 'Device side clipboard text');
      await page.keyboard.press('Escape');
      await page.locator('.launcher').waitFor({ state: 'hidden' });
      await pause(600);
      await page.waitForFunction(() => !document.querySelector('.resize-waiting'), undefined, {
        timeout: 45000,
      });
      await remoteClick('notes');
      await page.waitForFunction(() => document.activeElement?.matches('.remote-input'), undefined, {
        timeout: 45000,
      });
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Control+V');
      await until(
        () => latest().values.notes.includes('Device side clipboard text'),
        'device text remotely pasted',
        30000,
      );
      return latest().values.notes;
    });
    await step('07b-native-device-copy-sync-on', async () => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: stack.origin });
      const text = 'External device ' + id;
      await copyOutsideViewer(text);
      await remoteClick('notes');
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+V');
      await until(() => latest().values.notes === text, 'external device paste with sync enabled', 30000);
      await shot('07b-device-paste-sync-on');
      return { value: latest().values.notes };
    });
    await step('08-input-settings', async () => {
      await start();
      const tile = page
        .getByRole('dialog', { name: '开始屏幕' })
        .locator('[data-tile-key]')
        .filter({ has: page.getByText('设置', { exact: true }) })
        .first();
      await click(tile);
      await click(page.getByRole('navigation', { name: '设置分区' }).getByText('输入', { exact: true }));
      const auto = page.getByRole('switch', { name: '聚焦输入框时自动打开键盘' });
      const sync = page.getByRole('switch', { name: '与本机剪贴板同步' });
      const before = (await state()).workspace.settings.workspace.autoKeyboard;
      await click(auto);
      await until(
        async () => (await state()).workspace.settings.workspace.autoKeyboard !== before,
        'auto keyboard changed',
        30000,
      );
      await shot('08-input-settings');
      await click(auto);
      await click(sync);
      await until(
        async () => !(await state()).workspace.settings.workspace.clipboardSync,
        'sync disabled',
        30000,
      );
      const switcher = page
        .locator('.narrow-window-switcher')
        .getByRole('button', { name: 'Input journey form', exact: true });
      if (await switcher.isVisible()) await click(switcher);
      else await click(page.getByRole('tab', { name: 'Input journey form', exact: true }).first());
      await page.locator('canvas[data-video-input]').first().waitFor({ state: 'visible', timeout: 45000 });
      await remoteClick('notes');
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Control+V');
      await pause(500);
      return { autoBefore: before, settings: (await state()).workspace.settings.workspace };
    });
    await step('08b-native-device-copy-sync-off', async () => {
      const expected = await page.evaluate(async () =>
        (await import('/client/clipboard/app-clipboard.ts')).appClipboard.read(),
      );
      assert.equal((await state()).workspace.settings.workspace.clipboardSync, false);
      await copyOutsideViewer('Do not sync ' + id);
      await remoteClick('notes');
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+V');
      await until(
        () => latest().values.notes === expected,
        'retained remote clipboard with device sync disabled',
        30000,
      );
      await shot('08b-device-paste-sync-off');
      return { expected, value: latest().values.notes };
    });
    await step('09-scroll-fling-pinch', async () => {
      const canvas = await page.locator('canvas[data-video-input]').boundingBox();
      const x = canvas.x + canvas.width * 0.8,
        y = canvas.y + canvas.height * 0.75;
      const before = latest().scrollY;
      if (pointer === 'touch') {
        await swipe(x, y, 0, -250, 600);
        await swipe(x, y, 0, -280, 90);
      } else {
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, 900);
        await pause(1200);
      }
      assert(latest().scrollY > before);
      await shot('09-scrolled-form');
      if (pointer === 'touch') {
        const cx = canvas.x + canvas.width / 2,
          cy = canvas.y + canvas.height / 2;
        const points = (d) => [
          { x: cx - d, y: cy, id: 1 },
          { x: cx + d, y: cy, id: 2 },
        ];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(35) });
        for (let i = 1; i <= 12; i++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: points(35 + i * 4),
          });
          await pause(30);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await pause(800);
        await shot('09-pinched');
        const zoomed = latest().scale;
        assert(zoomed > 1.2, 'Pinch changed the remote visual viewport scale');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(83) });
        for (let i = 1; i <= 12; i++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: points(83 - i * 4),
          });
          await pause(30);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await pause(800);
        for (let i = 0; i < 8 && latest().scrollY > 10; i++) await swipe(x, canvas.y + 150, 0, 350, 180);
      } else {
        await page.mouse.wheel(0, -4000);
        await pause(1000);
      }
      return { before, after: latest().scrollY, scale: latest().scale };
    });
    await step('09b-complete-long-form', async () => {
      const box = await page.locator('canvas[data-video-input]').boundingBox();
      const scroll = async (direction) => {
        if (pointer === 'touch')
          await swipe(
            box.x + box.width * 0.85,
            box.y + box.height * (direction > 0 ? 0.75 : 0.25),
            0,
            direction > 0 ? -250 : 250,
            350,
          );
        else {
          await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
          await page.mouse.wheel(0, direction * 350);
          await pause(700);
        }
      };
      for (let i = 0; i < 10; i++) {
        for (let tries = 0; tries < 18; tries++) {
          const p = await project('q' + i);
          if (p.y > box.y + 40 && p.y < box.y + box.height - 50) break;
          await scroll(p.y > box.y + box.height - 50 ? 1 : -1);
        }
        await remoteClick('q' + i);
        await page.keyboard.type('Answer ' + (i + 1), { delay: 45 });
        await until(() => latest().values['q' + i] === 'Answer ' + (i + 1), 'form answer ' + i, 30000);
      }
      for (let tries = 0; tries < 8 && (await project('submit')).y > box.y + box.height - 60; tries++)
        await scroll(1);
      await remoteClick('submit');
      await shot('09b-submitted-long-form');
      for (let tries = 0; tries < 20 && latest().scrollY > 0; tries++) await scroll(-1);
      return { values: latest().values };
    });
    await step('10-links-history-context-menu', async () => {
      await remoteClick('link', { button: 'right' });
      await page.getByRole('menu', { name: '页面菜单' }).waitFor();
      await shot('10-context-menu');
      await page.keyboard.press('Escape');
      await remoteClick('link');
      await until(() => latest().path === '/next', 'link navigation', 45000);
      if (pointer === 'touch') {
        const box = await page.locator('canvas[data-video-input]').boundingBox();
        await swipe(box.x + 3, box.y + box.height / 2, box.width * 0.7, 0, 500);
        const backGesture = latest().path;
        await swipe(box.x + box.width - 3, box.y + box.height / 2, -box.width * 0.7, 0, 500);
        await writeFile(
          join(run, 'history-gestures.json'),
          JSON.stringify({ backGesture, forwardGesture: latest().path }, null, 2),
        );
      }
      const back = page.getByRole('button', { name: '后退', exact: true });
      await click(back);
      await until(() => latest().path === '/', 'back navigation', 45000);
      const forward = page.getByRole('button', { name: '前进', exact: true });
      if (await forward.isVisible()) await click(forward);
      else {
        await click(button('更多'));
        await click(page.getByRole('menuitem', { name: '前进', exact: true }));
      }
      await until(() => latest().path === '/next', 'forward navigation', 45000);
      return { path: latest().path };
    });
    await step('10b-type-during-loading', async () => {
      const address = page.locator('.address-form input').first();
      await click(address);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(`http://127.0.0.1:${Number(process.env.E2E_PORT) + 5}/loading?case=${id}`, {
        delay: 20,
      });
      await page.keyboard.press('Enter');
      await until(() => latest()?.path === '/loading', 'loading form document', 45000);
      await page.waitForFunction(
        () => {
          const transport = window.journeyTransport;
          const state = window.__remotekitTest.state();
          const tab = state.workspace.tabs.find((tab) => tab.url.includes('/loading'));
          if (!tab?.usageDocument) return false;
          const view = transport.presentation.layout?.views.find((view) => view.id === tab.webviewId);
          return (
            view?.document === JSON.parse(tab.usageDocument)[2] && !!transport.presentation.canInput(view.id)
          );
        },
        undefined,
        { timeout: 45000 },
      );
      await page
        .locator('canvas[data-video-input]:not(.no-frame)')
        .first()
        .waitFor({ state: 'visible', timeout: 45000 });
      const loading = (await state()).workspace.tabs.some(
        (tab) => tab.url.includes('/loading') && tab.loading,
      );
      assert(loading, 'Page finished loading before the input regression');
      assert(pendingImages.size > 0, 'Fixture image request is still loading');
      await remoteClick('name');
      await page.keyboard.type('Fast loading input', { delay: 5 });
      await page.keyboard.insertText('你好');
      await until(
        () => latest().values.name === 'Fast loading input你好',
        'fast input during page load',
        30000,
      );
      await shot('10b-typing-while-loading');
      for (const image of pendingImages)
        image
          .writeHead(200, { 'Content-Type': 'image/png' })
          .end(
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII=',
              'base64',
            ),
          );
      return { loading, value: latest().values.name };
    });
    await step('11-network-lock-recovery', async () => {
      await context.setOffline(true);
      await pause(1800);
      await shot('11-offline');
      await context.setOffline(false);
      await pause(2000);
      if (await page.locator('.viewer-lock-blank').isVisible()) await session.unlock();
      await start();
      await click(button('锁定'));
      await page.locator('.viewer-lock-blank').waitFor();
      await shot('11-locked');
      await session.unlock();
      await shot('11-unlocked');
      return { state: (await state()).user.username };
    });
    await shot('12-final');
    await writeFile(
      join(run, 'final-state.json'),
      JSON.stringify(
        { state: await state(), remote: latest(), text: await page.locator('body').innerText() },
        null,
        2,
      ),
    );
  } catch (error) {
    process.exitCode = 1;
    await writeFile(join(run, 'fatal.txt'), error.stack);
    console.error(id, error.stack);
  } finally {
    await session?.close();
    await stack?.stop();
  }
} finally {
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
}
