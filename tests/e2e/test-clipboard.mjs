import { createViewerContext, instrumentViewer, launchBrowser, remoteInputReady } from './kit/viewer.mjs';

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { requireControl, startStack, until } from './kit/stack.mjs';

/**
 * Edge / Chrome 89, isolated Control and native H264 clipboard verification.
 * node tests/e2e/test-clipboard.mjs <playwright module> <viewer exe>
 *   <endpoint exe> <browser exe> <unused evidence directory> [port=34120]
 */
import assert from 'node:assert/strict';

const [modulePath, viewerExe, endpoint, browser, output, portArg = '34120'] = process.argv.slice(2);
assert([modulePath, viewerExe, endpoint, browser, output].every(Boolean));
const run = resolve(output);
const port = Number(portArg);
const origin = `http://127.0.0.1:${port}`;
const fixtureOrigin = `http://127.0.0.1:${port + 1}`;
const marker = 'RKCLIP' + randomUUID().replaceAll('-', '');
const oversizeMarker = 'RKLARGE' + randomUUID().replaceAll('-', '');

const Database = requireControl('better-sqlite3');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
await mkdir(run, { recursive: true });

const remote = [];
const results = [];
let user, admin, chrome, db;
const result = (scenario, detail) => {
  results.push({ scenario, status: 'verified', at: new Date().toISOString(), detail });
  console.log(scenario, JSON.stringify(detail));
};

const stack = await startStack({
  seed: false,
  fixtures: { kind: 'test-clipboard', context: { remote, marker, oversizeMarker } },
  ports: { control: port + 3, viewer: port, fixture: port + 1, peer: port + 2 },
  run,
  port,
  endpoint,
  browser,
});
const password = randomUUID();
const deadline = setTimeout(() => void chrome?.close(), 420000);
const latest = () => remote.at(-1);
const row = () =>
  db
    .prepare(
      'SELECT revision,text,html FROM clipboards WHERE user_id=(SELECT id FROM users WHERE username=?)',
    )
    .get('clipboard-user');
