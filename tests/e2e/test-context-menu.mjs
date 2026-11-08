/**
 * Headed Chrome 157, isolated Control and native H264 context-menu verification.
 * node tests/e2e/test-context-menu.mjs <playwright module> <viewer exe>
 *   <endpoint exe> <browser exe> <unused evidence directory> [port=35140]
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startProductStack, until } from './kit/stack.mjs';

const [modulePath, viewer, endpoint, browser, output, portArg = '35140'] = process.argv.slice(2);
assert(
  modulePath && viewer && endpoint && browser && output,
  'Expected module, executables and evidence directory',
);
const run = resolve(output);
const port = Number(portArg);
assert(Number.isInteger(port) && port >= 35100 && port + 2 <= 35199, 'Use isolated ports 35100–35199');
const origin = `http://127.0.0.1:${port}`;
const fixtureOrigin = `http://127.0.0.1:${port + 1}`;
const { chromium } = createRequire(import.meta.url)(resolve(modulePath));
await mkdir(run);
const html = await readFile(new URL('./fixtures/context-menu.html', import.meta.url));
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQT99AEmIY1TCqYfhqAACGij4QoSpHPwAAAABJRU5ErkJggg==',
  'base64',
);
const remote = [];
const results = [];
const product = [];
let state;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const fixture = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/event') {
    let body = '';
    for await (const chunk of request) body += chunk;
    remote.push(JSON.parse(body));
    response.end();
  } else if (request.url === '/image.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' }).end(image);
  } else
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(html);
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
const deadline = setTimeout(() => void context?.close(), 300000);
const result = (scenario, status, detail) => {
  results.push({ scenario, status, detail });
  console.log(scenario, status, JSON.stringify(detail));
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
  page.setDefaultTimeout(10000);
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message.type === 'state') state = message.state;
        if (message.type === 'state' || message.type === 'error') product.push(message);
      } catch {}
    });
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message.method === 'product.action') product.push(message);
      } catch {}
    });
  });
  await page.addInitScript(() => {
    const q = (window.contextQA = { wire: [], peers: [], channels: [] });
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
                [
                  'layout',
                  'input.contextMenu',
                  'input.selection',
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
  assert.match(version.product, /\/157\./, 'Requires Chrome 157');
  result('platform', 'verified', version.product);
  await page.goto(origin);
  await page.locator('.viewer-lock-blank').waitFor();
  await pause(650);
  for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right']) {
    await page.keyboard.press('Arrow' + direction);
    await pause(55);
  }
  await page.locator('input[autocomplete=username]').fill('context-menu');
  await page.locator('input[autocomplete=new-password]').fill(randomBytes(18).toString('hex'));
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => contextQA.channels.filter((c) => c.readyState === 'open').length === 2);
  await page.getByRole('button', { name: '打开开始屏幕', exact: true }).click();
  await page.locator('.launcher-search input').fill(fixtureOrigin + '/');
  await page.locator('.launcher-search input').press('Enter');
  await until(() => remote.at(-1), 'fixture ready');
  const ready = () =>
    page.waitForFunction(() => {
      const section = document.querySelector('.remote-viewport');
      return (
        section &&
        !section.classList.contains('resize-waiting') &&
        section.querySelector('canvas[data-video-input]:not(.no-frame)') &&
        section.querySelector('video')?.videoWidth > 0
      );
    });
  await ready();
  await until(
    () => state?.workspace.tabs.some((tab) => tab.url === fixtureOrigin + '/'),
    'product fixture tab',
  );
  const original = state.workspace.tabs.find((tab) => tab.url === fixtureOrigin + '/');
  let activeUrl = original.url;
  const latest = () => remote.findLast((entry) => entry.url === activeUrl);
  const project = async (rect) => {
    const canvas = await page.locator('canvas[data-video-input]').boundingBox();
    return {
      x: canvas.x + (rect.x * canvas.width) / latest().width,
      y: canvas.y + (rect.y * canvas.height) / latest().height,
      width: (rect.width * canvas.width) / latest().width,
      height: (rect.height * canvas.height) / latest().height,
    };
  };
  const point = async (id) => {
    const r = await project(latest().geometry[id]);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const click = async (id, options) => {
    const p = await point(id);
    await page.mouse.click(p.x, p.y, options);
    await pause(250);
  };
  const wire = () => page.evaluate(() => contextQA.wire);
  const menuMessage = () =>
    page.evaluate(
      () => contextQA.wire.findLast((entry) => entry.message.type === 'input.contextMenu')?.message,
    );
  const menu = page.getByRole('menu', { name: '页面菜单', exact: true });
  const open = async (id) => {
    const previous = (await menuMessage())?.revision;
    const count = latest().menus.length;
    const p = await point(id);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await menu.waitFor({ state: 'visible' });
    const message = await menuMessage();
    assert(message.menu && message.revision !== previous);
    assert.equal(message.menu.source, 'mouse');
    await until(() => latest().menus.length === count + 1, 'page contextmenu listener');
    return { message, point: p, paper: await page.locator('.page-context-menu').boundingBox() };
  };
  const choose = async (label) => {
    await menu.getByRole('menuitem', { name: label, exact: true }).click();
    await menu.waitFor({ state: 'hidden' });
    await pause(300);
  };
  const escape = async () => {
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await pause(250);
  };
  const hold = async (id) => {
    const p = await point(id);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...p, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    await pause(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await pause(400);
    return p;
  };
  const restoreTab = async () => {
    await page.locator(`[data-tab-id="${original.id}"] .tab-select`).click();
    await ready();
    await pause(400);
  };
  const scenario = async (number, name, action) => {
    try {
      const detail = await action();
      await page.screenshot({ path: join(run, `${number}.png`) });
      result(`${number} ${name}`, 'verified', detail);
    } catch (error) {
      result(`${number} ${name}`, 'failed', error.stack);
      await page.screenshot({ path: join(run, `${number}-failure.png`) }).catch(() => {});
      if (await menu.isVisible().catch(() => false)) await escape().catch(() => {});
    }
  };
  await pause(700);
  await scenario(1, 'mouse link', async () => {
    const first = await open('link');
    assert.equal(first.message.menu.link.url, fixtureOrigin + '/linked');
    assert(
      Math.abs(first.paper.x - first.point.x) <= 4 && Math.abs(first.paper.y - first.point.y) <= 4,
      JSON.stringify(first),
    );
    await menu.getByRole('menuitem', { name: '在新标签页中打开链接', exact: true }).waitFor();
    await page.screenshot({ path: join(run, '1-menu.png') });
    await choose('复制链接地址');
    await click('paste');
    await page.keyboard.press('Control+V');
    await until(() => latest().pasted === fixtureOrigin + '/linked', 'link address pasted with Ctrl+V');
    await open('link');
    await choose('在新标签页中打开链接');
    const created = await until(
      () =>
        state.workspace.tabs.find((tab) => tab.id !== original.id && tab.url === fixtureOrigin + '/linked'),
      'link tab',
    );
    assert.equal(created.windowId, original.windowId);
    await until(() => remote.some((entry) => entry.url === created.url), 'new tab loaded link');
    await restoreTab();
    return { first, pasted: latest().pasted, created };
  });
  await scenario(2, 'touch link', async () => {
    const p = await hold('link');
    await menu.waitFor({ state: 'visible' });
    const message = await menuMessage();
    assert.equal(message.menu.source, 'touch');
    assert.equal(message.menu.link.url, fixtureOrigin + '/linked');
    const paper = await page.locator('.page-context-menu').boundingBox();
    assert(paper.y >= p.y + 15, JSON.stringify({ paper, p }));
    await page.screenshot({ path: join(run, '2-menu.png') });
    await escape();
    return { message, point: p, paper };
  });
  await scenario(3, 'editable roundtrip', async () => {
    const loads = latest().loadCount;
    await open('blank');
    await choose('重新加载');
    await until(() => latest().loadCount > loads, 'fresh document for edit history');
    await ready();
    const first = await open('editor');
    const flags = first.message.menu.editable;
    assert.equal(flags.undo, false);
    assert.equal(flags.redo, false);
    for (const [label, key] of [
      ['撤销', 'undo'],
      ['重做', 'redo'],
      ['剪切', 'cut'],
      ['复制', 'copy'],
      ['粘贴', 'paste'],
      ['全选', 'selectAll'],
    ])
      assert.equal(
        await menu.getByRole('menuitem', { name: label, exact: true }).isEnabled(),
        flags[key],
        label,
      );
    assert.equal(flags.paste, true, 'Browser clipboard contains the copied URL');
    await page.screenshot({ path: join(run, '3-menu.png') });
    await choose('全选');
    await until(() => latest().start === 0 && latest().end === latest().value.length, 'select all');
    await open('editor');
    await choose('剪切');
    await until(() => latest().value === '', 'cut input text');
    await open('editor');
    await choose('粘贴');
    await until(() => latest().value === 'context roundtrip', 'paste roundtrip');
    return { flags, value: latest().value };
  });
  await scenario(4, 'Bing search of host-like selection', async () => {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('combobox', { name: '默认搜索引擎', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Bing', exact: true }).click();
    await until(() => state.workspace.settings.browser.searchEngine === 'bing', 'Bing settings saved');
    await page.getByRole('button', { name: '关闭浏览器设置', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const r = await project(latest().geometry.word);
    await page.mouse.move(r.x + 1, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width - 1, r.y + r.height / 2, { steps: 20 });
    await until(() => latest().selection === 'example.com', 'mouse drag selects full text');
    await page.mouse.up();
    await until(() => latest().selection === 'example.com', 'mouse selection');
    const opened = await open('word');
    assert.equal(opened.message.menu.selection, 'example.com');
    await menu.getByRole('menuitem', { name: '复制', exact: true }).waitFor();
    await page.screenshot({ path: join(run, '4-menu.png') });
    await choose('使用Bing搜索"example.com"');
    const created = await until(
      () => state.workspace.tabs.find((tab) => tab.url === 'https://www.bing.com/search?q=example.com'),
      'Bing search tab',
    );
    assert.equal(created.windowId, original.windowId);
    await restoreTab();
    await click('blank');
    return { menu: opened.message, created };
  });
  await scenario(5, 'history and reload', async () => {
    await click('blank');
    const first = await open('blank');
    const initialTab = state.workspace.tabs.find((tab) => tab.id === original.id);
    assert.equal(
      await menu.getByRole('menuitem', { name: '返回', exact: true }).isEnabled(),
      !!initialTab.canGoBack,
    );
    assert.equal(
      await menu.getByRole('menuitem', { name: '前进', exact: true }).isEnabled(),
      !!initialTab.canGoForward,
    );
    const loads = latest().loadCount;
    await choose('重新加载');
    await until(() => latest().loadCount > loads, 'fixture reload count');
    await ready();
    const reloaded = latest().loadCount;
    await click('next');
    activeUrl = fixtureOrigin + '/history';
    await until(
      () => latest() && state.workspace.tabs.find((tab) => tab.id === original.id)?.url === activeUrl,
      'history navigation',
    );
    await ready();
    await open('blank');
    assert(await menu.getByRole('menuitem', { name: '返回', exact: true }).isEnabled());
    assert(!(await menu.getByRole('menuitem', { name: '前进', exact: true }).isEnabled()));
    await choose('返回');
    activeUrl = fixtureOrigin + '/';
    await until(
      () => state.workspace.tabs.find((tab) => tab.id === original.id)?.url === activeUrl,
      'back navigation',
    );
    await ready();
    await open('blank');
    assert(await menu.getByRole('menuitem', { name: '前进', exact: true }).isEnabled());
    await page.screenshot({ path: join(run, '5-menu.png') });
    await escape();
    return { initial: first.message, initialTab, loads, reloaded };
  });
  await scenario(6, 'close and reopen', async () => {
    const ids = [];
    for (const reason of ['escape', 'outside', 'item']) {
      const before = await wire();
      const first = await open('link');
      ids.push(first.message.menu.id);
      if (reason === 'escape') await escape();
      else if (reason === 'outside') {
        await page.mouse.click(15, 15);
        await menu.waitFor({ state: 'hidden' });
        await pause(250);
      } else await choose('复制链接地址');
      await until(async () => !(await menuMessage())?.menu, 'Browser menu closed');
      const commands = (await wire())
        .slice(before.length)
        .filter((entry) => entry.direction === 'out' && entry.message.event?.type === 'context_command');
      assert.equal(commands.length, 1, JSON.stringify(commands));
      assert.equal(commands[0].message.event.command, reason === 'item' ? 'copyLinkAddress' : 'dismiss');
      const second = await open('link');
      assert(BigInt(second.message.menu.id) > BigInt(first.message.menu.id));
      ids.push(second.message.menu.id);
      await escape();
    }
    return { ids, pageEvents: latest().menus };
  });
  await scenario(7, 'touch selection more', async () => {
    await hold('word');
    await until(() => latest().selection.length > 0, 'touch word selection');
    const quick = page.locator('.selection-menu');
    await quick.getByRole('button', { name: '更多', exact: true }).waitFor();
    const selection = await page.evaluate(
      () => contextQA.wire.findLast((entry) => entry.message.type === 'input.selection')?.message,
    );
    assert.equal(selection.menu.more, true);
    await page.screenshot({ path: join(run, '7-quick.png') });
    await quick.getByRole('button', { name: '更多', exact: true }).tap();
    await menu.waitFor({ state: 'visible' });
    const message = await menuMessage();
    assert.equal(message.menu.source, 'touch');
    assert.equal(message.menu.selection, latest().selection);
    await menu.getByRole('menuitem', { name: '复制', exact: true }).waitFor();
    await menu.getByRole('menuitem', { name: /^使用Bing搜索/ }).waitFor();
    await page.screenshot({ path: join(run, '7-menu.png') });
    await escape();
    await click('blank');
    return { selection, message };
  });
  await scenario(8, 'image clipboard', async () => {
    const opened = await open('image');
    assert.equal(opened.message.menu.image.src, fixtureOrigin + '/image.png');
    await page.screenshot({ path: join(run, '8-menu.png') });
    await choose('复制图片地址');
    await click('paste');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+V');
    await until(() => latest().pasted === fixtureOrigin + '/image.png', 'image address paste');
    await open('image');
    await choose('复制图片');
    await pause(400);
    const pastes = latest().pastes.length;
    await click('rich');
    await page.keyboard.press('Control+V');
    await until(() => latest().pastes.length > pastes, 'image clipboard paste event');
    await pause(300);
    const pasted = latest().pastes.at(-1);
    assert(pasted.types.length > 0);
    return { address: latest().pasted, paste: pasted, rich: latest().rich, images: latest().images };
  });
  await scenario(9, 'IME focus restoration', async () => {
    await click('editor');
    await page.waitForFunction(() => document.activeElement?.matches('.remote-input'));
    const before = latest().value;
    await open('editor');
    await page.keyboard.press('ArrowDown');
    assert(await menu.isVisible(), 'Menu closed while moving keyboard focus between items');
    await escape();
    assert(
      await page.evaluate(() => document.activeElement?.matches('.remote-input')),
      'Editor proxy focus was not restored',
    );
    await page.keyboard.press('End');
    await page.keyboard.insertText(' focus-restored');
    await until(() => latest().value === before + ' focus-restored', 'typing after Esc');
    return { before, after: latest().value, focused: latest().focused };
  });
  const codecs = await page.evaluate(async () => {
    const stats = await contextQA.peers[0].getStats();
    return [...stats.values()]
      .filter((s) => s.type === 'inbound-rtp' && s.kind === 'video')
      .map((s) => ({ framesDecoded: s.framesDecoded, codec: stats.get(s.codecId)?.mimeType }));
  });
  assert(codecs.some((s) => s.codec === 'video/H264' && s.framesDecoded > 0));
  const rejected = (await wire()).filter(
    (entry) => entry.message.type === 'input.result' && !entry.message.ok,
  );
  result('transport', rejected.length ? 'failed' : 'verified', { codecs, rejected });
  if (results.some((entry) => entry.status === 'failed')) process.exitCode = 1;
} catch (error) {
  result('harness', 'failed', error.stack);
  if (page && !page.isClosed()) await page.screenshot({ path: join(run, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  const wire = page && !page.isClosed() ? await page.evaluate(() => contextQA.wire).catch(() => []) : [];
  await writeFile(join(run, 'trace.json'), JSON.stringify({ results, remote, wire, product }, null, 2));
  await context?.close();
  if (control.connected) control.disconnect();
  await Promise.race([stopped, pause(10000)]);
  fixture.closeAllConnections();
  fixture.close();
  console.log('Evidence:', run);
}
