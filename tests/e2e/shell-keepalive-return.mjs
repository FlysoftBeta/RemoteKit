import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario } from './kit/viewer.mjs';

await runScenario('shell-keepalive-return', async (v, stack) => {
  const phone = process.env.QA_PHONE === '1';
  if (phone) await v.page.setViewportSize({ width: 390, height: 844 });
  await v.openStart();
  if (v.touch) await v.tile('浏览器').tap();
  else await v.tile('浏览器').click();
  await v.navigate(stack.fixture + '/notes/keepalive');
  await v.page.locator('canvas[data-video-input]:not(.no-frame)').first().waitFor({ timeout: 90000 });
  await v.page.getByRole('button', { name: '更多', exact: true }).first().click();
  await v.page.getByRole('menuitemcheckbox', { name: /挂机模式/ }).click();
  await v.until(() => v.state.workspace.tabs.some((t) => t.idleKeepAlive), 'keepalive enabled');
  const before = v.state.workspace.tabs.find((t) => t.idleKeepAlive);
  await v.shot('enabled');
  await v.page.close();
  await new Promise((done) => setTimeout(done, 12000));
  const page = await v.context.newPage();
  page.setDefaultTimeout(90000);
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto(stack.origin, { timeout: 120000 });
    await page.locator('.viewer-lock-blank').waitFor();
    await page.waitForTimeout(600);
    if (v.touch) {
      const cdp = await v.context.newCDPSession(page);
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
        await page.waitForTimeout(90);
      }
    } else
      for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'])
        await page.keyboard.press('Arrow' + direction);
    const password = page.locator('input[autocomplete="current-password"]');
    await password.click();
    await page.keyboard.type(stack.password, { delay: 70 });
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await page.getByText(/挂机期间页面保持运行/).waitFor();
    await page.screenshot({ path: join(v.out, 'return-notice.png') });
    const after = await page.evaluate(() => __remotekitTest.state());
    assert(after.workspace.tabs.some((t) => t.id === before.id && t.url === before.url));
    writeFileSync(
      join(v.out, 'return.json'),
      JSON.stringify({ before, after, text: await page.locator('body').innerText() }, null, 2),
    );
    console.log('Keepalive return notice verified');
  } catch (error) {
    await page.screenshot({ path: join(v.out, 'failure.png') }).catch(() => {});
    throw error;
  }
});