const revision = () => row()?.revision ?? 0;
const connect = async (username, setup = false) => {
  const context = await createViewerContext(chrome, {
    viewport: { width: 1100, height: 1000 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const response = await context.request.post(origin + (setup ? '/api/auth/setup' : '/api/auth/login'), {
    headers: { Origin: origin },
    data: { username, password },
  });
  assert.equal(response.status(), 200, await response.text());
  const connected = await instrumentViewer(context, run, username);
  await context.addInitScript(() => {
    window.inputClipboardQA = { wire: [], local: [] };
    const q = window.inputClipboardQA;
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (raw) {
      try {
        const message = JSON.parse(raw);
        q.wire.push({ at: performance.now(), direction: 'out', message });
      } catch {}
      if (!this.__inputClipboardObserved) {
        this.__inputClipboardObserved = true;
        this.addEventListener('message', ({ data }) => {
          try {
            const message = JSON.parse(data);
            if (
              [
                'input.result',
                'input.editable',
                'input.selection',
                'input.contextMenu',
                'focus',
                'layout',
              ].includes(message.type)
            )
              q.wire.push({ at: performance.now(), direction: 'in', message });
          } catch {}
        });
      }
      return send.call(this, raw);
    };
    for (const type of ['pointerdown', 'pointerup', 'focusin', 'focusout', 'keydown', 'keyup', 'paste'])
      document.addEventListener(
        type,
        (event) =>
          q.local.push({ at: performance.now(), type, target: event.target.className, key: event.key }),
        true,
      );
  });
  await connected.page.goto(origin);
  await connected.ready();
  await connected.call('auth.settings', {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  if (username === 'clipboard-user') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await connected.page.bringToFront();
  }
  return connected;
};
const ready = async () => {
  await user.media();
  await user.page.waitForFunction(() => {
    const section = document.querySelector('.remote-viewport');
    return (
      section &&
      !section.classList.contains('resize-waiting') &&
      section.querySelector('canvas[data-video-input]:not(.no-frame)') &&
      section.querySelector('video')?.videoWidth > 0
    );
  });
  await user.page.waitForFunction(remoteInputReady);
};
const project = async (id) => {
  const canvas = await user.page.locator('canvas[data-video-input]').boundingBox();
  const rect = latest().geometry[id];
  return {
    x: canvas.x + (rect.x * canvas.width) / latest().width,
    y: canvas.y + (rect.y * canvas.height) / latest().height,
    width: (rect.width * canvas.width) / latest().width,
    height: (rect.height * canvas.height) / latest().height,
  };
};
const click = async (id, options) => {
  await ready();
  const rect = await project(id);
  await user.page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, options);
  await pause(200);
};
const paste = async () => {
  await click('paste');
  await user.page.keyboard.press('Control+A');
  await user.page.keyboard.press('Backspace');
  await until(() => latest().pasted === '', 'empty paste target');
  const serial = latest().serial;
  await user.page.keyboard.press('Control+V');
  await until(() => latest().serial > serial, 'remote paste event');
  await pause(250);
  return latest().pasted;
};
async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found;
}
async function privacy() {
  const started = await user.call('diagnostics.start', { environment: {} });
  await pause(2400);
  const complete = await user.call('diagnostics.stop', { id: started.id });
  assert.equal(complete.status, 'complete');
  const artifacts = await files(run);
  const logs = artifacts.filter((path) =>
    /(?:control|endpoint|browser)(?:\.(?:log|jsonl)(?:\.\d+)?|[\\/]stderr\.log)$|[\\/]logs[\\/]browser[\\/][^\\/]+\.log$/.test(
      path,
    ),
  );
  const archives = artifacts.filter((path) => path.endsWith('.tar.zst'));
  assert(logs.length >= 3, 'Expected Control, Endpoint and Browser logs');
  assert(archives.length > 0, 'Expected diagnostics archive');
  const encoders = new Set();
  for (const path of [...logs, ...archives]) {
    const bytes = await readFile(path);
    const content = path.endsWith('.tar.zst') ? zstdDecompressSync(bytes) : bytes;
    assert(!content.includes(Buffer.from(marker)), 'Clipboard content in ' + path);
    assert(!content.includes(Buffer.from(oversizeMarker)), 'Oversize clipboard content in ' + path);
    if (path.endsWith('.tar.zst')) {
      for (const match of content.toString('utf8').matchAll(/"encoder"\s*:\s*"(qsv|nvenc)"/g)) {
        encoders.add(match[1]);
      }
    }
  }
  assert(encoders.size > 0, 'Expected native QSV/NVENC encoding in diagnostics');
  return { logs, archives, matches: 0, encoders: [...encoders] };
}
try {
  await until(async () => (await fetch(origin + '/api/auth/setup')).ok, 'Control startup');
  chrome = await launchBrowser({
    executablePath: resolve(viewerExe),
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
  });
  const version = await (await chrome.newBrowserCDPSession()).send('Browser.getVersion');
  assert.match(version.product, /\/(?:89|\d{3})\./);
  admin = await connect('clipboard-admin', true);
  await admin.call('admin.createUser', { username: 'clipboard-user', password });
  user = await connect('clipboard-user');
  db = new Database(join(run, 'control.db'), { readonly: true });
  await user.action({
    type: 'window.open',
    appId: 'browser',
    placement: { mode: 'space' },
    url: fixtureOrigin + '/',
  });
  await until(() => latest(), 'fixture ready');
  await ready();
  const layoutIdentity = () =>
    user.page.evaluate(() => {
      const layout = inputClipboardQA.wire
        .slice()
        .reverse()
        .find((entry) => entry.direction === 'in' && entry.message.type === 'layout')?.message;
      return layout && { generation: layout.generation, epoch: layout.epoch };
    });
  const unchangedLayout = await layoutIdentity();
  assert(unchangedLayout && unchangedLayout.generation !== '0');
  await user.call('clipboard.set', { text: 'desired-state layout regression' });
  await ready();
  assert.deepEqual(await layoutIdentity(), unchangedLayout, 'Clipboard convergence retains input layout');
  result('0 identical desired views retain layout', unchangedLayout);
  const before = revision();
  const rect = await project('copy');
  const mouseCdp = await user.context.newCDPSession(user.page);
  const dragMouse = (type, x, buttons) =>
    mouseCdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y: rect.y + rect.height / 2,
      buttons,
      button: buttons || type === 'mouseReleased' ? 'left' : 'none',
      clickCount: 1,
    });
  await dragMouse('mouseMoved', rect.x + 1, 0);
  await dragMouse('mousePressed', rect.x + 1, 1);
  for (let step = 1; step <= 20; step++)
    await dragMouse('mouseMoved', rect.x + 1 + ((rect.width - 2) * step) / 20, 1);
  await dragMouse('mouseReleased', rect.x + rect.width - 1, 0);
  await until(() => latest().selection === marker, 'mouse text selection');
  await user.page.keyboard.press('Control+C');
  await until(() => row()?.text === marker, 'Control clipboard record');
  await pause(700);
  assert.equal(revision(), before + 1);
  assert(row().html.includes(marker), 'Copied HTML missing');
  await until(
    () => user.page.evaluate(() => navigator.clipboard.readText()).then((text) => text === marker),
    'remote copy reaches device',
  );
  const library = await user.call('library.get');
  const snippet = library.entries.find((entry) => entry.kind === 'snippet' && entry.preview === marker);
  assert(snippet, 'Page copy missing from clipboard history');
  assert.deepEqual(snippet.source, { app: 'clipboard', channel: '' });
  assert.equal(snippet.origin.kind, 'page');
  assert.equal(new URL(snippet.origin.url).host, new URL(fixtureOrigin).host);
  const deviceText = 'DEVICE' + marker;
  await user.page.evaluate((text) => navigator.clipboard.writeText(text), deviceText);
  assert.equal(await paste(), deviceText);
  await until(() => row()?.text === deviceText, 'device clipboard reaches Control');
  const deviceEntry = (await user.call('library.get')).entries.find(
    (entry) => entry.kind === 'snippet' && entry.preview === deviceText,
  );
  assert.deepEqual(deviceEntry?.origin, { kind: 'device' });
  const browserSpace = (await user.state()).workspace.activeSpaceId;
  await user.action({ type: 'window.open', appId: 'files', placement: { mode: 'space' } });
  await user.page.getByRole('navigation', { name: '文件导航' }).getByText('剪贴板', { exact: true }).click();
  const snippetRow = user.page.locator(`[data-snippet="${snippet.id}"]`);
  await snippetRow.getByText(new URL(fixtureOrigin).host, { exact: false }).waitFor();
  await user.page.screenshot({ path: join(run, 'clipboard-history.png') });
  await snippetRow.getByRole('button', { name: marker, exact: true }).click();
  await user.page.getByText('已复制', { exact: true }).waitFor();
  await until(() => row()?.text === marker, 'snippet copy reaches remote clipboard');
  await until(
    () => user.page.evaluate(() => navigator.clipboard.readText()).then((text) => text === marker),
    'snippet copy reaches device clipboard',
  );
  const filesWindow = (await user.state()).workspace.windows.find((window) => window.appId === 'files');
  await user.action({ type: 'window.close', windowId: filesWindow.id });
  await user.action({ type: 'space.activate', spaceId: browserSpace });
  await ready();
  assert.equal(await paste(), marker);
  result('clipboard history and two-way device sync', {
    pageOrigin: new URL(snippet.origin.url).host,
    deviceOrigin: deviceEntry.origin.kind,
  });
  result('1 mouse copy and privacy', { revision: revision(), ...(await privacy()) });
  await user.action({ type: 'settings.update', settings: { workspace: { clipboardSync: false } } });
  const incarnation = latest().incarnation;
  await user.context.close();
  await until(
    async () =>
      !(await admin.call('admin.users')).find((entry) => entry.username === 'clipboard-user').online,
    'viewer detached',
  );
  await until(
    async () => {
      const users = await admin.call('admin.stop', { username: 'clipboard-user' });
      return users.find((entry) => entry.username === 'clipboard-user').session.state === 'stopped';
    },
    'Session hibernated',
    90000,
  );
  user = await connect('clipboard-user');
  await ready();
  const seedRevision = revision();
  await until(() => latest().incarnation !== incarnation, 'new Browser page incarnation');
  assert.equal(await paste(), marker);
  if (latest().startup?.value !== undefined) assert.equal(latest().startup.value, marker);
  result('2 restart seed and paste', { incarnation: latest().incarnation, startup: latest().startup });
  await pause(900);
  assert.equal(revision(), seedRevision);
  result('6 seed does not echo', { revision: revision() });

  const menu = user.page.getByRole('menu', { name: '页面菜单', exact: true });
  await click('link', { button: 'right' });
  await menu.getByRole('menuitem', { name: '复制链接地址', exact: true }).click();
  await until(() => row()?.text === fixtureOrigin + '/linked', 'context link copy recorded');
  const linkRevision = revision();
  const word = await project('quick');
  const cdp = await user.context.newCDPSession(user.page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: word.x + word.width / 2, y: word.y + word.height / 2, id: 1, radiusX: 2, radiusY: 2, force: 1 },
    ],
  });
  await pause(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const quick = user.page.locator('.selection-menu');
  await quick.getByRole('button', { name: '复制', exact: true }).tap();
  await until(() => row()?.text === 'quickclipboardword', 'quick copy recorded');
  assert.equal(revision(), linkRevision + 1);
  result('3 context and quick menu copy', { linkRevision, quickRevision: revision() });

  const retained = row();
  const nodesBeforeOversize = await admin.call('admin.nodes');
  await writeFile(join(run, 'nodes-before-oversize.json'), JSON.stringify(nodesBeforeOversize, null, 2));
  await click('large');
  await until(
    async () =>
      (await readFile(join(run, 'logs/control.jsonl'), 'utf8')).split('\n').some((line) => {
        try {
          return JSON.parse(line).ev === 'clipboard.write_exceeds_limits';
        } catch {
          return false;
        }
      }),
    'oversize warning',
  );
  assert.deepEqual(row(), retained);
  const large = await paste();
  assert.equal(Buffer.byteLength(large), 3 * 1024 * 1024);
  assert(large.startsWith(oversizeMarker));
  const nodesAfterOversize = await admin.call('admin.nodes');
  await writeFile(join(run, 'nodes-after-oversize.json'), JSON.stringify(nodesAfterOversize, null, 2));
  for (const before of nodesBeforeOversize) {
    const after = nodesAfterOversize.find((node) => node.nodeId === before.nodeId);
    assert.equal(after.state, 'ready');
    assert.deepEqual(after.exited, before.exited);
    assert.equal(after.connectedAt, before.connectedAt);
  }
  result('4 oversize remains local', { bytes: Buffer.byteLength(large), revision: revision() });
  await assert.rejects(admin.call('admin.resetSession', { username: 'clipboard-user' }), /需先停止/);
  assert.deepEqual(row(), retained);
  await user.context.close();
  await until(
    async () =>
      !(await admin.call('admin.users')).find((entry) => entry.username === 'clipboard-user').online,
    'viewer detached before reset',
  );
  await until(
    async () => {
      const users = await admin.call('admin.stop', { username: 'clipboard-user' });
      return users.find((entry) => entry.username === 'clipboard-user').session.state === 'stopped';
    },
    'Session hibernated before reset',
    90000,
  );
  await admin.call('admin.resetSession', { username: 'clipboard-user' });
  assert.equal(row(), undefined);
  user = await connect('clipboard-user');
  await ready();
  await until(() => latest().pasted === '', 'fresh reset page');
  assert.equal(await paste(), '');
  assert.equal(row(), undefined);
  result('5 admin reset', { row: null, pasted: '', afterReconnect: true });
  result('privacy after oversize and reset', await privacy());
  const media = await user.media();
  result('platform and transport', {
    product: version.product,
    codec: media.codec,
    framesDecoded: media.framesDecoded,
  });
} catch (error) {
  results.push({ scenario: 'harness', status: 'failed', detail: error.stack });
  console.error(error.stack);
  if (user?.page && !user.page.isClosed())
    await user.page.screenshot({ path: join(run, 'failure.png') }).catch(() => {});
  if (user?.page && !user.page.isClosed())
    await writeFile(
      join(run, 'input-wire.json'),
      JSON.stringify(
        await user.page.evaluate(() => ({
          probe: inputClipboardQA,
          active: document.activeElement?.outerHTML,
          text: document.body.innerText,
        })),
        null,
        2,
      ),
    );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  db?.close();
  await writeFile(
    join(run, 'trace.json'),
    JSON.stringify({ results, marker, oversizeMarker, remote }, null, 2),
  );
  await chrome?.close();
  await stack.stop();

  console.log('Evidence:', run);
}
