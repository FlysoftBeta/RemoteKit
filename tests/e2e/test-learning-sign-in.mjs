import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliOptions, launch } from './kit/viewer.mjs';
import { startStack } from './kit/stack.mjs';

const options = cliOptions();
const stack = await startStack({ scenario: 'learning-sign-in', browser: options['browser-path'] });
console.log('RUN ' + stack.run);
let viewer;
const results = [];
try {
  viewer = await launch({ ...options, stack });
  const { page } = viewer;
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
        if (index === 6) await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.waitForTimeout(400);
      }
    } else {
      await page.waitForFunction(() => {
        const video = document.querySelector('.learning-sign-in-view video');
        if (!video?.videoWidth) return false;
        const sample = document.createElement('canvas');
        sample.width = sample.height = 1;
        const draw = sample.getContext('2d');
        draw.drawImage(video, video.videoWidth * 0.64, video.videoHeight * 0.46, 1, 1, 0, 0, 1, 1);
        const [red, green, blue] = draw.getImageData(0, 0, 1, 1).data;
        if (red < 235 || green < 235 || blue < 235) return false;
        draw.drawImage(video, video.videoWidth * 0.64, video.videoHeight * 0.72, 1, 1, 0, 0, 1, 1);
        const [buttonRed, buttonGreen, buttonBlue] = draw.getImageData(0, 0, 1, 1).data;
        return buttonBlue > buttonRed + 80 && buttonBlue > buttonGreen + 60;
      });
      await page.locator('.learning-sign-in-view .resize-waiting').waitFor({ state: 'hidden' });
      const inputBounds = await box.boundingBox();
      await page.mouse.click(
        inputBounds.x + inputBounds.width * 0.64,
        inputBounds.y + inputBounds.height * 0.46,
      );
      await page.locator('.remote-open-keyboard').waitFor();
      await page.keyboard.type('remotekit-keyboard-check', { delay: 35 });
      await page.keyboard.insertText('中文');
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
