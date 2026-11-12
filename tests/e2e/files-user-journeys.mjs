import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJourney } from './kit/viewer.mjs';

const results = [];
function pdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
  ];
  for (const text of ['BT /F1 22 Tf 40 500 Td (Page one) Tj ET', 'BT /F1 22 Tf 40 500 Td (Page two) Tj ET'])
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let text = '%PDF-1.4\n',
    offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text);
  text += 'xref\n0 8\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) text += String(offset).padStart(10, '0') + ' 00000 n \n';
  return Buffer.from(text + `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
const browser = process.env.E2E_BROWSER ?? 'edge';
const pointer = process.env.E2E_POINTER ?? 'mouse';

const j = await startJourney(browser, pointer),
  { page, click, button, menu, type } = j;
const stages = [];
const step = async (name, work) => {
  try {
    await work();
    await j.shot(name);
    stages.push({ name, status: 'pass' });
  } catch (error) {
    stages.push({ name, status: 'fail', error: error.stack });
    await j.shot('fail-' + name).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    if (await button('取消文件选择').isVisible()) await click(button('取消文件选择')).catch(() => {});
  }
  writeFileSync(join(j.run, 'journey-results.json'), JSON.stringify(stages, null, 2));
  console.log(browser, pointer, name, stages.at(-1).status);
};
const upload = async (files, scope = page) => {
  await click(scope.getByRole('button', { name: '添加文件', exact: true }));
  const chooser = page.waitForEvent('filechooser');
  await click(menu('从设备选择'));
  await (await chooser).setFiles(files);
};
const nav = () => page.getByRole('navigation', { name: '文件导航' });
const search = () => page.getByRole('textbox', { name: '搜索文件名' });
const basket = () => page.getByRole('dialog', { name: '文件篮', exact: true });
const libraryPicker = async () => {
  const direct = basket().getByRole('button', { name: '从我的文件选择', exact: true });
  if (await direct.isVisible()) await click(direct);
  else {
    await click(basket().getByRole('button', { name: '添加文件', exact: true }));
    await click(menu('从我的文件选择'));
  }
};
const remote = async (id) => {
  await basket().waitFor({ state: 'hidden' });
  await page.waitForTimeout(600);
  await page.locator('.remote-viewport.resize-waiting').waitFor({ state: 'hidden' });
  const box = await page.locator('.remote-viewport:visible').boundingBox();
  const geo = await j.until(
    () => j.provider.events.findLast((e) => e.type === 'file-geometry' && Math.abs(e.width - box.width) < 3),
    'file fixture geometry',
  );
  const target = geo.boxes[id];
  await j.tapAt(box.x + target.x + 30, box.y + target.y + 12);
};
let photos = [];
try {
  console.log('JOURNEY', j.run);
  await step('01-mixed-device-upload', async () => {
    await j.open('我的文件');
    await upload([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('User notes') },
      {
        name: 'photo.png',
        mimeType: 'image/png',
        buffer: readFileSync('control/test/fixtures/learning/files/lesson.png'),
      },
      { name: 'lesson.pdf', mimeType: 'application/pdf', buffer: pdf() },
      {
        name: 'lesson.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: readFileSync('control/test/fixtures/learning/files/lesson.docx'),
      },
    ]);
    await button('lesson.docx').waitFor({ timeout: 120000 });
  });
  await step('02-image-preview', async () => {
    await click(button('photo.png'));
    await click(menu('查看大图'));
    await page.getByRole('img', { name: 'photo.png' }).waitFor();
    await page.waitForTimeout(600);
  });
  await step('03-document-page-two', async () => {
    await click(button('返回'));
    await click(button('lesson.pdf'));
    await click(menu('预览'));
    await page.getByRole('document', { name: '文档第 1 页' }).waitFor({ timeout: 120000 });
    await click(button('跳转页码'));
    await page.keyboard.press('Control+A');
    await page.keyboard.type('2');
    await page.keyboard.press('Enter');
    await page.getByRole('document', { name: '文档第 2 页' }).waitFor();
    await click(button('放大'));
    await page.waitForTimeout(600);
  });
  await step('04-create-rename-move', async () => {
    if (await button('返回').isVisible()) await click(button('返回'));
    await click(button('新建分区'));
    await type(page.getByLabel('分区名称', { exact: true }), 'Trip draff');
    await click(button('保存'));
    await click(nav().getByText('设置', { exact: true }));
    await click(button('重命名 Trip draff'));
    await type(page.getByLabel('分区名称', { exact: true }), 'Trip 2026');
    await click(button('保存'));
    await click(nav().getByText(pointer === 'touch' ? '全部 4' : '全部', { exact: true }));
    await click(button('notes.txt'));
    await click(menu('移到分区…'));
    await click(page.getByRole('combobox', { name: '分区' }));
    await click(menu('Trip 2026'));
    await click(button('确认'));
  });
  await step('05-search-mistake-correction', async () => {
    if (pointer === 'touch') await click(button('搜索'));
    await type(search(), 'notse');
    assert.equal(await button('notes.txt').count(), 0);
    await j.shot('05-search-typo');
    await type(search(), 'notes');
    await button('notes.txt').waitFor();
    await click(button('清除搜索'));
  });
  await step('06-basket-reorder', async () => {
    for (const name of ['photo.png', 'notes.txt']) {
      await click(button(name));
      await click(menu('加入文件篮'));
    }
    await click(page.getByRole('button', { name: /文件篮（2）/ }));
    const cards = basket().locator('[data-file-card]');
    const before = await cards.evaluateAll((ns) => ns.map((n) => n.dataset.fileCard));
    await j.drag(cards.first(), cards.nth(1));
    const after = await cards.evaluateAll((ns) => ns.map((n) => n.dataset.fileCard));
    assert.deepEqual(after, [before[1], before[0]]);
    await click(button('关闭文件篮'));
  });
  await step('07-delete-cancel-then-confirm', async () => {
    if (await button('关闭文件篮').isVisible()) await click(button('关闭文件篮'));
    await click(button('notes.txt'));
    await click(menu('删除文件'));
    await click(
      page.getByRole('dialog', { name: '删除文件？' }).getByRole('button', { name: '取消', exact: true }),
    );
    await button('notes.txt').waitFor();
    await click(button('lesson.docx'));
    await click(menu('删除文件'));
    await click(
      page.getByRole('dialog', { name: '删除文件？' }).getByRole('button', { name: '删除文件', exact: true }),
    );
    await button('lesson.docx').waitFor({ state: 'hidden' });
  });
  await step('08-reconnect-close-mid-upload', async () => {
    await upload(
      Array.from({ length: 4 }, (_, i) => ({
        name: `resume-${i}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.alloc(1024 * 1024, 65 + i),
      })),
    );
    await j.context.setOffline(true);
    await page.waitForTimeout(1800);
    await j.shot('08-offline');
    await j.context.setOffline(false);
    await click(button('窗口把手'));
    await click(menu('关闭窗口'));
    await page.waitForTimeout(700);
    await j.shot('08-window-closed');
    await j.open('我的文件');
    await button('resume-3.txt').waitFor({ timeout: 120000 });
  });
  await step('09-lock-unlock', async () => {
    await click(button('开始'));
    await click(button('锁定'));
    await page.locator('.viewer-lock-blank').waitFor();
    await j.shot('09-locked');
    await page.evaluate(() => window.__remotekitTest.unlock());
    await type(page.getByLabel(/^账户密码/), j.stack.password);
    await click(button('解锁'));
    await button('开始').waitFor();
  });
  await step('10-fixture-single-accept-and-cancel', async () => {
    await j.open('浏览器');
    await type(
      page.getByRole('textbox', { name: '搜索或输入网址', exact: true }).first(),
      j.provider.origin + '/files-journey',
    );
    await page.keyboard.press('Enter');
    await j.viewer.media();
    await remote('single');
    await basket().waitFor();
    await libraryPicker();
    await basket().getByRole('group', { name: '我的文件', exact: true }).waitFor();
    await j.shot('10-txt-accept-picker');
    await click(basket().getByRole('button', { name: '返回', exact: true }));
    await click(button('取消文件选择'));
    await remote('single');
    await upload(
      [{ name: 'device-single.txt', mimeType: 'text/plain', buffer: Buffer.from('Single device') }],
      basket(),
    );
    await basket().getByRole('radio', { name: '选择 device-single.txt', exact: true }).waitFor();
    await click(basket().getByRole('radio', { name: '选择 device-single.txt', exact: true }));
    await click(basket().getByRole('button', { name: '发送', exact: true }));
    await j.until(
      () =>
        j.provider.events.some(
          (e) =>
            e.type === 'file-selected' &&
            e.id === 'single' &&
            e.trusted &&
            e.files.length === 1 &&
            e.files[0].name === 'device-single.txt',
        ),
      'single native result',
    );
  });
  await step('11-multiple-library-picker', async () => {
    await remote('multiple');
    await basket().waitFor();
    await libraryPicker();
    const grid = basket().getByRole('group', { name: '我的文件', exact: true });
    await click(grid.getByRole('button', { name: 'lesson.pdf', exact: true }));
    await click(basket().getByRole('button', { name: '加入文件篮', exact: true }));
    await click(basket().getByRole('button', { name: '发送', exact: true }));
    await j.until(
      () =>
        j.provider.events.some(
          (e) =>
            e.type === 'file-selected' &&
            e.id === 'multiple' &&
            e.trusted &&
            e.files.some((f) => f.name === 'lesson.pdf'),
        ),
      'multiple native result',
    );
  });
  await step('12-camera-photo-and-scan', async () => {
    await remote('images');
    await basket().waitFor();
    for (const mode of ['普通照片', '文档扫描']) {
      await click(basket().getByRole('button', { name: '添加文件', exact: true }));
      await click(menu('摄像头拍照'));
      const camera = page.getByRole('dialog', { name: '摄像头拍照', exact: true });
      await click(camera.getByRole('button', { name: mode, exact: true }));
      const shutter = camera.getByRole('button', { name: '拍照', exact: true });
      await j.until(() => shutter.isEnabled(), 'camera ready');
      await click(shutter);
      await page.waitForTimeout(1300);
      await j.shot('12-camera-' + (mode === '普通照片' ? 'photo' : 'scan'));
      await click(camera.getByRole('button', { name: '返回', exact: true }));
      await j.until(async () => !(await basket().innerText()).includes('处理中'), 'photo processing', 120000);
    }
    photos = await basket()
      .locator('[data-file-card]')
      .evaluateAll((ns) =>
        ns
          .map((n) => ({
            id: n.dataset.fileCard,
            name: n.querySelector('button[aria-label]')?.getAttribute('aria-label'),
          }))
          .filter((n) => n.name?.startsWith('photo-')),
      );
    assert(photos.length >= 2);
  });
  await step('13-rotate-retake-send', async () => {
    const card = basket().locator(`[data-file-card="${photos[0].id}"]`);
    await click(card.getByRole('button', { name: photos[0].name, exact: true }));
    await click(menu('向右旋转'));
    await page.waitForTimeout(1800);
    await click(card.getByRole('button', { name: photos[0].name, exact: true }));
    await click(menu('重拍'));
    const camera = page.getByRole('dialog', { name: '摄像头拍照', exact: true });
    await j.until(
      () => camera.getByRole('button', { name: '拍照', exact: true }).isEnabled(),
      'retake ready',
    );
    await click(camera.getByRole('button', { name: '拍照', exact: true }));
    await page.waitForTimeout(1500);
    if (await camera.isVisible()) await click(camera.getByRole('button', { name: '返回', exact: true }));
    await j.until(async () => !(await basket().innerText()).includes('处理中'), 'retake processing', 120000);
    await click(basket().getByRole('button', { name: '发送', exact: true }));
    await j.until(
      () =>
        j.provider.events.some(
          (e) =>
            e.type === 'file-selected' &&
            e.id === 'images' &&
            e.trusted &&
            e.files.length >= 2 &&
            e.files.every((f) => f.type.startsWith('image/')),
        ),
      'camera native FileList',
    );
  });
  await step('14-page-download', async () => {
    if (await button('取消文件选择').isVisible()) await click(button('取消文件选择'));
    await remote('download');
    await j.until(
      () => j.provider.events.some((e) => e.type === 'download-click' && e.trusted),
      'page download click',
    );
    await j.open('我的文件');
    await button('page-notes.txt').waitFor({ timeout: 90000 });
  });
  await step('15-study-sign-in-browse-attachment', async () => {
    await j.open('学习');
    await type(page.getByLabel('账号', { exact: true }), 'fixture-student');
    await type(page.getByLabel('密码', { exact: true }), 'fixture-password');
    await click(button('登录'));
    await j.until(
      async () => (await j.viewer.state()).learning.accounts.changyan.status === 'signed_in',
      'study signed in',
    );
    await page.getByText('数学作业 1', { exact: true }).first().waitFor();
    await click(page.getByText('数学作业 1', { exact: true }).first());
    await click(page.getByRole('button').filter({ hasText: '共享数学讲义.docx' }).first());
    await page.getByRole('document', { name: '文档第 1 页' }).waitFor({ timeout: 120000 });
  });
  await step('16-bank-sign-in-expiry', async () => {
    await j.open('题库');
    await click(button('开始登录'));
    await j.viewer.media();
    await page.locator('.learning-sign-in-opening').waitFor({ state: 'hidden', timeout: 90000 });
    const box = await page.locator('.learning-sign-in-view').boundingBox();
    const geo = await j.until(
      () => j.provider.events.findLast((e) => e.type === 'geometry' && Math.abs(e.width - box.width) < 3),
      'bank geometry',
    );
    await j.tapAt(
      box.x + geo.username.x + geo.username.width / 2,
      box.y + geo.username.y + geo.username.height / 2,
    );
    await page.locator('.remote-open-keyboard').waitFor();
    await page.keyboard.type('mistkae', { delay: 70 });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('fixture-student', { delay: 45 });
    await j.until(
      () => j.provider.events.some((event) => event.type === 'input' && event.value === 'fixture-student'),
      'bank username received',
    );
    await j.tapAt(box.x + geo.login.x + geo.login.width / 2, box.y + geo.login.y + geo.login.height / 2);
    await j.until(
      async () => (await j.viewer.state()).learning.accounts.xinjiaoyu.status === 'signed_in',
      'bank signed in',
    );
    await j.shot('16-bank-signed-in');
    await fetch(j.provider.origin + '/fixture/expire');
    const search = page.getByRole('textbox', { name: '搜索题目', exact: true });
    await click(search);
    await page.keyboard.type('expired-session', { delay: 45 });
    await j.until(
      async () => (await j.viewer.state()).learning.accounts.xinjiaoyu.status === 'signed_out',
      'expiry reflected',
    );
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: '开始登录', exact: true }).waitFor({ timeout: 5000 });
    assert.equal((await j.viewer.state()).user.username, j.stack.username);
    await page.getByRole('button', { name: '开始', exact: true }).waitFor();
  });
} finally {
  results.push({ browser, pointer, run: j.run, stages });
  await j.close();
  writeFileSync(join(j.run, 'user-journey-matrix.json'), JSON.stringify(results, null, 2));
  if (stages.some((stage) => stage.status === 'fail')) process.exitCode = 1;
}
