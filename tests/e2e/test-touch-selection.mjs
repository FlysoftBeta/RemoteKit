import { startFixture } from './kit/fixtures.mjs';
import { launchPersistentViewer } from './kit/viewer.mjs';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStack, until } from './kit/stack.mjs';

/**
 * Isolated Control and native H264 selection regression on Edge and Chrome 89.
 * node tests/e2e/test-touch-selection.mjs <playwright module> <viewer exe>
 *   <endpoint exe> <browser exe> <unused evidence directory> [port=34120]
 */

const [modulePath, viewer, endpoint, browser, output, portArg = '34120'] = process.argv.slice(2);
assert(
  modulePath && viewer && endpoint && browser && output,
  'Expected module, viewer, endpoint, browser, evidence directory',
);
const run = resolve(output);
const port = Number(portArg);
const origin = `http://127.0.0.1:${port}`;

await mkdir(run, { recursive: true });

const remote = [];
const results = [];
const password = randomBytes(18).toString('hex');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const fixture = await startFixture('test-touch-selection', port + 1, { remote });

const stack = await startStack({
  seed: false,
  fixtures: false,
  ports: { control: port + 3, viewer: port, fixture: port + 1, peer: port + 2 },
  run,
  port,
  endpoint,
  browser,
});
let context, page;
const deadline = setTimeout(() => void context?.close(), 420000);
const result = (scenario, detail) => {
  results.push({ scenario, detail });
  console.log(scenario, JSON.stringify(detail));
};
try {
  await until(async () => (await fetch(origin + '/api/auth/setup')).ok, 'Control startup');
  context = await launchPersistentViewer(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer),
    headless: true,
    viewport: { width: 1100, height: 1000 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
  });
  page = context.pages()[0];
  page.setDefaultTimeout(30000);
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
    q.pending = new Map();
    q.call = (method, params, rtc, id) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          q.pending.delete(id);
          reject(Error('RPC timeout: ' + method));
        }, 30000);
        q.pending.set(id, (message) => {
          clearTimeout(timeout);
          q.pending.delete(id);
          message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result);
        });
        (rtc ? q[method.startsWith('selection.') ? 'browser' : 'service'].channel : q.socket).send(
          JSON.stringify(
            rtc
              ? {
                  type: 'files.request',
                  version: 1,
                  requestId: id,
                  method,
                  params,
                  authEpoch: method.startsWith('selection.') ? q.auth.peerEpoch : q.auth.serviceEpoch,
                }
              : { id, method, params },
          ),
        );
      });
    window.WebSocket = class extends WebSocket {
      constructor(...args) {
        super(...args);
        q.socket = this;
        this.addEventListener('message', ({ data }) => {
          try {
            const message = JSON.parse(data);
            q.pending.get(message.id)?.(message);
            if (message.type === 'state') q.state = message.state;
            if (message.type === 'auth') q.auth = message.auth;
          } catch {}
        });
      }
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
        if (channel.label === 'remotekit') {
          const role = this.getTransceivers().length ? 'browser' : 'service';
          q[role] = { peer: this, channel };
        }
        if (channel.label !== 'remotekit-auth')
          channel.addEventListener('message', (event) => {
            try {
              const message = JSON.parse(event.data);
              q.pending.get(message.requestId)?.(message);
              if (
                [
                  'layout',
                  'input.selection',
                  'input.contextMenu',
                  'input.editable',
                  'input.result',
                  'focus',
                ].includes(message.type)
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
  assert(Number(version.product.match(/\/(\d+)/)[1]) >= 89);
  result('platform', version.product);
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('.viewer-lock-blank').waitFor();
  await pause(650);
  for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right']) {
    await page.keyboard.press('Arrow' + direction);
    await pause(55);
  }
  await page.locator('input[autocomplete=username]').fill('touch-selection');
  await page.locator('input[autocomplete=new-password]').fill(password);
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => selectionQA.channels.some((c) => c.readyState === 'open'));
  await page.evaluate(async (operationId) => {
    const q = selectionQA;
    const receipt = await q.call(
      'operation.submit',
      {
        operationId,
        operationGeneration: q.state.operationGeneration,
        action: { type: 'settings.update', settings: { workspace: { clipboardSync: false } } },
      },
      false,
      operationId,
    );
    if (receipt.status === 'failed') throw Error(JSON.stringify(receipt));
  }, randomUUID());
  await page.waitForFunction(() => selectionQA.state.workspace.settings.workspace.clipboardSync === false);
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
  const call = (method, params = {}, rtc = false) =>
    page.evaluate(({ method, params, rtc, id }) => selectionQA.call(method, params, rtc, id), {
      method,
      params,
      rtc,
      id: randomUUID(),
    });
  const action = (value) =>
    page.evaluate(
      ({ value, id }) =>
        selectionQA.call(
          'operation.submit',
          {
            operationId: id,
            operationGeneration: selectionQA.state.operationGeneration,
            action: value,
          },
          false,
          id,
        ),
      { value, id: randomUUID() },
    );
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
    await page.waitForFunction(
      () =>
        !document.querySelector('.resize-waiting') &&
        !!document.querySelector('canvas[data-video-input]:not(.no-frame)'),
      undefined,
      { timeout: 45000 },
    );
    await touch('touchStart', await point(rect));
    await pause(60);
    await touch('touchEnd');
    await pause(300);
  };
  const hold = async (rect) => {
    await page.waitForFunction(
      () =>
        !document.querySelector('.resize-waiting') &&
        !!document.querySelector('canvas[data-video-input]:not(.no-frame)'),
      undefined,
      { timeout: 45000 },
    );
    await pause(300);
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
        [...selectionQA.wire]
          .reverse()
          .find((e) => e.direction === 'in' && e.message.type === 'input.selection')?.message,
    );
  const menu = async () => {
    await page.locator('.selection-menu').waitFor({ state: 'visible' });
    const message = await selectionMessage();
    assert(message?.menu);
    return message.menu;
  };
  const command = async (label) => {
    await page.locator('.selection-menu').getByRole('button', { name: label, exact: true }).tap();
    if (label !== '全选') await page.locator('.selection-menu').waitFor({ state: 'hidden' });
    await pause(350);
  };
  const crop = async (name, rect) => {
    const image = await page.evaluate((rect) => {
      const video = document.querySelector('.remote-viewport video');
      const surface = [...selectionQA.wire]
        .reverse()
        .find((e) => e.message.type === 'layout' && e.message.views.length)?.message.views[0];
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
  assert.equal(await page.locator('.selection-handle-start').count(), 1);
  assert.equal(await page.locator('.selection-handle-end').count(), 1);
  result('2 Viewer handles and clean video', {
    leftChanged: changed[0],
    rightChanged: changed[1],
    width: after.width,
    height: after.height,
  });
  assert(
    changed.every((count) => count < 20),
    'Chromium handle pixels remain in the streamed frame',
  );
  await page.screenshot({ path: join(run, 'selection-menu.png') });
  const dragBefore = latest();
  const handle = await page.locator('.selection-handle-end').boundingBox();
  const start = { x: handle.x + handle.width / 2, y: handle.y + 16 };
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
  await until(
    async () => (await call('clipboard.get')).text === 'bravo',
    'remote copy reaches app clipboard',
  );
  await page.getByRole('button', { name: '开始', exact: true }).click();
  const search = page.locator('.launcher-search input');
  await search.fill('');
  const searchBox = await search.boundingBox();
  await touch('touchStart', { x: searchBox.x + 18, y: searchBox.y + searchBox.height / 2 });
  await pause(650);
  await touch('touchEnd');
  await page.locator('.selection-menu').getByRole('button', { name: '粘贴', exact: true }).tap();
  assert.equal(await search.inputValue(), 'bravo');
  await page.keyboard.press('Escape');
  result('app clipboard into Viewer search', 'bravo with device sync disabled');
  await tap(latest().geometry.editor);
  await page.waitForFunction(
    () =>
      [...selectionQA.wire].reverse().find((entry) => entry.message.type === 'input.editable')?.message
        .editable.focusSource === 'pointer',
  );
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
        !!(
          [...selectionQA.wire].reverse().find((e) => e.message.type === 'input.editable')?.message.editable
            .flags & 2
        ),
    );
    const editable = await page.evaluate(
      () => [...selectionQA.wire].reverse().find((e) => e.message.type === 'input.editable').message.editable,
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
  if (Number(version.product.match(/\/(\d+)/)[1]) >= 100) {
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
  } else result('CDP composition', 'unavailable in Chrome 89');
  result('7 IME placement and commit', { caretBefore, caretAfter, value: latest().value });
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('alpha bravo charlie');
  await until(() => latest().value === 'alpha bravo charlie', 'populated input');
  const inputWord = { ...latest().geometry.editor, x: latest().geometry.editor.x + 80, width: 30 };
  await hold(inputWord);
  const populated = await menu();
  assert(populated.commands.includes('copy') && populated.commands.includes('cut'));
  await command('复制');
  await tap(latest().geometry.editor);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await until(() => latest().value === '', 'empty input');
  await hold(latest().geometry.editor);
  assert((await menu()).commands.includes('paste'));
  await command('粘贴');
  await until(() => latest().value.length > 0, 'empty input paste');
  result('8 editable long press', { populated, value: latest().value });
  await tap(latest().geometry.editor);
  const insertion = await page.evaluate(
    () =>
      [...selectionQA.wire].reverse().find((entry) => entry.message.type === 'input.editable').message
        .editable,
  );
  await page.locator('.selection-handle-insertion').waitFor();
  const insertionHandle = await page.locator('.selection-handle-insertion').boundingBox();
  await touch('touchStart', { x: insertionHandle.x + 22, y: insertionHandle.y + 16 });
  await pause(650);
  await touch('touchEnd');
  assert((await menu()).commands.includes('paste'));
  await command('粘贴');
  result('8 insertion handle long press', latest().value);
  for (const close of ['outside', 'command', 'reload', 'disconnect', 'escape']) {
    await page.locator('.address-form input').fill(`http://127.0.0.1:${port + 1}/?more=${close}`);
    await page.locator('.address-form input').press('Enter');
    await pause(1200);
    await page.waitForFunction(() => document.querySelector('canvas[data-video-input]:not(.no-frame)'));
    await tap(latest().geometry.blank);
    await hold(latest().geometry.word);
    await menu();
    await page.locator('.selection-menu').getByRole('button', { name: '更多', exact: true }).tap();
    const contextMenu = page.getByRole('menu', { name: '页面菜单', exact: true });
    await contextMenu.waitFor({ state: 'visible' });
    if (close === 'command') await contextMenu.getByRole('menuitem', { name: '复制', exact: true }).tap();
    else if (close === 'escape') await page.keyboard.press('Escape');
    else if (close !== 'disconnect') await page.touchscreen.tap(10, 100);
    if (close !== 'disconnect') {
      await contextMenu.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () =>
          ![...selectionQA.wire].reverse().find((entry) => entry.message.type === 'input.contextMenu')
            ?.message.menu,
      );
    }
    if (close === 'reload' || close === 'disconnect') {
      await page.reload();
      await page.locator('.viewer-lock-blank').waitFor();
      await pause(650);
      for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right']) {
        await page.keyboard.press('Arrow' + direction);
        await pause(55);
      }
      await page.locator('input[type=password]').fill(password);
      await page.getByRole('button', { name: '解锁', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('canvas[data-video-input]:not(.no-frame)'));
      await pause(1000);
    }
    const clicks = latest().clicks;
    await tap(latest().geometry.blank);
    await until(() => latest().clicks > clicks, `tap after more ${close}`);
    const position = await point(latest().geometry.blank);
    const scroll = latest().scrollY;
    await touch('touchStart', { x: position.x + 300, y: position.y + 300 });
    for (let step = 1; step <= 10; ++step) {
      await pause(20);
      await touch('touchMove', { x: position.x + 300, y: position.y + 300 - step * 20 });
    }
    await touch('touchEnd');
    await until(() => latest().scrollY > scroll + 30, `scroll after more ${close}`);
    await page.waitForFunction(() => {
      const wire = selectionQA.wire;
      const end = [...wire]
        .reverse()
        .find(
          (entry) =>
            entry.direction === 'out' &&
            entry.message.type === 'input' &&
            entry.message.event?.type === 'touch' &&
            entry.message.event.action === 'end',
        )?.message.event;
      if (!end?.gestures.some((gesture) => gesture.type === 'flingStart')) return true;
      return wire.some(
        (entry) =>
          entry.direction === 'out' &&
          entry.message.type === 'input' &&
          entry.message.event?.sequenceId === end.sequenceId &&
          ['momentumEnd', 'cancel'].includes(entry.message.event.action),
      );
    });
    await pause(150);
    result(`9 more ${close}`, { clicks: latest().clicks });
  }
  const readerText = Buffer.from('Reader alpha bravo charlie delta.\n');
  const upload = await call(
    'asset.begin',
    {
      requestId: 'library',
      operationId: randomUUID(),
      name: 'Selection reader.txt',
      type: 'text/plain',
      size: readerText.length,
    },
    true,
  );
  await call(
    'asset.chunk',
    { requestId: 'library', uploadId: upload.uploadId, offset: 0, data: readerText.toString('base64') },
    true,
  );
  const sealed = await call('asset.seal', { requestId: 'library', uploadId: upload.uploadId }, true);
  await call('library.import', {
    operationId: randomUUID(),
    assetId: sealed.assetId,
    name: 'Selection reader.txt',
    destination: 'library',
    origin: { kind: 'files', channel: 'upload', partitionId: null },
  });
  await action({ type: 'window.open', appId: 'files', placement: { mode: 'space' } });
  const file = page.getByRole('button', { name: 'Selection reader.txt', exact: true });
  await file.waitFor();
  const tile = await file.boundingBox();
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await touch('touchStart', { x: tile.x + 20, y: tile.y + 20 });
  await pause(650);
  await touch('touchEnd');
  assert(await page.evaluate(() => document.getSelection().isCollapsed));
  await page.getByRole('button', { name: '退出选择', exact: true }).click();
  await file.click();
  await page.getByRole('menuitem', { name: '预览', exact: true }).click();
  const wordNode = page.locator('.document-viewer-page-body .word').filter({ hasText: 'Reader' }).first();
  await wordNode.waitFor({ timeout: 60000 });
  const readerWord = await wordNode.boundingBox();
  await touch('touchStart', {
    x: readerWord.x + readerWord.width / 2,
    y: readerWord.y + readerWord.height / 2,
  });
  await pause(650);
  await touch('touchEnd');
  await page.locator('.selection-handle-start').waitFor();
  await page.locator('.selection-menu').getByRole('button', { name: '复制', exact: true }).tap();
  const clipboard = await call('clipboard.get');
  assert.equal(clipboard.text, 'Reader');
  assert(
    (await call('library.get')).entries.some(
      (entry) => entry.kind === 'snippet' && entry.preview === 'Reader',
    ),
  );
  await page.screenshot({ path: join(run, 'document-selection.png') });
  result('document shadow-root selection and snippet', clipboard.text);
  const codecs = await page.evaluate(async () => {
    const stats = await selectionQA.browser.peer.getStats();
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
  await stack.stop();
  fixture.closeAllConnections();
  fixture.close();
  console.log('Evidence:', run);
}
