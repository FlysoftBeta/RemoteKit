import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { instrumentViewer } from './cluster-test-support.mjs';
import { startStack, until } from './files-stack.mjs';

const before = process.argv.includes('--before');
const selectedDevice = process.argv.find((arg) => arg.startsWith('--device='))?.split('=')[1];
const output = resolve(process.env.FILES_RUN ?? `develop/tmp/e2e-files/files-ui-${Date.now()}`);
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.REMOTEKIT_PLAYWRIGHT ??
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
);
mkdirSync(output, { recursive: true });
let stack;
const events = [];
const fixture = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    events.push(JSON.parse(body));
    writeFileSync(join(output, 'fixture-events.json'), JSON.stringify(events, null, 2));
    return response.end('ok');
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
    <title>Files UI fixture</title><style>body{font:20px system-ui;background:#eef3fb}
    input{position:fixed;top:42%;left:32px;width:300px;height:44px}</style>
    <h1>Files UI fixture</h1><input type="file" multiple id="upload">
    <script>
      const input = document.querySelector('input');
      const report = () => fetch('/event', {method:'POST',body:JSON.stringify({
        width:innerWidth,height:innerHeight,box:input.getBoundingClientRect().toJSON()
      })});
      addEventListener('resize', report); report();
      input.onchange = () => fetch('/event', {method:'POST',body:JSON.stringify({
        files:[...input.files].map(file => file.name)
      })});
    </script>`);
});
await new Promise((done) => fixture.listen(Number(process.env.FILES_PORT ?? 34200) + 1, '127.0.0.1', done));
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
const results = [];
try {
  for (const device of selectedDevice ? [selectedDevice] : ['chrome89', 'edge']) {
    const out = join(output, device);
    mkdirSync(out, { recursive: true });
    stack = await startStack({ scenario: `files-ui-${device}`, run: join(out, 'stack') });
    const tablet = process.env.FILES_POINTER ? process.env.FILES_POINTER === 'touch' : device === 'chrome89';
    const browser = await chromium.launch(
      device === 'chrome89'
        ? { executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: true }
        : { channel: 'msedge', headless: true },
    );
    const context = await browser.newContext({
      viewport: tablet
        ? process.env.FILES_POINTER
          ? { width: 390, height: 844 }
          : { width: 800, height: 1280 }
        : { width: 1600, height: 1000 },
      deviceScaleFactor: tablet ? 2 : 1,
      hasTouch: tablet,
    });
    const viewer = await instrumentViewer(context, out, device);
    const { page, call } = viewer;
    page.setDefaultTimeout(20000);
    try {
      const response = await context.request.post(stack.origin + '/api/auth/login', {
        data: { username: stack.username, password: stack.password },
        headers: { Origin: stack.origin },
      });
      assert(response.ok(), await response.text());
      await page.goto(stack.origin, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await viewer.ready();
      await call('auth.settings', {
        currentPassword: stack.password,
        settings: { lockOnHidden: false, lockOnIdle: false },
      });
      const mutate = (method, params) => call('library.' + method, { operationId: randomUUID(), ...params });
      const assetBytes = Buffer.from('Files UI reference');
      const upload = await call(
        'asset.begin',
        {
          requestId: 'library',
          operationId: randomUUID(),
          name: 'reference.txt',
          type: 'text/plain',
          size: assetBytes.length,
        },
        true,
      );
      await call(
        'asset.chunk',
        { requestId: 'library', uploadId: upload.uploadId, offset: 0, data: assetBytes.toString('base64') },
        true,
      );
      const asset = await call('asset.seal', { requestId: 'library', uploadId: upload.uploadId }, true);
      let library;
      for (let index = 0; index < 60; index++) {
        library = await mutate('import', {
          assetId: asset.assetId,
          name: `${device}-reference-${index}.txt`,
          destination: 'library',
          origin: { kind: 'files', channel: 'upload', partitionId: null },
        });
      }
      const reference = library.entries.find((entry) => entry.name === `${device}-reference-0.txt`);
      await viewer.action({ type: 'window.open', appId: 'files', placement: { mode: 'space' } });
      const filesWindow = (await viewer.state()).workspace.windows.find((win) => win.appId === 'files');
      await viewer.action({
        type: 'window.state',
        windowId: filesWindow.id,
        state: {
          tabs: [
            { id: 'library1', kind: 'library', view: 'all', query: '' },
            { id: 'document', kind: 'document', entryId: reference.id },
          ],
          activeTabId: 'library1',
          layout: 'list',
        },
      });
      const pane = page.locator('.files-window-content:visible');
      await pane.locator('input[type=file]').setInputFiles(
        Array.from({ length: 10 }, (_, index) => ({
          name: `${device}-batch-${index}.txt`,
          mimeType: 'text/plain',
          buffer: randomBytes(1024 * 1024),
        })),
      );
      const uploaded = async () =>
        (await call('library.get')).entries.filter((entry) => entry.name.startsWith(`${device}-batch-`));
      await until(async () => (await uploaded()).length > 0, 'first device upload');
      await page.screenshot({ path: join(out, 'upload-before-switch.png') });
      const tabs = page.locator('.tab-bar:visible [role=tab]');
      const atSwitch = (await uploaded()).length;
      assert(atSwitch < 10, 'tab switch occurs with uploads pending');
      await tabs.filter({ hasText: reference.name }).click();
      await page.screenshot({ path: join(out, 'upload-document.png') });
      await page.waitForTimeout(1000);
      await tabs.filter({ hasText: '全部' }).click();
      if (!before)
        await until(async () => (await uploaded()).length === 10, 'all ten uploads after tab switch', 90000);
      else await page.waitForTimeout(3000);
      const count = (await uploaded()).length;
      await page.screenshot({ path: join(out, 'upload-return.png') });

      await viewer.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
      const browserWindow = (await viewer.state()).workspace.windows.find((win) => win.appId === 'browser');
      await viewer.action({ type: 'tab.navigate', tabId: browserWindow.activeTabId, url: fixtureOrigin });
      await viewer.media();
      await page.waitForFunction(() => {
        const viewport = document.querySelector('.remote-viewport');
        return (
          viewport &&
          !viewport.classList.contains('resize-waiting') &&
          viewport.querySelector('canvas:not(.no-frame)')
        );
      });
      const { remote, geometry } = await until(async () => {
        const remote = await page.locator('.remote-viewport:visible').boundingBox();
        const geometry = events.findLast(
          (event) => Math.abs(event.width - remote.width) < 2 && Math.abs(event.height - remote.height) < 2,
        );
        return geometry && { remote, geometry };
      }, 'fixture geometry');
      const x = remote.x + geometry.box.x + 30;
      const y = remote.y + geometry.box.y + 20;
      if (tablet) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      const dialog = page.getByRole('dialog', { name: '文件篮', exact: true });
      await dialog.getByRole('button', { name: '从我的文件选择', exact: true }).click();
      const grid = dialog.getByRole('group', { name: '我的文件', exact: true });
      await grid.locator('button').first().click();
      const measure = () =>
        dialog.evaluate((panel) => {
          const confirm = [...panel.querySelectorAll('button')].find((button) =>
            button.textContent.includes('加入文件篮'),
          );
          const grid = panel.querySelector('[role=group][aria-label="我的文件"]');
          const rect = panel.getBoundingClientRect();
          const button = confirm.getBoundingClientRect();
          const outer = [...panel.querySelectorAll('*')].filter(
            (element) =>
              ['auto', 'scroll'].includes(getComputedStyle(element).overflowY) &&
              element.scrollHeight > element.clientHeight,
          );
          return {
            panel: rect.toJSON(),
            confirm: button.toJSON(),
            gridHeight: grid.clientHeight,
            gridScroll: grid.scrollTop,
            scrollSurfaces: outer.length,
            confirmVisible:
              button.top >= rect.top && button.bottom <= rect.bottom && button.bottom <= innerHeight,
          };
        });
      const initial = await measure();
      const gridBox = await grid.boundingBox();
      await page.mouse.move(
        gridBox.x + gridBox.width / 2,
        Math.min(gridBox.y + 30, page.viewportSize().height - 20),
      );
      await page.mouse.wheel(0, 650);
      await page.waitForTimeout(300);
      const wheel = await measure();
      await page.screenshot({ path: join(out, 'picker-wheel.png') });
      results.push({
        device,
        version: browser.version(),
        uploadsAtSwitch: atSwitch,
        uploads: count,
        initial,
        wheel,
      });
      writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify(results.at(-1)));
      if (!before) {
        assert.equal(count, 10);
        assert(initial.confirmVisible && wheel.confirmVisible, 'picker confirmation stays inside panel');
        assert.equal(initial.scrollSurfaces, 1);
        assert.equal(wheel.scrollSurfaces, 1);
        assert(wheel.gridScroll > initial.gridScroll, 'mouse wheel scrolls the grid');
        await dialog.getByRole('button', { name: '加入文件篮', exact: true }).click();
        const eventCount = events.length;
        await dialog.getByRole('button', { name: '发送', exact: true }).click();
        await until(
          () => events.slice(eventCount).some((event) => event.files?.length),
          'native selected file callback',
        );
        await until(async () => !(await call('library.get')).basket.length, 'basket checkout reconciled');
      }
      if (before) await dialog.getByRole('button', { name: '取消文件选择', exact: true }).click();
    } catch (error) {
      await page.screenshot({ path: join(out, 'failure.png') });
      writeFileSync(
        join(out, 'failure.json'),
        JSON.stringify(
          {
            error: String(error.stack),
            viewer: await page.evaluate(() => ({
              auth: clusterQA.auth,
              state: clusterQA.state,
              fileWire: clusterQA.fileWire,
              text: document.body.innerText,
            })),
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      await browser.close();
      await stack.stop();
      stack = undefined;
    }
  }
} finally {
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
  await stack?.stop();
}
