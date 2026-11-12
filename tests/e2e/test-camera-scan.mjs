import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cameraFixtures, startFixture } from './kit/fixtures.mjs';
import { createViewerContext, instrumentViewer, launchBrowser } from './kit/viewer.mjs';

import { join, resolve } from 'node:path';
import { startStack, until } from './kit/stack.mjs';

/** Real fake-camera capture, document processing, rotation and native FileList delivery. */
import assert from 'node:assert/strict';

const [modulePath, viewerExe, endpoint, browser, output, listenPort = '34200'] = process.argv.slice(2);
assert([modulePath, viewerExe, endpoint, browser, output].every(Boolean));
const run = resolve(output);
const port = Number(listenPort);
const origin = `http://127.0.0.1:${port}`;
const fixtureOrigin = `http://127.0.0.1:${port + 1}`;
await mkdir(run, { recursive: true });

const cameras = await cameraFixtures(run);
const events = [];
const results = [];
const rpcEvidence = [];
const fixture = await startFixture('test-camera-scan', port + 1, { events });

const stack = await startStack({
  seed: false,
  fixtures: false,
  ports: { control: port + 3, viewer: port, fixture: port + 1, peer: port + 2 },
  run,
  port,
  endpoint,
  browser,
});

const password = randomUUID();
let chrome;
let viewer;
let registered = false;
let win;

