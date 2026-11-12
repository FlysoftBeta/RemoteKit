// Real Viewer journeys. Test hooks only read authoritative state or reveal unlock.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startStack, until } from './kit/stack.mjs';
import { launch } from './kit/viewer.mjs';

const root = resolve(process.argv[2] ?? 'develop/tmp/e2e-shell/journeys');
mkdirSync(root, { recursive: true });
const stack = await startStack({
  scenario: 'shell-journeys',
  port: 34070,
  seed: false,
  run: join(root, 'stack'),
});
stack.username = 'shell-admin';
stack.password = 'shell-journey-password';
const results = [];
const variants = [
  ['edge', false],
  ['edge', true],
  ['chrome89', false],
  ['chrome89', true],
];
let memberAbsentAt;
let memberTab;
let normalContext;
let normalBrowser;
let viewer;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function record(value) {
  results.push(value);
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(value));
}

async function prepare(browser, phone, first = false) {
  const name = browser + (phone ? '-phone' : '-desktop');
  const out = join(root, name);
  const v = await launch({ browser, pointer: phone ? 'touch' : 'mouse', out, stack, initialAuth: false });
  const { page, context } = v;
  page.setDefaultTimeout(30000);
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await page.addInitScript(() => {
    window.shellQA = { peers: [], sockets: [], errors: [], wire: [] };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) {
        super(...args);
        shellQA.peers.push(this);
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        channel.addEventListener('message', (event) => {
          try {
            const m = JSON.parse(event.data);
            if (m.error || m.type === 'input.result') shellQA.wire.push(m);
          } catch {}
        });
        return channel;
      }
    };
    const Socket = WebSocket;
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args);
        shellQA.sockets.push(this);
        this.addEventListener('message', (event) => {
          try {
            const m = JSON.parse(event.data);
            if (m.error) shellQA.errors.push(m);
          } catch {}
        });
      }
    };
  });
  const shot = async (label) => {
    await page.screenshot({ path: join(out, label + '.png') });
    writeFileSync(
      join(out, label + '.json'),
      JSON.stringify(
        await page.evaluate(() => ({
          state: window.__remotekitTest?.state(),
          text: document.body.innerText,
          peers: window.shellQA?.peers.map((p) => p.connectionState),
          errors: window.shellQA?.errors,
          wire: window.shellQA?.wire,
        })),
        null,
        2,
      ),
    );
  };
  const click = async (locator, double = false) => {
    await locator.waitFor({ state: 'visible' });
    await until(() => locator.isEnabled(), 'control enabled', 90000);
    appendFileSync(
      join(out, 'actions.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        action: 'click',
        text: (await locator.innerText()).slice(0, 120),
        aria: await locator.getAttribute('aria-label'),
      }) + '\n',
    );
    await locator.scrollIntoViewIfNeeded();
    const b = await until(
      async () => {
        const a = await locator.boundingBox();
        if (!a) return;
        await pause(180);
        const b = await locator.boundingBox();
        if (!b || Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || Math.abs(a.width - b.width) > 1)
          return;
        const exposed = await locator.evaluate((el) => {
          const b = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
        });
        return exposed && b;
      },
      'stable exposed control',
      30000,
    );
    assert(b);
    if (phone) {
      for (let i = 0; i < (double ? 2 : 1); i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [
            { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1, radiusX: 3, radiusY: 3, force: 1 },
          ],
        });
        await pause(85);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        if (double) await pause(100);
      }
    } else
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, {
        clickCount: double ? 2 : 1,
        delay: 70,
      });
    await pause(320);
  };
  const type = async (locator, text) => {
    await click(locator);
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(text);
    await pause(200);
  };
  const pointTap = async (x, y) => {
    if (!phone) return page.mouse.click(x, y);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1, radiusX: 3, radiusY: 3, force: 1 }],
    });
    await pause(90);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const button = (label, scope = page) => scope.getByRole('button', { name: label, exact: true });
  const menu = (label) => page.getByRole('menuitem', { name: label, exact: true });
  const state = () => page.evaluate(() => window.__remotekitTest.state());
  const waitState = (probe, label) => until(async () => probe(await state()), label, 90000);
  const start = async () => {
    await page.locator('.launcher.overlay-exiting').waitFor({ state: 'hidden' });
    if (!(await page.getByRole('dialog', { name: '开始屏幕' }).isVisible())) await click(button('开始'));
    await page.getByRole('dialog', { name: '开始屏幕' }).waitFor();
    await pause(450);
  };
  const tile = (label) =>
    page
      .getByRole('dialog', { name: '开始屏幕' })
      .locator('[data-tile-key]')
      .filter({ has: page.getByText(label, { exact: true }) })
      .first();
  const open = async (label) => {
    await start();
    await click(tile(label));
    await page.getByRole('dialog', { name: '开始屏幕' }).waitFor({ state: 'hidden' });
  };
  const frame = async (app) => {
    const s = await state();
    const active = s.workspace.spaces.find((space) => space.id === s.workspace.activeSpaceId);
    const win =
      s.workspace.windows.find((w) => w.appId === app && active?.windowIds.includes(w.id)) ??
      s.workspace.windows.find((w) => w.appId === app);
    assert(win, app + ' exists');
    return page.locator(`[data-window-id="${win.id}"]`);
  };
  const alone = async (app) => {
    const f = await frame(app);
    const id = await f.getAttribute('data-window-id');
    await click(button('窗口把手', f));
    await click(menu('移到新窗口组'));
    await waitState(
      (s) =>
        s.workspace.spaces.some(
          (g) => g.id === s.workspace.activeSpaceId && g.windowIds.length === 1 && g.windowIds[0] === id,
        ),
      'window moved alone',
    );
    await pause(800);
    return f;
  };
  const closeWindow = async (f) => {
    const id = await f.getAttribute('data-window-id');
    await click(button('窗口把手', f));
    await click(menu('关闭窗口'));
    await waitState((s) => !s.workspace.windows.some((w) => w.id === id), 'window closed');
    await pause(600);
  };
  const navigation = async (url, f) => {
    const box = (f ?? page).getByRole('textbox', { name: '搜索或输入网址', exact: true }).first();
    await type(box, url);
    await page.keyboard.press('Enter');
    await waitState((s) => s.workspace.tabs.some((t) => t.url === url && !t.loading), 'navigate ' + url);
    await page.locator('canvas[data-video-input]:not(.no-frame)').first().waitFor();
    await pause(1200);
  };
  const section = async (f, label) => {
    const tabs = f.getByRole('tab', { name: label, exact: true });
    if (await tabs.count()) await click(tabs);
    else await click(button(label, f));
  };
  const settingsSection = async (f, label) => {
    if (await page.getByRole('dialog', { name: '开始屏幕' }).isVisible()) {
      await click(button('关闭开始屏幕'));
      await page.getByRole('dialog', { name: '开始屏幕' }).waitFor({ state: 'hidden' });
    }
    const back = button('返回设置分区', f);
    if (await back.isVisible()) await click(back);
    await click(button(label, f));
  };
  const reveal = async () => {
    await page.locator('.viewer-lock-blank').waitFor();
    await pause(500);
    if (phone) {
      const { width, height } = page.viewportSize();
      for (const [x, y] of [
        [0.5, 0.25],
        [0.5, 0.25],
        [0.5, 0.75],
        [0.5, 0.75],
        [0.25, 0.5],
        [0.75, 0.5],
        [0.25, 0.5],
        [0.75, 0.5],
      ]) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: x * width, y: y * height, id: 1 }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await pause(120);
      }
    } else
      for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right']) {
        await page.keyboard.press('Arrow' + direction);
        await pause(80);
      }
  };
  const login = async (username = stack.username, password = stack.password, setup = false) => {
    await page.goto(stack.origin);
    await reveal();
    await type(page.locator('input[autocomplete="username"]'), username);
    await type(
      page.locator(`input[autocomplete="${setup ? 'new-password' : 'current-password'}"]`),
      password,
    );
    await click(page.locator('button[type="submit"]'));
    await button('开始').waitFor({ timeout: 120000 });
    await waitState((s) => !!s, 'first snapshot');
  };
  const unlock = async () => {
    if (await button('开始').isVisible()) return;
    await reveal();
    await type(page.locator('input[autocomplete="current-password"]'), stack.password);
    await click(button('解锁'));
    await button('开始').waitFor();
  };
  const step = async (label, action) => {
    try {
      if (!page.isClosed() && (await page.locator('.viewer-lock-blank').isVisible())) await unlock();
      await action();
      if (!page.isClosed()) await shot(label);
      record({ variant: name, step: label, status: 'pass' });
    } catch (error) {
      await shot('FAIL-' + label).catch(() => {});
      record({ variant: name, step: label, status: 'fail', error: String(error.stack) });
      await page.keyboard.press('Escape').catch(() => {});
    }
  };
  return {
    ...v,
    name,
    phone,
    cdp,
    shot,
    click,
    type,
    pointTap,
    button,
    menu,
    state,
    waitState,
    start,
    tile,
    open,
    frame,
    alone,
    closeWindow,
    navigation,
    section,
    settingsSection,
    reveal,
    login,
    unlock,
    step,
  };
}

