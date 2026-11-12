import { startJourney } from './files-user-session.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const j = await startJourney('chrome89', 'touch'),
  { page } = j;
let count = 0;
page.on('filechooser', async (c) => {
  count++;
  await c.setFiles({
    name: 'touch-device.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Touch selected'),
  });
});
try {
  await page.evaluate(() => {
    window.touchClicks = [];
    document.addEventListener('click', (e) =>
      touchClicks.push({
        trusted: e.isTrusted,
        text: e.target.closest('button,[role=menuitem]')?.textContent,
        x: e.clientX,
        y: e.clientY,
      }),
    );
  });
  await j.open('浏览器');
  await j.type(
    page.getByRole('textbox', { name: '搜索或输入网址', exact: true }).first(),
    j.provider.origin + '/files-journey',
  );
  await page.keyboard.press('Enter');
  await j.viewer.media();
  const box = await page.locator('.remote-viewport:visible').boundingBox();
  const geo = await j.until(
    () => j.provider.events.findLast((e) => e.type === 'file-geometry' && Math.abs(e.width - box.width) < 3),
    'fixture geometry',
  );
  await j.tapAt(box.x + geo.boxes.single.x + 30, box.y + geo.boxes.single.y + 12);
  const basket = page.getByRole('dialog', { name: '文件篮', exact: true });
  await basket.waitFor();
  await j.click(basket.getByRole('button', { name: '添加文件', exact: true }));
  await j.click(j.menu('从设备选择'));
  await page.waitForTimeout(3000);
  await j.shot('menu-device-result');
  const menuCount = count;
  if (!count) {
    await j.click(basket.getByRole('button', { name: '从设备选择', exact: true }));
    await page.waitForTimeout(3000);
    await j.shot('direct-device-result');
  }
  if (count) {
    const choice = basket.getByRole('radio', { name: '选择 touch-device.txt', exact: true });
    await choice.waitFor({ timeout: 90000 });
    await j.click(choice);
    const send = basket.getByRole('button', { name: '发送', exact: true });
    await j.until(() => send.isEnabled(), 'send enabled');
    await j.click(send);
    await j.until(
      () =>
        j.provider.events.some(
          (e) =>
            e.type === 'file-selected' &&
            e.id === 'single' &&
            e.trusted &&
            e.files.length === 1 &&
            e.files[0].name === 'touch-device.txt',
        ),
      'touch device native selection',
    );
    await j.shot('touch-device-sent');
  }
  writeFileSync(
    join(j.run, 'device-probe.json'),
    JSON.stringify(
      {
        menuCount,
        finalCount: count,
        selected: j.provider.events.filter((e) => e.type === 'file-selected'),
        clicks: await page.evaluate(() => touchClicks),
      },
      null,
      2,
    ),
  );
  console.log('PROBE', j.run, menuCount, count);
} finally {
  await j.close();
}
