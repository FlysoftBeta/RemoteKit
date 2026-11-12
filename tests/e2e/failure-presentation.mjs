import assert from 'node:assert/strict';

async function checkNoticePlacement(page, narrow = false) {
  await page.locator('.notice-center .failure-A').waitFor();
  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width };
    };
    return {
      notice: rect('.notice-center'),
      shell: rect('.viewer-shell'),
      start: rect('.dock-button[aria-label="开始"]'),
      chrome: [...document.querySelectorAll('.tab-bar, .address-bar')]
        .filter((element) => element.getClientRects().length)
        .map((element) => element.getBoundingClientRect().bottom),
    };
  });
  const { notice, shell, start, chrome } = geometry;
  assert(Math.abs(shell.right - notice.right - 16) < 1);
  assert(notice.top >= Math.max(...chrome));
  if (narrow) {
    assert(Math.abs(notice.left - shell.left - 16) < 1);
    assert(notice.bottom <= start.top - 16);
  } else {
    assert(notice.width <= 360);
    assert(Math.abs(shell.bottom - notice.bottom - 16) < 1);
    assert(notice.left >= start.right);
  }
}

export async function captureFailureScreenshots(viewer) {
  const { page, shot } = viewer;
  await page.locator('.remote-viewport').first().waitFor();
  for (const [scene, name] of [
    ['notices', 'notice-center'],
    ['item', 'item-error-id'],
    ['recovering', 'viewport-recovering'],
    ['calm', 'viewport-calm-30s'],
    ['action', 'capacity-action'],
  ]) {
    if (scene === 'item') {
      await viewer.openStart();
      await viewer.tile('我的文件').click();
      await page.getByRole('dialog', { name: '开始屏幕' }).waitFor({ state: 'hidden' });
      await page.locator('.library-tab:visible').first().waitFor();
    }
    if (scene === 'recovering') {
      await page
        .locator('.remote-viewport:visible')
        .first()
        .click({ position: { x: 10, y: 10 } });
      await page.waitForTimeout(400);
    }
    const viewport = await page.locator('.remote-viewport:visible').first().boundingBox();
    await page.evaluate((scene) => window.__remotekitTest.failures(scene), scene);
    if (scene === 'notices') await page.waitForTimeout(1600);
    await page
      .locator(scene === 'notices' ? '.notice-center .failure-C' : '[data-b3-failure-scene] .failure-note')
      .waitFor();
    if (scene === 'notices') await checkNoticePlacement(page);
    if (scene === 'item') {
      const area = page.locator('.library-tab:visible [data-upload-queue-area]').first();
      const toolbarBottom = await area.evaluate(
        (element) => element.previousElementSibling.getBoundingClientRect().bottom,
      );
      const row = await area.locator('[data-upload-job]').boundingBox();
      assert(row.y >= toolbarBottom);
      await area.getByRole('button', { name: '收起上传队列' }).click();
      assert.equal(await area.locator('[data-upload-job]').count(), 0);
      assert.equal(await area.locator('.failure-note').count(), 1);
      const summary = await area.locator('.failure-note').boundingBox();
      assert(summary.y >= toolbarBottom);
      await area.getByRole('button', { name: '展开上传队列' }).click();
    }
    if (scene === 'recovering' || scene === 'calm' || scene === 'action') {
      const pill = page.locator('[data-b3-failure-scene] .failure-note');
      const box = await pill.boundingBox();
      assert(box.width <= 480);
      assert(Math.abs(box.y - viewport.y - 8) < 1);
      assert(Math.abs(box.x + box.width / 2 - viewport.x - viewport.width / 2) < 1);
      assert.deepEqual(await page.locator('.remote-viewport:visible').first().boundingBox(), viewport);
      assert.equal(await pill.locator('.failure-spinner').count(), scene === 'recovering' ? 1 : 0);
      assert.equal(await pill.locator('.failure-action').count(), scene === 'action' ? 1 : 0);
    }
    await shot(name);
  }
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__remotekitTest.failures('notices'));
  await checkNoticePlacement(page, true);
  await shot('notice-center-narrow');
  await page.setViewportSize(originalViewport);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/failure-presentation.mjs')) {
  const { runScenario } = await import('./kit/viewer.mjs');
  await runScenario('failure-presentation', async (viewer, stack) => {
    await viewer.openStart();
    await viewer.tile('浏览器').click();
    await viewer.navigate(stack.fixture + '/notes/');
    await captureFailureScreenshots(viewer);
  });
}
