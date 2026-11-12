import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario } from './kit/viewer.mjs';
// Idle locking, both reveal methods, diagnostic collection, and error lookup.
import assert from 'node:assert/strict';

await runScenario('shell-security-admin', async (v, stack) => {
  const { page } = v;
  const phone = process.env.QA_PHONE === '1';
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const click = async (locator) => {
    if (v.touch) await locator.tap();
    else await locator.click();
    await page.waitForTimeout(400);
  };
  const type = async (locator, text) => {
    await click(locator);
    await page.keyboard.press('Control+A');
    await page.keyboard.type(text, { delay: 90 });
  };
  const button = (s, scope = page) => scope.getByRole('button', { name: s, exact: true });
  const closeStart = async () => {
    if (await page.getByRole('dialog', { name: '开始屏幕' }).isVisible()) await v.closeStart();
  };
  const frame = async (app) => {
    await v.until(() => v.state.workspace.windows.some((w) => w.appId === app), 'App window ' + app, 90000);
    const w = v.state.workspace.windows.find((w) => w.appId === app);
    assert(w);
    return page.locator(`[data-window-id="${w.id}"]`);
  };
  const alone = async (app) => {
    const f = await frame(app);
    await click(button('窗口把手', f));
    await click(page.getByRole('menuitem', { name: '移到新窗口组', exact: true }));
    await page.waitForTimeout(1000);
    return f;
  };
  const section = async (f, name) => {
    await closeStart();
    const back = button('返回设置分区', f);
    if (await back.isVisible()) await click(back);
    await click(button(name, f));
  };
  const savePolicy = async (f, seconds) => {
    await type(f.getByLabel('无操作时长（秒）'), seconds);
    await click(button('保存安全设置', f));
    const d = page.getByRole('dialog');
    await type(d.getByLabel('当前账户密码'), stack.password);
    await click(button('确认', d));
    await d.waitFor({ state: 'hidden' });
  };
  await v.step('idle-lock-and-key-reveal', async () => {
    await v.openStart();
    await click(v.tile('设置'));
    const f = await alone('settings');
    await section(f, '安全');
    await savePolicy(f, '15');
    await page.locator('.viewer-lock-blank').waitFor({ timeout: 45000 });
    await v.shot('idle-locked');
    await v.unlockByKeys();
    await closeStart();
    await savePolicy(f, '300');
    await v.shot('idle-unlocked-keys');
  });
  await v.step('manual-lock-and-tap-reveal', async () => {
    await v.lock();
    await v.unlockByTaps();
    await closeStart();
    await v.shot('unlocked-taps');
  });
  await v.step('diagnostic-start-stop', async () => {
    const f = await frame('settings');
    await section(f, '诊断');
    await click(button('开始诊断', f));
    await button('停止数据收集').waitFor({ timeout: 90000 });
    await v.shot('collecting');
    await page.waitForTimeout(3500);
    await click(button('停止数据收集'));
    const d = page.getByRole('dialog', { name: '诊断已保存' });
    await d.waitFor({ timeout: 90000 });
    await v.shot('saved');
    writeFileSync(join(v.out, 'diagnostic-id.txt'), await d.getByLabel('诊断 ID').inputValue());
    await click(button('完成', d));
  });
  await v.step('admin-nodes-users-storage-error-lookup', async () => {
    await v.openStart();
    await click(v.tile('管理'));
    const f = await alone('admin');
    const select = async (name) => {
      const tab = f.getByRole('tab', { name, exact: true });
      await click((await tab.count()) ? tab : button(name, f));
    };
    await select('用户');
    await v.shot('admin-users');
    await click(button('新建用户', f));
    const duplicate = page.getByRole('dialog', { name: '新建用户' });
    await type(duplicate.getByLabel('用户名'), stack.username);
    await type(duplicate.getByLabel('密码', { exact: true }), stack.password);
    await click(button('创建', duplicate));
    await duplicate.locator('.failure-note').waitFor();
    assert.match(await duplicate.locator('.failure-note').innerText(), /用户名已存在/);
    assert.doesNotMatch(await duplicate.innerText(), /内容已在别处更改/);
    await v.shot('duplicate-user-error');
    await click(button('取消', duplicate));
    await select('存储');
    await page.waitForTimeout(1200);
    await v.shot('admin-storage');
    await select('节点');
    await f.getByText('公钥指纹', { exact: true }).waitFor();
    await v.shot('admin-node');
    await select('诊断');
    const log = readFileSync(join(stack.run, 'logs/control.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    const error = log.filter((r) => r.errorId).at(-1);
    assert(error, 'journey produced an error ID');
    await type(f.getByLabel('错误 ID'), error.errorId);
    await click(button('查找', f));
    await f.getByRole('cell', { name: error.ev, exact: true }).first().waitFor({ timeout: 90000 });
    await click(f.getByRole('cell', { name: error.ev, exact: true }).first());
    await v.shot('admin-error-match');
    writeFileSync(join(v.out, 'matched-error.json'), JSON.stringify(error, null, 2));
  });
});
