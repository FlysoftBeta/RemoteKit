import { runScenario } from './kit/viewer.mjs';
await runScenario('workspace-ui', async (v, stack) => {
  const { page, pointer, touch, shot, tile, step, errors, uploads, viewports, log } = v;
  const launcher = v.openStart;
  const origin = stack.origin;
  const fixture = stack.fixture + '/notes/';
  const group = () => v.state.workspace.spaces.find((space) => space.id === v.state.workspace.activeSpaceId);
  let initialSpace;
  let fixtureWindow;
  let replacementWindow;
  let newSpace;
  const assert = (condition, label) => {
    if (!condition) throw new Error(label);
  };
  const windows = () => v.state.workspace.windows.map((win) => win.id);
  const startDialog = () => page.getByRole('dialog', { name: '开始屏幕' });
  async function beginTile(name) {
    const box = await tile(name).boundingBox();
    assert(box, 'tile bounds');
    await pointer.move(box.x + box.width / 2, box.y + box.height / 2);
    await pointer.down();
    if (touch) await page.waitForTimeout(500);
    await pointer.move(box.x + box.width / 2 + 8, box.y + box.height / 2, { steps: 2 });
    await page.locator('.launcher-lifted').waitFor();
  }

  await step('seed-browser-fixture', async () => {
    await launcher();
    await tile('浏览器').click({ timeout: 120000 });
    await v.until(() => v.state.workspace.windows.length === 1 && group().windowIds.length === 1, 'browser');
    initialSpace = group().id;
    fixtureWindow = group().windowIds[0];
    const address = page.getByRole('textbox', { name: '搜索或输入网址', exact: true }).first();
    await address.fill(fixture);
    await address.press('Enter');
    await v.until(
      () => v.state.workspace.tabs.some((tab) => tab.url.startsWith(fixture) && !tab.loading),
      'fixture loaded',
    );
    await page.locator('video').waitFor({ state: 'attached' });
    await v.until(() => uploads.some((upload) => upload.url.startsWith(fixture)), 'preview upload', 30000);
    const image = Buffer.from(
      uploads.find((upload) => upload.url.startsWith(fixture)).image.split(',')[1],
      'base64',
    );
    assert(image.length <= 24576 && image[0] === 255 && image[1] === 216, 'bounded JPEG');
    // A page visited once is history; a favorite is listed on Start right away.
    await page.getByRole('button', { name: '收藏', exact: true }).first().click();
    await v.until(
      () => v.state.workspace.favorites.some((favorite) => favorite.url.startsWith(fixture)),
      'favorite',
    );
  });

  await step('start-group-column-1600', async () => {
    await launcher();
    const box = await page.getByRole('complementary', { name: '窗口组栏' }).boundingBox();
    assert(Math.abs(box.width - 200) < 1 && box.x > 1200, 'right column geometry');
    assert(
      (await page.locator(`[data-space-card="${initialSpace}"][aria-current="true"]`).count()) === 1,
      'current target',
    );
    assert(
      await page
        .locator(`[data-space-card="${initialSpace}"]`)
        .evaluate((node) => getComputedStyle(node).boxShadow.includes('inset')),
      'target ring',
    );
    assert(group().id === initialSpace && windows().length === 1, 'Start preserves workspace');
    await shot('launcher-1600');
  });

  await step('start-group-strip-390', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const box = await page.getByRole('complementary', { name: '窗口组栏' }).boundingBox();
    const search = await page.getByRole('textbox', { name: '搜索 App、网页和文件' }).boundingBox();
    assert(box.width > 300 && box.y >= search.y + search.height, 'strip below search');
    assert(group().id === initialSpace && windows().length === 1, 'narrow preserves workspace');
    await shot('launcher-390');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForTimeout(600);
  });

  await step('tile-click-appends', async () => {
    await tile('我的文件').click();
    await v.until(() => group().id === initialSpace && group().windowIds.length === 2, 'append to current');
    assert(group().windowIds[0] === fixtureWindow, 'existing window remains first');
    await startDialog().waitFor({ state: 'hidden' });
    await page.waitForTimeout(800);
    const geometry = await page.locator('.window-workspace').evaluate((stage) => {
      const bounds = stage.getBoundingClientRect();
      const frames = [...stage.querySelectorAll('[data-window-id]')]
        .filter((frame) => frame.offsetWidth)
        .map((frame) => frame.getBoundingClientRect());
      return {
        left: frames[0].left - bounds.left,
        right: bounds.right - frames[1].right,
        gap: frames[1].left - frames[0].right,
        top: frames[0].top - bounds.top,
        bottom: bounds.bottom - frames[0].bottom,
      };
    });
    const { gap, ...edges } = geometry;
    assert(
      Object.values(edges).every((value) => Math.abs(value) < 0.1) && Math.abs(gap - 1) < 0.1,
      'flush windows with a 1px separator',
    );
    const remote = await page
      .locator(`[data-window-id="${fixtureWindow}"]`)
      .getByRole('region', { name: '远程页面', exact: true })
      .boundingBox();
    const report = viewports
      .flatMap((viewport) => viewport.windows ?? [])
      .filter((win) => win.windowId === fixtureWindow && win.visible)
      .pop();
    assert(
      report && Math.abs(report.width - remote.width) <= 1 && Math.abs(report.height - remote.height) <= 1,
      'viewport reports content bounds',
    );
    await shot('window-cards-1600');
  });

  await step('tile-drag-insertion-midair', async () => {
    const before = windows();
    await launcher();
    await beginTile('设置');
    const divider = await page.getByRole('separator', { name: '调整分屏比例' }).boundingBox();
    await pointer.move(divider.x + divider.width / 2, divider.y + divider.height / 2, { steps: 12 });
    await page.locator('.window-insertion-marker').waitFor();
    assert((await page.locator('.window-insertion-guides i').count()) === 3, 'insertion lines');
    assert(
      await page.getByRole('complementary', { name: '窗口组栏' }).isVisible(),
      'group column stays visible',
    );
    assert(
      await page
        .locator('.launcher-groups')
        .evaluate(
          (node) => getComputedStyle(node).pointerEvents === 'none' && getComputedStyle(node).opacity === '0',
        ),
      'tile area faded',
    );
    assert(JSON.stringify(windows()) === JSON.stringify(before), 'midair does not open');
    await shot('tile-insertion-midair-1600');
  });

  await step('tile-drag-replace-midair', async () => {
    const frame = await page.locator(`[data-window-id="${fixtureWindow}"]`).boundingBox();
    await pointer.move(frame.x + frame.width / 2, frame.y + frame.height / 2, { steps: 12 });
    await page.locator(`[data-window-id="${fixtureWindow}"][data-window-replace]`).waitFor();
    assert(
      await page
        .locator(`[data-window-id="${fixtureWindow}"]`)
        .evaluate((node) => getComputedStyle(node, '::after').content.includes('替换')),
      'replace label',
    );
    assert(group().windowIds.includes(fixtureWindow) && windows().length === 2, 'hover preserves target');
    await shot('tile-replace-midair-1600');
  });

  await step('drop-replace-detaches-old-window', async () => {
    const before = windows();
    const weights = [...group().weights];
    await pointer.up();
    await v.until(() => windows().length === 3 && !group().windowIds.includes(fixtureWindow), 'replacement');
    replacementWindow = windows().find((id) => !before.includes(id));
    assert(
      group().id === initialSpace && group().focusedWindowId === replacementWindow,
      'new window focused in original group',
    );
    assert(JSON.stringify(group().weights) === JSON.stringify(weights), 'slot weights preserved');
    const displaced = v.state.workspace.spaces.find((space) => space.windowIds.includes(fixtureWindow));
    assert(
      displaced.windowIds.length === 1 && displaced.id !== initialSpace,
      'old window in own background group',
    );
    assert(
      v.state.workspace.tabs.some((tab) => tab.windowId === fixtureWindow && tab.url.startsWith(fixture)),
      'old remote page remains',
    );
    await startDialog().waitFor({ state: 'hidden' });
    await shot('replacement-result-1600');
  });

  await step('plus-target-tile-creates-group', async () => {
    await launcher();
    await startDialog().getByRole('button', { name: '新窗口组', exact: true }).click();
    assert(
      (await startDialog()
        .getByRole('button', { name: '新窗口组', exact: true })
        .getAttribute('aria-pressed')) === 'true',
      '+ selected',
    );
    assert(await startDialog().isVisible(), '+ keeps Start open');
    const before = v.state.workspace.spaces.length;
    await tile('我的文件').click();
    await v.until(
      () =>
        v.state.workspace.spaces.length === before + 1 &&
        group().id !== initialSpace &&
        group().windowIds.length === 1,
      'new target group',
    );
    newSpace = group().id;
    assert(
      v.state.workspace.windows.find((win) => win.id === group().windowIds[0]).appId === 'files',
      'new file window',
    );
    await startDialog().waitFor({ state: 'hidden' });
  });

  await step('group-card-switches', async () => {
    await launcher();
    await page.locator(`[data-space-card="${initialSpace}"]`).click();
    await v.until(() => group().id === initialSpace, 'group card activates');
    assert(
      v.state.workspace.spaces.some((space) => space.id === newSpace),
      'other group preserved',
    );
    await startDialog().waitFor({ state: 'hidden' });
  });

  await step('handle-drag-trash-zones-midair', async () => {
    const handle = await page
      .locator(`[data-window-id="${replacementWindow}"]`)
      .getByRole('button', { name: '窗口把手' })
      .boundingBox();
    await pointer.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await pointer.down();
    await pointer.move(handle.x + 100, handle.y + 160, { steps: 12 });
    await page.locator('.window-drop-column').waitFor();
    assert(
      (await page.locator('.window-drop-column [data-new-group]').innerText()) === '新窗口组',
      'new group zone',
    );
    assert((await page.locator('[data-close-window]').innerText()).trim() === '关闭窗口', 'close zone');
    const trash = await page.locator('[data-close-window]').boundingBox();
    await pointer.move(trash.x + trash.width / 2, trash.y + trash.height / 2, { steps: 12 });
    await page.locator('[data-close-window][data-window-drop-hover]').waitFor();
    assert(windows().includes(replacementWindow) && windows().length === 4, 'midair preserves window');
    await shot('handle-trash-midair-1600');
  });

  await step('handle-drop-trash-closes', async () => {
    await pointer.up();
    await v.until(
      () => !windows().includes(replacementWindow) && windows().length === 3,
      'trash closes window',
    );
    assert(group().id === initialSpace && group().windowIds.length === 1, 'remaining window stays in group');
    assert(
      v.state.workspace.spaces.some((space) => space.windowIds.includes(fixtureWindow)),
      'displaced window preserved',
    );
  });

  await step('page-preview-start-rows', async () => {
    await launcher();
    const preview = tile('Workspace Notes');
    await preview.waitFor();
    const image = preview.locator('img').first();
    assert(
      await image.evaluate(
        (node) =>
          node.complete && node.naturalWidth > 0 && node.naturalWidth <= 320 && node.naturalHeight <= 200,
      ),
      'page crop shown within bounds',
    );
    const response = await page.request.get(new URL(await image.getAttribute('src'), origin).href);
    assert(
      response.ok() && response.headers()['cache-control'].includes('immutable'),
      'authenticated preview URL',
    );
    assert((await response.body()).length <= 24576, 'preview byte bound');
    assert(windows().length === 3 && group().id === initialSpace, 'preview display preserves state');
    await shot('page-preview-start-rows-1600');
  });

  await step('tile-drag-cancel-restores-start', async () => {
    const before = windows();
    await beginTile('浏览器');
    await page.keyboard.press('Escape');
    await pointer.up();
    assert(
      (await startDialog().isVisible()) && (await page.locator('.launcher-lifted').count()) === 0,
      'cancel restores Start',
    );
    assert(JSON.stringify(windows()) === JSON.stringify(before), 'cancel preserves workspace');
  });

  await step('tile-drop-inserts-at-line', async () => {
    const before = windows();
    const oldFirst = group().windowIds[0];
    await beginTile('浏览器');
    const stage = await page.locator('.window-workspace').boundingBox();
    await pointer.move(stage.x + 4, stage.y + stage.height / 2, { steps: 12 });
    await page.locator('.window-insertion-marker').waitFor();
    await pointer.up();
    await v.until(
      () => windows().length === before.length + 1 && group().windowIds.length === 2,
      'insert window',
    );
    assert(group().windowIds[1] === oldFirst && !before.includes(group().windowIds[0]), 'inserted on left');
    await startDialog().waitFor({ state: 'hidden' });
  });

  await step('tile-drop-group-card-appends', async () => {
    const before = windows();
    const old = [...v.state.workspace.spaces.find((space) => space.id === newSpace).windowIds];
    await launcher();
    await beginTile('我的文件');
    const card = await page.locator(`[data-space-card="${newSpace}"]`).boundingBox();
    await pointer.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 12 });
    await page.locator(`[data-space-card="${newSpace}"][data-window-drop-hover]`).waitFor();
    await pointer.up();
    await v.until(
      () => group().id === newSpace && group().windowIds.length === old.length + 1,
      'append to card group',
    );
    assert(
      group().windowIds[0] === old[0] && windows().length === before.length + 1,
      'card append preserves old slot',
    );
    await startDialog().waitFor({ state: 'hidden' });
  });

  await step('full-group-click-opens-new-with-notice', async () => {
    await launcher();
    await tile('我的文件').click();
    await v.until(() => group().id === newSpace && group().windowIds.length === 3, 'fill group');
    await launcher();
    const before = v.state.workspace.spaces.length;
    await tile('我的文件').click();
    await v.until(
      () => group().id !== newSpace && v.state.workspace.spaces.length === before + 1,
      'full group fallback',
    );
    assert(
      v.state.workspace.spaces.find((space) => space.id === newSpace).windowIds.length === 3,
      'full group preserved',
    );
    await page.getByText('当前窗口组已满，已在新窗口组打开', { exact: true }).waitFor();
    await startDialog().waitFor({ state: 'hidden' });
  });

  await step('home-bar-recent-two-and-swipe-start', async () => {
    const active = group().id;
    const previous = [...v.state.workspace.spaces]
      .filter((space) => space.id !== active)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0].id;
    const bar = await page.getByRole('button', { name: '主页条', exact: true }).boundingBox();
    async function swipe(dx, dy) {
      await pointer.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
      await pointer.down();
      await pointer.move(bar.x + bar.width / 2 + dx, bar.y + bar.height / 2 + dy, { steps: 12 });
      await pointer.up();
    }
    await swipe(100, 0);
    await v.until(() => group().id === previous, 'first recent group');
    await swipe(-100, 0);
    await v.until(() => group().id === active, 'toggle back');
    await swipe(0, -80);
    await startDialog().waitFor();
    assert(group().id === active, 'swipe Start preserves group');
  });

  for (const method of ['unlockByKeys', 'unlockByTaps']) {
    await step('lock-' + method, async () => {
      await v.refresh();
      const before = JSON.stringify({
        windows: windows(),
        spaces: v.state.workspace.spaces.map((space) => ({
          id: space.id,
          windowIds: space.windowIds,
          weights: space.weights,
        })),
        active: group().id,
        tabs: v.state.workspace.tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, url: tab.url })),
      });
      await v.lock();
      await shot('locked-' + method);
      await v[method]();
      const after = JSON.stringify({
        windows: windows(),
        spaces: v.state.workspace.spaces.map((space) => ({
          id: space.id,
          windowIds: space.windowIds,
          weights: space.weights,
        })),
        active: group().id,
        tabs: v.state.workspace.tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, url: tab.url })),
      });
      assert(before === after, 'unlock preserves workspace');
      await shot('unlocked-' + method);
    });
  }
  await step('filesystem-no-browser-restart', async () => {
    await launcher();
    await tile('浏览器').click();
    await startDialog().waitFor({ state: 'hidden' });
    await v.navigate(stack.fixture + '/fs/');
    await page.waitForTimeout(15000);
    await v.assertNoBrowserRestart();
    const events = await (await fetch(stack.fixture + '/events')).json();
    assert(
      events.some((event) => event.api === 'getDirectory' && event.status === 'ok'),
      'getDirectory wrote a file',
    );
    assert(
      events.some(
        (event) => event.api === 'webkitRequestFileSystem' && ['ok', 'unavailable'].includes(event.status),
      ),
      'legacy File System API completed',
    );
    await shot('filesystem');
  });
  await step('runtime-clean', async () => {
    assert(errors.length === 0, errors.join('; '));
    assert(!log.some((line) => line.startsWith('FAIL')), 'all prior steps succeeded');
  });
});
