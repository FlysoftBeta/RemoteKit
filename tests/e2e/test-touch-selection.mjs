/**
 * Headed Chrome 157, isolated Control and native H264 touch-selection regression.
 * node tests/e2e/test-touch-selection.mjs <playwright module> <viewer exe>
 *   <endpoint exe> <browser exe> <unused evidence directory> [port=34631]
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startProductStack, until } from './kit/stack.mjs';

const [modulePath, viewer, endpoint, browser, output, portArg = '34631'] = process.argv.slice(2);
assert(
  modulePath && viewer && endpoint && browser && output,
  'Expected module, viewer, endpoint, browser, evidence directory',
);
const run = resolve(output);
const port = Number(portArg);
const origin = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)(resolve(modulePath));
await mkdir(run);
const html = await readFile(new URL('./fixtures/touch-selection.html', import.meta.url));
const remote = [];
const results = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const fixture = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/event') {
    let body = '';
    for await (const chunk of request) body += chunk;
    remote.push(JSON.parse(body));
    response.end();
  } else response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((done, reject) => {
  fixture.once('error', reject);
  fixture.listen(port + 1, '127.0.0.1', done);
});
const control = startProductStack({ run, port, endpoint, browser });
control.stdout.on('data', (data) => void appendFile(join(run, 'control.log'), data));
control.stderr.on('data', (data) => void appendFile(join(run, 'control.log'), data));
const stopped = new Promise((done) => control.once('exit', done));
let context, page;
const deadline = setTimeout(() => void context?.close(), 180000);
const result = (scenario, detail) => {
  results.push({ scenario, detail });
  console.log(scenario, JSON.stringify(detail));
};
try {
  await until(async () => (await fetch(origin + '/api/auth/setup')).ok, 'Control startup');
  context = await chromium.launchPersistentContext(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer),
    headless: false,
    viewport: { width: 1100, height: 1000 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
  });
  page = context.pages()[0];
  page.setDefaultTimeout(12000);
  await page.addInitScript(() => {
    const q = (window.selectionQA = { wire: [], peers: [], channels: [] });
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (raw) {
      if (this.label !== 'remotekit-auth' && typeof raw === 'string') {
        try {
          q.wire.push({ direction: 'out', message: JSON.parse(raw), at: performance.now() });
        } catch {}
      }
      return send.call(this, raw);
    };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) {
        super(...args);
        q.peers.push(this);
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        q.channels.push(channel);
        if (channel.label !== 'remotekit-auth')
          channel.addEventListener('message', (event) => {
            try {
              const message = JSON.parse(event.data);
              if (
                ['layout', 'input.selection', 'input.editable', 'input.result', 'focus'].includes(
                  message.type,
                )
              )
                q.wire.push({ direction: 'in', message, at: performance.now() });
            } catch {}
          });
        return channel;
      }
    };
  });
  const cdp = await context.newCDPSession(page);
  const version = await cdp.send('Browser.getVersion');
  assert.match(version.product, /\/157\./, 'This scenario requires Chrome 157');
  result('platform', version.product);
  await page.goto(origin);
  await page.locator('.viewer-lock-blank').waitFor();
  await pause(650);
  for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right']) {
    await page.keyboard.press('Arrow' + direction);
    await pause(55);
  }
  await page.locator('input[autocomplete=username]').fill('touch-selection');
  await page.locator('input[autocomplete=new-password]').fill(randomBytes(18).toString('hex'));
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => selectionQA.channels.filter((c) => c.readyState === 'open').length === 2);
  await page.getByRole('button', { name: '打开开始屏幕', exact: true }).click();
  await page.locator('.launcher-search input').fill(`http://127.0.0.1:${port + 1}/`);
  await page.locator('.launcher-search input').press('Enter');
  await until(() => remote.at(-1), 'fixture ready');
  await page.waitForFunction(() => {
    const section = document.querySelector('.remote-viewport');
    return (
      section &&
      !section.classList.contains('resize-waiting') &&
      section.querySelector('canvas[data-video-input]:not(.no-frame)') &&
      section.querySelector('video')?.videoWidth > 0
    );
  });
  await pause(800);
  const latest = () => remote.at(-1);
  const project = async (rect) => {
    const canvas = await page.locator('canvas[data-video-input]').boundingBox();
    return {
      x: canvas.x + (rect.x * canvas.width) / latest().width,
      y: canvas.y + (rect.y * canvas.height) / latest().height,
      width: (rect.width * canvas.width) / latest().width,
      height: (rect.height * canvas.height) / latest().height,
    };
  };
  const point = async (rect) => {
    const r = await project(rect);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const touch = (type, p) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ ...p, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
  const tap = async (rect) => {
    await touch('touchStart', await point(rect));
    await pause(60);
    await touch('touchEnd');
    await pause(300);
  };
  const hold = async (rect) => {
    const wireStart = await page.evaluate(() => selectionQA.wire.length);
    await touch('touchStart', await point(rect));
    await pause(700);
    await touch('touchEnd');
    await pause(450);
    const packets = await page.evaluate(
      (from) =>
        selectionQA.wire
          .slice(from)
          .filter((e) => e.direction === 'out' && e.message.type === 'input')
          .map((e) => e.message.event),
      wireStart,
    );
    const presses = packets.filter((e) => e.action === 'longPress');
    assert.equal(presses.length, 1, 'A stationary hold must send exactly one long press');
    assert(presses[0].sampleElapsedUs >= 500000, 'Long press fired before 500ms');
    const terminal = packets.find((e) => e.type === 'touch' && e.action === 'end');
    assert.equal(terminal?.sequenceId, presses[0].sequenceId);
    assert.deepEqual(
      terminal.gestures.map((g) => g.type),
      ['longTap'],
    );
    assert(
      !packets.some((e) =>
        e.gestures?.some((g) => ['scrollBegin', 'pinchBegin', 'flingStart'].includes(g.type)),
      ),
      'Long press started another gesture',
    );
  };
  const selectionMessage = () =>
    page.evaluate(
      () =>
        selectionQA.wire.findLast((e) => e.direction === 'in' && e.message.type === 'input.selection')
          ?.message,
    );
  const menu = async () => {
    await page.locator('.selection-menu').waitFor({ state: 'visible' });
    const message = await selectionMessage();
    assert(message?.menu);
    return message.menu;
  };
  const command = async (label) => {
    await page.locator('.selection-menu').getByRole('button', { name: label, exact: true }).tap();
    await page.locator('.selection-menu').waitFor({ state: 'hidden' });
    await pause(350);
  };
  const crop = async (name, rect) => {
    const image = await page.evaluate((rect) => {
      const video = document.querySelector('.remote-viewport video');
      const surface = selectionQA.wire.findLast((e) => e.message.type === 'layout' && e.message.views.length)
        ?.message.views[0];
      const scaleX = surface.deviceScaleFactor * (surface.mediaScaleX ?? surface.mediaScale ?? 1);
      const scaleY = surface.deviceScaleFactor * (surface.mediaScaleY ?? surface.mediaScale ?? 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(rect.width * scaleX);
      canvas.height = Math.ceil(rect.height * scaleY);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(
        video,
        surface.x + rect.x * scaleX,
        surface.y + rect.y * scaleY,
        rect.width * scaleX,
        rect.height * scaleY,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      return {
        png: canvas.toDataURL('image/png').split(',')[1],
        pixels: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data],
        width: canvas.width,
        height: canvas.height,
      };
    }, rect);
    await writeFile(join(run, name + '.png'), Buffer.from(image.png, 'base64'));
    return image;
  };
  const word = latest().geometry.word;
  const handleRect = { x: word.x - 30, y: word.y + word.height + 2, width: word.width + 60, height: 40 };
  const before = await crop('handles-before', handleRect);
  await hold(word);
  await until(() => latest().selection === 'bravo', 'long press selects bravo');
  const firstMenu = await menu();
  assert(firstMenu.commands.includes('copy'));
  const anchor = await project(firstMenu);
  const projectedWord = await project(word);
  assert(
    Math.abs(anchor.x - projectedWord.x) <= 4 &&
      Math.abs(anchor.y - projectedWord.y) <= 4 &&
      Math.abs(anchor.width - projectedWord.width) <= 4 &&
      Math.abs(anchor.height - projectedWord.height) <= 4,
    'Selection anchor does not match word',
  );
  const pill = await page.locator('.selection-menu').boundingBox();
  assert(
    Math.abs(pill.x + pill.width / 2 - anchor.x - anchor.width / 2) <= 4,
    'Selection menu is not centered on the anchor',
  );
  assert(
    pill.y + pill.height <= anchor.y - 4 || pill.y >= anchor.y + anchor.height + firstMenu.handleHeight + 4,
    'Menu overlaps selection handles',
  );
  result('1 long press', { selection: latest().selection, menu: firstMenu, anchor, pill });
  const after = await crop('handles-after', handleRect);
  const changed = [0, 0];
  for (let i = 0; i < after.pixels.length; i += 4) {
    if (Math.max(...[0, 1, 2].map((c) => Math.abs(after.pixels[i + c] - before.pixels[i + c]))) > 35)
      changed[(i / 4) % after.width < after.width / 2 ? 0 : 1]++;
  }
  result('2 streamed handles', {
    leftChanged: changed[0],
    rightChanged: changed[1],
    width: after.width,
    height: after.height,
  });
  assert(
    changed.every((count) => count >= 100),
    'STOP: teardrop handles absent from streamed video; inspect Aura compositor/layer capture path',
  );
  await page.screenshot({ path: join(run, 'selection-menu.png') });
  const dragBefore = latest();
  const start = await project({
    x: word.x + word.width + 7,
    y: word.y + word.height + 10,
    width: 0,
    height: 0,
  });
  const end = await project({
    x: dragBefore.geometry.extended.x + dragBefore.geometry.extended.width + 20,
    y: word.y + word.height + 10,
    width: 0,
    height: 0,
  });
  await touch('touchStart', { x: start.x, y: start.y });
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', { x: start.x + ((end.x - start.x) * i) / 12, y: start.y });
    await pause(35);
  }
  await touch('touchEnd');
  await until(() => latest().selection.includes('charlie delta'), 'end handle extends selection');
  assert.equal(
    latest().touches.filter((e) => ['touchstart', 'touchmove'].includes(e.type)).length,
    dragBefore.touches.filter((e) => ['touchstart', 'touchmove'].includes(e.type)).length,
    'Handle drag reached the page',
  );
  assert.equal(latest().scrollY, dragBefore.scrollY);
  assert.equal(latest().scrollX, dragBefore.scrollX);
  result('3 handle drag', latest().selection);
  await tap(latest().geometry.blank);
  await hold(word);
  await menu();
  await command('复制');
  await tap(latest().geometry.editor);
  await hold(latest().geometry.editor);
  assert((await menu()).commands.includes('paste'));
  await command('粘贴');
  await until(() => latest().value.includes('bravo'), 'clipboard paste');
  await hold(latest().geometry.editor);
  await menu();
  await command('全选');
  await until(() => latest().start === 0 && latest().end === latest().value.length, 'input select all');
  result('4 clipboard and select all', { value: latest().value, start: latest().start, end: latest().end });
  await tap(latest().geometry.blank);
  await hold(word);
  await menu();
  await tap(latest().geometry.blank);
  await page.locator('.selection-menu').waitFor({ state: 'hidden' });
  const handlesHidden = async (name) => {
    await until(
      async () => {
        const image = await crop(name, handleRect);
        const colored = image.pixels.filter((v, i) => i % 4 === 0 && v < 220).length;
        return colored < 100;
      },
      'streamed handles disappear after ' + name,
      5000,
    );
  };
  await handlesHidden('handles-after-tap');
  await hold(word);
  await menu();
  const mousePoint = await point(latest().geometry.blank);
  await page.mouse.click(mousePoint.x, mousePoint.y);
  await page.locator('.selection-menu').waitFor({ state: 'hidden' });
  await handlesHidden('handles-after-mouse');
  result('5 dismissal', 'touch tap and mouse click hide menu and streamed handles');
  const blockedStart = remote.length;
  const blockedWireStart = await page.evaluate(() => selectionQA.wire.length);
  await hold(latest().geometry.blocked);
  assert(
    remote.slice(blockedStart).every((e) => e.selection === ''),
    'Consumed long press selected text',
  );
  const blockedMenus = await page.evaluate(
    (from) =>
      selectionQA.wire
        .slice(from)
        .filter((e) => e.direction === 'in' && e.message.type === 'input.selection' && e.message.menu),
    blockedWireStart,
  );
  assert.equal(blockedMenus.length, 0, 'Consumed long press briefly opened a menu');
  assert(latest().touches.some((e) => e.type === 'touchstart' && e.target === 'blocked'));
  assert.equal(latest().selection, '');
  assert.equal((await selectionMessage()).menu, null);
  assert.equal(await page.locator('.selection-menu').count(), 0);
  result('6 arbitration', 'preventDefault + touch-action:none suppress selection and menu');
  await tap(latest().geometry.editor);
  const caret = async () => {
    await page.waitForFunction(
      () =>
        document.activeElement?.matches('.remote-input') &&
        !!(selectionQA.wire.findLast((e) => e.message.type === 'input.editable')?.message.editable.flags & 2),
    );
    const editable = await page.evaluate(
      () => selectionQA.wire.findLast((e) => e.message.type === 'input.editable').message.editable,
    );
    const expected = await project({
      x: editable.caretX,
      y: editable.caretY,
      width: editable.caretWidth,
      height: editable.caretHeight,
    });
    const actual = await page.locator('.remote-input').boundingBox();
    assert(
      Math.abs(actual.x - expected.x) <= 4 &&
        Math.abs(actual.y - expected.y) <= 4 &&
        Math.abs(actual.height - expected.height) <= 4,
      `IME proxy misplaced: ${JSON.stringify({ actual, expected })}`,
    );
    return { actual, expected };
  };
  const caretBefore = await caret();
  await page.keyboard.press('End');
  await page.keyboard.insertText('abcdef');
  await until(() => latest().value.includes('abcdef'), 'typing moves remote caret');
  await pause(250);
  const caretAfter = await caret();
  assert(Math.abs(caretAfter.actual.x - caretBefore.actual.x) > 20, 'IME proxy did not move with caret');
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  });
  await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 });
  await until(
    () => latest().compositions.some((e) => e.type === 'compositionupdate' && e.data === '你好'),
    'remote composition',
  );
  await cdp.send('Input.insertText', { text: '你好' });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  });
  await until(
    () =>
      latest().value.includes('abcdef你好') &&
      latest().compositions.some((e) => e.type === 'compositionend' && e.data === '你好'),
    'remote IME commit',
  );
  result('7 IME placement and commit', { caretBefore, caretAfter, value: latest().value });
  const codecs = await page.evaluate(async () => {
    const stats = await selectionQA.peers[0].getStats();
    return [...stats.values()]
      .filter((s) => s.type === 'inbound-rtp' && s.kind === 'video')
      .map((s) => ({ framesDecoded: s.framesDecoded, codec: stats.get(s.codecId)?.mimeType }));
  });
  assert(codecs.some((s) => s.codec === 'video/H264' && s.framesDecoded > 0));
  const rejected = await page.evaluate(() =>
    selectionQA.wire.filter((e) => e.message.type === 'input.result' && !e.message.ok),
  );
  assert.deepEqual(rejected, [], 'Input pipeline rejected an event');
  result('transport', codecs);
} catch (error) {
  result('failure', error.stack);
  if (page && !page.isClosed()) await page.screenshot({ path: join(run, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  clearTimeout(deadline);
  const wire = page && !page.isClosed() ? await page.evaluate(() => selectionQA.wire).catch(() => []) : [];
  await writeFile(join(run, 'trace.json'), JSON.stringify({ results, remote, wire }, null, 2));
  await context?.close();
  if (control.connected) control.disconnect();
  await Promise.race([stopped, pause(10000)]);
  fixture.closeAllConnections();
  fixture.close();
  console.log('Evidence:', run);
}
