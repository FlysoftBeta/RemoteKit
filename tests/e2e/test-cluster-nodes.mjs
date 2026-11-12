import { stageRuntime } from './../integration/stage-runtime.mjs';
/** Real Viewer/H264, two local nodes, checkpoint relocation and demand peer object read.
 * args: playwright module, Edge exe, Endpoint exe, Browser exe, new evidence directory, [port]
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { buildHarness, instrumentViewer, startControl, until } from './cluster-test-support.mjs';

const [modulePath, edge, endpoint, browser, output, portArg = '33831'] = process.argv.slice(2);
assert([modulePath, edge, endpoint, browser, output].every(Boolean));
const run = resolve(output),
  port = Number(portArg),
  origin = `http://127.0.0.1:${port}`;
const fixtureOrigin = `http://127.0.0.1:${port + 1}`;
await mkdir(run);
const evidence = async (name, value) => {
  console.log(name);
  await writeFile(join(run, name + '.json'), JSON.stringify(value, null, 2));
};
const events = [];
const fixture = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let raw = '';
    for await (const bytes of request) raw += bytes;
    events.push(JSON.parse(raw));
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Cluster ${request.url}</title>
    <style>body{margin:20px;background:#e3effa}button,input{display:block;margin-bottom:20px}</style>
    <button id="store">Persist state</button><input id="file" type="file"><canvas width="24" height="24"></canvas>
    <script>
    const report=(type,extra={})=>fetch('/event',{method:'POST',body:JSON.stringify({type,path:location.pathname,cookie:document.cookie,storage:localStorage.getItem('cluster'),...extra})});
    store.onclick=()=>{document.cookie='cluster=persisted; Max-Age=86400; SameSite=Lax';localStorage.setItem('cluster','stored-value');report('stored')};
    file.onchange=async()=>{const f=file.files[0];report('attached',{name:f.name,size:f.size,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')})};
    document.addEventListener('click',event=>report('clicked',{id:event.target.id,trusted:event.isTrusted}));
    const geometry=()=>report('ready',{width:innerWidth,height:innerHeight,boxes:Object.fromEntries([store,file].map(el=>[el.id,el.getBoundingClientRect().toJSON()]))});
    geometry();addEventListener('resize',geometry);
    let tick=0;setInterval(()=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle=++tick%2?'red':'blue';c.fillRect(0,0,24,24)},100);
    </script>`);
});
await new Promise((done) => fixture.listen(port + 1, '127.0.0.1', done));
const server = await buildHarness(join(run, 'runtime'));
const nodes = Object.fromEntries(
  ['alpha', 'beta'].map((id, index) => [
    id,
    {
      peer: { listen: `127.0.0.1:${port + 2 + index}`, address: `127.0.0.1:${port + 2 + index}` },
      limits: { maxSessions: 1 },
      local: {
        executable: stageRuntime(endpoint, browser, join(run, 'node-runtime/bin')),
        root: join(run, id, 'root'),
      },
    },
  ]),
);
const configPath = join(run, 'control.json');
await writeFile(
  configPath,
  JSON.stringify({
    http: { listen: `127.0.0.1:${port}`, origins: [origin] },
    storage: { database: join(run, 'control.db') },
    nodes,
  }),
);
const control = startControl(server, configPath, run);
const { chromium } = createRequire(import.meta.url)(resolve(modulePath));
let viewers;
const contexts = [];
const password = randomUUID();
let setupDone = false;
// The first account comes from setup; the administrator creates the others, which then log in.
async function connect(name, context) {
  context ??= await viewers.newContext({ viewport: { width: 1000, height: 760 } });
  if (!contexts.includes(context)) contexts.push(context);
  const response = await context.request.post(origin + (setupDone ? '/api/auth/login' : '/api/auth/setup'), {
    headers: { Origin: origin },
    data: { username: name, password },
  });
  assert.equal(response.status(), 200, await response.text());
  const viewer = await instrumentViewer(context, run, name);
  await viewer.page.goto(origin);
  await viewer.ready();
  await viewer.call('auth.settings', {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  await viewer.action({ type: 'settings.update', settings: { browser: { memorySaverEnabled: true } } });
  return viewer;
}
async function workspace(viewer, path) {
  await viewer.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
  const state = await viewer.state();
  const window = state.workspace.windows.at(-1);
  await viewer.action({ type: 'tab.navigate', tabId: window.activeTabId, url: fixtureOrigin + path });
  await viewer.media();
  return window;
}
async function tap(viewer, path, id) {
  await viewer.page.waitForFunction(() => {
    const viewport = document.querySelector('.remote-viewport');
    const workspace = clusterQA.state?.workspace;
    const active = workspace?.tabs.find((tab) => tab.id === workspace.windows[0]?.activeTabId);
    return (
      clusterQA.layout?.views.some((view) => view.id === active?.webviewId && !view.stale) &&
      viewport?.querySelector('video')?.videoWidth > 0 &&
      !viewport.classList.contains('resize-waiting') &&
      !viewport.querySelector('canvas[data-video-input]')?.classList.contains('no-frame')
    );
  });
  const region = viewer.page.locator('.remote-viewport').first();
  const box = await region.boundingBox();
  const geometry = await until('fixture geometry', () =>
    events.findLast(
      (event) => event.type === 'ready' && event.path === path && Math.abs(event.width - box.width) < 2,
    ),
  );
  const target = geometry.boxes[id];
  await viewer.page.mouse.click(
    box.x + ((target.x + 15) * box.width) / geometry.width,
    box.y + ((target.y + 8) * box.height) / geometry.height,
  );
}
const placementFor = (snapshot, name) =>
  snapshot.placements.find((p) => p.tenant === snapshot.users.find((u) => u.username === name)?.tenant);
async function hibernate(viewer, name) {
  await viewer.page.close();
  await until('Viewer detached', async () => {
    const snapshot = await control.call('inspect');
    const tenant = placementFor(snapshot, name).tenant;
    return snapshot.runtimes.find((r) => r.tenant === tenant)?.viewer === false;
  });
  await control.call('advance', { ms: 600001 });
  return until(
    'checkpoint committed for ' + name,
    async () => {
      const snapshot = await control.call('inspect');
      const tenant = placementFor(snapshot, name)?.tenant;
      const runtime = snapshot.runtimes.find((entry) => entry.tenant === tenant);
      assert(!runtime?.error?.includes('unclean Browser shutdown'), runtime?.error);
      return placementFor(snapshot, name)?.state === 'hibernated' && snapshot;
    },
    90000,
  );
}
try {
  await until('both nodes ready with metrics', async () => {
    try {
      const snapshot = await control.call('inspect');
      return (
        snapshot.nodes.length === 2 && snapshot.nodes.every((node) => node.state === 'ready' && node.metrics)
      );
    } catch {
      return false;
    }
  });
  viewers = await chromium.launch({
    executablePath: resolve(edge),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const first = await connect('cluster-first');
  setupDone = true;
  for (const username of ['cluster-second', 'cluster-third'])
    await first.call('admin.createUser', { username, password });
  await workspace(first, '/first');
  await tap(first, '/first', 'store');
  await until('persistent state set', () => events.some((event) => event.type === 'stored'));
  const firstWindow = (await first.state()).workspace.windows[0];
  await first.action({ type: 'tab.create', windowId: firstWindow.id });
  const tabs = (await first.state()).workspace.tabs;
  await first.action({ type: 'tab.navigate', tabId: tabs.at(-1).id, url: fixtureOrigin + '/second-tab' });
  await first.media();
  const second = await connect('cluster-second');
  await workspace(second, '/other-tenant');
  const initial = await control.call('inspect');
  const source = placementFor(initial, 'cluster-first'),
    other = placementFor(initial, 'cluster-second');
  assert.notEqual(source.node_id, other.node_id);
  await evidence('simultaneous-streams', {
    initial,
    first: await first.media(),
    second: await second.media(),
  });
  const bytes = Buffer.from('RemoteKit cluster peer object ' + randomUUID());
  const begin = await first.call(
    'asset.begin',
    {
      requestId: 'library',
      operationId: randomUUID(),
      name: 'moved.txt',
      type: 'text/plain',
      size: bytes.length,
    },
    true,
  );
  await first.call(
    'asset.chunk',
    { requestId: 'library', uploadId: begin.uploadId, offset: 0, data: bytes.toString('base64') },
    true,
  );
  const asset = await first.call('asset.seal', { requestId: 'library', uploadId: begin.uploadId }, true);
  const library = await first.call('library.import', {
    operationId: randomUUID(),
    assetId: asset.assetId,
    name: 'moved.txt',
    destination: 'basket',
    origin: { kind: 'files', channel: 'upload', partitionId: null },
  });
  const before = (await first.state()).workspace.tabs;
  const checkpoint = await hibernate(first, 'cluster-first');
  assert(placementFor(checkpoint, 'cluster-first').checkpoint_id);
  await evidence('checkpoint-committed', checkpoint);
  // The third tenant consumes the source slot while the source stays online as an object peer.
  await until('source metrics reflect hibernation', async () => {
    const snapshot = await control.call('inspect');
    return snapshot.nodes.find((n) => n.nodeId === source.node_id)?.metrics?.sessions === 0;
  });
  const third = await connect('cluster-third');
  await workspace(third, '/fill-source');
  assert.equal(placementFor(await control.call('inspect'), 'cluster-third').node_id, source.node_id);
  await hibernate(second, 'cluster-second');
  await until('destination metrics reflect hibernation', async () => {
    const snapshot = await control.call('inspect');
    return snapshot.nodes.find((n) => n.nodeId === other.node_id)?.metrics?.sessions === 0;
  });
  const restoreEvents = events.length;
  const restored = await connect('cluster-first', first.context);
  const media = await restored.media();
  const moved = await control.call('inspect');
  const target = placementFor(moved, 'cluster-first');
  assert.equal(target.node_id, other.node_id);
  assert.equal(target.session_id, source.session_id);
  assert.equal(target.placement_epoch, source.placement_epoch + 1);
  assert.deepEqual(
    (await restored.state()).workspace.tabs.map((tab) => ({ id: tab.id, url: tab.url })),
    before.map((tab) => ({ id: tab.id, url: tab.url })),
  );
  await restored.action({ type: 'tab.activate', tabId: before[0].id });
  await restored.media();
  const persisted = await until('cookie and localStorage restored', () =>
    events
      .slice(restoreEvents)
      .findLast(
        (event) =>
          event.type === 'ready' &&
          event.path === '/first' &&
          event.cookie.includes('cluster=persisted') &&
          event.storage === 'stored-value',
      ),
  );
  const objectPath = join(
    join(nodes[target.node_id].local.root, 'data'),
    'objects',
    asset.assetId.slice(0, 2),
    asset.assetId + '.rko',
  );
  await control.call('evict', { nodeId: target.node_id, tenant: target.tenant, objectId: asset.assetId });
  assert.equal(
    await stat(objectPath).then(
      () => true,
      () => false,
    ),
    false,
  );
  const locateStart = control.events.length;
  await tap(restored, '/first', 'file');
  const request = await until('page file chooser', async () =>
    (await restored.state()).fileRequests.find((r) => r.state === 'pending'),
  );
  const prepared = await restored.call('library.prepare', {
    operationId: randomUUID(),
    requestId: request.id,
    entryIds: [library.basket[0]],
  });
  await restored.call('selection.commit', { requestId: request.id, selectionId: prepared.selectionId }, true);
  const attached = await until('moved file attached', () =>
    events.findLast((event) => event.type === 'attached'),
  );
  assert.equal(attached.hash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(attached.name, 'moved.txt');
  const demand = control.events
    .slice(locateStart)
    .find(
      (event) =>
        event.event === 'object.locate' &&
        event.nodeId === target.node_id &&
        event.request.ids.includes(asset.assetId),
    );
  assert(demand, 'Attachment must fetch the missing object from a peer');
  assert((await readFile(objectPath)).length > 0);
  await evidence('restored-on-peer', { moved, media, persisted, attached, demand });
  await restored.page.screenshot({ path: join(run, 'restored.png') });
  await evidence('pass', {
    source: source.node_id,
    destination: target.node_id,
    clockSeam: 'createApplication Clock.monotonicMs advanced by 600001ms after Viewer detach',
  });
} catch (error) {
  process.exitCode = 1;
  await evidence('failure', {
    error: error.stack,
    snapshot: await control.call('inspect').catch(String),
    events,
  });
} finally {
  await viewers?.close();
  await control.stop();
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
}
