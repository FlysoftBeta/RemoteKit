import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startFixture } from './kit/fixtures.mjs';
import { createViewerContext, instrumentViewer, launchBrowser } from './kit/viewer.mjs';

import { connect, createServer as createProxy } from 'node:net';
import { join, resolve } from 'node:path';
import { pause, requireControl, startStack, until } from './kit/stack.mjs';

import assert from 'node:assert/strict';

const [modulePath, edge, endpoint, browser, output, portArg = '34050'] = process.argv.slice(2);
assert([modulePath, edge, endpoint, browser, output].every(Boolean));
const run = resolve(output),
  port = Number(portArg),
  origin = 'http://127.0.0.1:' + (port + 4);
await mkdir(run, { recursive: true });
let management = true,
  closePage = false,
  childLoads = 0,
  geometry;
const sockets = new Set();
const proxy = createProxy((socket) => {
  if (!management) {
    socket.destroy();
    return;
  }
  const upstream = connect(port, '127.0.0.1');
  sockets.add(socket);
  sockets.add(upstream);
  for (const peer of [socket, upstream]) {
    peer.on('error', () => {});
    peer.on('close', () => {
      sockets.delete(peer);
      socket.destroy();
      upstream.destroy();
    });
  }
  socket.pipe(upstream);
  upstream.pipe(socket);
});
await new Promise((done) => proxy.listen(port + 2, '127.0.0.1', done));
const fixture = await startFixture('test-coordination-reconnect', port + 1, {
  getClosePage: () => closePage,
  setGeometry: (value) => {
    geometry = value;
  },
  onChildLoad: () => childLoads++,
});

