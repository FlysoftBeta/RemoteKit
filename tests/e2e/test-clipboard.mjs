/**
 * Headed Chrome 157, isolated Control and native H264 clipboard verification.
 * node tests/e2e/test-clipboard.mjs <playwright module> <viewer exe>
 *   <endpoint exe> <browser exe> <unused evidence directory> [port=35300]
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { startProductStack, until } from './kit/stack.mjs';
import { instrumentViewer, requireControl } from './cluster-test-support.mjs';

const [modulePath, viewerExe, endpoint, browser, output, portArg = '35300'] = process.argv.slice(2);
assert([modulePath, viewerExe, endpoint, browser, output].every(Boolean));
const run = resolve(output);
const port = Number(portArg);
assert(Number.isInteger(port) && port >= 35300 && port + 2 <= 35399);
const origin = `http://127.0.0.1:${port}`;
const fixtureOrigin = `http://127.0.0.1:${port + 1}`;
const marker = 'RKCLIP' + randomUUID().replaceAll('-', '');
const oversizeMarker = 'RKLARGE' + randomUUID().replaceAll('-', '');
const { chromium } = createRequire(import.meta.url)(resolve(modulePath));
const Database = requireControl('better-sqlite3');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
await mkdir(run);
const html = (await readFile(new URL('./fixtures/clipboard.html', import.meta.url), 'utf8'))
  .replaceAll('CLIPBOARD_MARKER', marker)
  .replaceAll('OVERSIZE_MARKER', oversizeMarker);
const remote = [];
const results = [];
let user, admin, chrome, db;
const result = (scenario, detail) => {
  results.push({ scenario, status: 'verified', detail });
  console.log(scenario, JSON.stringify(detail));
};
const fixture = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/event') {
    let body = '';
    for await (const chunk of request) body += chunk;
    remote.push(JSON.parse(body));
    response.end();
  } else
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(html);
});
await new Promise((done, reject) => {
  fixture.once('error', reject);
  fixture.listen(port + 1, '127.0.0.1', done);
});
const control = startProductStack({ run, port, endpoint, browser });
control.stdout.on('data', (data) => void appendFile(join(run, 'control.log'), data));
control.stderr.on('data', (data) => void appendFile(join(run, 'control.log'), data));
const stopped = new Promise((done) => control.once('exit', done));
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
  const context = await chrome.newContext({
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
  await connected.page.goto(origin);
  await connected.ready();
  await connected.call('auth.settings', {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
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
  await pause(400);
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
    /(?:control|endpoint|browser)(?:\.log(?:\.\d+)?|[\\/]stderr\.log)$/.test(path),
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
  chrome = await chromium.launch({
    executablePath: resolve(viewerExe),
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
  });
  const version = await (await chrome.newBrowserCDPSession()).send('Browser.getVersion');
  assert.match(version.product, /\/157\./);
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
  const before = revision();
  const rect = await project('copy');
  await user.page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
  await user.page.mouse.down();
  await user.page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 20 });
  await user.page.mouse.up();
  await until(() => latest().selection === marker, 'mouse text selection');
  await user.page.keyboard.press('Control+C');
  await until(() => row()?.text === marker, 'Control clipboard record');
  await pause(700);
  assert.equal(revision(), before + 1);
  assert(row().html.includes(marker), 'Copied HTML missing');
  const copied = row();
  await writeFile(join(run, 'copy-row.json'), JSON.stringify(copied, null, 2));
  result('1 mouse copy and privacy', { revision: revision(), ...(await privacy()) });
  const incarnation = latest().incarnation;
  await user.context.close();
  await until(
    async () =>
      !(await admin.call('admin.users')).find((entry) => entry.username === 'clipboard-user').online,
    'viewer detached',
  );
  await until(
    async () => {
      const users = await admin.call('admin.hibernate', { username: 'clipboard-user' });
      return users.find((entry) => entry.username === 'clipboard-user').session.state === 'hibernated';
    },
    'Session hibernated',
    90000,
  );
  user = await connect('clipboard-user');
  await ready();
  await until(() => latest().incarnation !== incarnation, 'new Browser page incarnation');
  assert.equal(await paste(), marker);
  if (latest().startup?.value !== undefined) assert.equal(latest().startup.value, marker);
  result('2 restart seed and paste', { incarnation: latest().incarnation, startup: latest().startup });
  await pause(900);
  assert.equal(revision(), copied.revision);
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
  await click('large');
  await until(
    async () => (await readFile(join(run, 'control.log'), 'utf8')).includes('Clipboard write exceeds limits'),
    'oversize warning',
  );
  assert.deepEqual(row(), retained);
  const large = await paste();
  assert.equal(Buffer.byteLength(large), 3 * 1024 * 1024);
  assert(large.startsWith(oversizeMarker));
  result('4 oversize remains local', { bytes: Buffer.byteLength(large), revision: revision() });
  await assert.rejects(admin.call('admin.resetSession', { username: 'clipboard-user' }), /需先休眠/);
  assert.deepEqual(row(), retained);
  await user.context.close();
  await until(
    async () =>
      !(await admin.call('admin.users')).find((entry) => entry.username === 'clipboard-user').online,
    'viewer detached before reset',
  );
  await until(
    async () => {
      const users = await admin.call('admin.hibernate', { username: 'clipboard-user' });
      return users.find((entry) => entry.username === 'clipboard-user').session.state === 'hibernated';
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
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  db?.close();
  await writeFile(
    join(run, 'trace.json'),
    JSON.stringify({ results, marker, oversizeMarker, remote }, null, 2),
  );
  await chrome?.close();
  if (control.connected) control.disconnect();
  await Promise.race([stopped, pause(10000)]);
  fixture.closeAllConnections();
  fixture.close();
  console.log('Evidence:', run);
}
