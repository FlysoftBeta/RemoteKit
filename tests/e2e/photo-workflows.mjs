import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildAction } from './kit/product-actions.mts';
import { startJourney } from './kit/viewer.mjs';

const j = await startJourney('chrome89');
const { page, click, menu } = j;
const basket = () => page.getByRole('dialog', { name: '文件篮', exact: true });
const camera = () => page.getByRole('dialog', { name: '摄像头拍照', exact: true });
const evidence = [];
const library = () => j.viewer.call('library.get');
const focused = (state) =>
  state.workspace.spaces.find((space) => space.id === state.workspace.activeSpaceId)?.focusedWindowId;
const shots = resolve('develop/tmp/codex-1120/shots');
mkdirSync(shots, { recursive: true });
await page.evaluate(() => {
  window.photoActions = [];
  const send = clusterQA.socket.send.bind(clusterQA.socket);
  clusterQA.socket.send = (raw) => {
    const message = JSON.parse(raw);
    if (message.method === 'operation.submit') window.photoActions.push(message.params.action);
    return send(raw);
  };
});
const save = async (name) => {
  evidence.push({
    name,
    state: await j.viewer.state(),
    library: await library(),
    wire: await page.evaluate(() => clusterQA.fileWire),
    actions: await page.evaluate(() => window.photoActions),
    activeElement: await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      className: document.activeElement?.className,
    })),
    visible: await page
      .locator('[data-window-id]')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => getComputedStyle(node).display !== 'none')
          .map((node) => node.dataset.windowId),
      ),
    body: await page.locator('body').innerText(),
  });
  writeFileSync(join(j.run, 'photo-evidence.json'), JSON.stringify(evidence, null, 2));
  await j.shot(name);
};
const remote = async (id = 'images') => {
  await basket().waitFor({ state: 'hidden' });
  await page.waitForTimeout(800);
  await page.locator('.remote-viewport.resize-waiting').waitFor({ state: 'hidden' });
  const box = await page.locator('.remote-viewport:visible').boundingBox();
  const geo = await j.until(
    () =>
      j.provider.events.findLast(
        (event) => event.type === 'file-geometry' && Math.abs(event.width - box.width) < 3,
      ),
    'file geometry',
  );
  await j.tapAt(
    box.x + ((geo.boxes[id].x + 30) * box.width) / geo.width,
    box.y + ((geo.boxes[id].y + 12) * box.height) / geo.height,
  );
  await basket().waitFor();
};
const capture = async (continuous, retake = false) => {
  if (!retake) {
    const direct = basket().getByRole('button', { name: '摄像头拍照', exact: true });
    if (await direct.isVisible()) await click(direct);
    else {
      await click(basket().getByRole('button', { name: '添加文件', exact: true }));
      await click(menu('摄像头拍照'));
    }
  }
  await camera().waitFor();
  if (!continuous && !retake)
    await click(camera().getByRole('button', { name: '连续拍摄已开启', exact: true }));
  await click(camera().getByRole('button', { name: '普通照片', exact: true }));
  const shutter = camera().getByRole('button', { name: '拍照', exact: true });
  await j.until(() => shutter.isEnabled(), 'shutter ready');
  await click(shutter);
  if (!continuous || retake) await camera().waitFor({ state: 'hidden' });
  else {
    await j.until(() => shutter.isEnabled(), 'continuous sampling completed');
    await click(camera().getByRole('button', { name: '返回', exact: true }));
  }
};
const ready = () =>
  j.until(
    async () => {
      const body = await basket().innerText();
      assert(!body.includes('处理失败') && !body.includes('扫描失败'), body);
      return await basket().getByRole('button', { name: '发送', exact: true }).isEnabled();
    },
    'photo ready for native delivery',
    120000,
  );
const photoCard = () =>
  basket()
    .locator('[data-file-card]')
    .filter({ has: page.getByRole('button', { name: /^photo-/ }) })
    .first();
