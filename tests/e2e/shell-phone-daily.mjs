// Phone-sized touch journey: dynamic switcher titles, drags, Start, App lifecycle.
import assert from 'node:assert/strict';
import { runScenario } from './kit/viewer.mjs';
await runScenario('shell-phone-daily', async (v, stack) => {
  const { page } = v;
  await page.setViewportSize({ width: 390, height: 844 });
  const click = async (l) => {
    await l.tap();
    await page.waitForTimeout(500);
  };
  const start = async () => {
    await v.openStart();
  };
  const open = async (name) => {
    await start();
    await click(v.tile(name));
    await page.getByRole('dialog', { name: '开始屏幕' }).waitFor({ state: 'hidden' });
  };
  const group = () => v.state.workspace.spaces.find((s) => s.id === v.state.workspace.activeSpaceId);
  await v.step('phone-windows-switcher-and-drag', async () => {
    await open('浏览器');
    await v.navigate(stack.fixture + '/notes/');
    await open('我的文件');
    await open('设置');
    await v.until(() => group().windowIds.length === 3, 'three windows');
    const ids = [...group().windowIds];
    const sw = page.locator('.narrow-window-switcher');
    assert.equal(await sw.getByRole('button').count(), 3);
    await click(sw.getByRole('button').nth(1));
    await v.until(() => group().focusedWindowId === ids[1], 'switch to files');
    await v.shot('switcher-files');
    await click(sw.getByRole('button').first());
    await v.until(() => group().focusedWindowId === ids[0], 'switch to titled Browser');
    await v.shot('switcher-browser');
    const handle = page.locator(`[data-window-id="${ids[0]}"]`).getByRole('button', { name: '窗口把手' });
    const b = await handle.boundingBox();
    await v.pointer.move(b.x + b.width / 2, b.y + b.height / 2);
    await v.pointer.down();
    await page.waitForTimeout(500);
    await v.pointer.move(b.x + 120, b.y + 190, { steps: 12 });
    await page.locator('.window-drop-column').waitFor();
    await v.shot('drag-midair');
    const target = await page.locator('[data-new-group]').boundingBox();
    await v.pointer.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
    await v.pointer.up();
    await v.until(
      () => group().windowIds.length === 1 && group().windowIds[0] === ids[0],
      'drag to new Space',
    );
    await v.shot('drag-new-space');
    await start();
    await page.locator('[data-space-card]').first().tap();
    await page.waitForTimeout(500);
  });
  await v.step('phone-install-launch-uninstall', async () => {
    await open('浏览器');
    await v.navigate(stack.fixture + '/notes/');
    await click(page.getByRole('button', { name: '更多', exact: true }).first());
    await click(page.getByRole('menuitem', { name: /安装为 App/ }));
    let d = page.getByRole('dialog', { name: '安装为 App' });
    await d.getByText('正在读取网页信息').waitFor({ state: 'hidden' });
    await click(d.getByRole('button', { name: '安装', exact: true }));
    await d.waitFor({ state: 'hidden' });
    await v.until(() => v.state.workspace.apps.length === 1, 'App installed');
    await open('Workspace Notes');
    await v.until(() => v.state.workspace.windows.some((w) => w.appId.startsWith('web:')), 'App window');
    await v.shot('app-running');
    await open('设置');
    await v.refresh();
    const w = v.state.workspace.windows.find((w) => w.appId === 'settings');
    const f = page.locator(`[data-window-id="${w.id}"]`);
    await click(f.getByRole('button', { name: '窗口把手' }));
    await click(page.getByRole('menuitem', { name: '移到新窗口组', exact: true }));
    await page.waitForTimeout(600);
    const back = f.getByRole('button', { name: '返回设置分区' });
    if (await back.isVisible()) await click(back);
    await click(f.getByRole('button', { name: 'App', exact: true }));
    await click(f.getByText('Workspace Notes', { exact: true }).first());
    await click(f.getByRole('button', { name: '卸载', exact: true }));
    d = page.getByRole('dialog', { name: '卸载 Workspace Notes？' });
    await click(d.getByRole('button', { name: '卸载', exact: true }));
    await v.until(
      () =>
        v.state.workspace.apps.length === 0 &&
        !v.state.workspace.windows.some((w) => w.appId.startsWith('web:')),
      'App removed with windows',
    );
    await v.shot('app-uninstalled');
  });
});