async function stage(name, work) {
  const started = Date.now();
  const evidence = await work();
  results.push({ name, durationMs: Date.now() - started, ...evidence });
  await writeFile(join(run, 'results.json'), JSON.stringify(results, null, 2));
  console.log(name, JSON.stringify(evidence));
}
async function saveRPCs() {
  if (viewer) rpcEvidence.push(...(await viewer.page.evaluate(() => cameraQA)));
}
async function openViewer(sample) {
  if (viewer) await saveRPCs();
  await chrome?.close();
  viewer = undefined;
  chrome = await launchBrowser({
    executablePath: resolve(viewerExe),
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${cameras.get(sample)}`,
      '--use-fake-ui-for-media-stream',
    ],
  });
  const context = await createViewerContext(chrome, {
    viewport: { width: 1280, height: 720 },
    hasTouch: process.env.E2E_POINTER === 'touch',
  });
  const response = await context.request.post(origin + `/api/auth/${registered ? 'login' : 'setup'}`, {
    headers: { Origin: origin },
    data: { username: 'camera-scan', password },
  });
  assert.equal(response.status(), 200, await response.text());
  registered = true;
  await context.addInitScript(() => {
    window.cameraQA = [];
    window.cameraRotationClicks = [];
    document.addEventListener('click', (event) => {
      const item = event.target.closest('[role="menuitem"]');
      if (item?.textContent === '向右旋转') {
        cameraRotationClicks.push({
          at: performance.now(),
          trusted: event.isTrusted,
        });
      }
    });
    const send = RTCDataChannel.prototype.send;
    const observed = new WeakSet();
    RTCDataChannel.prototype.send = function (data) {
      if (!observed.has(this)) {
        observed.add(this);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          const reply = JSON.parse(event.data);
          const record = cameraQA.find((item) => item.request.requestId === reply.requestId);
          if (record) {
            record.reply = reply;
            record.receivedAt = performance.now();
          }
        });
      }
      if (typeof data === 'string') {
        const message = JSON.parse(data);
        if (message.method === 'photo.process')
          cameraQA.push({ request: message, sentAt: performance.now() });
      }
      return send.call(this, data);
    };
  });
  viewer = await instrumentViewer(context, run, `sample-${sample}-${Date.now()}`);
  viewer.page.setDefaultNavigationTimeout(120000);
  await viewer.page.goto(origin);
  await viewer.ready(90000);
  await viewer.call('auth.settings', {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  if (!win) {
    await viewer.action({
      type: 'window.open',
      appId: 'browser',
      placement: { mode: 'space' },
    });
    win = (await viewer.state()).workspace.windows[0];
    await viewer.action({
      type: 'tab.navigate',
      tabId: win.activeTabId,
      url: fixtureOrigin,
    });
  }
  await viewer.media();
}
const rtc = (method, params) => viewer.call(method, { requestId: 'library', ...params }, true);
const library = () => viewer.call('library.get');
const dialog = () => viewer.page.getByRole('dialog', { name: '文件篮', exact: true });
async function chooser(id) {
  await dialog().waitFor({ state: 'hidden' });
  await viewer.page.waitForTimeout(400);
  await viewer.page.waitForFunction(() => {
    const viewport = document.querySelector('.remote-viewport');
    return (
      viewport &&
      !viewport.classList.contains('resize-waiting') &&
      !viewport.querySelector('canvas').classList.contains('no-frame')
    );
  });
  const box = await viewer.page.locator('.remote-viewport').boundingBox();
  const geometry = await until(
    () =>
      events.findLast(
        (event) =>
          event.type === 'geometry' &&
          Math.abs(event.width - box.width) < 2 &&
          Math.abs(event.height - box.height) < 2,
      ),
    'remote geometry',
  );
  const target = geometry.boxes[id];
  await (
    process.env.E2E_POINTER === 'touch'
      ? viewer.page.touchscreen.tap.bind(viewer.page.touchscreen)
      : viewer.page.mouse.click.bind(viewer.page.mouse)
  )(
    box.x + ((target.x + 20) * box.width) / geometry.width,
    box.y + ((target.y + 20) * box.height) / geometry.height,
  );
  const request = await until(
    async () => (await viewer.state()).fileRequests.find((item) => item.state === 'pending'),
    'native chooser',
  );
  await dialog().waitFor();
  assert.equal(request.multiple, id === 'multiple');
  assert(request.accept.includes(id === 'single' ? 'image/png' : 'image/*'));
  return request;
}
async function cancelChooser() {
  await dialog().getByRole('button', { name: '取消文件选择', exact: true }).click();
  await until(async () => !(await viewer.state()).fileRequests.length, 'chooser cancelled');
}
async function dimensions(assetId) {
  const asset = await rtc('asset.describe', { assetId });
  const chunks = [];
  let offset = 0;
  while (offset < asset.size) {
    const chunk = await rtc('asset.read', { assetId, offset });
    assert(chunk.offset > offset);
    chunks.push(Buffer.from(chunk.data, 'base64'));
    offset = chunk.offset;
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, asset.size);
  const size = await viewer.page.evaluate(
    async ({ data, type }) => {
      const image = await createImageBitmap(await (await fetch(`data:${type};base64,${data}`)).blob());
      const result = { width: image.width, height: image.height };
      image.close();
      return result;
    },
    { data: bytes.toString('base64'), type: asset.type },
  );
  return { ...size, type: asset.type, bytes: asset.size };
}
async function shoot(mode) {
  const before = await library();
  await dialog().getByRole('button', { name: '添加文件', exact: true }).click();
  await viewer.page.getByRole('menuitem', { name: '摄像头拍照', exact: true }).click();
  const camera = viewer.page.getByRole('dialog', {
    name: '摄像头拍照',
    exact: true,
  });
  await camera
    .getByRole('button', {
      name: mode === 'scan' ? '文档扫描' : '普通照片',
      exact: true,
    })
    .click();
  const shutter = camera.getByRole('button', { name: '拍照', exact: true });
  await shutter.waitFor();
  await until(() => shutter.isEnabled(), 'camera ready');
  const capture = await camera.locator('video').evaluate((video) => ({
    width: video.videoWidth,
    height: video.videoHeight,
  }));
  assert.deepEqual(capture, { width: 1920, height: 1080 });
  await shutter.click();
  const entry = await until(
    async () => {
      const snapshot = await library();
      return snapshot.entries.find(
        (item) =>
          snapshot.basket.includes(item.id) &&
          !before.basket.includes(item.id) &&
          item.type === 'image/webp' &&
          !item.photo?.pending,
      );
    },
    `${mode} WebP entry`,
    90000,
  );
  assert.match(entry.name, /\.webp$/i);
  assert.equal(entry.photo.mode, mode);
  assert(entry.originalAssetId);
  const original = await dimensions(entry.originalAssetId);
  assert.equal(original.type, 'image/jpeg');
  assert.deepEqual([original.width, original.height], [1920, 1080]);
  const derivative = await dimensions(entry.assetId);
  assert.equal(derivative.type, 'image/webp');
  const processing = await viewer.page.evaluate(
    (assetId) => cameraQA.find((item) => item.reply?.result?.assetId === assetId),
    entry.assetId,
  );
  assert(processing, 'observed photo.process result');
  assert.equal(processing.request.params.assetId, entry.originalAssetId);
  assert.equal(processing.request.params.mode, mode);
  assert(!Object.hasOwn(processing.request.params, 'quarterTurns'));
  await camera.getByRole('button', { name: '返回', exact: true }).click();
  await dialog().waitFor();
  return { entry, original, derivative, processing: processing.reply.result };
}

try {
  await until(async () => (await fetch(origin + '/api/auth/setup').catch(() => null))?.ok, 'Control ready');
  await openViewer(3);
  await stage('1-native-chooser', async () => {
    const request = await chooser('single');
    return {
      accept: request.accept,
      multiple: request.multiple,
      media: (await viewer.media()).framesDecoded,
    };
  });
  let scan3;
  let scan4;
  let photo3;
  await stage('2-scan-3-orientation', async () => {
    scan3 = await shoot('scan');
    assert.equal(scan3.entry.photo.quarterTurns, 1);
    assert.equal(scan3.processing.quarterTurns, 1);
    assert.equal(scan3.processing.orientation, 'text');
    assert(scan3.derivative.height > scan3.derivative.width);
    return scan3;
  });
  await cancelChooser();
  await openViewer(4);
  await chooser('single');
  await stage('3-scan-4-perspective', async () => {
    scan4 = await shoot('scan');
    assert(!Object.hasOwn(scan4.entry.photo, 'quarterTurns'));
    assert.equal(scan4.processing.quarterTurns, 0);
    assert.equal(scan4.processing.geometry, 'perspective');
    assert.notDeepEqual([scan4.derivative.width, scan4.derivative.height], [1920, 1080]);
    return scan4;
  });
  await cancelChooser();
  await openViewer(3);
  await chooser('single');
  await stage('4-photo-3-orientation', async () => {
    photo3 = await shoot('photo');
    assert.equal(photo3.entry.photo.quarterTurns, 1);
    assert.equal(photo3.processing.orientation, 'text');
    assert.equal(photo3.processing.geometry, 'unchanged');
    assert.deepEqual([photo3.derivative.width, photo3.derivative.height], [1080, 1920]);
    return photo3;
  });
  await stage('5-debounced-manual-rotation', async () => {
    const before = await library();
    const count = await viewer.page.evaluate(() => cameraQA.length);
    const card = dialog().locator(`[data-file-card="${photo3.entry.id}"]`);
    const clickRotation = async () => {
      await card.getByRole('button', { name: photo3.entry.name, exact: true }).click();
      // Click the rendered menu coordinates after the opening frame. The
      // normal locator stability wait costs most of the 600 ms debounce.
      const item = viewer.page.getByRole('menuitem', { name: '向右旋转', exact: true });
      await item.waitFor();
      await viewer.page.waitForTimeout(100);
      const bounds = await item.boundingBox();
      await viewer.page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await viewer.page.getByRole('menuitem', { name: '向右旋转', exact: true }).waitFor({ state: 'hidden' });
    };
    await clickRotation();
    await clickRotation();
    const clicks = await viewer.page.evaluate(() => cameraRotationClicks);
    assert.equal(clicks.length, 2);
    assert(clicks.every((click) => click.trusted));
    const clickIntervalMs = clicks[1].at - clicks[0].at;
    assert(clickIntervalMs < 600, `rotations exceeded debounce window: ${clickIntervalMs} ms`);
    const rotated = await until(
      async () =>
        (await library()).entries.find(
          (item) => item.id === photo3.entry.id && item.photo?.quarterTurns === 3,
        ),
      'rotation committed',
      90000,
    );
    const after = await library();
    assert.deepEqual(after.basket, before.basket);
    assert.equal(rotated.id, photo3.entry.id);
    assert.equal(rotated.originalAssetId, photo3.entry.originalAssetId);
    const requests = await viewer.page.evaluate((count) => cameraQA.slice(count), count);
    assert.equal(requests.length, 1, JSON.stringify(requests));
    assert.equal(requests[0].request.params.quarterTurns, 3);
    assert.equal(requests[0].request.params.assetId, photo3.entry.originalAssetId);
    assert.equal(requests[0].reply.result.orientation, 'manual');
    const derivative = await dimensions(rotated.assetId);
    assert.deepEqual([derivative.width, derivative.height], [1080, 1920]);
    await viewer.page.screenshot({ path: join(run, 'rotated-basket.png') });
    return {
      clickIntervalMs,
      requests,
      basketBefore: before.basket,
      basketAfter: after.basket,
      rotated,
      derivative,
    };
  });
  await stage('6-native-selection-handoff', async () => {
    await dialog()
      .getByRole('radio', { name: `选择 ${scan3.entry.name}`, exact: true })
      .check();
    await dialog().getByRole('button', { name: '发送', exact: true }).click();
    const png = await until(
      () => events.find((event) => event.type === 'selected' && event.id === 'single'),
      'PNG native FileList',
    );
    assert.equal(png.trusted, true);
    assert.equal(png.files.length, 1);
    assert.equal(png.files[0].type, 'image/png');
    assert.match(png.files[0].name, /\.png$/i);
    assert.deepEqual(
      [png.files[0].width, png.files[0].height],
      [scan3.derivative.width, scan3.derivative.height],
    );
    assert.equal(png.files[0].pixel.length, 4);
    await until(async () => !(await viewer.state()).fileRequests.length, 'PNG chooser completed');
    await chooser('multiple');
    const basket = await library();
    const expected = basket.basket.map((id) => basket.entries.find((entry) => entry.id === id));
    assert(expected.length > 0);
    await dialog().getByRole('button', { name: '发送', exact: true }).click();
    const webp = await until(
      () => events.find((event) => event.type === 'selected' && event.id === 'multiple'),
      'WebP native FileList',
    );
    assert.equal(webp.trusted, true);
    assert.equal(webp.files.length, expected.length);
    for (const [index, file] of webp.files.entries()) {
      assert.equal(file.type, 'image/webp');
      assert.equal(file.name, expected[index].name);
      assert.match(file.name, /\.webp$/i);
      assert(file.width > 0 && file.height > 0);
      assert.equal(file.pixel.length, 4);
    }
    return { png, webp };
  });
} catch (error) {
  await viewer?.page.screenshot({ path: join(run, 'failure.png'), timeout: 15000 }).catch(() => {});
  await writeFile(
    join(run, 'failure.json'),
    JSON.stringify({ error: error.stack, state: await viewer?.state() }, null, 2),
  );
  throw error;
} finally {
  await saveRPCs();
  await writeFile(join(run, 'photo-rpcs.json'), JSON.stringify(rpcEvidence, null, 2));
  await writeFile(join(run, 'fixture-events.json'), JSON.stringify(events, null, 2));
  await chrome?.close();
  await stack.stop();

  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
}