const cardOpen = async () => {
  const card = photoCard();
  const name = await card.locator('button[aria-label]').first().getAttribute('aria-label');
  await click(card.getByRole('button', { name, exact: true }));
};
try {
  console.log('PHOTO RUN', j.run);
  await j.open('我的文件');
  await j.open('浏览器');
  const address = page.getByRole('textbox', { name: '搜索或输入网址', exact: true }).first();
  await j.type(address, j.provider.origin + '/photo-workflows');
  await page.keyboard.press('Enter');
  await j.viewer.media();
  for (const [name, continuous, retake, input] of [
    ['single-shot-immediate', false, false, 'images'],
    ['continuous', true, false, 'images'],
    ['retake', false, true, 'images'],
    ['jpeg-delivery', false, false, 'jpeg'],
  ]) {
    await page.setViewportSize({ width: continuous ? 360 : 1600, height: continuous ? 640 : 1000 });
    await remote(input);
    const before = await j.viewer.state();
    const actionStart = await page.evaluate(() => window.photoActions.length);
    const selectedBefore = j.provider.events.filter((event) => event.type === 'file-selected').length;
    await capture(continuous);
    const inFlight = await page.evaluate(() => {
      const incoming = new Set(
        clusterQA.fileWire
          .filter((message) => message.direction === 'in')
          .map((message) => message.requestId),
      );
      return clusterQA.fileWire.some(
        (message) =>
          message.direction === 'out' &&
          message.method === 'photo.process' &&
          !incoming.has(message.requestId),
      );
    });
    if (inFlight)
      assert.equal(await basket().getByRole('button', { name: '发送', exact: true }).isEnabled(), false);
    await save(name + '-after-shutter');
    assert.equal(focused(await j.viewer.state()), focused(before));
    await ready();
    if (retake) {
      await cardOpen();
      await click(menu('重拍'));
      await capture(false, true);
      await save(name + '-processing');
      await ready();
    }
    if (name === 'continuous' && !process.env.E2E_PHOTO_BASELINE) {
      const order = (await library()).basket;
      await cardOpen();
      await click(menu('查看大图'));
      await page.locator('.photo-window-overlay .photo-viewer').waitFor();
      const bounds = await page.locator('.photo-window-overlay').boundingBox();
      assert(bounds.height > 450, JSON.stringify(bounds));
      await save('basket-window-viewer');
      const oldPhoto = (await library()).entries.find((entry) => entry.id === order[0]);
      await click(page.locator('.photo-viewer').getByRole('button', { name: '向右旋转', exact: true }));
      assert((await page.locator('.photo-transform img').getAttribute('style')).includes('rotate(90deg)'));
      await j.until(
        async () =>
          (await library()).entries.find((entry) => entry.id === oldPhoto.id).assetId !== oldPhoto.assetId,
        'rotation persisted',
      );
      await click(page.locator('.photo-viewer').getByRole('button', { name: '照片详情', exact: true }));
      const rotated = (await library()).entries.find((entry) => entry.id === oldPhoto.id);
      const dimensions = await j.viewer.call(
        'asset.describe',
        { requestId: 'library', assetId: rotated.assetId },
        true,
      );
      await j.until(
        async () =>
          (await page.getByLabel('照片详情面板', { exact: true }).innerText()).includes(
            `${dimensions.width} × ${dimensions.height}`,
          ),
        'full-resolution photo dimensions',
      );
      await page.keyboard.press('Escape');
      await basket().waitFor();
      assert.deepEqual((await library()).basket, order);
    }
    await click(basket().getByRole('button', { name: '发送', exact: true }));
    await j.until(
      () => j.provider.events.filter((event) => event.type === 'file-selected').length > selectedBefore,
      name + ' native FileList',
    );
    await save(name + '-delivered');
    assert.equal(focused(await j.viewer.state()), focused(before));
    const actions = await page.evaluate((start) => window.photoActions.slice(start), actionStart);
    assert(
      !actions.some((action) => action.type === 'window.open' && action.appId === 'files'),
      JSON.stringify(actions),
    );
    const selected = j.provider.events.filter((event) => event.type === 'file-selected').at(-1);
    assert.equal(selected.trusted, true);
    if (input === 'jpeg')
      assert(
        selected.files.every((file) => file.type === 'image/jpeg'),
        JSON.stringify(selected),
      );
    console.log(name, JSON.stringify(selected));
  }
  if (process.env.E2E_PHOTO_BASELINE) process.exitCode = 0;
  else {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await j.open('我的文件');
    const filesWindow = (await j.viewer.state()).workspace.windows.find((win) => win.appId === 'files');
    await j.viewer.action(
      buildAction({ type: 'window.place', windowId: filesWindow.id, placement: { mode: 'space' } }),
    );
    await click(page.getByRole('button', { name: '添加文件', exact: true }).last());
    const chooser = page.waitForEvent('filechooser');
    await click(menu('从设备选择'));
    await (
      await chooser
    ).setFiles(
      Array.from({ length: 24 }, (_, index) => ({
        name: `layout-${String(index + 1).padStart(2, '0')}.png`,
        mimeType: 'image/png',
        buffer: readFileSync('control/test/fixtures/learning/files/lesson.png'),
      })),
    );
    await j.until(
      async () => (await library()).entries.filter((entry) => entry.name.startsWith('layout-')).length === 24,
      'layout library imported',
      120000,
    );
    const scroll = page.locator('.library-virtual-list:visible');
    for (const [width, height, scale] of [
      [360, 640, 1],
      [768, 1024, 1],
      [1280, 800, 1],
      [1280, 800, 1.5],
    ]) {
      await page.setViewportSize({ width, height });
      await j.viewer.action({ type: 'settings.update', settings: { workspace: { uiScale: scale } } });
      await page.waitForTimeout(700);
      await scroll.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.waitForTimeout(300);
      const prefix = `${width}x${height}-scale-${scale}`;
      await page.screenshot({ path: join(shots, prefix + '-first.png') });
      await scroll.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await page.waitForTimeout(350);
      if (width / scale >= 600) {
        const navigation = page.getByRole('navigation', { name: '文件导航', exact: true });
        const items = navigation.locator('.MuiList-root').first();
        await items.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        const lastItem = await items.locator('.MuiListItemButton-root').last().boundingBox();
        const viewport = await items.boundingBox();
        assert(lastItem.y + lastItem.height <= viewport.y + viewport.height + 1);
      }
      await page.screenshot({ path: join(shots, prefix + '-last.png') });
      const geometry = await scroll.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          rect: rect.toJSON(),
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          cards: [...node.querySelectorAll('[data-file-card]')].map((card) =>
            card.getBoundingClientRect().toJSON(),
          ),
        };
      });
      for (const card of geometry.cards) {
        assert(card.x >= geometry.rect.x, JSON.stringify(geometry));
        assert(card.right <= geometry.rect.right + 1, JSON.stringify(geometry));
      }
      const nav = page.getByRole('navigation', { name: '文件导航', exact: true });
      if (width / scale >= 600) {
        const settings = nav.getByText('设置', { exact: true });
        const box = await settings.boundingBox();
        assert(box && box.y + box.height <= height, JSON.stringify(box));
      }
      const last = geometry.cards.at(-1);
      assert(last.bottom <= geometry.rect.bottom - 50 * scale, JSON.stringify(geometry));
      writeFileSync(join(shots, prefix + '-geometry.json'), JSON.stringify(geometry, null, 2));
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await j.viewer.action({ type: 'settings.update', settings: { workspace: { uiScale: 1 } } });
    await scroll.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.getByRole('textbox', { name: '搜索文件名', exact: true }).fill('layout');
    await click(page.getByRole('button', { name: 'layout-24.png', exact: true }));
    await page.locator('.photo-viewer').waitFor();
    await click(page.locator('.photo-viewer').getByRole('button', { name: '照片详情', exact: true }));
    await page.screenshot({ path: join(shots, 'viewer-wide-details.png') });
    const area = await page.locator('.photo-gesture').boundingBox();
    await page.mouse.dblclick(area.x + area.width / 2, area.y + area.height / 2);
    await j.until(
      async () => (await page.locator('.photo-transform').getAttribute('style')).includes('scale(2)'),
      'double click zoom',
    );
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    assert((await page.locator('.photo-transform').getAttribute('style')).includes('scale(1)'));
    await j.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const touchArea = await page.locator('.photo-gesture').boundingBox();
    const center = { x: touchArea.x + touchArea.width / 2, y: touchArea.y + touchArea.height / 2 };
    const touches = (radius) =>
      [-1, 1].map((side, index) => ({
        id: index + 1,
        x: center.x + radius * side,
        y: center.y,
        radiusX: 4,
        radiusY: 4,
        force: 1,
      }));
    await j.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(50) });
    await j.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(100) });
    await j.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await j.until(
      async () => (await page.locator('.photo-transform').getAttribute('style')).includes('scale(2)'),
      'pinch zoom',
    );
    await j.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, 'viewer-narrow-details.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('textbox', { name: '搜索文件名', exact: true }).inputValue(), 'layout');
    await save('final-layout');
  }
} finally {
  await save('final').catch(() => {});
  await j.close();
}
