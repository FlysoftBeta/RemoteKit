/**
 * Isolated production H264/file-library regression.
 * node tools/test-file-library.mjs <playwright module> <viewer exe> <endpoint exe> <browser exe> <new output dir> [port] [Control server.mjs]
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [playwright, viewer, endpoint, browser, output, listenPort = '33791', server] = process.argv.slice(2);
assert([playwright, viewer, endpoint, browser, output].every(Boolean), 'Expected module, three executables and a new output directory');
const port = Number(listenPort);
assert(Number.isInteger(port) && port > 1024 && port < 65535);
const root = fileURLToPath(new URL('../', import.meta.url));
const run = resolve(output);
const origin = 'http://127.0.0.1:' + port;
const fixtureOrigin = 'http://127.0.0.1:' + (port + 1);
const { chromium } = createRequire(import.meta.url)(resolve(playwright));
await mkdir(run);

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(label, probe, timeout = 12000) {
  const end = Date.now() + timeout;
  do {
    const found = await probe();
    if (found) return found;
    await sleep(100);
  } while (Date.now() < end);
  throw new Error('Timed out: ' + label);
}
const log = async (stage, detail = {}) => {
  console.log(stage);
  await appendFile(join(run, 'file-library-results.jsonl'), JSON.stringify({ stage, detail }) + '\n');
};

const events = [];
const fixture = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/event') {
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 8192) return response.writeHead(413).end();
      }
      const event = JSON.parse(body);
      events.push(event);
      await appendFile(join(run, 'fixture-events.jsonl'), JSON.stringify(event) + '\n');
      response.end();
    } catch { response.writeHead(400).end(); }
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:16px;font:18px sans-serif}input,button{display:block;margin-bottom:22px;width:290px;height:45px}[hidden]{display:none}</style>
    <input id="single" type="file" accept=".txt"><input id="multiple" type="file" multiple>
    <button id="hidden">Hidden input</button><input id="fallback" type="file" hidden>
    <button id="later">Read held files again</button>
    <script>
      const report = (type, detail) => fetch('/event', {method:'POST',body:JSON.stringify({type,...detail})});
      const inputs = [...document.querySelectorAll('input')];
      const reportGeometry = () => report('geometry', {
        path:location.pathname,width:innerWidth,height:innerHeight,boxes:Object.fromEntries(
          [...inputs, ...document.querySelectorAll('button')].map(el=>[el.id,el.getBoundingClientRect().toJSON()]))});
      let held = [];
      const describe = async files => Promise.all(files.map(async file => ({
        name:file.name,size:file.size,hash:Array.from(new Uint8Array(
          await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')
      })));
      for(const el of inputs) el.onchange = async () => {
        held = [...el.files];
        report('selected', {id:el.id,files:await describe(held)});
        el.value = '';
      };
      document.querySelector('#hidden').onclick = event => {
        report('hidden-click', { trusted: event.isTrusted });
        document.querySelector('#fallback').click();
      };
      document.querySelector('#later').onclick = async () => report('delayed',{files:await describe(held)});
      if (location.pathname === '/files-converted') document.querySelector('#single').addEventListener('click', event => {
        const target = event.currentTarget;
        setTimeout(() => { target.style.display = 'none'; report('anchor-hidden'); }, 3000);
      });
      reportGeometry(); addEventListener('resize',reportGeometry);
    </script>`);
});
await new Promise((done, reject) => {
  fixture.once('error', reject);
  fixture.listen(port + 1, '127.0.0.1', done);
});
const control = spawn(process.execPath, [server ? resolve(server) : join(root, 'control/dist/server.mjs')], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^REMOTEKIT_/i.test(key))),
    PORT: String(port), REMOTEKIT_CONTROL_HOST: '127.0.0.1', REMOTEKIT_CONTROL_ORIGINS: origin,
    REMOTEKIT_METRICS_DIR: join(run, 'metrics'),
    REMOTEKIT_CONTROL_DB: join(run, 'control.db'), REMOTEKIT_ENDPOINT: resolve(endpoint),
    REMOTEKIT_ENDPOINT_ARGS: JSON.stringify(['--browser=' + resolve(browser), '--data-path=' + join(run, 'endpoint')]) },
});
const stopped = new Promise(done => {
  control.once('exit', done);
  control.once('error', error => done(error.message));
});
control.stdout.on('data', data => void appendFile(join(run, 'control.stdout.log'), data));
control.stderr.on('data', data => void appendFile(join(run, 'control.stderr.log'), data));

const photoSize = { width: 320, height: 240 };
function pixels(x, y, variant) {
  if (variant === 'blank') return 135;
  const page = y > 28 && y < 214 && x > 52 + y / 6 && x < 281 - y / 14;
  if (!page) return 28;
  if (variant === 'page') return x > 100 && x < 232 && y > 53 && y < 191 && y % 13 < 3 ? 32 : 230;
  return y > 53 && y < 191 && x > 100 && x < 232 && x % 13 < 3 ? 32 : 230;
}
async function makeCamera() {
  const { width, height } = photoSize;
  const yuv = Buffer.alloc(width * height * 3 / 2, 128);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) yuv[y * width + x] = pixels(x, y, 'page');
  const frame = Buffer.concat([Buffer.from('FRAME\n'), yuv]);
  const path = join(run, 'camera.y4m');
  await writeFile(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`), ...Array(24).fill(frame)]));
  return path;
}
let context, page;
let stage = 'startup';
const deadline = setTimeout(() => void context?.close().catch(() => {}), 210000);
try {
  await until('fresh production Control', async () => {
    const response = await fetch(origin + '/api/auth/registration', { signal: AbortSignal.timeout(1000) }).catch(() => null);
    return response?.ok && !(await response.json()).hasAdmin;
  });
  context = await chromium.launchPersistentContext(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer), headless: false, viewport: { width: 1152, height: 820 },
    timeout: 15000, args: ['--no-first-run', '--no-default-browser-check',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-video-capture=' + await makeCamera()],
  });
  page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => {
    const qa = window.fileQA = { sockets: [], peers: [], channels: [], pending: new Map(), sealed: new Map(), timeline: [],
      thumbnails: new Map(), imageReads: new Set() };
    const ids = new WeakMap();
    let nextId = 0;
    const identity = object => {
      if (object && !ids.has(object)) ids.set(object, ++nextId);
      return object ? ids.get(object) : null;
    };
    const record = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'state') qa.state = message.state;
      if (message.type === 'auth') {
        qa.auth = message.auth;
        if (message.auth.peerEpoch > 0) qa.peerEpoch = message.auth.peerEpoch;
        qa.note({ type: 'auth', locked: message.auth.locked, peerEpoch: message.auth.peerEpoch });
      }
      if (['layout', 'presentation.prepare', 'frame'].includes(message.type))
        qa.note({ type: message.type, epoch: message.epoch ?? message.layoutEpoch,
          peerEpoch: message.authEpoch, keyframe: message.keyframe, views: message.views?.length });
      if (message.type === 'files.result') {
        const source = qa.thumbnails.get(message.requestId);
        if (source && message.ok && message.result?.assetId) qa.thumbnails.set(source, message.result);
        if (message.ok && message.result?.assetId && message.result?.hash)
          qa.sealed.set(message.result.assetId, message.result);
        qa.receive(message.requestId, message);
      }
      if (message.id) qa.receive(message.id, message);
    };
    window.WebSocket = class extends WebSocket {
      constructor(...args) { super(...args); qa.sockets.push(this); this.addEventListener('message', record); }
      send(raw) {
        const message = JSON.parse(raw);
        if (message.method === 'library.basket' && !qa.pending.has(message.id)) {
          qa.basketWrites = (qa.basketWrites ?? 0) + 1;
          if (qa.holdBasket) {
            qa.holdBasket = false;
            qa.heldBasket = { params: message.params, release: () => super.send(raw) };
            return;
          }
        }
        return super.send(raw);
      }
    };
    window.RTCPeerConnection = class extends RTCPeerConnection {
      constructor(...args) { super(...args); qa.peers.push(this); }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        qa.channels.push(channel);
        channel.addEventListener('message', record);
        if (channel.label === 'remotekit') qa.fileChannel = channel;
        return channel;
      }
    };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(raw) {
      try {
        const packet = JSON.parse(raw);
        if (packet.method === 'photo.thumbnail') qa.thumbnails.set(packet.requestId, packet.params.assetId);
        if (packet.method === 'asset.read') qa.imageReads.add(packet.params.assetId);
        if (packet.type === 'media.refresh') qa.note({ type: packet.type, peerEpoch: packet.authEpoch });
        if (packet.authEpoch > 0 && this.label !== 'remotekit-auth') {
          qa.fileChannel = this;
          qa.peerEpoch = packet.authEpoch;
        }
      } catch {}
      return send.call(this, raw);
    };
    qa.note = entry => {
      qa.timeline.push({ at: Math.round(performance.now()), ...entry });
      if (qa.timeline.length > 80) qa.timeline.shift();
    };
    qa.receive = (id, message) => {
      const done = qa.pending.get(id);
      if (done) done(message);
    };
    qa.call = ({ id, method, params, rtc, authEpoch, timeout = 10000 }) => new Promise(resolve => {
      const channel = rtc ? qa.fileChannel : qa.sockets[qa.sockets.length - 1];
      const done = message => { clearTimeout(timer); qa.pending.delete(id); resolve(message); };
      const timer = setTimeout(() => done({ timeout: true }), timeout);
      qa.pending.set(id, done);
      const message = rtc ? { type: 'files.request', version: 1, requestId: id,
        method, params, authEpoch: authEpoch ?? qa.peerEpoch } : { id, method, params };
      try {
        if (rtc) send.call(channel, JSON.stringify(message));
        else channel.send(JSON.stringify(message));
      } catch (error) { done({ error: String(error), unsent: true }); }
    });
    qa.sample = () => {
      const peer = qa.peers[0];
      const video = document.querySelector('.remote-video-plane video');
      return { peer: identity(peer), tracks: peer?.getReceivers().map(receiver => identity(receiver.track)),
        channels: qa.channels.map(channel => [identity(channel), channel.readyState]), video: identity(video),
        stream: identity(video?.srcObject), peerCount: qa.peers.length, connected: peer?.connectionState };
    };
    qa.action = (action, operationId) => send.call(qa.fileChannel, JSON.stringify({
      type: 'product.action', version: 1, authEpoch: qa.peerEpoch,
      operationId, operationGeneration: qa.state.operationGeneration, action,
    }));
    const devices = navigator.mediaDevices;
    const getUserMedia = devices?.getUserMedia.bind(devices);
    if (getUserMedia) devices.getUserMedia = async constraints => {
      if (!qa.alternateCamera || !constraints.video) return getUserMedia(constraints);
      const canvas = document.createElement('canvas');
      canvas.width = 520; canvas.height = 400;
      const drawing = canvas.getContext('2d');
      let alternate = false;
      const render = () => {
        drawing.fillStyle = alternate ? 'rgb(235,184,94)' : 'rgb(193,174,255)';
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.fillStyle = alternate ? 'rgb(69,19,0)' : 'rgb(31,25,92)';
        drawing.font = 'bold 28px sans-serif';
        for (let y = 42; y < 400; y += 31) drawing.fillText('RemoteKit photo quality', 24, y);
        alternate = !alternate;
      };
      const stream = canvas.captureStream(24);
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      render();
      const timer = setInterval(render, 140);
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    };
  });

  const raw = (method, params, options = {}) => page.evaluate(input => fileQA.call(input),
    { id: randomUUID(), method, params, ...options });
  const call = async (method, params, options) => {
    const reply = await raw(method, params, options);
    assert(Object.hasOwn(reply, 'result') && !reply.error && reply.ok !== false, method + ': ' + JSON.stringify(reply));
    return reply.result;
  };
  const library = (method, params = {}) => call('library.' + method, params);
  const rtc = (method, params = {}) => call(method, { requestId: 'library', ...params }, { rtc: true });
  const state = () => page.evaluate(() => fileQA.state);
  const action = async intent => {
    const operationId = randomUUID(), operationGeneration = (await state()).operationGeneration;
    await page.evaluate(({ intent, operationId }) => fileQA.action(intent, operationId), { intent, operationId });
    await until('product action ' + intent.type, async () => {
      const receipt = await call('operation.status', { operationId, operationGeneration });
      assert(!['rejected', 'expired'].includes(receipt.status), JSON.stringify(receipt));
      return receipt.status === 'committed';
    });
  };
  const wait = (probe, arg) => page.waitForFunction(probe, arg, { timeout: 12000 });
  const click = async (css, text) => {
    const handle = await wait(({ css, text }) => {
      const match = Array.from(document.querySelectorAll(css)).find(element =>
        (text === undefined || element.textContent.trim() === text) && !element.disabled && element.getClientRects().length);
      const box = match?.getBoundingClientRect();
      if (!box?.width) return false;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      return match.contains(document.elementFromPoint(x, y)) && { x, y };
    }, { css, text });
    const { x, y } = await handle.jsonValue();
    await page.mouse.click(x, y);
  };
  const fill = async (css, value) => {
    await page.focus(css);
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(value);
  };
  const ready = () => wait(() => {
    const viewport = document.querySelector('.remote-viewport');
    const video = viewport?.querySelector('.remote-video-plane video');
    return video?.videoWidth > 0 && !viewport.classList.contains('resize-waiting') &&
      !viewport.querySelector('canvas[data-video-input]')?.classList.contains('no-frame');
  });
  const tapRemote = async id => {
    await ready();
    const local = await page.locator('.remote-viewport').boundingBox();
    const geometry = await until('current remote fixture geometry', async () => {
      const path = await page.locator('.address-form input').inputValue();
      if (!path.startsWith(fixtureOrigin)) return null;
      return events.findLast(event => event.type === 'geometry' &&
        Math.abs(event.width - local.width) <= 1 && event.path === new URL(path).pathname);
    });
    const { x, y, width, height } = geometry.boxes[id];
    await page.mouse.click(local.x + (x + width / 2) * local.width / geometry.width,
      local.y + (y + height / 2) * local.height / geometry.height);
  };
  const chooser = async id => {
    await wait(() => !document.getElementById('file-chooser-title') && !fileQA.state.fileRequests.length);
    await tapRemote(id);
    return until('native chooser ' + id, async () => (await state())?.fileRequests.find(request => request.state === 'pending'));
  };
  const identity = () => page.evaluate(() => fileQA.sample());
  const screenshot = async name => {
    await sleep(300);
    await page.screenshot({ path: join(run, name + '.png') });
  };
  const containedImages = selector => wait(css => {
    const images = Array.from(document.querySelectorAll(css));
    if (!images.length) return false;
    return images.every(image => {
      const outer = image.parentElement.getBoundingClientRect(), inner = image.getBoundingClientRect();
      return image.complete && image.naturalWidth > 0 && getComputedStyle(image).objectFit === 'contain' &&
        inner.width > 0 && inner.height > 0 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1 &&
        inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    });
  }, selector);
  const waitForAnchor = requestId => wait(id => {
    const current = fileQA.state.fileRequests.find(request => request.id === id);
    const paper = document.getElementById('file-chooser-title')?.closest('[role="dialog"]');
    return current?.anchor && paper && getComputedStyle(paper).position === 'fixed' && current.anchor;
  }, requestId).then(handle => handle.jsonValue());

  await page.goto(origin, { timeout: 12000 });
  await wait(() => document.querySelector('.viewer-lock-blank'));
  await until('authentication gate ready', async () => {
    for (const key of ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight'])
      await page.keyboard.press(key);
    await sleep(300);
    return page.evaluate(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '创建账户'));
  });
  const password = randomUUID();
  await click('button', '创建账户');
  await fill('input[autocomplete="username"]', 'file-library-qa');
  await fill('input[autocomplete="new-password"]', password);
  await click('button[type="submit"]', '创建账户');
  await click('button', '新建窗口');
  await fill('.address-form input', fixtureOrigin);
  await page.keyboard.press('Enter');
  await ready();
  await wait(() => fileQA.fileChannel?.readyState === 'open' && fileQA.auth?.peerEpoch > 0);
  await call('auth.settings', { currentPassword: password, settings: { lockOnHidden: false, lockOnIdle: false } });
  const baseline = await identity();
  assert.equal(baseline.connected, 'connected');
  const codec = await until('received H264 frames', () => page.evaluate(async () => {
    const stats = await fileQA.peers[0].getStats();
    const video = Array.from(stats.values()).find(entry => entry.type === 'inbound-rtp' &&
      (entry.kind ?? entry.mediaType) === 'video' && entry.framesDecoded > 0);
    const mime = video && stats.get(video.codecId)?.mimeType;
    return /video\/h264/i.test(mime ?? '') ? mime : null;
  }));
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await log(stage, { browser: userAgent, codec, baseline });

  async function upload(name, type, bytes, operationId = randomUUID()) {
    const begin = { operationId, name, type, size: bytes.length };
    const { uploadId, offset } = await rtc('asset.begin', begin);
    assert.deepEqual(await rtc('asset.begin', begin), { uploadId, offset });
    assert.equal(offset, 0);
    for (let position = 0; position < bytes.length;) {
      const chunk = bytes.subarray(position, position + 16384);
      assert.equal((await rtc('asset.chunk', { uploadId, offset: position, data: chunk.toString('base64') })).offset,
        position + chunk.length);
      position += chunk.length;
    }
    const asset = await rtc('asset.seal', { uploadId });
    assert.equal(asset.hash, hash(bytes));
    assert.equal(asset.size, bytes.length);
    return asset;
  }
  async function read(asset) {
    const parts = [];
    for (let offset = 0; offset < asset.size;) {
      const part = await rtc('asset.read', { assetId: asset.assetId, offset });
      const bytes = Buffer.from(part.data, 'base64');
      assert(bytes.length > 0 && bytes.length <= 16384);
      assert.equal(part.total, asset.size);
      assert.equal(part.offset, offset + bytes.length);
      parts.push(bytes);
      offset = part.offset;
    }
    const bytes = Buffer.concat(parts);
    assert.equal(bytes.length, asset.size);
    assert.equal(hash(bytes), asset.hash);
    return bytes;
  }
  const operation = (method, params) => library(method, { operationId: randomUUID(), ...params });
  const importAsset = (asset, name, params = {}) => operation('import', {
    assetId: asset.assetId, name, destination: 'basket', groupId: null, ...params,
  });
  const expectRejection = async (method, params, options) => {
    const reply = await raw(method, params, options);
    assert(reply.error || reply.ok === false, 'Expected rejection for ' + method + ': ' + JSON.stringify(reply));
  };

  stage = 'rtc-assets-and-basket';
  const bytes = Buffer.alloc(37019);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 29 + (index >> 8)) & 255;
  const assetA = await upload('中文-字节.txt', 'text/plain', bytes);
  assert.deepEqual(await read(assetA), bytes);
  const assetB = await upload('empty.bin', 'application/octet-stream', Buffer.alloc(0));
  const assetC = await upload('third.txt', 'text/plain', Buffer.from('third\n'));
  let snapshot = await operation('group', { name: 'QA incoming' });
  const { id: groupId } = snapshot.groups.find(group => group.name === 'QA incoming');
  snapshot = await operation('group', { id: groupId, name: 'QA receipts' });
  assert(snapshot.groups.some(group => group.id === groupId && group.name === 'QA receipts'));
  const importA = { operationId: randomUUID(), assetId: assetA.assetId, name: '中文-字节.txt', destination: 'basket', groupId: null };
  snapshot = await library('import', importA);
  const [a] = snapshot.basket;
  assert.deepEqual((await library('import', importA)).basket, [a]);
  const b = (await importAsset(assetB, 'empty.bin')).basket.at(-1);
  snapshot = await importAsset(assetC, 'third.txt', { afterId: a });
  const [, c] = snapshot.basket;
  assert.deepEqual(snapshot.basket, [a, c, b]);
  const preReorderRevision = snapshot.revision;
  const reorder = { operationId: randomUUID(), ids: [b, c, a], expectedRevision: preReorderRevision };
  snapshot = await library('basket', reorder);
  assert.deepEqual(snapshot.basket, [b, c, a]);
  assert.deepEqual((await library('basket', reorder)).basket, [b, c, a]);
  await expectRejection('library.basket', { operationId: randomUUID(), ids: [a, a], expectedRevision: snapshot.revision });
  await expectRejection('library.basket', { operationId: randomUUID(), ids: [a], expectedRevision: preReorderRevision });
  assert.deepEqual((await library('get')).basket, [b, c, a]);
  assert(snapshot.entries.filter(entry => [a,b,c].includes(entry.id)).every(entry => !entry.archived));
  await log(stage, { hashes: [assetA.hash, assetB.hash, assetC.hash], order: snapshot.basket });

  stage = 'basket-list-cards-and-order';
  const single = await chooser('single');
  assert.equal(single.multiple, false);
  const anchor = await waitForAnchor(single.id);
  assert(anchor.instance && anchor.document && anchor.layoutGeneration);
  assert(anchor.width > 0 && anchor.height > 0 && anchor.x + anchor.width <= anchor.viewportWidth);
  const basketList = 'ul[aria-label="文件篮"]';
  const listRow = id => `${basketList} > li[data-sort-item="${id}"]`;
  const cardButton = id => listRow(id) + ' [data-file-card] > button';
  const handle = id => listRow(id) + ' button[aria-label^="拖动排序 "]';
  const overlay = '[data-basket-drag-overlay]';
  const order = () => page.locator(basketList + ' > li[data-sort-item]').evaluateAll(nodes => nodes.map(node => node.dataset.sortItem));
  const basketOrder = async expected => {
    await until('authority and visible basket order ' + expected.join(','), async () =>
      JSON.stringify((await library('get')).basket) === JSON.stringify(expected) &&
      JSON.stringify(await order()) === JSON.stringify(expected));
  };
  const center = async selector => {
    const box = await page.locator(selector).boundingBox();
    assert(box, selector + ' has no bounds');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const dragMouse = async (from, to) => {
    const first = await center(from), last = await center(to);
    if (userAgent.includes('Chrome/89.')) {
      // The current Playwright mouse drag interception command postdates Chrome89.
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...first, button: 'left', buttons: 1, clickCount: 1 });
        for (let step = 1; step <= 12; step++) await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: first.x + (last.x - first.x) * step / 12,
          y: first.y + (last.y - first.y) * step / 12, buttons: 1,
        });
        await wait(css => document.querySelector(css), overlay);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...last, button: 'left', buttons: 0, clickCount: 1 });
      } finally { await cdp.detach(); }
      await wait(css => !document.querySelector(css), overlay);
      await sleep(100);
      return;
    }
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    await page.mouse.move(last.x, last.y, { steps: 12 });
    await wait(css => document.querySelector(css), overlay);
    await page.mouse.up();
    await wait(css => !document.querySelector(css), overlay);
    await sleep(100);
  };
  const keyboardSort = async (selector, direction, finish) => {
    await page.focus(selector);
    await page.keyboard.press('Space');
    await wait(css => document.querySelector(css), overlay);
    await sleep(100);
    await page.keyboard.press(direction);
    await sleep(100);
    await page.keyboard.press(finish);
    await wait(css => !document.querySelector(css), overlay);
    await sleep(100);
  };
  await basketOrder([b,c,a]);
  await wait(css => {
    const rows = Array.from(document.querySelectorAll(css + ' > li'));
    return rows.length === 3 && rows.every(row => {
      const buttons = Array.from(row.querySelectorAll('button')).filter(button => button.getBoundingClientRect().width > 0);
      return buttons.some(button => button.getAttribute('aria-label')?.startsWith('拖动排序 ')) &&
        ['插入', '移除'].every(action => buttons.some(button => button.textContent.trim() === action));
    });
  }, basketList);
  await wait(() => document.getElementById('file-chooser-title')?.closest('[role="dialog"]')?.textContent.includes('使用单选按钮选择一个文件'));
  await screenshot('chooser-list');
  await dragMouse(handle(b), listRow(c));
  await basketOrder([c,b,a]);
  await click('button[aria-label="切换到卡片"]');
  await wait(css => document.querySelectorAll(css + ' [data-file-card]').length === 3 &&
    !document.querySelector(css + ' button[aria-label^="拖动排序 "]'), basketList);
  await click(cardButton(c));
  await wait(() => Array.from(document.querySelectorAll('[role="menuitem"]'))
    .some(item => item.textContent.trim() === '从文件篮移除'));
  assert.equal(await page.locator('input[name="chooser-file"]:checked').count(), 0);
  await page.keyboard.press('Escape');
  await wait(() => !document.querySelector('[role="menuitem"]'));
  await dragMouse(cardButton(c), cardButton(b));
  await basketOrder([b,c,a]);
  const writes = () => page.evaluate(() => fileQA.basketWrites ?? 0);
  const beforeCancel = await writes();
  await keyboardSort(cardButton(b), 'ArrowRight', 'Escape');
  await basketOrder([b,c,a]);
  assert.equal(await writes(), beforeCancel);
  await keyboardSort(cardButton(b), 'ArrowRight', 'Enter');
  await basketOrder([c,b,a]);
  await keyboardSort(cardButton(c), 'ArrowRight', 'Enter');
  await basketOrder([b,c,a]);
  await screenshot('chooser-single');

  const touch = await context.newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const dispatchTouch = (type, point) => touch.send('Input.dispatchTouchEvent', {
    type, touchPoints: point ? [{ ...point, id: 1 }] : [],
  });
  const beforeSwipe = await writes();
  const start = await center(cardButton(c));
  await dispatchTouch('touchStart', start);
  for (let delta = 20; delta <= 120; delta += 20) await dispatchTouch('touchMove', { x: start.x - delta, y: start.y });
  await dispatchTouch('touchEnd');
  await wait(css => document.querySelector(css)?.scrollLeft > 20, basketList);
  assert.equal(await page.locator('[role="menuitem"]').count(), 0);
  assert.equal(await page.locator(overlay).count(), 0);
  await basketOrder([b,c,a]);
  assert.equal(await writes(), beforeSwipe);
  await page.locator(basketList).evaluate(node => { node.scrollLeft = 0; });
  const first = await center(cardButton(b)), target = await center(cardButton(c));
  await dispatchTouch('touchStart', first);
  await wait(css => document.querySelector(css), overlay);
  for (let step = 1; step <= 10; step++) await dispatchTouch('touchMove', {
    x: first.x + (target.x - first.x) * step / 10, y: first.y,
  });
  await dispatchTouch('touchEnd');
  await basketOrder([c,b,a]);
  assert.equal(await writes(), beforeSwipe + 1);
  assert.equal(await page.locator('[role="menuitem"]').count(), 0);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await touch.detach();

  await page.evaluate(() => { fileQA.holdBasket = true; });
  await keyboardSort(cardButton(c), 'ArrowRight', 'Enter');
  await wait(() => !!fileQA.heldBasket);
  const held = await page.evaluate(() => fileQA.heldBasket.params);
  assert.deepEqual(held.ids, [b,c,a]);
  assert.deepEqual(await order(), held.ids);
  await wait(() => document.querySelector('button[aria-label="切换到列表"]')?.disabled);
  const winner = [c,a,b];
  await operation('basket', { ids: winner, expectedRevision: held.expectedRevision });
  await page.evaluate(() => { fileQA.heldBasket.release(); delete fileQA.heldBasket; });
  await basketOrder(winner);
  await wait(() => Array.from(document.querySelectorAll('[role="alert"]'))
    .some(node => node.textContent.includes('文件篮已更新')));
  await screenshot('basket-conflict-rollback');
  await wait(css => document.querySelectorAll(css + ' [data-file-card]').length === 3, basketList);
  await keyboardSort(cardButton(b), 'Home', 'Enter');
  await basketOrder([b,c,a]);
  await log(stage, { anchor, listAndCardOrder: await order(), staleWriteRejected: true });

  stage = 'native-selection';
  const expected = (name, asset) => ({ name, size: asset.size, hash: asset.hash });
  async function select(request, ids, expectedFiles) {
    const prepare = { operationId: randomUUID(), requestId: request.id, entryIds: ids, groupId };
    const { selectionId } = await library('prepare', prepare);
    assert.equal((await library('prepare', prepare)).selectionId, selectionId);
    const count = events.filter(event => event.type === 'selected').length;
    const commit = () => rtc('selection.commit', { requestId: request.id, selectionId });
    const commitReply = await commit();
    assert(['selected', 'validating'].includes(commitReply.state));
    const selected = await until('native FileList callback', () => events.filter(event => event.type === 'selected')[count]);
    assert.deepEqual(selected.files, expectedFiles);
    const finished = await until('durable selection receipt', async () => {
      const result = await library('finish', { selectionId });
      return result.state === 'selected' && result;
    });
    const replay = await raw('selection.commit', { requestId: request.id, selectionId }, { rtc: true, timeout: 2500 });
    assert(replay.timeout || replay.error || ['selected', 'cancelled', 'unknown'].includes(replay.result?.state), JSON.stringify(replay));
    const repeated = await library('finish', { selectionId });
    assert.equal(repeated.state, 'selected');
    assert.deepEqual(repeated.snapshot.basket, finished.snapshot.basket);
    assert.equal(events.filter(event => event.type === 'selected').length, count + 1);
    for (const id of ids) {
      assert(!finished.snapshot.basket.includes(id));
      const entry = finished.snapshot.entries.find(entry => entry.id === id);
      assert(entry.archived && entry.groupId === groupId);
    }
  }
  await expectRejection('library.prepare', { operationId: randomUUID(), requestId: single.id, entryIds: [a,b], groupId });
  await select(single, [a], [expected('中文-字节.txt', assetA)]);
  assert.deepEqual((await library('get')).basket, [b,c]);
  await wait(() => !document.getElementById('file-chooser-title'));
  await tapRemote('later');
  assert.deepEqual((await until('held browser file bytes', () => events.find(event => event.type === 'delayed'))).files,
    [expected('中文-字节.txt', assetA)]);
  const multiple = await chooser('multiple');
  assert.equal(multiple.multiple, true);
  await select(multiple, [b,c], [expected('empty.bin', assetB), expected('third.txt', assetC)]);
  assert.deepEqual((await library('get')).basket, []);
  assert.deepEqual(await identity(), baseline);
  await log(stage, { anchor, files: events.filter(event => event.type === 'selected') });

  stage = 'photo-processing';
  // Encode fixtures with built-in Canvas so the harness has no image-codec dependency.
  async function png(variant) {
    const { width, height } = photoSize;
    const gray = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray[y * width + x] = pixels(x, y, variant);
    const url = await page.evaluate(({ width, height, base64 }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const drawing = canvas.getContext('2d'), image = drawing.createImageData(width, height);
      const gray = atob(base64);
      for (let index = 0; index < gray.length; index++) {
        image.data.fill(gray.charCodeAt(index), index * 4, index * 4 + 3);
        image.data[index * 4 + 3] = 255;
      }
      drawing.putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    }, { width, height, base64: gray.toString('base64') });
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  }
  const originalBytes = await png('page');
  const original = await upload('page.png', 'image/png', originalBytes);
  const second = await upload('vertical.png', 'image/png', await png('vertical'));
  const blank = await upload('blank.png', 'image/png', await png('blank'));
  const ranking = await rtc('photo.rank', { assetIds: [original.assetId, second.assetId] });
  assert([original.assetId, second.assetId].includes(ranking.selectedAssetId));
  assert.equal(typeof ranking.uncertain, 'boolean');
  assert(ranking.candidates.length <= 3);
  const singleRank = await rtc('photo.rank', { assetIds: [original.assetId] });
  assert.equal(singleRank.selectedAssetId, original.assetId);
  assert.equal(singleRank.uncertain, false);
  await expectRejection('photo.process', { requestId: 'library', assetId: blank.assetId, mode: 'rectify' }, { rtc: true });
  const rectify = await rtc('photo.process', { assetId: original.assetId, mode: 'rectify' });
  const scan = await rtc('photo.process', { assetId: original.assetId, mode: 'scan' });
  for (const asset of [rectify, scan]) {
    assert(asset.width > 0 && asset.height > 0);
    assert.notEqual(asset.hash, original.hash);
    assert((await read(asset)).length > 0);
  }
  assert.notEqual(scan.hash, rectify.hash);
  assert.deepEqual(await read(original), originalBytes);
  snapshot = await importAsset(scan, 'scan.jpg', { destination: 'library', originalAssetId: original.assetId, groupId });
  const scanEntry = snapshot.entries.find(entry => entry.assetId === scan.assetId);
  assert(scanEntry.archived && scanEntry.originalAssetId === original.assetId);
  snapshot = await operation('move', { ids: [scanEntry.id], groupId: null });
  assert.equal(snapshot.entries.find(entry => entry.id === scanEntry.id).groupId, null);
  await log(stage, { ranking, singleRank, original, rectify, scan });

  stage = 'continuous-camera-and-chooser-retirement';
  const openCamera = async () => {
    await click('button', '添加文件');
    await click('[role="menuitem"]', '摄像头拍照');
  };
  const hidden = await chooser('hidden');
  await wait(id => {
    const current = fileQA.state.fileRequests.find(request => request.id === id);
    const paper = document.getElementById('file-chooser-title')?.closest('[role="dialog"]');
    return current && !current.anchor && paper && getComputedStyle(paper).position !== 'fixed';
  }, hidden.id);
  await screenshot('chooser-fallback');
  await openCamera();
  const camera = '[role="dialog"].MuiDialog-paperFullScreen';
  await wait(css => {
    const video = document.querySelector(css + ' video');
    if (!(video?.videoWidth > 0)) return false;
    fileQA.cameraTrack = video.srcObject.getVideoTracks()[0];
    return true;
  }, camera);
  const shutter = camera + ' button[aria-label="拍照"]';
  await screenshot('camera');
  await click(shutter);
  await wait(css => Array.from(document.querySelectorAll(css + ' button')).some(button => button.textContent.trim() === '完成（1）'), camera);
  await click(shutter);
  await click(camera + ' button', '完成（2）');
  const review = '[role="dialog"][aria-labelledby="photo-review"]';
  const reviewItems = review + ' ul[aria-label="照片顺序"] > li[data-sort-item]';
  const reviewCard = index => `${reviewItems}:nth-child(${index}) [data-file-card] > button`;
  const reviewIds = () => page.locator(reviewItems).evaluateAll(nodes => nodes.map(node => node.dataset.sortItem));
  await wait(css => document.querySelectorAll(css).length === 2 && fileQA.cameraTrack.readyState === 'ended', reviewItems);
  await click(reviewCard(1));
  await wait(() => document.querySelector('[role="menuitem"]'));
  const candidateCount = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"]'))
    .filter(item => item.textContent.trim() === '查看候选').length);
  assert.equal(candidateCount, 0, 'Identical fake-camera frames should not require choosing candidates');
  const beforeRetake = await reviewIds();
  await click('[role="menuitem"]', '重拍这张');
  await click(camera + ' button[aria-label="取消重拍"]');
  await wait(css => document.querySelectorAll(css).length === 2, reviewItems);
  assert.deepEqual(await reviewIds(), beforeRetake);
  await click(reviewCard(1));
  await click('[role="menuitem"]', '重拍这张');
  await click(shutter);
  await wait(css => !document.querySelector(css), camera);
  assert.deepEqual(await reviewIds(), beforeRetake);
  await keyboardSort(reviewCard(1), 'ArrowRight', 'Enter');
  assert.deepEqual(await reviewIds(), [...beforeRetake].reverse());
  await containedImages(review + ' button[aria-label="查看当前照片大图"] img');
  await screenshot('camera-review');
  await click(reviewCard(1));
  await click('[role="menuitem"]', '移除');
  await click(review + ' button', '继续拍照');
  await click(shutter);
  await click(camera + ' button', '完成（2）');
  await click(review + ' button', '加入文件篮（2）');
  await click('[role="dialog"] button', '确认');
  snapshot = await until('two continuous photos imported', async () => {
    const next = await library('get');
    return next.basket.length === 2 && next;
  });
  assert.deepEqual(await identity(), baseline);
  const prepared = await library('prepare', { operationId: randomUUID(), requestId: hidden.id, entryIds: snapshot.basket.slice(0, 1), groupId: null });
  const remoteTab = (await state()).workspace.windows.find(window => window.id === hidden.windowId).activeTabId;
  await action({ type: 'tab.navigate', tabId: remoteTab, url: fixtureOrigin + '/retired' });
  const retired = await until('prepared chooser retires without consuming basket', async () => {
    const result = await library('finish', prepared);
    return result.state === 'cancelled' && result;
  });
  assert.deepEqual(retired.snapshot.basket, snapshot.basket);
  assert.equal(events.filter(event => event.type === 'selected').length, 2);
  const photos = snapshot.basket.map(id => snapshot.entries.find(entry => entry.id === id));
  await chooser('single');
  await wait(() => document.querySelectorAll('input[name="chooser-file"]').length === 2);
  await wait(css => document.querySelectorAll(css + ' [data-file-card] img').length === 2, basketList);
  await screenshot('chooser-photo-cards');
  const submit = () => page.evaluate(() => Array.from(document.querySelectorAll('button'))
    .find(button => button.textContent.trim() === '使用选中文件')?.disabled);
  assert.equal(await submit(), true);
  await click('[aria-label="文件篮"] li:nth-child(2) input[name="chooser-file"]');
  assert.equal(await submit(), false);
  await click('button', '使用选中文件');
  await click('[role="dialog"] button', '确认');
  const photoSelected = await until('radio choice delivers exactly one photo', () =>
    events.filter(event => event.type === 'selected')[2]);
  const chosenPhoto = await page.evaluate(id => fileQA.sealed.get(id), photos[1].assetId);
  assert(chosenPhoto);
  assert.deepEqual(photoSelected.files, [expected(photos[1].name, chosenPhoto)]);
  await until('radio choice removes only selected photo', async () => {
    const current = await library('get');
    return current.basket.length === 1 && current.basket[0] === photos[0].id;
  });
  await ready();
  await log(stage, { candidateCount, outcome: retired.state, remainingPhotos: 1 });

  stage = 'uncertain-camera-review';
  await page.evaluate(() => { fileQA.alternateCamera = true; });
  await chooser('hidden');
  await openCamera();
  await click(shutter);
  await click(camera + ' button', '完成（1）');
  const canSave = () => page.evaluate(css => Array.from(document.querySelectorAll(css + ' button'))
    .find(button => button.textContent.trim().startsWith('加入文件篮'))?.disabled === false, review);
  await wait(css => document.querySelector(css)?.textContent.includes('待选片'), review);
  assert.equal(await canSave(), false);
  await click(reviewCard(1));
  await click('[role="menuitem"]', '查看候选');
  const comparison = await wait(() => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
      .find(node => node.textContent.includes('比较候选照片') && node.textContent.includes('使用这张'));
    const candidates = Array.from(dialog?.querySelectorAll('[data-file-card] img') ?? []);
    if (candidates.length < 2 || candidates.some(img => img.naturalWidth < 300)) return false;
    return candidates.map(img => ({ width: img.width, height: img.height, sourceWidth: img.naturalWidth }));
  }).then(handle => handle.jsonValue());
  const candidateHero = 'button[aria-label="查看原图"] img';
  await click('[data-file-card] > button[aria-label="候选 1"]');
  await sleep(150);
  const candidateHeroBefore = await page.locator(candidateHero).getAttribute('src');
  await click('[data-file-card] > button[aria-label="候选 2"]');
  await wait(({ css, src }) => {
    const image = document.querySelector(css);
    return image?.complete && image.naturalWidth > 0 && image.src !== src;
  }, { css: candidateHero, src: candidateHeroBefore });
  await containedImages(candidateHero);
  await screenshot('camera-candidate-comparison');
  await click('button[aria-label="查看原图"]');
  const preview = await wait(() => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
      .find(node => Array.from(node.querySelectorAll('button')).some(button => button.textContent.trim() === '返回候选'));
    const photo = dialog?.querySelector('img');
    return photo?.naturalWidth >= 500 && photo.getBoundingClientRect().width > 300 &&
      { displayed: photo.getBoundingClientRect().width, original: photo.naturalWidth };
  }).then(handle => handle.jsonValue());
  await screenshot('camera-candidate-original');
  await click('[role="dialog"] button', '返回候选');
  await click('[role="dialog"] button', '使用这张');
  assert.equal(await canSave(), true);
  await click(review + ' button', '关闭');
  await click('button[aria-label="取消文件选择"]');
  await wait(() => !document.getElementById('file-chooser-title'));
  assert.deepEqual(await identity(), baseline);
  await log(stage, { comparison, preview, resolveCandidate: '使用这张' });

  stage = 'authorization';
  const originalEpoch = await page.evaluate(() => fileQA.peerEpoch);
  const pendingUpload = await rtc('asset.begin', { operationId: randomUUID(), name: 'abandon.txt', size: 3, type: 'text/plain' });
  assert((await call('auth.lock', { reason: 'manual' })).locked);
  await wait(() => document.querySelector('.viewer-lock-blank'));
  await expectRejection('library.get', {});
  const locked = await raw('asset.read', { requestId: 'library', assetId: assetA.assetId, offset: 0 },
    { rtc: true, authEpoch: originalEpoch, timeout: 1500 });
  assert(!locked.unsent && !locked.result, 'Stale RTC peer obtained locked file bytes or could not send the probe');
  assert(!(await call('auth.verify', { method: 'password', secret: password })).locked);
  await ready();
  await until('rotated auth epoch', () => page.evaluate(old => fileQA.peerEpoch !== old, originalEpoch));
  await expectRejection('asset.chunk', { requestId: 'library', uploadId: pendingUpload.uploadId, offset: 0, data: 'YWJj' }, { rtc: true });
  assert.equal((await identity()).peer, baseline.peer);
  assert.deepEqual((await identity()).channels, baseline.channels);
  const disconnectedUpload = await rtc('asset.begin', { operationId: randomUUID(), name: 'disconnect.txt', size: 3, type: 'text/plain' });
  await log(stage, { originalEpoch, lockedReply: locked.timeout ? 'no reply' : 'rejected' });

  stage = 'files-tab-and-reattach';
  const windowId = (await state()).workspace.activeWindowId;
  await click('button[aria-label="更多"]');
  await click('[role="menuitem"]', '我的文件');
  await action({ type: 'tab.files', windowId });
  const files = await until('singleton native files tab', async () => {
    const { tabs, windows } = (await state()).workspace;
    const native = tabs.filter(tab => tab.windowId === windowId && tab.kind === 'files');
    return native.length === 1 && windows.find(window => window.id === windowId).activeTabId === native[0].id && native[0];
  });
  await screenshot('files-tab');
  await until('archived delete confirmation visible', async () => {
    if (await page.evaluate(() => !!document.getElementById('delete-library-file'))) return true;
    const direct = 'button[aria-label="删除 empty.bin"]';
    if (await page.locator(direct).count()) await click(direct);
    else {
      await click('[data-file-card] > button[aria-label="empty.bin"]');
      await click('[role="menuitem"]', '删除文件');
    }
    return false;
  });
  await click('[role="dialog"] button', '删除文件');
  await until('deleted archived file is absent', async () => !(await library('get')).entries.some(entry => entry.id === b));
  const current = await library('get');
  await operation('basket', { ids: [scanEntry.id], expectedRevision: current.revision });
  await page.reload();
  await wait(() => fileQA.auth);
  if (await page.evaluate(() => fileQA.auth.locked)) {
    assert(!(await call('auth.verify', { method: 'password', secret: password })).locked);
  }
  snapshot = await until('persisted basket on fresh Viewer', async () => {
    const reply = await raw('library.get', {});
    return reply.result;
  });
  assert.deepEqual(snapshot.basket, [scanEntry.id]);
  assert.equal(snapshot.groups.find(group => group.id === groupId).name, 'QA receipts');
  await wait(() => fileQA.fileChannel?.readyState === 'open' && fileQA.auth?.peerEpoch > 0);
  const thumb = await wait(({ assetId, name }) => {
    const thumbnail = fileQA.thumbnails.get(assetId);
    const images = Array.from(document.querySelectorAll('img')).filter(img => img.complete && img.naturalWidth > 0 && img.src.startsWith('blob:'));
    const named = images.find(img => img.closest('[data-file-card]')?.querySelector('button')?.getAttribute('aria-label') === name);
    return thumbnail?.assetId && fileQA.imageReads.has(thumbnail.assetId) &&
      (named ?? images.find(img => img.naturalWidth === thumbnail.width && img.naturalHeight === thumbnail.height)) &&
      { width: thumbnail.width, height: thumbnail.height, bytes: thumbnail.size, originalRead: fileQA.imageReads.has(assetId) };
  }, { assetId: scan.assetId, name: scanEntry.name }).then(value => value.jsonValue());
  assert(thumb.width <= 320 && thumb.height <= 320 && thumb.bytes > 0 && !thumb.originalRead);
  await screenshot('files-tab-thumbnail-after-reload');
  await expectRejection('asset.chunk', { requestId: 'library', uploadId: disconnectedUpload.uploadId, offset: 0, data: 'YWJj' }, { rtc: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(() => document.body.textContent.includes('我的文件'));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await containedImages('[data-file-card] img');
  await screenshot('files-tab-narrow');
  await page.setViewportSize({ width: 1152, height: 820 });
  await action({ type: 'tab.navigate', tabId: files.id, url: fixtureOrigin + '/files-converted' });
  await until('files tab converts to remote', async () => (await state()).workspace.tabs.find(tab => tab.id === files.id)?.kind === 'remote');
  await ready();
  await log(stage, { filesTab: files.id, basket: snapshot.basket, thumb });

  stage = 'anchor-visibility-revocation';
  const moving = await chooser('single');
  const visible = await waitForAnchor(moving.id);
  const beforeHide = await page.locator('.remote-viewport').boundingBox();
  await until('remote hides actual input', () => events.some(event => event.type === 'anchor-hidden'));
  await wait(id => {
    const current = fileQA.state.fileRequests.find(request => request.id === id);
    const paper = document.getElementById('file-chooser-title')?.closest('[role="dialog"]');
    return current && !current.anchor && paper && getComputedStyle(paper).position !== 'fixed';
  }, moving.id);
  assert.deepEqual(await page.locator('.remote-viewport').boundingBox(), beforeHide);
  await click('button[aria-label="取消文件选择"]');
  await until('cancel native request after fallback', async () => !(await state()).fileRequests.some(request => request.id === moving.id));
  await log(stage, { visible, contentBounds: beforeHide });
  await log('pass');
} catch (error) {
  process.exitCode = 1;
  const probe = await page?.evaluate(async () => {
    const paper = document.getElementById('file-chooser-title')?.closest('[role="dialog"]');
    const qa = window.fileQA;
    const stats = await qa?.peers[0]?.getStats().catch(() => undefined);
    const inbound = Array.from(stats?.values() ?? []).filter(entry => entry.type === 'inbound-rtp' &&
      (entry.kind ?? entry.mediaType) === 'video').map(entry => ({
      framesDecoded: entry.framesDecoded, keyFramesDecoded: entry.keyFramesDecoded, packetsReceived: entry.packetsReceived,
    }));
    const workspace = qa?.state?.workspace;
    const activeTab = workspace?.tabs.find(tab => workspace.windows.find(window => window.id === workspace.activeWindowId)?.activeTabId === tab.id);
    return { requests: window.fileQA?.state?.fileRequests, position: paper && getComputedStyle(paper).position,
      auth: window.fileQA?.auth && { locked: fileQA.auth.locked, peerEpoch: fileQA.auth.peerEpoch },
      media: window.fileQA?.sample(), viewport: document.querySelector('.remote-viewport')?.className,
      input: document.querySelector('canvas[data-video-input]')?.className, inbound, timeline: qa?.timeline,
      activeTab: activeTab && { id: activeTab.id, webviewId: activeTab.webviewId, restoring: activeTab.restoring,
        residency: activeTab.residency, kind: activeTab.kind },
      dialogs: Array.from(document.querySelectorAll('[role="dialog"]'), dialog => dialog.textContent.slice(0, 600)) };
  }).catch(() => null);
  await log('failure', { stage, error: error.stack, probe });
  await page?.screenshot({ path: join(run, 'failure.png'), timeout: 3000 }).catch(() => {});
} finally {
  clearTimeout(deadline);
  try {
    await context?.close();
  } finally {
    if (control.connected) control.disconnect();
    fixture.closeAllConnections();
    await new Promise(done => fixture.close(done));
    await stopped;
  }
}
