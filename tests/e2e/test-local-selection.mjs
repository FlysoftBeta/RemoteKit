import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStack } from './kit/stack.mjs';
import { createViewerContext, launchBrowser } from './kit/viewer.mjs';

import assert from 'node:assert/strict';

const [engine = 'edge', , output = process.env.E2E_RUN] = process.argv.slice(2);

const stack = await startStack({ scenario: 'local-selection', run: output, seed: false, fixtures: false });
const origin = stack.origin;
const browser = await launchBrowser(
  engine === 'chrome89'
    ? { executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: true }
    : { channel: 'msedge', headless: true },
);
const context = await createViewerContext(browser, {
  viewport: { width: 900, height: 800 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const run = resolve(output);
await mkdir(run, { recursive: true });
const results = [];
try {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.goto(origin);
  await page.waitForSelector('#root > *');
  await page.evaluate(async () => {
    const clipboardModule = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/client/clipboard/app-clipboard.ts'));
    const { appClipboard } = await import(clipboardModule.name);
    let revision = 0;
    window.probeClipboard = appClipboard;
    appClipboard.configure('selection-probe', async () => ({ revision: String(++revision) }));
    const host = document.createElement('section');
    host.id = 'selection-probe';
    host.style.cssText =
      'position:fixed;inset:0;background:white;color:black;z-index:100000;padding:60px;font:24px/32px Arial';
    host.innerHTML =
      '<input id="probe-input" value="alpha bravo charlie" style="font:24px/32px Arial;width:600px;height:50px"><p data-selectable id="probe-text">alpha bravo charlie delta</p><div id="probe-shadow"></div><button id="probe-button">chrome label cannot select</button>';
    document.body.append(host);
    window.selectionEvents = [];
    for (const type of [
      'selectionchange',
      'selectstart',
      'focusin',
      'focusout',
      'pointerdown',
      'pointerup',
      'click',
    ]) {
      document.addEventListener(type, (event) => {
        const selection = document.getSelection();
        window.selectionEvents.push({
          type,
          target: event.target.id,
          selected: selection?.toString(),
          range: selection?.rangeCount ? selection.getRangeAt(0).toString() : null,
          active: document.activeElement?.id,
        });
      });
    }
    const { mountPage } = await import('/client/documents/page-content.ts');
    mountPage(
      host.querySelector('#probe-shadow'),
      '<main class="page"><p><span class="word">shadow</span> reader selectable text</p></main>',
      '.page{font:24px/32px Arial;height:150px}.word{display:inline-block}',
      new Map(),
    );
  });
  const cdp = await context.newCDPSession(page);
  const touch = (type, point) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ ...point, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
  const point = async (selector, offset = 20) => {
    const box = await page.locator(selector).boundingBox();
    return { x: box.x + offset, y: box.y + box.height / 2 };
  };
  const hold = async (selector, offset) => {
    await touch('touchStart', await point(selector, offset));
    await page.waitForTimeout(650);
    await touch('touchEnd');
    await page.locator('.selection-menu').waitFor();
  };
  await hold('#probe-input', 95);
  assert.equal(await page.locator('.selection-handle-start').count(), 1);
  assert.equal(await page.locator('.selection-handle-end').count(), 1);
  assert.equal(
    await page
      .locator('#probe-input')
      .evaluate((node) => node.value.slice(node.selectionStart, node.selectionEnd)),
    'bravo',
  );
  await page.locator('.selection-menu').getByRole('button', { name: '复制', exact: true }).tap();
  assert.equal(await page.evaluate(() => probeClipboard.read()), 'bravo');
  results.push('input word selection and app copy');
  await page.locator('#probe-input').evaluate((node) => {
    node.value = '';
    node.focus();
    node.setSelectionRange(0, 0);
  });
  await hold('#probe-input', 12);
  await page.locator('.selection-menu').getByRole('button', { name: '粘贴', exact: true }).tap();
  assert.equal(await page.locator('#probe-input').inputValue(), 'bravo');
  results.push('app paste without device permission');
  await page.touchscreen.tap(90, 85);
  await page.keyboard.type('Z');
  assert.match(await page.locator('#probe-input').inputValue(), /Z/);
  results.push('tap caret and keyboard editing');
  await hold('#probe-text', 94);
  assert.equal(await page.evaluate(() => document.getSelection().toString()), 'bravo');
  const end = await point('.selection-handle-end', 22);
  await touch('touchStart', end);
  await touch('touchMove', { x: end.x + 100, y: end.y });
  await touch('touchEnd');
  assert.match(await page.evaluate(() => document.getSelection().toString()), /bravo charlie/);
  results.push('local DOM handle drag');
  await page.touchscreen.tap(10, 10);
  await hold('#probe-shadow .word', 30);
  await page.locator('.selection-menu').getByRole('button', { name: '复制', exact: true }).tap();
  assert.equal(await page.evaluate(() => probeClipboard.read()), 'shadow');
  results.push('document shadow-root word selection and copy');
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await touch('touchStart', await point('#probe-button'));
  await page.waitForTimeout(650);
  await touch('touchEnd');
  assert(await page.evaluate(() => document.getSelection().isCollapsed));
  results.push('chrome button never selects');
  const textBox = await page.locator('#probe-text').boundingBox();
  const mouse = (type, x, buttons) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y: textBox.y + 16,
      buttons,
      button: buttons || type === 'mouseReleased' ? 'left' : 'none',
      clickCount: 1,
    });
  await mouse('mouseMoved', textBox.x + 66, 0);
  await mouse('mousePressed', textBox.x + 66, 1);
  for (let step = 1; step <= 8; step++) await mouse('mouseMoved', textBox.x + 66 + step * 8, 1);
  await mouse('mouseReleased', textBox.x + 130, 0);
  const mouseText = await page.evaluate(() => document.getSelection().toString());
  assert(mouseText.length > 2);
  assert.equal(await page.locator('.selection-handle').count(), 0);
  await page.keyboard.press('Control+C');
  await page.waitForFunction((text) => probeClipboard.read() === text, mouseText);
  await page.locator('#probe-input').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+V');
  assert.equal(await page.locator('#probe-input').inputValue(), mouseText);
  results.push('ordinary mouse selection and app clipboard keyboard shortcuts');
  await page.touchscreen.tap(textBox.x + 95, textBox.y + 16);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(textBox.x + 95, textBox.y + 16);
  await page.locator('.selection-handle-start').waitFor();
  assert.equal(await page.evaluate(() => document.getSelection().toString()), 'bravo');
  results.push('touch double tap selects a word');
  assert.equal(
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#probe-text'));
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    }),
    'alpha bravo charlie delta',
  );
  results.push('programmatic selection remains available after touch');
  await page.screenshot({ path: join(run, `${engine}.png`) });
  await page.touchscreen.tap(10, 10);
  await page.evaluate(async () => {
    const { setUiScale } = await import('/client/app/ui-scale.ts');
    setUiScale(1.5);
  });
  await hold('#probe-text', 140);
  const scaled = await page.evaluate(() => {
    const range = document.getSelection().getRangeAt(0).getBoundingClientRect();
    const center = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return rect.left + rect.width / 2;
    };
    return {
      start: center('.selection-handle-start') - range.left,
      end: center('.selection-handle-end') - range.right,
    };
  });
  assert(Math.abs(scaled.start) < 1 && Math.abs(scaled.end) < 1, JSON.stringify(scaled));
  results.push('handles stay on the selection under interface scaling');
  console.log(engine, results);
} catch (error) {
  await writeFile(
    join(run, `${engine}-events.json`),
    JSON.stringify(await page.evaluate(() => selectionEvents), null, 2),
  );
  await page.screenshot({ path: join(run, `${engine}-failure.png`) });
  throw error;
} finally {
  await writeFile(join(run, `${engine}.json`), JSON.stringify(results, null, 2));
  await browser.close();
  await stack.stop();
}