try {
  for (let i = 0; i < variants.length; i++) {
    const [browser, phone] = variants[i];
    viewer = await prepare(browser, phone, i === 0);
    const q = viewer,
      { page, click, type, button, menu } = q;
    await q.step('01-first-visit', () => q.login(stack.username, stack.password, i === 0));
    await q.step('02-admin-member-announcement', async () => {
      while ((await q.state()).workspace.windows.length) {
        const s = await q.state();
        const space = s.workspace.spaces.find((s) => s.windowIds.length);
        await q.start();
        await click(page.locator(`[data-space-card="${space.id}"]`));
        const win = space.focusedWindowId ?? space.windowIds[0];
        await q.closeWindow(page.locator(`[data-window-id="${win}"]`));
      }
      await q.open('管理');
      const f = await q.alone('admin');
      await q.section(f, '用户');
      if (i === 0) {
        await click(button('新建用户', f));
        const d = page.getByRole('dialog', { name: '新建用户' });
        await type(d.getByLabel('用户名'), 'shell-member');
        await type(d.getByLabel('密码', { exact: true }), stack.password);
        await click(button('创建', d));
        await d.waitFor({ state: 'hidden' });
        await f.getByText('shell-member', { exact: true }).waitFor();
      }
      await q.section(f, '公告');
      await click(button('发布公告', f));
      let d = page.getByRole('dialog', { name: '发布公告' });
      await type(d.getByLabel('标题'), 'Shell maintenance ' + i);
      await type(d.getByLabel('内容'), 'Today: save your work.\nPlease return after maintenance.');
      await click(button('发布', d));
      await d.waitFor({ state: 'hidden' });
      await click(button('编辑', f).last());
      d = page.getByRole('dialog', { name: '编辑公告' });
      await type(d.getByLabel('内容'), 'Updated: maintenance postponed.');
      await click(button('保存', d));
      await d.waitFor({ state: 'hidden' });
      await q.section(f, '节点');
      await f.getByText('公钥指纹', { exact: true }).waitFor();
      assert(/[0-9a-f]{16}/.test(await f.innerText()), 'node fingerprint');
      await q.shot('admin-node-fingerprint');
      await q.section(f, '存储');
      await pause(1500);
      await q.shot('admin-storage');
      await q.closeWindow(f);
    });
    if (i === 0) {
      await q.step('03-member-real-login', async () => {
        normalBrowser = await q.browser
          .browserType()
          .launch({
            executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            headless: true,
          });
        normalContext = await normalBrowser.newContext({ viewport: { width: 1600, height: 1000 } });
        const other = await normalContext.newPage();
        await other.goto(stack.origin);
        await other.locator('.viewer-lock-blank').waitFor();
        await pause(600);
        for (const key of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'])
          await other.keyboard.press('Arrow' + key);
        const user = other.locator('input[autocomplete="username"]');
        await user.click();
        await other.keyboard.type('shell-member', { delay: 80 });
        await other.locator('input[autocomplete="current-password"]').click();
        await other.keyboard.type(stack.password, { delay: 50 });
        await other.locator('button[type="submit"]').click();
        const announcement = other.getByRole('dialog', { name: 'Shell maintenance 0' });
        await announcement.waitFor({ timeout: 120000 });
        await other.screenshot({ path: join(root, 'member-announcement.png') });
        await announcement.getByRole('button', { name: '知道了' }).click();
        await other.getByRole('button', { name: '开始', exact: true }).click();
        await other
          .locator('[data-tile-key]')
          .filter({ has: other.getByText('浏览器', { exact: true }) })
          .click();
        const address = other.getByRole('textbox', { name: '搜索或输入网址', exact: true }).first();
        await address.fill(stack.fixture + '/notes/normal-absence');
        await address.press('Enter');
        await other.waitForFunction(() =>
          window.__remotekitTest
            ?.state()
            ?.workspace.tabs.some((t) => t.url.endsWith('/normal-absence') && !t.loading),
        );
        memberTab = await other.evaluate(() => window.__remotekitTest.state().workspace.tabs[0]);
        await other.screenshot({ path: join(root, 'member-before-absence.png') });
        await other.close();
        memberAbsentAt = Date.now();
      });
    }
    await q.step('04-daily-windows-spaces', async () => {
      await q.open('浏览器');
      let f = await q.alone('browser');
      await q.navigation(stack.fixture + '/flow/A', f);
      await q.navigation(stack.fixture + '/flow/B', f);
      await q.navigation(stack.fixture + '/notes/', f);
      await q.open('我的文件');
      await q.open('设置');
      await pause(1000);
      await q.shot('daily-three-windows');
      if (phone) {
        const sw = page.locator('.narrow-window-switcher');
        await sw.waitFor();
        await click(sw.getByRole('button', { name: '我的文件', exact: true }));
        await click(sw.getByRole('button').first());
        await q.shot('phone-window-switcher');
      }
      await q.start();
      await click(button('新窗口组', page.getByRole('dialog', { name: '开始屏幕' })));
      await click(q.tile('我的文件'));
      await pause(700);
      await q.start();
      const cards = page.locator('[data-space-card]');
      assert((await cards.count()) >= 2);
      await click(cards.first());
      await pause(700);
      const files = (await q.state()).workspace.windows.find((w) => w.appId === 'files');
      if (files) {
        const ff = page.locator(`[data-window-id="${files.id}"]`);
        if (await ff.isVisible()) await q.closeWindow(ff);
      }
      // Leave the Browser alone for the media/network journey.
      await q.open('浏览器');
      f = await q.alone('browser');
      await q.navigation(stack.fixture + '/notes/typing-' + i, f);
    });
    await q.step('05-install-launch-uninstall', async () => {
      await q.open('浏览器');
      const f = await q.alone('browser');
      await q.navigation(stack.fixture + '/notes/', f);
      await click(button('更多', f));
      await click(page.getByRole('menuitem', { name: /安装为 App/ }));
      const d = page.getByRole('dialog', { name: '安装为 App' });
      await d.waitFor();
      await d.getByText('正在读取网页信息').waitFor({ state: 'hidden' });
      await click(button('安装', d));
      await d.waitFor({ state: 'hidden' });
      await q.waitState((s) => s.workspace.apps.some((a) => a.name === 'Workspace Notes'), 'App installed');
      await q.open('Workspace Notes');
      await q.waitState((s) => s.workspace.windows.some((w) => w.appId.startsWith('web:')), 'App launch');
      await q.shot('app-running');
      await q.open('设置');
      const sf = await q.alone('settings');
      await q.settingsSection(sf, 'App');
      await click(sf.getByText('Workspace Notes', { exact: true }).first());
      await click(button('卸载', sf));
      const uninstall = page.getByRole('dialog', { name: '卸载 Workspace Notes？' });
      await click(button('卸载', uninstall));
      await q.waitState(
        (s) => !s.workspace.apps.length && !s.workspace.windows.some((w) => w.appId.startsWith('web:')),
        'App uninstall removes windows',
      );
      await q.closeWindow(sf);
    });
    await q.step('06-network-navigation-typing', async () => {
      await q.open('浏览器');
      const f = await q.alone('browser');
      await q.navigation(stack.fixture + '/notes/network-' + i, f);
      const canvas = f.locator('canvas[data-video-input]:not(.no-frame)');
      await canvas.waitFor();
      let b = await canvas.boundingBox();
      await q.pointTap(b.x + 65, b.y + 200);
      await page.keyboard.type('Before outage', { delay: 90 });
      await q.cdp.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });
      // Chromium's Network domain leaves existing UDP/WS sessions alive. Close those
      // transports under offline emulation to exercise a complete network loss.
      await page.evaluate(() => {
        shellQA.sockets.forEach((s) => s.close());
        shellQA.peers.forEach((p) => p.close());
      });
      await page.keyboard.type(' while offline', { delay: 90 });
      await pause(3000);
      await q.shot('network-offline-typing');
      assert.equal(await button('重试').count(), 0);
      await q.cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await pause(5000);
      await q.unlock();
      await until(
        () => page.evaluate(() => shellQA.peers.some((p) => p.connectionState === 'connected')),
        'RTC reconverges',
        90000,
      );
      await q.navigation(stack.fixture + '/flow/C', f);
      const address = f.getByRole('textbox', { name: '搜索或输入网址', exact: true });
      await type(address, stack.fixture + '/flow/D');
      await page.keyboard.press('Enter');
      await q.cdp.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });
      await pause(4000);
      await q.shot('network-offline-navigation');
      assert.equal(await button('重试').count(), 0);
      await q.cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await pause(5000);
      await q.unlock();
      await q.waitState(
        (s) => s.workspace.tabs.some((t) => t.url === stack.fixture + '/flow/D' && !t.loading),
        'navigation converges',
      );
      await q.navigation(stack.fixture + '/notes/network-final-' + i, f);
      b = await canvas.boundingBox();
      await q.pointTap(b.x + 65, b.y + 200);
      await page.keyboard.type('Recovered ' + i, { delay: 90 });
      await until(
        async () => {
          const es = await (await fetch(stack.fixture + '/events')).json();
          return es.some((e) => e.path === '/notes/network-final-' + i && e.value === 'Recovered ' + i);
        },
        'typing after recovery',
        30000,
      );
    });
    await q.step('07-keepalive-return', async () => {
      const f = await q.frame('browser');
      await q.navigation(stack.fixture + '/notes/keepalive-' + i, f);
      await click(button('更多', f));
      await click(page.getByRole('menuitemcheckbox', { name: /挂机模式/ }));
      await q.waitState((s) => s.workspace.tabs.some((t) => t.idleKeepAlive), 'keepalive enabled');
      const context = q.context;
      await page.close();
      await pause(12000);
      const next = await context.newPage();
      // Reuse this context's cookies, then real reveal and password entry.
      await next.goto(stack.origin);
      await next.locator('.viewer-lock-blank').waitFor();
      await pause(600);
      for (const key of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'])
        await next.keyboard.press('Arrow' + key);
      await next.locator('input[autocomplete="current-password"]').click();
      await next.keyboard.type(stack.password, { delay: 50 });
      await next.getByRole('button', { name: '解锁', exact: true }).click();
      await next.getByText(/挂机期间页面保持运行/).waitFor({ timeout: 90000 });
      await next.screenshot({ path: join(q.out, 'keepalive-return-notice.png') });
      writeFileSync(
        join(q.out, 'keepalive-return.json'),
        JSON.stringify(
          await next.evaluate(() => ({ state: __remotekitTest.state(), text: document.body.innerText })),
          null,
          2,
        ),
      );
      await next.close();
    });
    // Closing the Viewer above is deliberate. A fresh login continues security/admin tasks.
    await q.close();
    viewer = await prepare(browser, phone);
    const r = viewer;
    await r.login();
    // A previously published announcement may be waiting behind the unlock panel.
    for (const d of await r.page.getByRole('dialog').all()) {
      const ok = d.getByRole('button', { name: '知道了' });
      if (await ok.count()) await r.click(ok);
    }
    await r.step('08-idle-lock-unlock-diagnostics', async () => {
      await r.open('设置');
      const sf = await r.alone('settings');
      await r.settingsSection(sf, '安全');
      const idle = sf.getByLabel('无操作时长（秒）');
      await r.type(idle, '15');
      await r.click(r.button('保存安全设置', sf));
      const d = r.page.getByRole('dialog');
      await r.type(d.locator('input[autocomplete="current-password"]'), stack.password);
      await r.click(d.getByRole('button', { name: '确认', exact: true }));
      await d.waitFor({ state: 'hidden' });
      await r.page.locator('.viewer-lock-blank').waitFor({ timeout: 30000 });
      await r.shot('locked-by-idle');
      await r.unlock();
      await r.type(sf.getByLabel('无操作时长（秒）'), '300');
      await r.click(r.button('保存安全设置', sf));
      const restore = r.page.getByRole('dialog');
      await r.type(restore.locator('input[autocomplete="current-password"]'), stack.password);
      await r.click(restore.getByRole('button', { name: '确认', exact: true }));
      await restore.waitFor({ state: 'hidden' });
      await r.start();
      await r.click(r.button('锁定'));
      await r.page.locator('.viewer-lock-blank').waitFor();
      await r.reveal();
      await r.type(r.page.locator('input[autocomplete="current-password"]'), stack.password);
      await r.click(r.button('解锁'));
      await r.settingsSection(sf, '诊断');
      await r.click(r.button('开始诊断', sf));
      await pause(2500);
      await r.shot('diagnostic-collecting');
      await r.click(r.button('停止数据收集'));
      await r.page.getByRole('dialog', { name: '诊断已保存' }).waitFor({ timeout: 90000 });
      await r.shot('diagnostic-saved');
      await r.click(r.button('完成'));
      await r.closeWindow(sf);
    });
    await r.step('09-admin-error-lookup', async () => {
      await r.open('管理');
      const af = await r.alone('admin');
      await r.section(af, '用户');
      await r.click(r.button('新建用户', af));
      const d = r.page.getByRole('dialog', { name: '新建用户' });
      await r.type(d.getByLabel('用户名'), 'shell-member');
      await r.type(d.getByLabel('密码', { exact: true }), stack.password);
      await r.click(r.button('创建', d));
      await d.locator('.failure-note').waitFor();
      await r.shot('duplicate-user-error');
      const errorText = await d.innerText();
      const id =
        errorText.match(/c-[a-f0-9]+/i)?.[0] ??
        (await r.page.evaluate(() => shellQA.errors.find((e) => e.error?.errorId)?.error.errorId));
      assert(id, 'an error ID produced during the journey');
      await r.click(r.button('取消', d));
      await r.section(af, '诊断');
      await r.type(af.getByLabel('错误 ID'), id);
      await r.click(r.button('查找', af));
      await af.getByRole('table').first().waitFor();
      await pause(1200);
      await r.shot('admin-error-lookup');
      await r.closeWindow(af);
    });
    await r.close();
    viewer = undefined;
  }
  if (memberAbsentAt) {
    while (Date.now() - memberAbsentAt < 610000) {
      console.log('Normal-tab absence: ' + Math.floor((Date.now() - memberAbsentAt) / 1000) + ' seconds');
      await pause(Math.min(30000, 610000 - (Date.now() - memberAbsentAt)));
    }
    const page = await normalContext.newPage();
    await page.goto(stack.origin);
    await page.locator('.viewer-lock-blank').waitFor();
    await pause(500);
    for (const key of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'])
      await page.keyboard.press('Arrow' + key);
    await page.locator('input[autocomplete="current-password"]').fill(stack.password);
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    for (let n = 0; n < 10; n++) {
      const ok = page.getByRole('button', { name: '知道了' });
      if (await ok.count()) await ok.first().click();
      else break;
      await pause(200);
    }
    await page.getByRole('button', { name: '开始', exact: true }).waitFor({ timeout: 120000 });
    await pause(2500);
    const state = await page.evaluate(() => __remotekitTest.state());
    await page.screenshot({ path: join(root, 'normal-long-absence-return.png') });
    writeFileSync(
      join(root, 'normal-long-absence-return.json'),
      JSON.stringify(
        {
          before: memberTab,
          after: state,
          text: await page.locator('body').innerText(),
          absentMs: Date.now() - memberAbsentAt,
        },
        null,
        2,
      ),
    );
    assert(state.workspace.tabs.some((t) => t.id === memberTab.id && t.url === memberTab.url));
    record({ variant: 'member', step: 'normal-long-absence-return', status: 'pass' });
  }
} finally {
  await viewer?.close().catch(() => {});
  await normalContext?.close();
  await normalBrowser?.close();
  await stack.stop();
}
if (results.some((r) => r.status === 'fail')) process.exitCode = 1;
