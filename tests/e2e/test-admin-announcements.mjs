import { createViewerContext } from './kit/viewer.mjs';

// Admin App window and announcements across two real Viewers.
import { runScenario } from './kit/viewer.mjs';

await runScenario('admin-announcements', async (v, stack) => {
  const { page, shot, tile, step, errors } = v;
  const assert = (condition, label) => {
    if (!condition) throw new Error(label);
  };
  const adminWindow = () => v.state.workspace.windows.find((win) => win.appId === 'admin');
  const app = () => page.locator(`[data-window-id="${adminWindow().id}"]`);
  const member = {
    username: `member-${Date.now()}`,
    password: 'member-e2e-password',
  };
  const title = '维护通知';
  const body = '今晚 22:00 起停机一小时。\n期间无法打开网页。';

  await step('admin-app-opens-from-start', async () => {
    await v.openStart();
    await tile('管理').click();
    await v.until(() => adminWindow(), 'admin window');
    await app().getByRole('heading', { name: '概览' }).waitFor({ timeout: 30000 });
    await shot('01-admin-app');
    await v.openStart();
    await tile('管理').click();
    await v.until(
      () => v.state.workspace.windows.filter((win) => win.appId === 'admin').length === 1,
      'single',
    );
  });

  await step('create-member', async () => {
    await app().getByRole('button', { name: '用户', exact: true }).click();
    await app().getByRole('button', { name: '新建用户' }).click();
    const dialog = page.getByRole('dialog', { name: '新建用户' });
    await dialog.getByLabel('用户名').fill(member.username);
    await dialog.getByLabel('密码', { exact: true }).fill(member.password);
    await dialog.getByRole('button', { name: '创建' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await app().getByText(member.username).waitFor();
  });

  await step('publish-announcement', async () => {
    await app().getByRole('button', { name: '公告', exact: true }).click();
    await app().getByRole('button', { name: '发布公告' }).click();
    const dialog = page.getByRole('dialog', { name: '发布公告' });
    await dialog.getByLabel('标题').fill(title);
    await dialog.getByLabel('内容').fill(body);
    await shot('02-publish-dialog');
    await dialog.getByRole('button', { name: '发布', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await app().getByText('1/2 人已读').waitFor();
    await v.until(
      () => v.state.announcements.length === 1 && v.state.announcements[0].read,
      'publisher read',
    );
    assert((await page.getByRole('dialog').count()) === 0, 'publisher sees no popup');
    await shot('03-admin-announcements');
  });

  await step('member-sees-and-dismisses', async () => {
    const context = await createViewerContext(v.browser, {
      viewport: { width: 1200, height: 800 },
    });
    try {
      const other = await context.newPage();
      const response = await other.request.post(stack.origin + '/api/auth/login', {
        data: member,
        headers: { Origin: stack.origin },
      });
      assert(response.ok(), 'member login');
      await other.goto(stack.origin);
      const dialog = other.getByRole('dialog', { name: title });
      await dialog.waitFor({ timeout: 120000 });
      assert((await dialog.textContent()).includes('期间无法打开网页'), 'body shown');
      await other.screenshot({ path: `${v.out}/04-member-popup.png` });
      await dialog.getByRole('button', { name: '知道了' }).click();
      await dialog.waitFor({ state: 'hidden' });
      // The next snapshot from Control carries read=true; the dialog must not come back.
      await other.waitForTimeout(3000);
      assert((await other.getByRole('dialog', { name: title }).count()) === 0, 'stays read');
      assert(
        (await other.getByRole('button', { name: '管理' }).count()) === 0,
        'member has no admin entry on the empty workspace',
      );
    } finally {
      await context.close();
    }
    await app().getByText('2/2 人已读').waitFor({ timeout: 20000 });
  });

  await step('settings-lists-announcements', async () => {
    await v.openStart();
    await tile('设置').click();
    await v.until(() => v.state.workspace.windows.some((win) => win.appId === 'settings'), 'settings');
    const settings = v.state.workspace.windows.find((win) => win.appId === 'settings');
    const frame = page.locator(`[data-window-id="${settings.id}"]`);
    await frame.getByRole('button', { name: '公告', exact: true }).click();
    await frame.locator('.announcement-item').getByText(title).waitFor();
    await shot('05-settings-announcements');
  });

  await step('admin-app-compact', async () => {
    await page.setViewportSize({ width: 560, height: 900 });
    await v.until(
      () => v.state.workspace.spaces.find((s) => s.id === v.state.workspace.activeSpaceId),
      'space',
    );
    await v.openStart();
    await tile('管理').click();
    await page.getByRole('heading', { name: '开始', exact: true }).waitFor({ state: 'hidden' });
    await app().locator('.admin-compact').waitFor();
    await app().getByRole('tab', { name: '公告' }).waitFor();
    await shot('06-admin-compact');
    await page.setViewportSize({ width: 1600, height: 1000 });
  });

  await step('runtime-clean', async () => {
    assert(errors.length === 0, errors.join('; '));
  });
});
