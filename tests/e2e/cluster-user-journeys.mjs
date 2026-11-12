import { homedir } from 'node:os';
/** Real Viewer actions, isolated two-node cluster. args: edge|chrome89 mouse|touch port output.
 * REMOTEKIT_CLUSTER_RESUME=crash rechecks an existing run's crash/admin flows;
 * =after-stop continues the independent offline-discard/admin flows after a recorded stop/resume failure.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { stageRuntime } from '../integration/stage-runtime.mjs';
import { instrumentViewer, startControl, until, pause } from './cluster-test-support.mjs';
const [browserName = 'edge', pointer = 'mouse', portArg = '34360', output] = process.argv.slice(2);
const port = Number(portArg),
  run = resolve(output),
  origin = `http://127.0.0.1:${port + 1}`,
  fixtureOrigin = `http://127.0.0.1:${port + 2}`;
await mkdir(run, { recursive: true });
const events = [];
const report = async (stage, value) => {
  console.log(stage);
  await appendFile(
    join(run, 'journey.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), stage, value }) + '\n',
  );
};
const fixture = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let raw = '';
    for await (const part of req) raw += part;
    const value = JSON.parse(raw);
    events.push(value);
    await appendFile(join(run, 'fixture.jsonl'), JSON.stringify(value) + '\n');
    return res.end('ok');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Cluster ${req.url}</title>
  <style>body{margin:20px;background:#e3effa;font:18px Arial}input,button,a{display:block;margin:20px 0;padding:10px}input{width:200px}</style>
  <h1>Cluster ${req.url}</h1><input id="value" value="${req.url.includes('mutated') ? 'isolated-new-value' : 'before-crash'}"><button id="store">Persist state</button><p id="state"></p><a href="/history">Visit history</a><input id="file" type="file"><canvas width="24" height="24"></canvas>
  <script>const report=(type)=>fetch('/event',{method:'POST',body:JSON.stringify({type,path:location.pathname,cookie:document.cookie,storage:localStorage.getItem('cluster'),width:innerWidth,height:innerHeight,boxes:Object.fromEntries([...document.querySelectorAll('input,button,a')].map(e=>[e.id||'link',e.getBoundingClientRect().toJSON()]))})});
  store.onclick=()=>{document.cookie='cluster='+value.value+'; Max-Age=86400; SameSite=Lax';localStorage.setItem('cluster',value.value);report('stored')};
  const show=()=>state.textContent='Cookie: '+document.cookie+' | localStorage: '+localStorage.getItem('cluster');show();store.addEventListener('click',show);
  report('ready');addEventListener('resize',()=>report('ready'));let i=0;setInterval(()=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle=i++%2?'red':'blue';c.fillRect(0,0,24,24)},150);</script>`);
});
await new Promise((done) => fixture.listen(port + 2, '127.0.0.1', done));
const endpoint = resolve('build/endpoint/endpoint/endpoint_service.exe'),
  remote = 'C:/src/chromium/src/out/rel/remotekit_browser.exe';
const nodes = Object.fromEntries(
  ['alpha', 'beta'].map((id, i) => [
    id,
    {
      local: {
        executable: stageRuntime(endpoint, remote, join(run, id, 'bin')),
        root: join(run, id, 'root'),
      },
      peer: { listen: `127.0.0.1:${port + 3 + i}`, address: `127.0.0.1:${port + 3 + i}` },
      limits: { maxSessions: 1 },
    },
  ]),
);
const config = join(run, 'control.json');
await writeFile(
  config,
  JSON.stringify({
    http: { listen: `127.0.0.1:${port}`, origins: [origin] },
    storage: {
      database: join(run, 'control.db'),
      diagnostics: join(run, 'diagnostics'),
      logs: join(run, 'logs'),
    },
    nodes,
  }),
);
let control = startControl(resolve('tests/e2e/cluster-journey-harness.mts'), config, run);
const vite = spawn(process.execPath, ['tests/e2e/kit/vite.mjs', String(port + 1), join(run, 'vite-cache')], {
  windowsHide: true,
  env: { ...process.env, REMOTEKIT_VITE_CONTROL: `http://127.0.0.1:${port}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of ['stdout', 'stderr'])
  vite[stream].on('data', (bytes) => void appendFile(join(run, 'vite.log'), bytes));
await writeFile(join(run, 'pids.json'), JSON.stringify({ control: control.child.pid, vite: vite.pid }));
const { chromium } = createRequire(import.meta.url)(
  process.env.REMOTEKIT_PLAYWRIGHT ??
    join(
      homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js',
    ),
);
let browser;
const viewers = [];
const password = 'cluster-user-password';
async function makeViewer(name) {
  const context = await browser.newContext({
    viewport: pointer === 'touch' ? { width: 390, height: 844 } : { width: 1600, height: 1000 },
    hasTouch: pointer === 'touch',
  });
  const viewer = await instrumentViewer(context, run, name);
  viewers.push(viewer);
  viewer.cdp = await context.newCDPSession(viewer.page);
  viewer.name = name;
  viewer.page.setDefaultTimeout(45000);
  return viewer;
}
async function point(v, x, y, double = false) {
  if (pointer === 'touch') {
    for (let i = 0; i < (double ? 2 : 1); i++) {
      await v.cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
      });
      await pause(70);
      await v.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await pause(100);
    }
  } else {
    await v.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    for (let i = 1; i <= (double ? 2 : 1); i++) {
      await v.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: i,
      });
      await pause(70);
      await v.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: i,
      });
    }
  }
}
async function click(v, locator, double = false) {
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  await pause(180);
  const b = await locator.boundingBox();
  assert(b);
  await point(v, b.x + b.width / 2, b.y + b.height / 2, double);
  await pause(300);
}
async function type(v, locator, text) {
  await click(v, locator);
  await v.page.keyboard.press('Control+A');
  await v.page.keyboard.type(text, { delay: 35 });
}
const button = (v, name) => v.page.getByRole('button', { name, exact: true });
async function shot(v, name) {
  await v.page.screenshot({ path: join(run, `${v.name}-${name}.png`) });
  await writeFile(join(run, `${v.name}-${name}.txt`), await v.page.locator('body').innerText());
}
async function login(v, name, setup = false) {
  await v.page.bringToFront();
  await v.page.goto(origin);
  await v.page.waitForFunction(() => !!window.__remotekitTest);
  await pause(800);
  await v.page.evaluate(() => window.__remotekitTest.unlock());
  await until(
    'login reveal',
    async () => {
      if (await v.page.locator('input[autocomplete="username"]').isVisible()) return true;
      if (await v.page.locator('.viewer-lock-blank').isVisible())
        await v.page.evaluate(() => window.__remotekitTest.unlock());
      return false;
    },
    15000,
  );
  await shot(v, 'auth-revealed');
  await type(v, v.page.locator('input[autocomplete="username"]'), name);
  await type(
    v,
    v.page.locator(`input[autocomplete="${setup ? 'new-password' : 'current-password'}"]`),
    password,
  );
  await click(v, v.page.locator('button[type=submit]'));
  await v.ready(90000);
}
async function reveal(v) {
  await v.page.bringToFront();
  await pause(250);
  if (await v.page.locator('.viewer-lock-blank').isVisible())
    await v.page.evaluate(() => window.__remotekitTest.unlock());
  const p = v.page.locator('input[autocomplete="current-password"]');
  if (await p.isVisible()) {
    await type(v, p, password);
    await v.page.keyboard.press('Enter');
    await v.ready(90000);
  }
}
const start = (v) => v.page.getByRole('dialog', { name: '开始屏幕' });
async function openApp(v, name) {
  await reveal(v);
  if (!(await start(v).isVisible())) await click(v, button(v, '开始'));
  await click(v, start(v).getByRole('button', { name: '新窗口组', exact: true }));
  await click(
    v,
    start(v)
      .locator('[data-tile-key]')
      .filter({ has: v.page.getByText(name, { exact: true }) })
      .first(),
  );
  await start(v).waitFor({ state: 'hidden' });
}
async function focusApp(v, appId) {
  await reveal(v);
  if (!(await start(v).isVisible())) await click(v, button(v, '开始'));
  const state = await v.state();
  const win = state.workspace.windows.find((w) => w.appId === appId);
  assert(win, appId);
  const space = state.workspace.spaces.find((s) => s.windowIds.includes(win.id));
  await click(v, v.page.locator(`[data-space-card="${space.id}"]`));
  await start(v).waitFor({ state: 'hidden' });
  await pause(500);
}
async function section(v, name) {
  const app = v.page.locator('.admin-app:visible');
  const tab = app.getByRole('tab', { name, exact: true });
  await click(v, (await tab.count()) ? tab : app.getByRole('button', { name, exact: true }));
}
async function navigate(v, path) {
  await reveal(v);
  await type(v, v.page.locator('.address-form input:visible').first(), fixtureOrigin + path);
  await v.page.keyboard.press('Enter');
  await until(
    'fixture ' + path,
    async () => (await v.state())?.workspace.tabs.some((t) => t.url === fixtureOrigin + path && !t.loading),
    90000,
  );
  await v.media();
  await pause(1500);
}
async function remoteClick(v, path, id) {
  const viewport = v.page.locator('.remote-viewport:visible').first();
  await viewport.waitFor();
  const b = await viewport.boundingBox();
  const e = await until(
    'geometry ' + path,
    () => events.findLast((e) => e.type === 'ready' && e.path === path && Math.abs(e.width - b.width) < 3),
    90000,
  );
  const t = e.boxes[id];
  assert(t);
  await point(
    v,
    b.x + ((t.x + Math.min(35, t.width / 2)) * b.width) / e.width,
    b.y + ((t.y + t.height / 2) * b.height) / e.height,
  );
  await pause(350);
}
const placement = (snap, name) =>
  snap.placements.find((p) => p.tenant === snap.users.find((u) => u.username === name)?.tenant);
async function commit(v, name) {
  await v.page.close();
  await until('detached', async () => {
    const s = await control.call('inspect');
    return !s.runtimes.find((r) => r.tenant === placement(s, name)?.tenant)?.viewer;
  });
  await control.call('advance', { ms: 600001 });
  return until(
    'committed ' + name,
    async () => {
      const s = await control.call('inspect');
      const p = placement(s, name);
      return p?.run_state === 'stopped' && p?.data_state === 'clean' && s;
    },
    120000,
  );
}
function nodePid(node) {
  const command = `Get-CimInstance Win32_Process -Filter "Name = 'endpoint_service.exe'" | Where-Object { $_.CommandLine -like '*${nodes[node].local.root.replaceAll("'", "''")}*' } | Select-Object -ExpandProperty ProcessId`;
  const ids = execFileSync('powershell', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(ids.length, 1, JSON.stringify(ids));
  return Number(ids[0]);
}
async function killNode(node, exitCode = 99) {
  const pid = nodePid(node);
  await report('hard-kill', { node, pid, exitCode });
  if (exitCode === 1) execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
  else
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ClusterKill { [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid); [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr handle, uint code); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle); }'; $handle=[ClusterKill]::OpenProcess(1,$false,${pid}); if($handle -eq [IntPtr]::Zero){throw 'OpenProcess failed'}; if(-not [ClusterKill]::TerminateProcess($handle,${exitCode})){throw 'TerminateProcess failed'}; [ClusterKill]::CloseHandle($handle)`,
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
}
async function userMenu(v, name) {
  await section(v, '用户');
  await click(v, button(v, `${name} 的操作`));
}
async function dialog(v, title, confirm, name) {
  const d = v.page.getByRole('dialog', { name: title, exact: true });
  await d.waitFor();
  await shot(v, name);
  await click(v, d.getByRole('button', { name: confirm, exact: true }));
  await d.waitFor({ state: 'hidden' });
}
async function step(name, fn) {
  try {
    await fn();
    await report('pass:' + name);
  } catch (error) {
    await report('fail:' + name, {
      error: error.stack,
      snapshot: await control.call('inspect').catch(String),
    });
    for (const v of viewers) if (!v.page.isClosed()) await shot(v, 'failure-' + name).catch(() => {});
    throw error;
  }
}
try {
  await until(
    'ready',
    async () => {
      try {
        return (
          (await control.call('inspect')).nodes.every((n) => n.state === 'ready') && (await fetch(origin)).ok
        );
      } catch {
        return false;
      }
    },
    90000,
  );
  browser = await chromium.launch({
    executablePath:
      browserName === 'edge'
        ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
        : 'C:/src/tmp/chrome89-google/app/chrome.exe',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${port + 5}`],
  });
  let first = await makeViewer('first'),
    second;
  if (process.env.REMOTEKIT_CLUSTER_RESUME) {
    await login(first, 'cluster-first');
    if (process.env.REMOTEKIT_CLUSTER_RESUME === 'crash') {
      if (pointer === 'touch')
        try {
          await step('restored-history-forward-back', async () => {
            await focusApp(first, 'browser');
            await click(first, first.page.getByRole('tab', { name: /Cluster \/first/ }).first());
            const state = await first.state();
            const tab = state.workspace.tabs.find((t) => t.url === fixtureOrigin + '/first');
            assert(tab?.canGoForward, 'Restored forward history must remain available');
            if (pointer === 'touch') {
              await click(first, button(first, '更多'));
              await click(first, first.page.getByRole('menuitem', { name: '前进', exact: true }));
            } else await click(first, button(first, '前进'));
            await until('restored forward history', async () =>
              (await first.state()).workspace.tabs.some(
                (t) => t.id === tab.id && t.url === fixtureOrigin + '/history' && !t.loading,
              ),
            );
            await click(first, button(first, '后退'));
            await until('restored back history', async () =>
              (await first.state()).workspace.tabs.some(
                (t) => t.id === tab.id && t.url === fixtureOrigin + '/first' && !t.loading,
              ),
            );
            await shot(first, 'restored-history-verified');
          });
        } catch {
          process.exitCode = 1;
        }
      try {
        await step('isolated-crash-recheck', async () => {
          await focusApp(first, 'browser');
          await navigate(first, '/crash-mutated');
          await remoteClick(first, '/crash-mutated', 'store');
          const stored = await until('new persistent value', () =>
            events.findLast((e) => e.type === 'stored' && e.storage === 'isolated-new-value'),
          );
          await pause(2000);
          await shot(first, 'isolated-before-crash');
          const s = await control.call('inspect');
          const node = placement(s, 'cluster-first').node_id;
          const offset = events.length;
          await killNode(node);
          await pause(800);
          await shot(first, 'isolated-endpoint-down');
          await until(
            'node restart',
            async () =>
              (await control.call('inspect')).nodes.find((n) => n.nodeId === node)?.state === 'ready',
            120000,
          );
          await reveal(first);
          await first.ready(120000);
          await focusApp(first, 'browser');
          await navigate(first, '/crash-mutated');
          const restored = await until(
            'post-crash fixture',
            () => events.slice(offset).findLast((e) => e.type === 'ready' && e.path === '/crash-mutated'),
            90000,
          );
          await report('crash-observation', { stored, restored });
          await shot(first, 'isolated-after-crash');
          assert.equal(restored.storage, 'isolated-new-value');
          assert(
            restored.cookie.includes('cluster=isolated-new-value'),
            'Cookie rolled back: ' + restored.cookie,
          );
        });
      } catch {
        process.exitCode = 1;
      }
    }
  } else {
    await step('setup-admin', async () => {
      await login(first, 'cluster-first', true);
      await openApp(first, '管理');
      await section(first, '用户');
      await click(first, button(first, '新建用户'));
      const d = first.page.getByRole('dialog', { name: '新建用户' });
      await type(first, d.getByLabel(/^用户名/), 'cluster-second');
      await type(first, d.getByLabel('密码', { exact: true }), password);
      await click(first, d.getByRole('button', { name: '创建', exact: true }));
      await d.waitFor({ state: 'hidden' });
      await shot(first, 'users-created');
    });
    await step('browse-persist-history', async () => {
      await openApp(first, '浏览器');
      await navigate(first, '/first');
      await remoteClick(first, '/first', 'store');
      await until('stored', () => events.some((e) => e.type === 'stored' && e.storage === 'before-crash'));
      await navigate(first, '/history');
      await click(first, button(first, '后退'));
      await until('back', async () =>
        (await first.state()).workspace.tabs.some((t) => t.url === fixtureOrigin + '/first' && !t.loading),
      );
      await click(first, button(first, '新建标签页'));
      await navigate(first, '/second-tab');
      await shot(first, 'two-tabs');
    });
    let initial, source, before;
    await step('two-users', async () => {
      second = await makeViewer('second');
      await login(second, 'cluster-second');
      await openApp(second, '浏览器');
      await navigate(second, '/other');
      initial = await control.call('inspect');
      source = placement(initial, 'cluster-first').node_id;
      assert.notEqual(source, placement(initial, 'cluster-second').node_id);
      before = (await first.state()).workspace.tabs.map((t) => ({ id: t.id, url: t.url }));
      await shot(first, 'simultaneous');
      await shot(second, 'simultaneous');
    });
    await step('automatic-stop-commit', async () => {
      const result = await commit(first, 'cluster-first');
      assert(placement(result, 'cluster-first').checkpoint_id);
      await report('automatic-commit', result);
      await commit(second, 'cluster-second');
    });
    let correct;
    await step('wrong-node-json', async () => {
      correct = await readFile(join(nodes[source].local.root, 'node.json'));
      const other = source === 'alpha' ? 'beta' : 'alpha';
      await writeFile(
        join(nodes[source].local.root, 'node.json'),
        JSON.stringify({
          ...JSON.parse(correct),
          privateKey: JSON.parse(await readFile(join(nodes[other].local.root, 'node.json'), 'utf8'))
            .privateKey,
        }),
      );
      await killNode(source);
      await until(
        'identity rejection',
        async () => {
          const n = (await control.call('inspect')).nodes.find((n) => n.nodeId === source);
          return n?.rejected?.code === 'identity_mismatch';
        },
        90000,
      );
    });
    await step('restore-other-node', async () => {
      first = await makeViewer('restored');
      await login(first, 'cluster-first');
      await first.media();
      const s = await control.call('inspect');
      assert.notEqual(placement(s, 'cluster-first').node_id, source);
      assert.deepEqual(
        (await first.state()).workspace.tabs.map((t) => ({ id: t.id, url: t.url })),
        before,
      );
      await click(first, first.page.getByRole('tab', { name: /Cluster \/first/ }).first());
      await until(
        'storage restored',
        () =>
          events.findLast(
            (e) =>
              e.type === 'ready' &&
              e.path === '/first' &&
              e.storage === 'before-crash' &&
              e.cookie.includes('cluster=before-crash'),
          ),
        90000,
      );
      await shot(first, 'restored-other-node');
    });
    await step('node-remove-readd', async () => {
      await openApp(first, '管理');
      await section(first, '节点');
      const card = first.page
        .locator('.admin-node')
        .filter({ has: first.page.getByText(source, { exact: true }) });
      await card.getByText('身份不匹配：请将新的 node.json 复制到该节点', { exact: false }).waitFor();
      assert.match(await card.innerText(), /[0-9a-f]{16}/);
      await shot(first, 'identity-mismatch');
      await click(first, card.getByRole('button', { name: '移除节点', exact: true }));
      await dialog(first, '移除节点', '移除', 'remove-node-dialog');
      await writeFile(join(nodes[source].local.root, 'node.json'), correct);
      await click(first, card.getByRole('button', { name: '重新添加', exact: true }));
      await dialog(first, '重新添加节点', '重新添加', 'readd-node-dialog');
      await until(
        'source ready',
        async () => (await control.call('inspect')).nodes.find((n) => n.nodeId === source)?.state === 'ready',
        90000,
      );
      await shot(first, 'nodes-recovered');
    });
    try {
      await step('diagnostics-and-endpoint-crash', async () => {
        await openApp(first, '设置');
        await click(
          first,
          first.page.locator('.settings-app:visible').getByRole('button', { name: '诊断', exact: true }),
        );
        await click(first, button(first, '开始诊断'));
        await button(first, '停止数据收集').waitFor();
        await shot(first, 'diagnostic-started');
        await focusApp(first, 'browser');
        await remoteClick(first, '/first', 'value');
        await first.page.waitForFunction(() => document.activeElement?.matches('.remote-input'));
        await first.page.keyboard.press('Control+A');
        await first.page.keyboard.insertText('after-checkpoint-before-kill');
        await remoteClick(first, '/first', 'store');
        await until('new stored value', () =>
          events.some((e) => e.type === 'stored' && e.storage === 'after-checkpoint-before-kill'),
        );
        const s = await control.call('inspect');
        await killNode(placement(s, 'cluster-first').node_id);
        await pause(900);
        await shot(first, 'endpoint-down');
        await until(
          'endpoint reconnected',
          async () => {
            const s = await control.call('inspect');
            return s.nodes.find((n) => n.nodeId === placement(s, 'cluster-first').node_id)?.state === 'ready';
          },
          120000,
        );
        await reveal(first);
        await first.ready(120000);
        await first.media();
        await navigate(first, '/first');
        await until(
          'no rollback',
          () =>
            events.findLast(
              (e) =>
                e.type === 'ready' &&
                e.storage === 'after-checkpoint-before-kill' &&
                e.cookie.includes('cluster=after-checkpoint-before-kill'),
            ),
          90000,
        );
        await shot(first, 'endpoint-recovered');
      });
    } catch {
      process.exitCode = 1;
    }
  }
  let diagnosticId, errorId;
  await step('start-fresh-diagnostic', async () => {
    const state = await first.state();
    if (state.workspace.windows.some((w) => w.appId === 'settings')) await focusApp(first, 'settings');
    else await openApp(first, '设置');
    const result = first.page.getByRole('dialog', { name: '诊断已保存' });
    if (await result.isVisible())
      await click(first, result.getByRole('button', { name: '完成', exact: true }));
    const nav = first.page
      .locator('.settings-navigation:visible')
      .getByRole('button', { name: '诊断', exact: true });
    if (await nav.isVisible()) await click(first, nav);
    await click(first, button(first, '开始诊断'));
    await button(first, '停止数据收集').waitFor();
  });
  await step('diagnostic-failure-stop-lookup', async () => {
    await focusApp(first, 'admin');
    await section(first, '用户');
    await click(first, button(first, '新建用户'));
    const d = first.page.getByRole('dialog', { name: '新建用户' });
    await type(first, d.getByLabel(/^用户名/), 'cluster-second');
    await type(first, d.getByLabel('密码', { exact: true }), password);
    await click(first, d.getByRole('button', { name: '创建', exact: true }), true);
    await d.locator('.failure-note').waitFor();
    await shot(first, 'duplicate-user-error');
    await click(first, d.getByRole('button', { name: '取消', exact: true }));
    const logs = (await readFile(join(run, 'logs/control.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((x) => {
        try {
          return JSON.parse(x);
        } catch {
          return {};
        }
      });
    const tenant = placement(await control.call('inspect'), 'cluster-first').tenant;
    errorId = logs.findLast(
      (r) => r.ev === 'viewer.request_failed' && r.method === 'admin.createUser' && r.tenant === tenant,
    )?.errorId;
    assert(errorId);
    await focusApp(first, 'settings');
    await click(first, button(first, '停止数据收集'));
    const result = first.page.getByRole('dialog', { name: '诊断已保存' });
    await result.waitFor();
    diagnosticId = await result.getByLabel('诊断 ID', { exact: true }).inputValue();
    assert.match(diagnosticId, /^[0-9a-f-]{36}$/);
    await shot(first, 'diagnostic-saved');
    await click(first, result.getByRole('button', { name: '完成', exact: true }));
    await focusApp(first, 'admin');
    await section(first, '诊断');
    await first.page.getByText(diagnosticId.slice(0, 8), { exact: true }).waitFor();
    await type(first, first.page.getByLabel('错误 ID', { exact: true }), errorId);
    await click(first, button(first, '查找'));
    await first.page.getByText('viewer.request_failed', { exact: true }).waitFor();
    await click(first, first.page.getByText('viewer.request_failed', { exact: true }).first());
    await shot(first, 'diagnostic-error-lookup');
    await report('diagnostic-ids', { diagnosticId, errorId });
  });
  if (process.env.REMOTEKIT_CLUSTER_RESUME !== 'after-stop')
    await step('admin-stop-session', async () => {
      second = await makeViewer('second-returned');
      await login(second, 'cluster-second');
      await navigate(second, '/uncommitted');
      await focusApp(first, 'admin');
      await section(first, '用户');
      await second.page.close();
      await until('second detached', async () => {
        const s = await control.call('inspect');
        return !s.runtimes.find((r) => r.tenant === placement(s, 'cluster-second').tenant)?.viewer;
      });
      await pause(5500);
      await userMenu(first, 'cluster-second');
      await click(first, first.page.getByRole('menuitem', { name: '立即停止', exact: true }));
      await dialog(first, '立即停止', '停止', 'stop-session-dialog');
      await until(
        'admin stopped',
        async () => {
          const p = placement(await control.call('inspect'), 'cluster-second');
          return p.run_state === 'stopped' && p.data_state === 'clean';
        },
        120000,
      );
      await shot(first, 'admin-stopped-session');
    });
  await step('admin-discard-offline-session', async () => {
    second = await makeViewer('second-dirty');
    try {
      await login(second, 'cluster-second');
    } catch (error) {
      process.exitCode = 1;
      await report('fail:resume-after-admin-stop', {
        error: error.stack,
        snapshot: await control.call('inspect'),
      });
      await shot(second, 'resume-after-admin-stop-stuck');
      // Record the failure, then restart this fixture so the remaining independent admin journey can run.
      await control.stop();
      control = startControl(resolve('tests/e2e/cluster-journey-harness.mts'), config, run);
      await appendFile(
        join(run, 'pids.jsonl'),
        JSON.stringify({
          control: control.child.pid,
          reason: 'recovery after recorded stop/resume failure',
        }) + '\n',
      );
      await until(
        'fixture nodes restarted',
        async () => {
          try {
            const s = await control.call('inspect');
            return s.nodes.length === 2 && s.nodes.every((n) => n.state === 'ready');
          } catch {
            return false;
          }
        },
        90000,
      );
      await first.page.reload();
      await second.page.reload();
      await pause(1000);
      await reveal(second);
      await second.ready(90000);
    }
    await navigate(second, '/discard-mutated');
    await remoteClick(second, '/discard-mutated', 'store');
    await until('dirty persistent data', () =>
      events.findLast(
        (e) => e.type === 'stored' && e.path === '/discard-mutated' && e.storage === 'isolated-new-value',
      ),
    );
    const s = await control.call('inspect');
    const node = placement(s, 'cluster-second').node_id;
    assert.notEqual(node, placement(s, 'cluster-first').node_id);
    await killNode(node, 1);
    await pause(1800);
    await shot(second, 'offline-dirty-session');
    await second.page.close();
    await focusApp(first, 'admin');
    await section(first, '用户');
    await pause(5500);
    await userMenu(first, 'cluster-second');
    await click(first, first.page.getByRole('menuitem', { name: '放弃未提交的更改', exact: true }));
    await dialog(first, '放弃未提交的更改', '放弃更改', 'discard-session-dialog');
    const p = placement(await control.call('inspect'), 'cluster-second');
    assert.equal(p.run_state, 'stopped');
    assert.equal(p.data_state, 'clean');
    await shot(first, 'discarded-offline-session');
    await section(first, '节点');
    const card = first.page
      .locator('.admin-node')
      .filter({ has: first.page.getByText(node, { exact: true }) });
    await click(first, card.getByRole('button', { name: '移除节点', exact: true }));
    await dialog(first, '移除节点', '移除', 'offline-node-remove');
    await click(first, card.getByRole('button', { name: '重新添加', exact: true }));
    await dialog(first, '重新添加节点', '重新添加', 'offline-node-readd');
    await until(
      'offline node ready',
      async () => (await control.call('inspect')).nodes.find((n) => n.nodeId === node)?.state === 'ready',
      90000,
    );
    second = await makeViewer('second-after-discard');
    await login(second, 'cluster-second');
    await navigate(second, '/discard-verified');
    const restored = await until('discard data restored', () =>
      events.findLast((e) => e.type === 'ready' && e.path === '/discard-verified'),
    );
    await report('discard-observation', restored);
    assert.equal(restored.storage, null);
    assert(!restored.cookie.includes('cluster='));
    await shot(second, 'discard-data-verified');
    await second.page.close();
  });
  await step('network-reconnect-and-lock', async () => {
    await focusApp(first, 'browser');
    await first.context.setOffline(true);
    await pause(2200);
    await shot(first, 'network-offline');
    await first.context.setOffline(false);
    await reveal(first);
    await first.ready(120000);
    await first.media();
    await click(first, button(first, '开始'));
    await click(first, button(first, '锁定'));
    await first.page.locator('.viewer-lock-blank').waitFor();
    await shot(first, 'locked');
    await reveal(first);
    await shot(first, 'unlocked');
  });
  await step('default-hard-kill-recovery', async () => {
    await focusApp(first, 'browser');
    const s = await control.call('inspect');
    const node = placement(s, 'cluster-first').node_id;
    await killNode(node, 1);
    await pause(800);
    await shot(first, 'taskkill-viewer-down');
    await pause(7500);
    await shot(first, 'taskkill-stuck');
    const n = (await control.call('inspect')).nodes.find((n) => n.nodeId === node);
    await report('taskkill-result', n);
    assert.equal(n.state, 'ready', 'taskkill /F must restart the local Endpoint');
  });
  await report('complete');
} catch (error) {
  process.exitCode = 1;
  for (const v of viewers) if (!v.page.isClosed()) await shot(v, 'failure-final').catch(() => {});
  await report('failure', error.stack);
} finally {
  await browser?.close();
  await control.stop();
  if (vite.exitCode === null)
    execFileSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
}
