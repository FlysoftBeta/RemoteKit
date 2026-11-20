import { buildAction } from './kit/product-actions.mts';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStack, until } from './kit/stack.mjs';
import { createViewerContext, instrumentViewer, launchBrowser } from './kit/viewer.mjs';

const [_module, edge, endpoint, browser, output, portArg = '35180'] = process.argv.slice(2);
const run = resolve(output);
const port = Number(portArg);
const origin = `http://127.0.0.1:${port}`;
const events = [];
await mkdir(run, { recursive: true });
const stack = await startStack({
  scenario: 'admin-online-session',
  run,
  port,
  endpoint,
  browser,
  seed: false,
  dev: false,
  fixtures: { kind: 'test-cluster-nodes', context: { events } },
  nodes: ['alpha', 'beta'],
  nodeLimits: { maxSessions: 1 },
  ports: { control: port, viewer: port + 4, fixture: port + 1, peers: [port + 2, port + 3] },
});
let viewers;
let viewer;
try {
  await until(
    async () =>
      (await stack.control.call('inspect')).nodes.every((node) => node.state === 'ready' && node.metrics),
    'two nodes ready',
  );
  viewers = await launchBrowser({ executablePath: edge, headless: true });
  const context = await createViewerContext(viewers, { viewport: { width: 1600, height: 1000 } });
  const response = await context.request.post(origin + '/api/auth/setup', {
    headers: { Origin: origin },
    data: { username: 'online-admin', password: 'online-admin-password' },
  });
  assert.equal(response.status(), 200, await response.text());
  viewer = await instrumentViewer(context, run, 'admin');
  await viewer.page.goto(origin);
  await viewer.ready();
  await viewer.service();
  await viewer.call('auth.settings', {
    currentPassword: 'online-admin-password',
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  await viewer.action(buildAction({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }));
  const browserWindow = (await viewer.state()).workspace.windows.find((window) => window.appId === 'browser');
  const url = `http://127.0.0.1:${port + 1}/online-admin`;
  await viewer.action({ type: 'tab.navigate', tabId: browserWindow.activeTabId, url });
  await viewer.media();
  const before = (await viewer.call('admin.users')).find((user) => user.username === 'online-admin').session;
  const target = before.nodeId === 'alpha' ? 'beta' : 'alpha';
  await viewer.page.evaluate(() => {
    window.originalViewerSocket = clusterQA.socket;
    window.originalBrowserPeer = clusterQA.browser.peer;
    window.viewerSocketClosed = false;
    originalViewerSocket.addEventListener('close', () => {
      window.viewerSocketClosed = true;
    });
  });
  await viewer.action(buildAction({ type: 'window.open', appId: 'admin', placement: { mode: 'space' } }));
  const app = viewer.page.locator('.admin-app:visible');
  await app.getByRole('button', { name: '用户', exact: true }).click();
  const openMenu = () => app.getByRole('button', { name: 'online-admin 的操作', exact: true }).click();
  await openMenu();
  await viewer.page.getByRole('menuitem', { name: '转移', exact: true }).click();
  const transfer = viewer.page.getByRole('dialog', { name: '转移 online-admin 的 Session' });
  await transfer.getByRole('combobox', { name: '目标节点' }).click();
  await viewer.page.getByRole('option', { name: target, exact: true }).click();
  await transfer.getByRole('checkbox', { name: '绑定到该节点' }).check();
  await transfer.getByRole('button', { name: '转移', exact: true }).click();
  await transfer.waitFor({ state: 'hidden', timeout: 210000 });
  await until(async () => {
    const user = (await viewer.call('admin.users')).find((entry) => entry.username === 'online-admin');
    return (
      user.online &&
      user.session.nodeId === target &&
      user.session.boundNodeId === target &&
      user.session.state === 'running'
    );
  }, 'online bound placement');
  await app
    .getByText(new RegExp('已绑定 ' + target))
    .filter({ visible: true })
    .first()
    .waitFor();
  const adminWindow = (await viewer.state()).workspace.windows.find((window) => window.appId === 'admin');
  await viewer.action({ type: 'window.focus', windowId: browserWindow.id });
  await viewer.media();
  await viewer.page.waitForFunction(
    () => clusterQA.browser.peer !== originalBrowserPeer && originalBrowserPeer.connectionState === 'closed',
  );
  assert.equal(
    (await viewer.state()).workspace.tabs.find((tab) => tab.id === browserWindow.activeTabId).url,
    url,
  );
  const generation = (await viewer.state()).endpointGeneration;
  const transferredSession = (await stack.control.call('inspect')).placements[0].session_id;
  await viewer.action({ type: 'window.focus', windowId: adminWindow.id });
  const requestsBeforeReset = events.length;
  await openMenu();
  await viewer.page.getByRole('menuitem', { name: '重置浏览器数据', exact: true }).click();
  const reset = viewer.page.getByRole('dialog', { name: '重置浏览器数据', exact: true });
  await reset.getByRole('button', { name: '重置', exact: true }).click();
  await reset.waitFor({ state: 'hidden', timeout: 210000 });
  await until(async () => (await viewer.state()).endpointGeneration > generation, 'reset media generation');
  await viewer.action({ type: 'window.focus', windowId: browserWindow.id });
  await viewer.media();
  const after = (await viewer.call('admin.users')).find((user) => user.username === 'online-admin');
  assert.equal(after.online, true);
  assert.equal(after.session.state, 'running');
  assert.equal(after.session.boundNodeId, target);
  assert.equal(after.session.nodeId, target);
  assert.equal(
    (await viewer.state()).workspace.tabs.find((tab) => tab.id === browserWindow.activeTabId).url,
    url,
  );
  await until(
    () =>
      events
        .slice(requestsBeforeReset)
        .some(
          (event) =>
            event.type === 'ready' &&
            event.path === '/online-admin' &&
            event.storage === null &&
            event.cookie === '',
        ),
    'reset page loaded with blank browser data',
  );
  assert.notEqual((await stack.control.call('inspect')).placements[0].session_id, transferredSession);
  await viewer.page.screenshot({ path: join(run, 'reset-restored.png') });
  const beforeStop = await stack.control.call('inspect');
  const placementBeforeStop = beforeStop.placements[0];
  const incarnationBeforeStop = beforeStop.observations[placementBeforeStop.tenant].browserIncarnation;
  const generationBeforeStop = (await viewer.state()).endpointGeneration;
  const requestsBeforeStop = events.length;
  await viewer.action({ type: 'window.focus', windowId: adminWindow.id });
  await openMenu();
  await viewer.page.getByRole('menuitem', { name: '立即停止', exact: true }).click();
  const stop = viewer.page.getByRole('dialog', { name: '立即停止', exact: true });
  await stop.getByRole('button', { name: '停止', exact: true }).click();
  await stop.waitFor({ state: 'hidden', timeout: 210000 });
  await until(
    async () => {
      const snapshot = await stack.control.call('inspect');
      const observed = snapshot.observations[placementBeforeStop.tenant];
      return (
        snapshot.placements[0].run_state === 'running' &&
        observed?.browser === 'running' &&
        observed.browserIncarnation !== incarnationBeforeStop
      );
    },
    'self stop restarted Browser',
    90000,
  );
  await viewer.action({ type: 'window.focus', windowId: browserWindow.id });
  await viewer.media();
  await until(
    () =>
      events
        .slice(requestsBeforeStop)
        .some((event) => event.type === 'ready' && event.path === '/online-admin'),
    'self stop restored original page',
  );
  const afterStop = await stack.control.call('inspect');
  assert.equal(afterStop.placements[0].session_id, placementBeforeStop.session_id);
  assert.equal(afterStop.placements[0].node_id, target);
  assert((await viewer.state()).endpointGeneration > generationBeforeStop);
  assert.equal(
    (await viewer.state()).workspace.tabs.find((tab) => tab.id === browserWindow.activeTabId).url,
    url,
  );
  assert.equal(
    await viewer.page.evaluate(
      () =>
        originalViewerSocket === clusterQA.socket &&
        !viewerSocketClosed &&
        originalViewerSocket.readyState === WebSocket.OPEN,
    ),
    true,
  );
  await viewer.page.screenshot({ path: join(run, 'self-stop-restored.png') });
  await writeFile(
    join(run, 'result.json'),
    JSON.stringify({ before, after, beforeStop, afterStop, events }, null, 2),
  );
} catch (error) {
  process.exitCode = 1;
  await writeFile(
    join(run, 'failure.json'),
    JSON.stringify(
      {
        error: error.stack,
        state: await viewer?.state().catch(String),
        snapshot: await stack.control.call('inspect').catch(String),
        events,
      },
      null,
      2,
    ),
  );
} finally {
  await viewers?.close();
  await stack.stop();
}
