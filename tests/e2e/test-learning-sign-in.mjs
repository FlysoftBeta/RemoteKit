import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPath, startStack } from './kit/stack.mjs';
import { cliOptions, launch } from './kit/viewer.mjs';

const options = cliOptions();
const run = options.out ?? runPath('learning-sign-in');
const stack = await startStack({
  scenario: 'learning-sign-in',
  run,
  browser: options['browser-path'],
  learning: { captcha: true },
  port: options.port,
});
const providerFixture = stack.provider;
console.log('RUN ' + stack.run);
let viewer;
const results = [];
try {
  viewer = await launch({ ...options, stack });
  const { page } = viewer;
  if (options.pointer === 'touch') await page.setViewportSize({ width: 390, height: 844 });
  const account = (provider) => viewer.state.learning.accounts[provider];
  for (const [app, provider] of [
    ['学习', 'changyan'],
    ['题库', 'xinjiaoyu'],
  ]) {
    const started = Date.now();
    await viewer.openStart();
    await viewer.tile(app).click();
    await viewer.until(
      () =>
        viewer.state.workspace.windows.some(
          (win) => win.appId === (provider === 'changyan' ? 'study' : 'questions'),
        ),
      app,
    );
    if (provider === 'changyan') {
      await page.getByLabel('账号', { exact: true }).fill('remotekit-e2e-dummy');
      await page.getByLabel('密码', { exact: true }).fill('remotekit-e2e-dummy-password');
    }
    const begin = () =>
      page
        .getByRole('button', {
          name: provider === 'changyan' ? '登录' : '开始登录',
          exact: true,
        })
        .click();
    await begin();
    await viewer.until(
      () =>
        account(provider).status === 'signing_in' &&
        account(provider).step === (provider === 'changyan' ? 'verification' : 'site'),
      'sign-in tab',
      60000,
    );
    const box = page.locator('.learning-sign-in-view');
    await box.waitFor();
    await page.locator('.learning-sign-in-opening').waitFor({ state: 'hidden', timeout: 60000 });
    await page.locator('.learning-sign-in-view .resize-waiting').waitFor({ state: 'hidden' });
    const bounds = await box.boundingBox();
    assert(bounds.width >= 300 && bounds.height >= 200, JSON.stringify(bounds));
    const region = viewer.viewports.at(-1)?.windows.find((win) => win.visible);
    assert(
      region && Math.abs(region.width - bounds.width) < 3 && Math.abs(region.height - bounds.height) < 3,
      JSON.stringify({ bounds, region }),
    );
    await viewer.shot(provider + '-site');
    if (provider === 'changyan') {
      for (let index = 0; index < 12; index++) {
        await viewer.refresh();
        if (account(provider).status !== 'signing_in' || account(provider).step !== 'verification') break;
        await viewer.shot(provider + '-widget-' + index);
        // Fixture verification remains open until the user cancels.
        await page.waitForTimeout(400);
      }
    } else {
      const geometry = providerFixture.events.filter((event) => event.type === 'geometry').at(-1);
      assert(geometry, 'fixture login geometry');
      const inputBounds = await box.boundingBox();
      const x = inputBounds.x + geometry.username.x + geometry.username.width / 2;
      const y = inputBounds.y + geometry.username.y + geometry.username.height / 2;
      if (options.pointer === 'touch') await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      await page.locator('.remote-open-keyboard').waitFor();
      await page.keyboard.type('remotekit-keyboard-check', { delay: 35 });
      await page.keyboard.insertText('中文');
      await viewer.until(
        () =>
          providerFixture.events.some(
            (event) => event.type === 'input' && event.value === 'remotekit-keyboard-check中文',
          ),
        'fixture received keyboard text',
      );
    }
    await page.waitForTimeout(provider === 'changyan' ? 0 : 1800);
    await viewer.shot(provider + '-input');
    await viewer.refresh();
    if (
      account(provider).status !== 'signing_in' ||
      (account(provider).step !== 'verification' && provider === 'changyan')
    ) {
      assert.equal(provider, 'changyan');
      await viewer.until(() => account(provider).status !== 'signing_in', 'dummy account rejected', 60000);
      await page.getByLabel('密码', { exact: true }).fill('remotekit-e2e-dummy-password');
      await begin();
      await viewer.until(
        () => account(provider).status === 'signing_in' && account(provider).step === 'verification',
        'repeat verification',
      );
    }
    await page.getByRole('button', { name: '取消', exact: true }).click({ timeout: 3000 });
    await viewer.until(
      () =>
        account(provider).status === 'signed_out' &&
        !viewer.state.workspace.tabs.some((tab) => tab.signIn === provider),
      'cancel closes sign-in',
    );
    if (provider === 'changyan')
      await page.getByLabel('密码', { exact: true }).fill('remotekit-e2e-dummy-password');
    await begin();
    await viewer.until(() => viewer.state.workspace.tabs.some((tab) => tab.signIn === provider), 'reopen');
    await page.getByRole('button', { name: '窗口把手', exact: true }).last().click();
    await page.getByRole('menuitem', { name: '关闭窗口', exact: true }).click();
    await viewer.until(
      () =>
        account(provider).status === 'signed_out' &&
        !viewer.state.workspace.tabs.some((tab) => tab.signIn === provider),
      'window close cancels',
    );
    results.push({ provider, durationMs: Date.now() - started, bounds });
    console.log(provider + ' cancelled and closed');
  }
  await viewer.assertNoBrowserRestart();
} catch (error) {
  await viewer?.shot('failure');
  throw error;
} finally {
  writeFileSync(join(stack.run, 'results.json'), JSON.stringify(results, null, 2));
  await viewer?.close();
  await stack.stop();
}
