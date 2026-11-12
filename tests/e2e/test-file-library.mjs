import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startFixture } from './kit/fixtures.mjs';
import { createViewerContext, instrumentViewer, launchBrowser } from './kit/viewer.mjs';

import { join, resolve } from 'node:path';
import { startStack, until } from './kit/stack.mjs';

/** Real H264, device upload, native FileList delivery and partition/library regression. */
import assert from 'node:assert/strict';

const [modulePath, viewerExe, endpoint, browser, output, listenPort = '34200'] = process.argv.slice(2);
assert([modulePath, viewerExe, endpoint, browser, output].every(Boolean));
const run = resolve(output),
  port = Number(listenPort);
const origin = 'http://127.0.0.1:' + port,
  fixtureOrigin = 'http://127.0.0.1:' + (port + 1);
await mkdir(run, { recursive: true });
const events = [],
  results = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = await startFixture('test-file-library', port + 1, { events });

const stack = await startStack({
  seed: false,
  fixtures: false,
  ports: { control: port + 3, viewer: port, fixture: port + 1, peer: port + 2 },
  run,
  port,
  endpoint,
  browser,
});

let chrome, viewer;
async function stage(name, work) {
  const started = Date.now();
  await work();
  results.push({ name, durationMs: Date.now() - started });
  await writeFile(join(run, 'results.json'), JSON.stringify(results, null, 2));
  console.log(name);
}
try {
  await until(async () => (await fetch(origin + '/api/auth/setup').catch(() => null))?.ok, 'Control ready');
  chrome = await launchBrowser({ executablePath: resolve(viewerExe), headless: true });
  const context = await createViewerContext(chrome, {
    viewport:
      process.env.E2E_POINTER === 'touch' ? { width: 390, height: 844 } : { width: 1600, height: 1000 },
    hasTouch: process.env.E2E_POINTER === 'touch',
  });
  const password = randomUUID();
  const response = await context.request.post(origin + '/api/auth/setup', {
    headers: { Origin: origin },
    data: { username: 'files-smoke', password },
  });
  assert.equal(response.status(), 200, await response.text());
  viewer = await instrumentViewer(context, run, 'files');
  const { page, call } = viewer;
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  await viewer.ready();
  await call('auth.settings', {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  await viewer.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
  const win = (await viewer.state()).workspace.windows[0];
  await viewer.action({ type: 'tab.navigate', tabId: win.activeTabId, url: fixtureOrigin });
  await viewer.media();
  const rtc = (method, params = {}) => call(method, { requestId: 'library', ...params }, true);
  const mutate = (method, params = {}) => call('library.' + method, { operationId: randomUUID(), ...params });
  async function tap(id) {
    await page.waitForFunction(() => {
      const viewport = document.querySelector('.remote-viewport');
      return (
        viewport &&
        !viewport.classList.contains('resize-waiting') &&
        !viewport.querySelector('canvas').classList.contains('no-frame')
      );
    });
    const box = await page.locator('.remote-viewport').boundingBox();
    const geometry = await until(
      () => events.findLast((event) => event.type === 'geometry' && Math.abs(event.width - box.width) < 2),
      'remote geometry',
    );
    const target = geometry.boxes[id];
    await (
      process.env.E2E_POINTER === 'touch'
        ? page.touchscreen.tap.bind(page.touchscreen)
        : page.mouse.click.bind(page.mouse)
    )(
      box.x + ((target.x + 20) * box.width) / geometry.width,
      box.y + ((target.y + 20) * box.height) / geometry.height,
    );
  }
  async function chooser(id) {
    await page.getByRole('dialog', { name: '文件篮', exact: true }).waitFor({ state: 'hidden' });
    await page.waitForTimeout(400);
    await tap(id);
    return until(
      async () => (await viewer.state()).fileRequests.find((request) => request.state === 'pending'),
      'native chooser',
    );
  }
  let entry;
  const bytes = Buffer.from('RemoteKit real device upload 中文\n');
  await stage('device-upload-and-catalog', async () => {
    const request = await chooser('single');
    const dialog = page.getByRole('dialog', { name: '文件篮', exact: true });
    await dialog.getByRole('button', { name: '添加文件', exact: true }).click();
    const upload = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: '从设备选择' }).click();
    await (await upload).setFiles({ name: '设备上传.txt', mimeType: 'text/plain', buffer: bytes });
    const snapshot = await until(async () => {
      const current = await call('library.get');
      return current.basket.length === 1 && current;
    }, 'uploaded entry');
    entry = snapshot.entries.find((item) => item.id === snapshot.basket[0]);
    const chunk = await rtc('asset.read', { assetId: entry.assetId, offset: 0, length: bytes.length });
    assert.equal(digest(Buffer.from(chunk.data, 'base64')), digest(bytes));
    await page.screenshot({ path: join(run, 'device-upload.png') });
    await dialog.getByRole('button', { name: '取消文件选择', exact: true }).click();
    await until(
      async () => !(await viewer.state()).fileRequests.some((item) => item.id === request.id),
      'cancelled chooser',
    );
  });
  await stage('partition-and-idempotent-native-selection', async () => {
    const snapshot = await mutate('partition', { name: '上传归档' });
    const partition = snapshot.partitions[0];
    await mutate('basketPartition', { partitionId: partition.id });
    const request = await chooser('single');
    const params = { operationId: randomUUID(), requestId: request.id, entryIds: [entry.id] };
    const prepared = await call('library.prepare', params);
    assert.deepEqual(await call('library.prepare', params), prepared);
    await call('selection.commit', { requestId: request.id, selectionId: prepared.selectionId }, true);
    const selected = await until(
      () => events.find((event) => event.type === 'selected'),
      'real FileList callback',
    );
    assert.deepEqual(selected.files, [{ name: entry.name, size: bytes.length, hash: digest(bytes) }]);
    const finished = await until(async () => {
      const result = await call('library.finish', prepared);
      return result.state === 'selected' && result;
    }, 'durable selection');
    assert.equal(finished.snapshot.basket.length, 0);
    const collected = finished.snapshot.entries.find((item) => item.id === entry.id);
    assert.equal(collected.partitionId, partition.id);
    assert.equal(collected.collected, true);
    assert.deepEqual(await call('library.finish', prepared), finished);
    assert.equal(events.filter((event) => event.type === 'selected').length, 1);
    await page.screenshot({ path: join(run, 'native-selection.png') });
  });
  await stage('deduplicated-upload-and-library-window', async () => {
    const started = await rtc('asset.begin', {
      operationId: randomUUID(),
      name: entry.name,
      type: 'text/plain',
      size: bytes.length,
    });
    await rtc('asset.chunk', { uploadId: started.uploadId, offset: 0, data: bytes.toString('base64') });
    const duplicate = await rtc('asset.seal', { uploadId: started.uploadId });
    assert.equal(duplicate.assetId, entry.assetId);
    await mutate('import', {
      assetId: entry.assetId,
      name: '共享副本.txt',
      destination: 'library',
      origin: { kind: 'files', channel: 'upload', partitionId: null },
    });
    await viewer.action({ type: 'window.open', appId: 'files', placement: { mode: 'space' } });
    await page.getByText('共享副本.txt', { exact: true }).waitFor();
    await page.screenshot({ path: join(run, 'file-library.png') });
    await mutate('delete', { ids: [entry.id] });
    assert(!(await call('library.get')).entries.some((item) => item.id === entry.id));
    assert.equal((await rtc('asset.describe', { assetId: duplicate.assetId })).size, bytes.length);
  });
  await stage('download-import-and-natural-close', async () => {
    const state = await viewer.state();
    const browserSpace = state.workspace.spaces.find((space) => space.windowIds.includes(win.id));
    await viewer.action({ type: 'space.activate', spaceId: browserSpace.id });
    await tap('download');
    await until(
      () => events.some((event) => event.type === 'download-click' && event.trusted),
      'trusted download click',
    );
    await until(
      async () =>
        (await call('library.get')).entries.some(
          (item) => item.source?.app === 'download' && item.name === 'download.txt',
        ),
      'download imported',
    );
    await tap('closePage');
    const child = await until(
      async () =>
        (await viewer.state()).workspace.tabs.find(
          (tab) => tab.url === fixtureOrigin + '/self-close' && tab.popup?.status === 'adopted',
        ),
      'script-opened child',
    );
    await until(() => events.some((event) => event.boxes?.closeSelf), 'child geometry');
    await tap('closeSelf');
    await until(
      async () => !(await viewer.state()).workspace.tabs.some((tab) => tab.id === child.id),
      'natural close acknowledged',
    );
    await page.screenshot({ path: join(run, 'natural-close.png') });
  });
} catch (error) {
  await viewer?.page.screenshot({ path: join(run, 'failure.png') });
  await writeFile(
    join(run, 'failure.json'),
    JSON.stringify({ error: error.stack, state: await viewer?.state() }, null, 2),
  );
  throw error;
} finally {
  await writeFile(join(run, 'fixture-events.json'), JSON.stringify(events, null, 2));
  await chrome?.close();
  await stack.stop();

  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
}
