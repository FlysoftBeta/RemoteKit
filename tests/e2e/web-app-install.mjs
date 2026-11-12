import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runScenario } from './kit/viewer.mjs';

await runScenario('web-app-install', async (v, stack) => {
  const { page, shot, tile, step, errors, out } = v;
  const launcher = v.openStart;
  const fixture = stack.fixture + '/notes/';
  const group = () => v.state.workspace.spaces.find((space) => space.id === v.state.workspace.activeSpaceId);
  const assert = (condition, label) => {
    if (!condition) throw new Error(label);
  };
  const target = fixture;
  const dump = (name, value) => writeFileSync(resolve(out, name + '.json'), JSON.stringify(value, null, 2));
  let app;

  await step('open-fixture-in-browser', async () => {
    await launcher();
    await tile('浏览器').click({ timeout: 120000 });
    await v.until(() => v.state.workspace.windows.length === 1, 'browser');
    const address = page.getByRole('textbox', { name: '搜索或输入网址', exact: true }).first();
    await address.fill(target);
    await address.press('Enter');
    await v.until(
      () => v.state.workspace.tabs.some((tab) => tab.url.startsWith(fixture) && !tab.loading),
      'fixture loaded',
      90000,
    );
    await page.waitForTimeout(4000);
    dump('tabs-browser', v.state.workspace.tabs);
    await shot('01-browser-fixture');
  });

  await step('install-dialog', async () => {
    await page.getByRole('button', { name: '更多' }).first().click();
    await page.getByRole('menuitem', { name: /安装为 App/ }).click();
    const dialog = page.getByRole('dialog', { name: '安装为 App' });
    await dialog.waitFor();
    await v.until(async () => !(await dialog.getByText('正在读取网页信息').count()), 'inspect', 30000);
    await page.waitForTimeout(500);
    await shot('02-install-dialog');
    await dialog.getByText('高级选项').click();
    await page.waitForTimeout(500);
    dump(
      'install-fields',
      await dialog
        .locator('input')
        .evaluateAll((inputs) =>
          inputs.map((input) => ({ label: input.labels?.[0]?.textContent, value: input.value })),
        ),
    );
    await shot('03-install-advanced');
    await dialog.getByRole('button', { name: '安装', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await v.until(() => v.state.workspace.apps.length === 1, 'installed');
    app = v.state.workspace.apps[0];
    assert(app.name === 'Workspace Notes', 'manifest name');
    assert(app.startUrl === fixture && app.scope === fixture, 'manifest start URL and scope');
    assert(app.display === 'standalone' && app.themeColor === '#2660b5', 'manifest presentation');
    assert(app.iconUrl, 'manifest icon');
    dump('app', app);
  });

  await step('start-shows-app', async () => {
    await launcher();
    await page.waitForTimeout(800);
    await shot('04-start');
    await tile(app.name).waitFor();
  });

  await step('open-app-window', async () => {
    const before = v.state.workspace.windows.length;
    await tile(app.name).click();
    await v.until(() => v.state.workspace.windows.length === before + 1, 'app window');
    const win = v.state.workspace.windows.find((win) => win.appId === `web:${app.id}`);
    assert(win, 'window uses the app');
    await v.until(
      () =>
        v.state.workspace.tabs.some(
          (tab) => tab.windowId === win.id && tab.url.startsWith(fixture) && !tab.loading,
        ),
      'app tab loaded',
      90000,
    );
    await page.waitForTimeout(5000);
    dump('workspace-after-open', { windows: v.state.workspace.windows, tabs: v.state.workspace.tabs });
    await shot('05-app-window');
  });

  await step('app-window-alone', async () => {
    const win = v.state.workspace.windows.find((win) => win.appId === `web:${app.id}`);
    await page.locator(`[data-window-id="${win.id}"]`).getByRole('button', { name: '窗口把手' }).click();
    await page.getByRole('menuitem', { name: '移到新窗口组' }).click();
    await v.until(() => group().windowIds.length === 1 && group().windowIds[0] === win.id, 'alone');
    await page.waitForTimeout(3000);
    await shot('06-app-window-alone');
    await page.locator(`[data-window-id="${win.id}"]`).getByRole('button', { name: '窗口把手' }).click();
    await page.waitForTimeout(300);
    await shot('07-app-handle-menu');
    await page.keyboard.press('Escape');
  });

  await step('settings-app-list', async () => {
    await launcher();
    await tile('设置').click();
    await page.getByRole('button', { name: 'App', exact: true }).click();
    await page.getByText(app.name, { exact: true }).first().waitFor();
    await page.waitForTimeout(800);
    await shot('08-settings-apps');
  });

  await step('page-tile-opens-app', async () => {
    await launcher();
    await page.waitForTimeout(800);
    await shot('09-start-after');
    const before = v.state.workspace.windows.map((win) => win.id);
    await page
      .locator('[data-tile-key^="page:"]')
      .filter({ has: page.getByText('Workspace Notes', { exact: true }) })
      .first()
      .click();
    await v.until(() => v.state.workspace.windows.length === before.length + 1, 'opened');
    const opened = v.state.workspace.windows.find((win) => !before.includes(win.id));
    assert(opened.appId === 'web:' + app.id, 'page tile opened ' + opened.appId);
  });

  await step('runtime-clean', async () => {
    assert(errors.length === 0, errors.join('; '));
  });
});
