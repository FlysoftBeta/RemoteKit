import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startStack, until } from './input-stack.mjs';
import { launch } from './input-viewer.mjs';

const root = resolve('develop/tmp/e2e-input');
const telemetry = new Map();
const pendingImages = new Set();
const fixture = createServer(async (req, res) => {
  if (req.url.startsWith('/slow-image.png')) {
    pendingImages.add(res);
    res.on('close', () => pendingImages.delete(res));
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    telemetry.set(value.caseId, value);
    await appendFile(join(root, 'journey-fixture.jsonl'), body + '\n');
    return res.end('ok');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Input journey form</title><style>body{margin:0;padding:16px;font:18px/1.5 Arial;background:#f6f8fc;color:#193450}h1{font-size:24px;margin:0 0 12px}label{display:block;margin:16px 0}input,textarea{display:block;box-sizing:border-box;width:100%;padding:10px;font:20px Arial}p{font:22px/1.7 monospace}a,button{padding:12px;display:inline-block}#words{white-space:nowrap;font:20px monospace}#tail{height:200px;background:#bed3ec}</style>
  <h1>Conference registration / 报名表</h1><div id="words">alpha bravo charlie delta</div>
  <a id="link" href="/next${new URL(req.url, 'http://fixture').search}">Open next page</a>
  <label>Name / 姓名<input id="name" autocomplete="name"></label>
  <label>Email<input id="email" type="email"></label><label>Notes<textarea id="notes"></textarea></label>
  ${Array.from({ length: 10 }, (_, i) => `<label>Question ${i + 1}<input id="q${i}"></label>`).join('')}
  <button id="submit" onclick="document.querySelector('#status').textContent='Submitted';report('submit')">Submit</button><div id="status"></div><div id="tail">End of long form</div>
  ${req.url.startsWith('/loading') ? '<img src="/slow-image.png" alt="Loading illustration">' : ''}
  <script>
  const caseId=new URLSearchParams(location.search).get('case');let n=0;
  function report(type){const nodes=[...document.querySelectorAll('[id]')];const word=()=>{const r=document.createRange();r.setStart(words.firstChild,6);r.setEnd(words.firstChild,11);return r.getBoundingClientRect().toJSON()};fetch('/event',{method:'POST',body:JSON.stringify({caseId,type,n:++n,path:location.pathname,width:innerWidth,height:innerHeight,scrollY,scale:visualViewport.scale,active:document.activeElement.id,selection:getSelection().toString(),values:Object.fromEntries(nodes.filter(x=>x.matches('input,textarea')).map(x=>[x.id,x.value])),geometry:{...Object.fromEntries(nodes.map(x=>[x.id,x.getBoundingClientRect().toJSON()])),word:word()}})})}
  for(const t of ['input','focusin','focusout','selectionchange','compositionstart','compositionupdate','compositionend','scroll','resize'])addEventListener(t,()=>report(t));
  report('ready');setInterval(()=>report('sample'),600);
  </script>`);
});
await mkdir(root, { recursive: true });
await new Promise((done) => fixture.listen(34148, '127.0.0.1', done));
const selected = process.argv[2];
const enabledSteps = new Set((process.env.INPUT_JOURNEY_STEPS ?? '').split(',').filter(Boolean));
try {
  for (const engine of ['edge', 'chrome89'])
    for (const pointer of ['mouse', 'touch']) {
      const id = `journey-${engine}-${pointer}`;
      if (selected && selected !== id) continue;
      const run = join(root, id + '-' + Date.now());
      await mkdir(run);
      process.env.E2E_INPUT_PORT = String(
        34140 + (engine === 'chrome89' ? 20 : 0) + (pointer === 'touch' ? 10 : 0),
      );
      let stack, session;
      const results = [];
      try {
        stack = await startStack({ scenario: id, run });
        session = await launch({ browser: engine, pointer, stack, out: join(run, 'shots') });
        const { page, context } = session;
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
          if (enabledSteps.size && !enabledSteps.has(name)) return;
          try {
            const detail = await action();
            results.push({ name, status: 'pass', detail });
          } catch (error) {
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
            y: canvas.y + ((r.y + r.height / 2) * canvas.height) / value.height,
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
          await local.goto(`http://127.0.0.1:34148/device?case=device-${id}`, {
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
          await navigate(`http://127.0.0.1:34148/?case=${id}`);
          await shot('01-form');
          return { platform: await cdp.send('Browser.getVersion'), viewport: page.viewportSize() };
        });
        if (!latest()) throw Error('Fixture did not open; see 01-open-form-dom.json');
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
          await page
            .locator('canvas[data-video-input]')
            .first()
            .waitFor({ state: 'visible', timeout: 45000 });
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
          await page.keyboard.type(`http://127.0.0.1:34148/loading?case=${id}`, { delay: 20 });
          await page.keyboard.press('Enter');
          await until(() => latest()?.path === '/loading', 'loading form document', 45000);
          await page
            .locator('canvas[data-video-input]:not(.no-frame)')
            .first()
            .waitFor({ state: 'visible', timeout: 45000 });
          const loading = (await state()).workspace.tabs.some(
            (tab) => tab.url.includes('/loading') && tab.loading,
          );
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
        await writeFile(join(run, 'fatal.txt'), error.stack);
        console.error(id, error.stack);
      } finally {
        await session?.close();
        await stack?.stop();
      }
    }
} finally {
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
}