const nodeRoot = join(run, 'node');
const stack = await startStack({
  scenario: 'coordination-reconnect',
  run,
  endpoint,
  browser,
  seed: false,
  fixtures: false,
  ports: { control: port, viewer: port + 4, fixture: port + 1, peer: port + 3 },
  nodes: { alpha: { remote: { control: 'ws://127.0.0.1:' + (port + 2) + '/api/node' } } },
});
const control = stack.control;
let native, viewers, context;
try {
  native = await stack.startRemote('alpha', nodeRoot);
  await until(
    () => Promise.resolve(control.events.some((event) => event.event === 'node.ready')),
    'remote node ready',
  );

  viewers = await launchBrowser({
    executablePath: edge,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  context = await createViewerContext(viewers, { viewport: { width: 1100, height: 800 } });
  const password = randomUUID();
  const setup = await context.request.post(origin + '/api/auth/setup', {
    headers: { Origin: origin },
    data: { username: 'coordination', password },
  });
  assert.equal(setup.status(), 200, await setup.text());
  const viewer = await instrumentViewer(context, run, 'viewer');
  await viewer.page.goto(origin, { timeout: 120000 });
  await viewer.ready();
  await viewer.call('auth.settings', {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  await viewer.action({
    type: 'window.open',
    appId: 'browser',
    placement: { mode: 'space' },
    url: 'http://127.0.0.1:' + (port + 1) + '/parent',
  });
  await viewer.media();
  await until(() => geometry, 'parent geometry');
  const viewport = viewer.page.locator('.remote-viewport').first();
  await viewer.page.waitForFunction(() => {
    const viewport = document.querySelector('.remote-viewport');
    const tab = clusterQA.state?.workspace.tabs[0];
    return (
      clusterQA.layout?.views.some((view) => view.id === tab?.webviewId && !view.stale) &&
      viewport?.querySelector('video')?.videoWidth > 0 &&
      !viewport.classList.contains('resize-waiting') &&
      !viewport.querySelector('canvas[data-video-input]')?.classList.contains('no-frame')
    );
  });
  const box = await viewport.boundingBox();
  await viewer.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const child = await until(
    async () =>
      (await viewer.state()).workspace.tabs.find(
        (tab) => tab.url.endsWith('/child') && tab.popup?.status === 'adopted',
      ),
    'adopted child tab',
  );
  const before = await control.call('inspect');
  const placement = before.placements[0],
    actual = before.observations[placement.tenant],
    loads = childLoads;
  management = false;
  for (const socket of sockets) socket.destroy();
  await until(
    () => Promise.resolve(control.events.some((event) => event.event === 'node.offline')),
    'management disconnected',
  );
  closePage = true;
  const Database = requireControl('better-sqlite3');
  await until(() => {
    const db = new Database(join(nodeRoot, 'data/sessions', placement.session_id, 'session.db'), {
      readonly: true,
    });
    try {
      return db
        .prepare("SELECT body FROM events WHERE type='view.closed'")
        .all()
        .some(
          (row) =>
            JSON.parse(row.body).body?.viewId === child.webviewId ||
            JSON.parse(row.body).viewId === child.webviewId,
        );
    } finally {
      db.close();
    }
  }, 'durable disconnected close');
  management = true;
  await until(
    () => Promise.resolve(control.events.filter((event) => event.event === 'node.ready').length >= 2),
    'node reconnected',
    60000,
  );
  await viewer.call('auth.verify', { method: 'password', secret: password });
  await until(
    async () => !(await viewer.state()).workspace.tabs.some((tab) => tab.id === child.id),
    'product removed closed tab',
    60000,
  );
  await pause(1500);
  const after = await control.call('inspect'),
    observed = after.observations[placement.tenant];
  assert.equal(native.exitCode, null);
  assert.equal(observed.browserIncarnation, actual.browserIncarnation);
  assert.equal(observed.browserPid, actual.browserPid);
  assert.equal(
    observed.views.some((view) => view.viewId === child.webviewId),
    false,
  );
  assert.equal(childLoads, loads);
  // The bootstrap path is shown for remote nodes (docs/cluster.md); managed
  // local nodes intentionally omit that distribution path.
  await viewer.page.getByRole('button', { name: '开始', exact: true }).click();
  await viewer.page
    .getByRole('dialog', { name: '开始屏幕' })
    .locator('[data-tile-key]')
    .filter({ has: viewer.page.getByText('管理', { exact: true }) })
    .click();
  const adminWindow = await until(
    async () => (await viewer.state()).workspace.windows.find((win) => win.appId === 'admin'),
    'admin window',
  );
  const admin = viewer.page.locator(`[data-window-id="${adminWindow.id}"]`);
  await admin
    .locator('.admin-nav .MuiListItemButton-root, .admin-tabs [role="tab"]')
    .filter({ hasText: /^节点$/ })
    .click();
  await admin.getByText('公钥指纹', { exact: true }).waitFor();
  await admin.getByText(/node\.json/).waitFor();
  assert.match(await admin.innerText(), /nodes[\\/]alpha[\\/]node\.json/);
  await viewer.page.screenshot({ path: join(run, 'remote-node-fingerprint-path.png') });
  // The shared cluster harness exposes an existing monotonic clock hook. Only
  // elapsed absence is advanced; all Viewer actions below remain real UI input.
  const beforeAbsence = await viewer.state();
  await viewer.page.close();
  await until(
    async () => {
      const snapshot = await control.call('inspect');
      const observed = snapshot.observations[placement.tenant];
      return (
        !snapshot.runtimes.find((runtime) => runtime.tenant === placement.tenant)?.viewer &&
        observed?.converged &&
        !observed.rtc?.active
      );
    },
    'detached viewer and settled native session',
    90000,
  );
  await control.call('advance', { ms: 11 * 60 * 1000 });
  const absent = await control.call('inspect');
  await writeFile(join(run, 'absence-before.json'), JSON.stringify({ beforeAbsence, absent }, null, 2));
  const returning = await instrumentViewer(context, run, 'returning-viewer');
  await returning.page.goto(origin, { timeout: 120000 });
  await returning.page.locator('.viewer-lock-blank').waitFor();
  await pause(500);
  for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'])
    await returning.page.keyboard.press('Arrow' + direction);
  await returning.page.locator('input[autocomplete="current-password"]').click();
  await returning.page.keyboard.type(password, { delay: 80 });
  await returning.page.getByRole('button', { name: '解锁', exact: true }).click();
  await returning.ready(120000);
  const returnedMedia = await returning.media();
  const afterAbsence = await returning.state();
  for (const tab of beforeAbsence.workspace.tabs)
    assert(afterAbsence.workspace.tabs.some((next) => next.id === tab.id && next.url === tab.url));
  await returning.page.screenshot({ path: join(run, 'normal-long-absence-return.png') });
  await writeFile(
    join(run, 'absence-return.json'),
    JSON.stringify({ beforeAbsence, absent, afterAbsence, returnedMedia }, null, 2),
  );
  await returning.page.close();
  await until(
    async () =>
      !(await control.call('inspect')).runtimes.find((runtime) => runtime.tenant === placement.tenant)
        ?.viewer,
    'viewer detached before stop',
  );
  await until(
    async () => {
      try {
        const users = await control.call('stop', { username: 'coordination' });
        return users.find((user) => user.username === 'coordination').session.state === 'stopped';
      } catch (error) {
        if (/会话状态尚未稳定/.test(error.message)) return false;
        throw error;
      }
    },
    'stopped Session',
    120000,
  );
  const stoppedState = await control.call('inspect');
  const stoppedReturn = await instrumentViewer(context, run, 'stopped-return');
  await stoppedReturn.page.goto(origin, { timeout: 120000 });
  await stoppedReturn.page.locator('.viewer-lock-blank').waitFor();
  await pause(500);
  for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'])
    await stoppedReturn.page.keyboard.press('Arrow' + direction);
  await stoppedReturn.page.locator('input[autocomplete="current-password"]').fill(password);
  await stoppedReturn.page.getByRole('button', { name: '解锁', exact: true }).click();
  await stoppedReturn.ready(120000);
  const stoppedReturnMedia = await stoppedReturn.media();
  const afterStoppedReturn = await stoppedReturn.state();
  for (const tab of afterAbsence.workspace.tabs)
    assert(afterStoppedReturn.workspace.tabs.some((next) => next.id === tab.id && next.url === tab.url));
  await stoppedReturn.page.screenshot({ path: join(run, 'stopped-return.png') });
  await writeFile(
    join(run, 'stopped-return.json'),
    JSON.stringify(
      {
        stoppedState,
        afterStoppedReturn,
        stoppedReturnMedia,
      },
      null,
      2,
    ),
  );
  await writeFile(join(run, 'result.json'), JSON.stringify({ before, after, child, childLoads }, null, 2));
  console.log('Disconnected self-close persisted, removed the tab, and did not recreate its page: ' + run);
} catch (error) {
  const pages = context?.pages() ?? [];
  const snapshots = [];
  for (const [index, page] of pages.entries()) {
    await page.screenshot({ path: join(run, `failure-${index}.png`) }).catch(() => {});
    snapshots.push(
      await page
        .evaluate(() => ({
          text: document.body.innerText,
          state: window.__remotekitTest?.state(),
          auth: window.clusterQA?.auth,
          peers: window.clusterQA?.peers.map((peer) => peer.connectionState),
        }))
        .catch(() => ({})),
    );
  }
  await writeFile(
    join(run, 'failure.json'),
    JSON.stringify({ error: String(error.stack), snapshots }, null, 2),
  );
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  management = false;
  for (const socket of sockets) socket.destroy();
  await context?.close();
  await viewers?.close();
  if (native && native.exitCode === null) {
    native.stdin.end();
    await new Promise((done) => native.once('exit', done));
  }
  await stack.stop();
  await new Promise((done) => proxy.close(done));
  await new Promise((done) => fixture.close(done));
}
