import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stageRuntime } from '../integration/stage-runtime.mjs';
import { startControl, until } from './cluster-test-support.mjs';
import { shellViewer } from './shell-avail-support.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const run = resolve(process.argv[2] ?? join(repository, 'develop/tmp/b2e-shots'));
const port = Number(process.argv[3] ?? 33941);
const origin = `http://127.0.0.1:${port}`;
const requireControl = createRequire(join(repository, 'control/package.json'));
await mkdir(run, { recursive: true });
const runtime = join(run, 'runtime');
await mkdir(join(runtime, 'control/dist'), { recursive: true });
await symlink(join(repository, 'control/node_modules'), join(runtime, 'control/node_modules'), 'junction');
await symlink(join(repository, 'control/dist/client'), join(runtime, 'control/dist/client'), 'junction');
const serverPath = join(runtime, 'control/dist/server.mjs');
await requireControl('esbuild').build({
  entryPoints: [join(repository, 'tests/e2e/shell-avail-harness.mts')],
  outfile: serverPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
const endpoint = resolve(
  process.env.REMOTEKIT_ENDPOINT ?? join(repository, 'build/endpoint/endpoint/endpoint_service.exe'),
);
const browserPath = process.env.REMOTEKIT_BROWSER ?? 'C:/src/chromium/src/out/rel/remotekit_browser.exe';
const bin = join(runtime, 'node/bin');
const executable = stageRuntime(endpoint, browserPath, bin);
for (const directory of ['models', 'documents'])
  await symlink(join(dirname(endpoint), directory), join(bin, directory), 'junction');
const nodes = Object.fromEntries(
  ['alpha', 'beta'].map((id, i) => [
    id,
    {
      peer: { listen: `127.0.0.1:${port + 2 + i}`, address: `127.0.0.1:${port + 2 + i}` },
      local: { executable, root: join(run, id) },
    },
  ]),
);
const configPath = join(runtime, 'control.json');
await writeFile(
  configPath,
  JSON.stringify({
    http: { listen: `127.0.0.1:${port}`, origins: [origin] },
    storage: { database: join(run, 'control.db') },
    nodes,
  }),
);
const fixture = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(
    '<title>Unavailable browser fixture</title><h1>Browser restored</h1><input value="dirty session"><script>localStorage.setItem("shell-avail","dirty")</script>',
  );
});
await new Promise((done) => fixture.listen(port + 1, '127.0.0.1', done));
const control = startControl(serverPath, configPath, run);
const { chromium } = createRequire(import.meta.url)(
  process.env.REMOTEKIT_PLAYWRIGHT ??
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
);
const contexts = [];
let browser;
let currentViewer;
const password = 'shell-' + randomUUID();
const username = 'shell-user';
const shot = async (viewer, name) => {
  await viewer.page.screenshot({ path: join(run, name + '.png'), fullPage: true });
  console.log(name);
};
async function connect(name, setup = false) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['camera'],
  });
  contexts.push(context);
  const response = await context.request.post(origin + (setup ? '/api/auth/setup' : '/api/auth/login'), {
    headers: { Origin: origin },
    data: { username, password },
  });
  assert.equal(response.status(), 200, await response.text());
  const viewer = await shellViewer(context, run, name);
  currentViewer = viewer;
  await viewer.page.goto(origin);
  await viewer.ready();
  await viewer.call('auth.settings', {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  return viewer;
}
async function upload(viewer, name, text) {
  const bytes = Buffer.from(text);
  const draft = await viewer.call(
    'asset.begin',
    { requestId: 'library', operationId: randomUUID(), name, type: 'text/plain', size: bytes.length },
    true,
  );
  await viewer.call(
    'asset.chunk',
    { requestId: 'library', uploadId: draft.uploadId, offset: 0, data: bytes.toString('base64') },
    true,
  );
  const asset = await viewer.call('asset.seal', { requestId: 'library', uploadId: draft.uploadId }, true);
  const snapshot = await viewer.call('library.import', {
    operationId: randomUUID(),
    assetId: asset.assetId,
    name,
    destination: 'library',
    origin: { kind: 'files', channel: 'upload', partitionId: null },
  });
  return { asset, entry: snapshot.entries.find((entry) => entry.name === name), text };
}
try {
  await until(
    'two nodes ready',
    async () => {
      try {
        const value = await control.call('inspect');
        return value.nodes.every((node) => node.state.state === 'ready' && node.metrics);
      } catch {
        return false;
      }
    },
    90000,
  );
  browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const initial = await connect('initial', true);
  await initial.service();
  await initial.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
  await initial.page.waitForFunction(() => shellQA.state?.browser.state === 'available');
  const remote = (await initial.state()).workspace.windows.find((win) => win.appId === 'browser');
  await initial.action({
    type: 'tab.navigate',
    tabId: remote.activeTabId,
    url: `http://127.0.0.1:${port + 1}/`,
  });
  await initial.media();
  const state = await control.call('inspect');
  const tenant = state.users.find((user) => user.username === username).tenant;
  const placement = state.placements.find((entry) => entry.tenant === tenant);
  const nodeA = placement.node_id,
    nodeB = state.nodes.find((entry) => entry.nodeId !== nodeA).nodeId;
  assert.equal(placement.data_state, 'dirty');
  await until('service follows running Session node', async () =>
    (await control.call('inspect')).services.some(
      (entry) => entry.tenant === tenant && entry.nodeId === nodeA,
    ),
  );
  const shared = await upload(initial, 'shared.txt', 'Readable from the surviving node.');
  const exclusive = await upload(initial, 'offline.txt', 'Only the offline node has these bytes.');
  await until('shared replica on B', async () =>
    (await control.call('inspect')).replicas.some(
      (entry) => entry.id === shared.asset.assetId && entry.node_id === nodeB,
    ),
  );
  await control.call('seedFace', { tenant });
  await shot(initial, '01-running-on-A');
  await control.call('down', { tenant, nodeId: nodeA, exclusiveObject: exclusive.asset.assetId });
  await initial.context.close();
  const viewer = await connect('fresh');
  await viewer.service();
  await viewer.call('auth.lock');
  await viewer.page.locator('.viewer-lock-blank').waitFor();
  await viewer.page.evaluate(() => new Promise(requestAnimationFrame));
  for (const key of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'])
    await viewer.page.keyboard.press('Arrow' + key);
  await viewer.page.getByLabel(/账户密码/).fill(password);
  await viewer.page.getByRole('button', { name: '解锁', exact: true }).click();
  await viewer.ready();
  await viewer.page.getByText('浏览器暂不可用：数据所在节点离线，恢复后自动继续', { exact: true }).waitFor();
  await shot(viewer, '02-unlocked-browser-unavailable');
  await viewer.call('auth.lock');
  await viewer.page.locator('.viewer-lock-blank').waitFor();
  await viewer.page.evaluate(() => new Promise(requestAnimationFrame));
  for (const key of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'])
    await viewer.page.keyboard.press('Arrow' + key);
  await viewer.page.getByRole('button', { name: '人脸', exact: true }).click();
  await viewer.page.getByRole('button', { name: '开启摄像头', exact: true }).click();
  await viewer.page.waitForFunction(() => shellQA.authFrames >= 2 && shellQA.authGrants >= 2);
  const face = await viewer.call('auth.get');
  assert(face.face.challengeId);
  await writeFile(
    join(run, 'face-service.json'),
    JSON.stringify(
      await viewer.page.evaluate(() => ({
        auth: shellQA.auth,
        frames: shellQA.authFrames,
        grants: shellQA.authGrants,
      })),
      null,
      2,
    ),
  );
  assert(
    (await control.call('inspect')).services.some(
      (entry) => entry.tenant === tenant && entry.nodeId === nodeB,
    ),
  );
  await shot(viewer, '03-face-service-on-B');
  await viewer.call('auth.verify', { method: 'password', secret: password });
  await viewer.ready();
  await viewer.page.getByRole('button', { name: '开始', exact: true }).click();
  await shot(viewer, '04-start-without-A');
  await viewer.page.keyboard.press('Escape');
  await viewer.action({ type: 'window.open', appId: 'settings', placement: { mode: 'space' } });
  await viewer.page.locator('.settings-app').waitFor();
  await shot(viewer, '05-settings-without-A');
  await viewer.action({ type: 'window.open', appId: 'files', placement: { mode: 'space' } });
  await viewer.page.getByText('暂不可用', { exact: true }).first().waitFor();
  const catalog = await viewer.call('library.get');
  assert.equal(catalog.entries.find((entry) => entry.id === shared.entry.id).available, true);
  assert.equal(catalog.entries.find((entry) => entry.id === exclusive.entry.id).available, false);
  const bytes = await viewer.call(
    'asset.read',
    { requestId: 'library', assetId: shared.asset.assetId, offset: 0 },
    true,
  );
  assert.equal(Buffer.from(bytes.data, 'base64').toString(), shared.text);
  await shot(viewer, '06-files-ready-and-unavailable');
  const files = (await viewer.state()).workspace.windows.find((win) => win.appId === 'files');
  await viewer.action({
    type: 'window.state',
    windowId: files.id,
    state: { launch: { requestId: randomUUID(), entryId: shared.entry.id } },
  });
  await viewer.page.locator('[role="document"][aria-busy="false"] svg').waitFor({ timeout: 120000 });
  await shot(viewer, '07-file-read-on-B');
  await viewer.action({ type: 'window.open', appId: 'study', placement: { mode: 'space' } });
  await viewer.page.locator('.study-app').waitFor();
  const study = await viewer.call('study.settings', { retentionDays: 30 });
  assert.equal(study.retentionDays, 30);
  await shot(viewer, '08-learning-without-A');
  await viewer.call('admin.overview');
  await control.call('up', { nodeId: nodeA });
  await until(
    'browser automatically available',
    async () => (await viewer.state()).browser.state === 'available',
    120000,
  );
  await viewer.action({ type: 'window.focus', windowId: remote.id });
  await viewer.media();
  await shot(viewer, '09-browser-resumed');
  await until(
    'exclusive object becomes available',
    async () =>
      (await viewer.call('library.get')).entries.find((entry) => entry.id === exclusive.entry.id).available,
    90000,
  );
  await viewer.action({ type: 'window.focus', windowId: files.id });
  await viewer.action({ type: 'window.state', windowId: files.id, state: {} });
  await shot(viewer, '10-files-restored');
  await writeFile(
    join(run, 'result.json'),
    JSON.stringify(
      { nodeA, nodeB, tenant, shared, exclusive, final: await control.call('inspect') },
      null,
      2,
    ),
  );
} catch (error) {
  await currentViewer?.page.screenshot({ path: join(run, 'failure.png'), fullPage: true });
  if (currentViewer)
    await writeFile(
      join(run, 'failure.json'),
      JSON.stringify(
        await currentViewer.page.evaluate(() => ({
          auth: shellQA.auth,
          state: shellQA.state,
          text: document.body.innerText,
        })),
        null,
        2,
      ),
    );
  throw error;
} finally {
  await browser?.close();
  await control.stop();
  await new Promise((done) => fixture.close(done));
}
