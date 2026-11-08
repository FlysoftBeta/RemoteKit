import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakeLearningProvider } from './kit/learning-provider.mjs';
import { startStack, seedUser, until } from './kit/stack.mjs';
import { instrumentViewer, requireControl } from './cluster-test-support.mjs';

const browserPath = process.argv[2] ?? 'C:/src/chromium/src/out/dev/remotekit_browser.exe';
const run = resolve('develop/tmp/e2e/learning-server-' + Date.now());
await mkdir(run, { recursive: true });
const provider = await fakeLearningProvider(run, browserPath);
const savedEnv = { ...process.env };
Object.assign(process.env, provider.env);
let stack;
try {
  stack = await startStack({ scenario: 'learning-server', run, browser: provider.launcher });
} finally {
  for (const key of Object.keys(provider.env)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}
console.log('RUN ' + run);
const { chromium } = createRequire(import.meta.url)(
  process.env.REMOTEKIT_PLAYWRIGHT ??
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const Database = requireControl('better-sqlite3');
const db = new Database(join(run, 'control.db'));
const viewers = [];
const results = [];
async function stage(name, action) {
  const start = Date.now();
  await action();
  results.push({ name, durationMs: Date.now() - start });
  console.log(name + ' ' + (Date.now() - start) + 'ms');
  await writeFile(join(run, 'results.json'), JSON.stringify(results, null, 2));
}
async function connect(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const response = await context.request.post(stack.origin + '/api/auth/login', {
    headers: { Origin: stack.origin },
    data: { username: name, password: stack.password },
  });
  assert.equal(response.status(), 200, await response.text());
  const viewer = await instrumentViewer(context, run, name);
  viewers.push(viewer);
  await viewer.page.goto(stack.origin);
  await viewer.ready();
  return viewer;
}
async function open(viewer, name, appId) {
  await viewer.page.getByRole('button', { name: '主页条', exact: true }).click();
  const tile = viewer.page
    .getByRole('dialog', { name: '开始屏幕' })
    .locator('[data-tile-key]')
    .filter({ has: viewer.page.getByText(name, { exact: true }) })
    .first();
  await tile.click();
  return until(
    async () => (await viewer.state())?.workspace.windows.find((win) => win.appId === appId),
    name,
  );
}
async function signIn(viewer) {
  await open(viewer, '学习', 'study');
  await viewer.page.getByLabel('账号', { exact: true }).fill('fixture-student');
  await viewer.page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await viewer.page.getByRole('button', { name: '登录', exact: true }).click();
  await until(
    async () => (await viewer.state())?.learning.accounts.changyan.status === 'signed_in',
    '畅言 signed_in',
  );
  await until(
    async () => {
      const state = (await viewer.state()).learning.study;
      return state.lastSyncAt && !state.syncing;
    },
    'sync complete',
    90000,
  );
  const state = (await viewer.state()).learning.study;
  assert(!state.error, JSON.stringify(state));
  return viewer.call('library.get');
}
try {
  const first = await connect(stack.username);
  const tenant = db.prepare('SELECT tenant FROM users WHERE username=?').get(stack.username).tenant;
  let catalog;
  let docx;
  await stage('changyan-sign-in-sync', async () => {
    catalog = await signIn(first);
    assert.equal(catalog.entries.length, 5);
    assert(
      catalog.entries.every(
        (entry) => entry.source.app === 'study' && entry.source.channel === '数学' && entry.detail,
      ),
    );
    const docs = catalog.entries.filter((entry) => entry.name.endsWith('.docx'));
    assert.equal(docs.length, 2);
    assert.equal(docs[0].assetId, docs[1].assetId);
    docx = docs[0];
    assert.equal(new Set(catalog.entries.map((entry) => entry.assetId)).size, 4);
    await first.page.screenshot({ path: join(run, 'study-synced.png') });
  });
  await stage('second-tenant-deduplication', async () => {
    await seedUser(join(run, 'control.db'), 'learning-second', stack.password);
    const second = await connect('learning-second');
    const other = await signIn(second);
    assert.deepEqual(
      new Set(other.entries.map((entry) => entry.assetId)),
      new Set(catalog.entries.map((entry) => entry.assetId)),
    );
    assert.equal(
      db
        .prepare(
          'SELECT count(*) AS count FROM objects WHERE id IN (SELECT object_id FROM learning_downloads)',
        )
        .get().count,
      4,
    );
    await second.context.close();
  });
  await stage('docx-pre-render-and-open', async () => {
    await until(
      () =>
        db
          .prepare("SELECT id FROM object_derivations WHERE source_id=? AND kind='document'")
          .get(docx.assetId),
      'docx pre-render',
      90000,
    );
    const start = Date.now();
    const opened = await first.call('document.open', { requestId: 'library', assetId: docx.assetId }, true);
    assert.equal(opened.state, 'ready', JSON.stringify(opened));
    results.push({ name: 'pre-render-open', durationMs: Date.now() - start });
    await first.page.getByRole('button').filter({ hasText: '共享数学讲义.docx' }).first().click();
    await first.page.getByRole('document', { name: '文档第 1 页' }).waitFor();
    await first.page.waitForFunction(
      () => document.querySelector('[role=document]')?.getAttribute('aria-busy') === 'false',
    );
    await first.page.screenshot({ path: join(run, 'study-docx-ready.png') });
    await first.page.keyboard.press('Escape');
  });
  await stage('manual-delete-stays-dismissed', async () => {
    const entry = catalog.entries.find((item) => item.name.endsWith('.mp3'));
    await first.call('library.delete', { operationId: randomUUID(), ids: [entry.id] });
    await first.call('study.sync');
    await until(async () => !(await first.state()).learning.study.syncing, 'resync');
    assert(!(await first.call('library.get')).entries.some((item) => item.assetId === entry.assetId));
    assert.equal(
      db.prepare('SELECT state FROM learning_downloads WHERE tenant=? AND entry_id=?').get(tenant, entry.id)
        .state,
      'dismissed',
    );
  });
  await stage('retention-preserves-partition', async () => {
    const partitioned = await first.call('library.partition', {
      operationId: randomUUID(),
      name: '保留讲义',
    });
    await first.call('library.move', {
      operationId: randomUUID(),
      ids: [docx.id],
      partitionId: partitioned.partitions[0].id,
    });
    db.prepare('UPDATE learning_downloads SET saved_at=? WHERE tenant=?').run(
      Date.now() - 2 * 86400_000,
      tenant,
    );
    await first.call('study.settings', { retentionDays: 1 });
    const retained = await first.call('library.get');
    assert.equal(retained.entries.length, 1);
    assert.equal(retained.entries[0].id, docx.id);
    assert.equal(retained.entries[0].source, null);
    await first.page.screenshot({ path: join(run, 'study-retention.png') });
  });
  await stage('xinjiaoyu-browser-observer', async () => {
    await open(first, '题库', 'questions');
    await first.page.getByRole('button', { name: '开始登录', exact: true }).click();
    await until(
      async () => (await first.state()).learning.accounts.xinjiaoyu.step === 'site',
      '新教育 sign-in view',
    );
    await first.media();
    await first.page.locator('.learning-sign-in-opening').waitFor({ state: 'hidden' });
    const box = await first.page.locator('.learning-sign-in-view').boundingBox();
    const geometry = await until(
      () =>
        provider.events
          .filter(
            (event) =>
              event.type === 'geometry' &&
              Math.abs(event.width - box.width) < 3 &&
              Math.abs(event.height - box.height) < 3,
          )
          .at(-1),
      'fake login geometry',
    );
    const video = await first.page.evaluate(() => {
      const video = document.querySelector('.learning-sign-in-view video');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return {
        png: canvas.toDataURL(),
        layout: clusterQA.layout,
        nodes: [...document.querySelectorAll('.learning-sign-in-view *')].map((node) => ({
          tag: node.tagName,
          class: node.className,
          rect: node.getBoundingClientRect().toJSON(),
          opacity: getComputedStyle(node).opacity,
          visibility: getComputedStyle(node).visibility,
          display: getComputedStyle(node).display,
        })),
      };
    });
    await writeFile(join(run, 'bank-atlas.png'), Buffer.from(video.png.split(',')[1], 'base64'));
    delete video.png;
    await writeFile(join(run, 'bank-video.json'), JSON.stringify(video, null, 2));
    const x = box.x + ((geometry.username.x + geometry.username.width / 2) * box.width) / geometry.width;
    const y = box.y + ((geometry.username.y + geometry.username.height / 2) * box.height) / geometry.height;
    await first.page.mouse.click(x, y);
    await until(() => provider.events.some((event) => event.type === 'focus'), 'Browser username focus');
    await first.page.locator('.remote-open-keyboard').waitFor();
    await first.page.keyboard.type('keyboard-student', { delay: 25 });
    await first.page.keyboard.insertText('中文输入');
    await until(
      () =>
        provider.events.some((event) => event.type === 'input' && event.value === 'keyboard-student中文输入'),
      'Browser keyboard input',
    );
    await first.page.screenshot({ path: join(run, 'bank-sign-in-typed.png') });
    await first.page.mouse.click(
      box.x + ((geometry.login.x + geometry.login.width / 2) * box.width) / geometry.width,
      box.y + ((geometry.login.y + geometry.login.height / 2) * box.height) / geometry.height,
    );
    await until(
      async () => (await first.state()).learning.accounts.xinjiaoyu.status === 'signed_in',
      'Browser observed signed_in',
    );
    assert(!(await first.state()).workspace.tabs.some((tab) => tab.signIn === 'xinjiaoyu'));
    assert([...provider.sessions.values()].some((handshakes) => handshakes === 2));
    assert(!provider.events.some((event) => event.type === 'binding-rejected'));
  });
  await stage('bank-filters-svg-and-media', async () => {
    const studyWindow = (await first.state()).workspace.windows.find((window) => window.appId === 'study');
    await first.action({ type: 'window.close', windowId: studyWindow.id });
    const subjects = await first.call('bank.subjects');
    assert.equal(subjects.subjects.length, 2);
    const subject = await first.call('bank.subject', { subjectId: '02' });
    assert.equal(subject.textbooks[0].id, 'book');
    const catalog = await first.call('bank.catalog', { subjectId: '02', textbookId: 'book' });
    assert.equal(catalog.nodes[0].id, 'chapter');
    const questions = await first.call('bank.questions', {
      subjectId: '02',
      textbookId: 'book',
      catalogId: 'chapter',
      typeIds: ['choice'],
      difficultyIds: ['10018'],
      search: 'fixture',
      page: 1,
      pageSize: 10,
      sort: 'oldest',
    });
    assert(questions.items.some((item) => item.stemHtml.includes('<svg')));
    const request = provider.requests.filter((request) => request.path.endsWith('/esDetail')).at(-1).body;
    assert.deepEqual(request.logicTypeIds, ['choice']);
    assert.deepEqual(request.difficultyIds, ['10018']);
    assert.deepEqual(request.dimensionTagList, [{ dimensionId: 'dimension', tagId: 'tag' }]);
    assert.equal(request.textBookId, 'book');
    assert.equal(request.isDesc, false);
    assert.equal(request.search, 'fixture');
    await first.page.getByRole('combobox', { name: '教材' }).click();
    await first.page.getByRole('option', { name: /数学必修第一册/ }).click();
    await first.page.getByRole('button', { name: '第一章 集合', exact: true }).click();
    await first.page.getByRole('button', { name: '题型', exact: true }).click();
    await first.page.getByRole('menuitem', { name: '选择题', exact: true }).click();
    await first.page.keyboard.press('Escape');
    await first.page.getByRole('button', { name: '难度', exact: true }).click();
    await first.page.getByRole('menuitem', { name: '基础题', exact: true }).click();
    await first.page.getByRole('button', { name: '排序', exact: true }).click();
    await first.page.getByRole('menuitem', { name: '最早', exact: true }).click();
    await first.page.getByRole('textbox', { name: '搜索题目', exact: true }).fill('viewer-filter');
    await until(
      () =>
        provider.requests.some(
          (request) =>
            request.path.endsWith('/esDetail') &&
            request.body.search === 'viewer-filter' &&
            request.body.textBookId === 'book' &&
            request.body.textBookCatalogId === 'chapter' &&
            request.body.logicTypeIds?.includes('choice') &&
            request.body.difficultyIds?.includes('10018') &&
            request.body.isDesc === false,
        ),
      'Viewer filter request',
    );
    await first.page.locator('.learning-html img').first().waitFor();
    await first.page.waitForFunction(() =>
      [...document.querySelectorAll('.learning-html img')].some(
        (image) =>
          image.complete &&
          image.naturalWidth > 0 &&
          image.getAttribute('src').startsWith('/api/learning/media/'),
      ),
    );
    await first.page.screenshot({ path: join(run, 'bank-questions.png') });
    const inlineSvg = await first.page.locator('.learning-html svg').count();
    assert(inlineSvg > 0, 'Needed elsewhere: allow server-rendered SVG in learning/html.tsx');
    await first.page.locator('.learning-html svg').first().scrollIntoViewIfNeeded();
    await first.page.screenshot({ path: join(run, 'bank-formulas.png') });
    results.push({ name: 'viewer-inline-svg', inlineSvg });
    assert(!provider.events.some((event) => event.type === 'failure'), JSON.stringify(provider.events));
  });
} catch (error) {
  for (const [index, viewer] of viewers.entries()) {
    if (!viewer.page.isClosed()) {
      await viewer.page.screenshot({ path: join(run, 'failure-' + index + '.png') });
      await writeFile(
        join(run, 'failure-state-' + index + '.json'),
        JSON.stringify(await viewer.state(), null, 2),
      );
    }
  }
  throw error;
} finally {
  await writeFile(join(run, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
  db.close();
  await stack.stop();
  await provider.close();
}
