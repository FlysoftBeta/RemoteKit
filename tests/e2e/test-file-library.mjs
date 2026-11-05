/**
 * Isolated production H264/file-library regression.
 * node tests/e2e/test-file-library.mjs <playwright module> <viewer exe> <endpoint exe> <browser exe> <new output dir> [port] [Control server.mjs] [scan fixture directory]
 * REMOTEKIT_QA_ACTIVE_FIXTURE=1 keeps the isolated remote fixture repainting during media-idle investigations.
 */
import assert from 'node:assert/strict';
import { startProductStack, registerViewer } from './product-stack.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [playwright, viewer, endpoint, browser, output, listenPort = '33791', server, scanFixtures] =
  process.argv.slice(2);
assert(
  [playwright, viewer, endpoint, browser, output].every(Boolean),
  'Expected module, three executables and a new output directory',
);
const port = Number(listenPort);
assert(Number.isInteger(port) && port > 1024 && port < 65535);
const root = fileURLToPath(new URL('../../', import.meta.url));
const run = resolve(output);
const origin = 'http://127.0.0.1:' + port;
const fixtureOrigin = 'http://127.0.0.1:' + (port + 1);
const activeFixture = process.env.REMOTEKIT_QA_ACTIVE_FIXTURE === '1';
const basketDialog = '[role="dialog"][aria-label="文件篮"]';
const { chromium } = createRequire(import.meta.url)(resolve(playwright));
await mkdir(run);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
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
    } catch {
      response.writeHead(400).end();
    }
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:16px;font:18px sans-serif}input,button{display:block;margin-bottom:22px;width:290px;height:45px}[hidden]{display:none}</style>
    <input id="single" type="file" accept=".txt"><input id="multiple" type="file" multiple>
    <button id="hidden">Hidden input</button><input id="fallback" type="file" hidden multiple>
    <button id="later">Read held files again</button>
    <script>
      if (${activeFixture}) {
        const marker = document.createElement('canvas');
        marker.width = marker.height = 24;
        marker.style.cssText = 'position:fixed;right:0;bottom:0;pointer-events:none';
        document.body.append(marker);
        const draw = marker.getContext('2d');
        let tick = 0;
        setInterval(() => {
          draw.fillStyle = ++tick % 2 ? '#f03030' : '#2830f0';
          draw.fillRect(0, 0, 24, 24);
        }, 80);
      }
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
const control = startProductStack({
  run,
  port,
  endpoint,
  browser,
  server: server ? resolve(server) : join(root, 'control/dist/server.mjs'),
});
const stopped = new Promise((done) => {
  control.once('exit', done);
  control.once('error', (error) => done(error.message));
});
control.stdout.on('data', (data) => void appendFile(join(run, 'control.stdout.log'), data));
control.stderr.on('data', (data) => void appendFile(join(run, 'control.stderr.log'), data));

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
  const yuv = Buffer.alloc((width * height * 3) / 2, 128);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) yuv[y * width + x] = pixels(x, y, 'page');
  const frame = Buffer.concat([Buffer.from('FRAME\n'), yuv]);
  const path = join(run, 'camera.y4m');
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`),
      ...Array(24).fill(frame),
    ]),
  );
  return path;
}
let context, page;
let stage = 'startup';
const deadline = setTimeout(() => void context?.close().catch(() => {}), 210000);
try {
  await until('fresh production Control', async () => {
    const response = await fetch(origin + '/api/auth/registration', {
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);
    return response?.ok && !(await response.json()).hasAdmin;
  });
  context = await chromium.launchPersistentContext(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer),
    headless: false,
    viewport: { width: 1152, height: 820 },
    timeout: 15000,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-video-capture=' + (await makeCamera()),
    ],
  });
  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => {
    const qa = (window.fileQA = {
      sockets: [],
      peers: [],
      channels: [],
      pending: new Map(),
      sealed: new Map(),
      timeline: [],
      thumbnails: new Map(),
      imageReads: new Set(),
      photoWire: [],
      heldUploads: [],
      cameraTracks: [],
      stillCalls: 0,
    });
    const ids = new WeakMap();
    let nextId = 0;
    const identity = (object) => {
      if (object && !ids.has(object)) ids.set(object, ++nextId);
      return object ? ids.get(object) : null;
    };
    const record = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'state') qa.state = message.state;
      if (message.type === 'auth') {
        qa.auth = message.auth;
        if (message.auth.peerEpoch > 0) qa.peerEpoch = message.auth.peerEpoch;
        qa.note({ type: 'auth', locked: message.auth.locked, peerEpoch: message.auth.peerEpoch });
      }
      if (['layout', 'presentation.prepare', 'frame'].includes(message.type))
        qa.note({
          type: message.type,
          epoch: message.epoch ?? message.layoutEpoch,
          peerEpoch: message.authEpoch,
          keyframe: message.keyframe,
          views: message.views?.length,
        });
      if (message.type === 'files.result') {
        const request = qa.photoWire.find((item) => item.id === message.requestId);
        if (request)
          Object.assign(request, {
            result: message.result,
            error: message.error,
            replied: performance.now(),
          });
        if (
          message.ok &&
          ['photo.burst.begin', 'photo.burst.sample'].includes(request?.method) &&
          qa.advanceCameraFrame
        ) {
          setTimeout(qa.advanceCameraFrame, 80);
        }
        const source = qa.thumbnails.get(message.requestId);
        if (source && message.ok && message.result?.assetId) qa.thumbnails.set(source, message.result);
        if (message.ok && message.result?.assetId && message.result?.hash)
          qa.sealed.set(message.result.assetId, message.result);
        qa.receive(message.requestId, message);
      }
      if (message.id) qa.receive(message.id, message);
    };
    window.WebSocket = class extends WebSocket {
      constructor(...args) {
        super(...args);
        qa.sockets.push(this);
        this.addEventListener('message', record);
      }
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
      constructor(...args) {
        super(...args);
        qa.peers.push(this);
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        qa.channels.push(channel);
        channel.addEventListener('message', record);
        if (channel.label === 'remotekit') qa.fileChannel = channel;
        return channel;
      }
    };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (raw) {
      try {
        const packet = JSON.parse(raw);
        if (packet.method === 'photo.thumbnail') qa.thumbnails.set(packet.requestId, packet.params.assetId);
        if (packet.method === 'asset.read') qa.imageReads.add(packet.params.assetId);
        if (
          packet.method?.startsWith('photo.burst.') ||
          packet.method === 'photo.process' ||
          (packet.method === 'asset.begin' && packet.params.type === 'image/png')
        ) {
          const { data, ...params } = packet.params;
          qa.photoWire.push({
            id: packet.requestId,
            method: packet.method,
            params,
            at: performance.now(),
            ...(data
              ? { jpeg: data.startsWith('/9j/'), bytes: atob(data).length, frame: qa.cameraSnapshotFrame }
              : {}),
          });
          if (packet.method === 'photo.burst.sample') qa.cameraSampleIndex = (qa.cameraSampleIndex ?? 0) + 1;
        }
        if (packet.type === 'media.refresh') qa.note({ type: packet.type, peerEpoch: packet.authEpoch });
        if (packet.authEpoch > 0 && this.label !== 'remotekit-auth') {
          qa.fileChannel = this;
          qa.peerEpoch = packet.authEpoch;
        }
        if (qa.holdPhotoUploads && packet.method === 'asset.begin' && packet.params.type === 'image/png') {
          qa.heldUploads.push(() => send.call(this, raw));
          return;
        }
      } catch {}
      return send.call(this, raw);
    };
    qa.note = (entry) => {
      qa.timeline.push({ at: Math.round(performance.now()), ...entry });
      if (qa.timeline.length > 80) qa.timeline.shift();
    };
    qa.receive = (id, message) => {
      const done = qa.pending.get(id);
      if (done) done(message);
    };
    qa.call = ({ id, method, params, rtc, authEpoch, timeout = 10000 }) =>
      new Promise((resolve) => {
        const channel = rtc ? qa.fileChannel : qa.sockets[qa.sockets.length - 1];
        const done = (message) => {
          clearTimeout(timer);
          qa.pending.delete(id);
          resolve(message);
        };
        const timer = setTimeout(() => done({ timeout: true }), timeout);
        qa.pending.set(id, done);
        const message = rtc
          ? {
              type: 'files.request',
              version: 1,
              requestId: id,
              method,
              params,
              authEpoch: authEpoch ?? qa.peerEpoch,
            }
          : { id, method, params };
        try {
          if (rtc) send.call(channel, JSON.stringify(message));
          else channel.send(JSON.stringify(message));
        } catch (error) {
          done({ error: String(error), unsent: true });
        }
      });
    qa.sample = () => {
      const peer = qa.peers[0];
      const video = document.querySelector('.remote-video-plane video');
      return {
        peer: identity(peer),
        tracks: peer?.getReceivers().map((receiver) => identity(receiver.track)),
        channels: qa.channels.map((channel) => [identity(channel), channel.readyState]),
        video: identity(video),
        stream: identity(video?.srcObject),
        peerCount: qa.peers.length,
        connected: peer?.connectionState,
      };
    };
    qa.action = (action, operationId) =>
      send.call(
        qa.fileChannel,
        JSON.stringify({
          type: 'product.action',
          version: 1,
          authEpoch: qa.peerEpoch,
          operationId,
          operationGeneration: qa.state.operationGeneration,
          action,
        }),
      );
    const devices = navigator.mediaDevices;
    const getUserMedia = devices?.getUserMedia.bind(devices);
    if (getUserMedia)
      devices.getUserMedia = async (constraints) => {
        if (!constraints.video) return getUserMedia(constraints);
        if (qa.cameraFixture === 'denied') throw new DOMException('QA denied camera', 'NotAllowedError');
        if (!qa.cameraFixture) {
          const stream = await getUserMedia(constraints);
          qa.cameraTracks.push(stream.getVideoTracks()[0]);
          return stream;
        }
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const drawing = canvas.getContext('2d');
        let tick = 0;
        const render = () => {
          tick++;
          drawing.fillStyle = tick % 2 ? '#ababab' : '#aaaaaa';
          drawing.fillRect(0, 0, canvas.width, canvas.height);
          if (qa.cameraFixture === 'soft') {
            drawing.filter = 'blur(14px)';
            drawing.fillStyle = '#656565';
            drawing.font = 'bold 40px sans-serif';
            drawing.fillText('Out of focus document', 25, 260);
            drawing.filter = 'none';
            return;
          }
          const alternate = qa.cameraFixture === 'alternate' && (qa.cameraSampleIndex ?? 0) % 2;
          drawing.fillStyle =
            qa.cameraFixture === 'alternate' ? (alternate ? '#ebb85e' : '#c1aeff') : '#c0bcb8';
          drawing.fillRect(70, 34, 500, 412);
          if (qa.cameraFixture === 'alternate') drawing.filter = 'blur(1.4px)';
          drawing.fillStyle =
            qa.cameraFixture === 'alternate' ? (alternate ? '#451300' : '#1f195c') : '#221f1c';
          drawing.font = '24px sans-serif';
          for (let y = 74; y < 430; y += 28) {
            drawing.fillText('RemoteKit photo quality · RemoteKit photo quality', 84, y);
          }
          // Four camera axes distinguish each edge when one axis is cropped.
          // A flat band avoids cross-browser text antialiasing at the side probes.
          drawing.fillStyle = '#a0a0a0';
          drawing.fillRect(0, 222, 640, 36);
          for (const [color, x, y, w, h] of [
            ['#ef2020', 0, 222, 150, 36],
            ['#20e040', 490, 222, 150, 36],
            ['#2040ef', 302, 0, 36, 125],
            ['#efd020', 302, 355, 36, 125],
          ]) {
            drawing.fillStyle = color;
            drawing.fillRect(x, y, w, h);
          }
          drawing.filter = 'none';
        };
        const manual = qa.cameraFixture === 'alternate';
        const stream = canvas.captureStream(manual ? 0 : 60);
        const track = stream.getVideoTracks()[0];
        qa.cameraTracks.push(track);
        const stop = track.stop.bind(track);
        render();
        const timer = manual ? undefined : setInterval(render, 1000 / 60);
        if (manual) {
          qa.advanceCameraFrame = () => {
            render();
            track.requestFrame();
          };
          track.requestFrame();
        }
        track.stop = () => {
          clearInterval(timer);
          if (manual) delete qa.advanceCameraFrame;
          stop();
        };
        return stream;
      };
    if (window.ImageCapture) {
      const takePhoto = ImageCapture.prototype.takePhoto;
      ImageCapture.prototype.takePhoto = function (...args) {
        qa.stillCalls++;
        return takePhoto.apply(this, args);
      };
    }
    const requestVideoFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
    if (requestVideoFrame)
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        return requestVideoFrame.call(this, (now, metadata) => {
          const localCamera = this.closest('[aria-label="摄像头拍照"]');
          if (localCamera)
            qa.cameraPresentedFrame = {
              presentedFrames: metadata.presentedFrames,
              mediaTime: metadata.mediaTime,
            };
          try {
            callback(now, metadata);
          } finally {
            if (localCamera) delete qa.cameraPresentedFrame;
          }
        });
      };
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      if (source instanceof HTMLVideoElement && qa.cameraPresentedFrame)
        qa.cameraSnapshotFrame = qa.cameraPresentedFrame;
      return drawImage.call(this, source, ...args);
    };
  });

  const raw = (method, params, options = {}) =>
    page.evaluate((input) => fileQA.call(input), { id: randomUUID(), method, params, ...options });
  const call = async (method, params, options) => {
    const reply = await raw(method, params, options);
    assert(
      Object.hasOwn(reply, 'result') && !reply.error && reply.ok !== false,
      method + ': ' + JSON.stringify(reply),
    );
    return reply.result;
  };
  const library = (method, params = {}) => call('library.' + method, params);
  const rtc = (method, params = {}) => call(method, { requestId: 'library', ...params }, { rtc: true });
  const state = () => page.evaluate(() => fileQA.state);
  const action = async (intent) => {
    const operationId = randomUUID(),
      operationGeneration = (await state()).operationGeneration;
    await page.evaluate(({ intent, operationId }) => fileQA.action(intent, operationId), {
      intent,
      operationId,
    });
    await until('product action ' + intent.type, async () => {
      const receipt = await call('operation.status', { operationId, operationGeneration });
      assert(!['rejected', 'expired'].includes(receipt.status), JSON.stringify(receipt));
      return receipt.status === 'committed';
    });
  };
  const wait = (probe, arg) => page.waitForFunction(probe, arg, { timeout: 12000 });
  const click = async (css, text) => {
    const handle = await wait(
      ({ css, text }) => {
        const match = Array.from(document.querySelectorAll(css)).find(
          (element) =>
            (text === undefined || element.textContent.trim() === text) &&
            !element.disabled &&
            element.getClientRects().length,
        );
        const box = match?.getBoundingClientRect();
        if (!box?.width) return false;
        const x = box.x + box.width / 2,
          y = box.y + box.height / 2;
        return match.contains(document.elementFromPoint(x, y)) && { x, y };
      },
      { css, text },
    );
    const { x, y } = await handle.jsonValue();
    await page.mouse.click(x, y);
  };
  const bounds = (selector) =>
    page.evaluate((css) => document.querySelector(css)?.getBoundingClientRect().toJSON(), selector);
  const scrollIntoView = (selector) =>
    page.evaluate(
      (css) => document.querySelector(css)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
      selector,
    );
  const isDisabled = (selector) => page.evaluate((css) => !!document.querySelector(css)?.disabled, selector);
  const fill = async (css, value) => {
    await wait((css) => {
      const input = document.querySelector(css);
      return input && !input.disabled && !input.readOnly;
    }, css);
    await page.focus(css);
    await wait((css) => document.activeElement === document.querySelector(css), css);
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(value);
  };
  const ready = () =>
    wait(() => {
      const viewport = document.querySelector('.remote-viewport');
      const video = viewport?.querySelector('.remote-video-plane video');
      return (
        video?.videoWidth > 0 &&
        !viewport.classList.contains('resize-waiting') &&
        !viewport.querySelector('canvas[data-video-input]')?.classList.contains('no-frame')
      );
    });
  const tapRemote = async (id) => {
    await ready();
    const local = await bounds('.remote-viewport');
    const geometry = await until('current remote fixture geometry', async () => {
      const path = await page.locator('.address-form input').inputValue();
      if (!path.startsWith(fixtureOrigin)) return null;
      return events.findLast(
        (event) =>
          event.type === 'geometry' &&
          Math.abs(event.width - local.width) <= 1 &&
          event.path === new URL(path).pathname,
      );
    });
    const { x, y, width, height } = geometry.boxes[id];
    await page.mouse.click(
      local.x + ((x + width / 2) * local.width) / geometry.width,
      local.y + ((y + height / 2) * local.height) / geometry.height,
    );
  };
  const chooser = async (id) => {
    await wait((css) => !document.querySelector(css) && !fileQA.state.fileRequests.length, basketDialog);
    await tapRemote(id);
    return until('native chooser ' + id, async () =>
      (await state())?.fileRequests.find((request) => request.state === 'pending'),
    );
  };
  const identity = () => page.evaluate(() => fileQA.sample());
  const screenshot = async (name) => {
    await sleep(300);
    await page.screenshot({ path: join(run, name + '.png') });
  };
  const containedImages = (selector) =>
    wait((css) => {
      const images = Array.from(document.querySelectorAll(css));
      if (!images.length) return false;
      return images.every((image) => {
        const outer = image.parentElement.getBoundingClientRect(),
          inner = image.getBoundingClientRect();
        return (
          image.complete &&
          image.naturalWidth > 0 &&
          getComputedStyle(image).objectFit === 'contain' &&
          inner.width > 0 &&
          inner.height > 0 &&
          inner.left >= outer.left - 1 &&
          inner.right <= outer.right + 1 &&
          inner.top >= outer.top - 1 &&
          inner.bottom <= outer.bottom + 1
        );
      });
    }, selector);
  const waitForAnchor = (requestId) =>
    wait(
      ({ id, css }) => {
        const current = fileQA.state.fileRequests.find((request) => request.id === id);
        const paper = document.querySelector(css);
        return current?.anchor && paper && getComputedStyle(paper).position === 'fixed' && current.anchor;
      },
      { id: requestId, css: basketDialog },
    ).then((handle) => handle.jsonValue());

  await page.goto(origin, { timeout: 12000 });
  await wait(() => document.querySelector('.viewer-lock-blank'));
  await until('authentication gate ready', async () => {
    for (const key of [
      'ArrowUp',
      'ArrowUp',
      'ArrowDown',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowLeft',
      'ArrowRight',
    ])
      await page.keyboard.press(key);
    await sleep(300);
    return page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent.trim() === '创建账户',
      ),
    );
  });
  const password = randomUUID();
  await registerViewer({ click, fill, username: 'file-library-qa', password: password });
  await click('button', '新建窗口');
  await fill('.address-form input', fixtureOrigin);
  await page.keyboard.press('Enter');
  await ready();
  await wait(() => fileQA.fileChannel?.readyState === 'open' && fileQA.auth?.peerEpoch > 0);
  await call('auth.settings', {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  const baseline = await identity();
  assert.equal(baseline.connected, 'connected');
  const codec = await until('received H264 frames', () =>
    page.evaluate(async () => {
      const stats = await fileQA.peers[0].getStats();
      const video = Array.from(stats.values()).find(
        (entry) =>
          entry.type === 'inbound-rtp' &&
          (entry.kind ?? entry.mediaType) === 'video' &&
          entry.framesDecoded > 0,
      );
      const mime = video && stats.get(video.codecId)?.mimeType;
      return /video\/h264/i.test(mime ?? '') ? mime : null;
    }),
  );
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await log(stage, { browser: userAgent, codec, baseline });

  async function upload(name, type, bytes, operationId = randomUUID()) {
    const begin = { operationId, name, type, size: bytes.length };
    const { uploadId, offset } = await rtc('asset.begin', begin);
    assert.deepEqual(await rtc('asset.begin', begin), { uploadId, offset });
    assert.equal(offset, 0);
    for (let position = 0; position < bytes.length;) {
      const chunk = bytes.subarray(position, position + 16384);
      assert.equal(
        (await rtc('asset.chunk', { uploadId, offset: position, data: chunk.toString('base64') })).offset,
        position + chunk.length,
      );
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
  const importAsset = (asset, name, params = {}) =>
    operation('import', {
      assetId: asset.assetId,
      name,
      destination: 'basket',
      groupId: null,
      ...params,
    });
  const expectRejection = async (method, params, options) => {
    const reply = await raw(method, params, options);
    assert(
      reply.error || reply.ok === false,
      'Expected rejection for ' + method + ': ' + JSON.stringify(reply),
    );
  };

  stage = 'rtc-assets-and-basket';
  const bytes = Buffer.alloc(37019);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 29 + (index >> 8)) & 255;
  const assetA = await upload('中文-字节.txt', 'text/plain', bytes);
  assert.deepEqual(await read(assetA), bytes);
  const assetB = await upload('empty.bin', 'application/octet-stream', Buffer.alloc(0));
  const assetC = await upload('third.txt', 'text/plain', Buffer.from('third\n'));
  let snapshot = await operation('group', { name: 'QA incoming' });
  const { id: groupId } = snapshot.groups.find((group) => group.name === 'QA incoming');
  snapshot = await operation('group', { id: groupId, name: 'QA receipts' });
  assert(snapshot.groups.some((group) => group.id === groupId && group.name === 'QA receipts'));
  const importA = {
    operationId: randomUUID(),
    assetId: assetA.assetId,
    name: '中文-字节.txt',
    destination: 'basket',
    groupId: null,
  };
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
  await expectRejection('library.basket', {
    operationId: randomUUID(),
    ids: [a, a],
    expectedRevision: snapshot.revision,
  });
  await expectRejection('library.basket', {
    operationId: randomUUID(),
    ids: [a],
    expectedRevision: preReorderRevision,
  });
  assert.deepEqual((await library('get')).basket, [b, c, a]);
  assert(snapshot.entries.filter((entry) => [a, b, c].includes(entry.id)).every((entry) => !entry.archived));
  await log(stage, { hashes: [assetA.hash, assetB.hash, assetC.hash], order: snapshot.basket });

  stage = 'basket-list-cards-and-order';
  const single = await chooser('single');
  assert.equal(single.multiple, false);
  const anchor = await waitForAnchor(single.id);
  assert(anchor.instance && anchor.document && anchor.layoutGeneration);
  assert(anchor.width > 0 && anchor.height > 0 && anchor.x + anchor.width <= anchor.viewportWidth);
  const basketList = 'ul[aria-label="文件篮项目"]';
  const listRow = (id) => `${basketList} > li[data-sort-item="${id}"]`;
  const cardButton = (id) => listRow(id) + ' [data-file-card] > button';
  const handle = (id) => listRow(id) + ' button[aria-label^="拖动排序 "]';
  const overlay = '[data-basket-drag-overlay]';
  const order = () =>
    page
      .locator(basketList + ' > li[data-sort-item]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.sortItem));
  const basketOrder = async (expected) => {
    await until(
      'authority and visible basket order ' + expected.join(','),
      async () =>
        JSON.stringify((await library('get')).basket) === JSON.stringify(expected) &&
        JSON.stringify(await order()) === JSON.stringify(expected),
    );
  };
  const center = async (selector) => {
    const box = await bounds(selector);
    assert(box, selector + ' has no bounds');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const dragMouse = async (from, to) => {
    const first = await center(from),
      last = await center(to);
    if (userAgent.includes('Chrome/89.')) {
      // The current Playwright mouse drag interception command postdates Chrome89.
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...first,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        for (let step = 1; step <= 12; step++)
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: first.x + ((last.x - first.x) * step) / 12,
            y: first.y + ((last.y - first.y) * step) / 12,
            buttons: 1,
          });
        await wait((css) => document.querySelector(css), overlay);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...last,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
      } finally {
        await cdp.detach();
      }
      await wait((css) => !document.querySelector(css), overlay);
      await sleep(100);
      return;
    }
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    await page.mouse.move(last.x, last.y, { steps: 12 });
    await wait((css) => document.querySelector(css), overlay);
    await page.mouse.up();
    await wait((css) => !document.querySelector(css), overlay);
    await sleep(100);
  };
  const keyboardSort = async (selector, direction, finish) => {
    await page.focus(selector);
    await page.keyboard.press('Space');
    await wait((css) => document.querySelector(css), overlay);
    await sleep(100);
    await page.keyboard.press(direction);
    await sleep(100);
    await page.keyboard.press(finish);
    await wait((css) => !document.querySelector(css), overlay);
    await sleep(100);
  };
  await basketOrder([b, c, a]);
  await wait((css) => {
    const rows = Array.from(document.querySelectorAll(css + ' > li'));
    return (
      rows.length === 3 &&
      rows.every((row) => {
        const buttons = Array.from(row.querySelectorAll('button')).filter(
          (button) => button.getBoundingClientRect().width > 0,
        );
        return (
          buttons.some((button) => button.getAttribute('aria-label')?.startsWith('拖动排序 ')) &&
          ['插入', '移除'].every((action) =>
            buttons.some((button) => button.getAttribute('aria-label') === action),
          )
        );
      })
    );
  }, basketList);
  await screenshot('chooser-list');
  await dragMouse(handle(b), listRow(c));
  await basketOrder([c, b, a]);
  const more = basketDialog + ' button[aria-label="更多"]';
  await click(more);
  await wait(
    (css) => document.querySelector(css)?.textContent.includes('使用单选按钮选择一个文件'),
    basketDialog,
  );
  await click('button[aria-label="切换到卡片"]');
  await click(more);
  await wait(
    (css) =>
      document.querySelectorAll(css + ' [data-file-card]').length === 3 &&
      !document.querySelector(css + ' button[aria-label^="拖动排序 "]'),
    basketList,
  );
  await click(cardButton(c));
  await wait(() =>
    [...document.querySelectorAll('button')].some((item) => item.textContent.trim() === '从文件篮移除'),
  );
  assert.equal(await page.locator('input[name="chooser-file"]:checked').count(), 0);
  await page.keyboard.press('Escape');
  await wait(() => !document.querySelector('button[aria-label="收起项目"]'));
  await dragMouse(cardButton(c), cardButton(b));
  await basketOrder([b, c, a]);
  const writes = () => page.evaluate(() => fileQA.basketWrites ?? 0);
  const beforeCancel = await writes();
  await keyboardSort(cardButton(b), 'ArrowRight', 'Escape');
  await basketOrder([b, c, a]);
  assert.equal(await writes(), beforeCancel);
  await keyboardSort(cardButton(b), 'ArrowRight', 'Enter');
  await basketOrder([c, b, a]);
  await keyboardSort(cardButton(c), 'ArrowRight', 'Enter');
  await basketOrder([b, c, a]);
  await screenshot('chooser-single');

  await page.setViewportSize({ width: 320, height: 568 });
  await wait((css) => {
    const strip = document.querySelector(css);
    return strip && strip.scrollWidth - strip.clientWidth > 25;
  }, basketList);
  const touch = await context.newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const dispatchTouch = (type, point) =>
    touch.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: point ? [{ ...point, id: 1 }] : [],
    });
  const beforeSwipe = await writes();
  const start = await center(cardButton(c));
  // Send the short swipe as one ordered CDP burst so debugger round trips on
  // old Chromium cannot turn the gesture into the 200 ms drag hold.
  await Promise.all([
    dispatchTouch('touchStart', start),
    ...[20, 40, 60, 80, 100, 120].map((delta) =>
      dispatchTouch('touchMove', { x: start.x - delta, y: start.y }),
    ),
    dispatchTouch('touchEnd'),
  ]);
  await wait((css) => document.querySelector(css)?.scrollLeft > 20, basketList);
  assert.equal(await page.locator('button[aria-label="收起项目"]').count(), 0);
  assert.equal(await page.locator(overlay).count(), 0);
  await basketOrder([b, c, a]);
  assert.equal(await writes(), beforeSwipe);
  await page.evaluate((css) => {
    document.querySelector(css).scrollLeft = 0;
  }, basketList);
  const first = await center(cardButton(b)),
    target = await center(cardButton(c));
  await dispatchTouch('touchStart', first);
  await wait((css) => document.querySelector(css), overlay);
  for (let step = 1; step <= 10; step++)
    await dispatchTouch('touchMove', {
      x: first.x + ((target.x - first.x) * step) / 10,
      y: first.y,
    });
  await dispatchTouch('touchEnd');
  await basketOrder([c, b, a]);
  assert.equal(await writes(), beforeSwipe + 1);
  assert.equal(await page.locator('button[aria-label="收起项目"]').count(), 0);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await touch.detach();
  await page.setViewportSize({ width: 1152, height: 820 });
  await ready();
  await sleep(250);

  await page.evaluate(() => {
    fileQA.holdBasket = true;
  });
  await keyboardSort(cardButton(c), 'ArrowRight', 'Enter');
  await wait(() => !!fileQA.heldBasket);
  const held = await page.evaluate(() => fileQA.heldBasket.params);
  assert.deepEqual(held.ids, [b, c, a]);
  assert.deepEqual(await order(), held.ids);
  await click(more);
  await wait(() => document.querySelector('button[aria-label="切换到列表"]')?.disabled);
  const winner = [c, a, b];
  await operation('basket', { ids: winner, expectedRevision: held.expectedRevision });
  await page.evaluate(() => {
    fileQA.heldBasket.release();
    delete fileQA.heldBasket;
  });
  await basketOrder(winner);
  await wait(() =>
    Array.from(document.querySelectorAll('[role="alert"]')).some((node) =>
      node.textContent.includes('状态已改变，请核对后重试'),
    ),
  );
  await screenshot('basket-conflict-rollback');
  await click(more);
  await wait((css) => document.querySelectorAll(css + ' [data-file-card]').length === 3, basketList);
  await keyboardSort(cardButton(b), 'Home', 'Enter');
  await basketOrder([b, c, a]);
  await log(stage, { anchor, listAndCardOrder: await order(), staleWriteRejected: true });

  stage = 'native-selection';
  const expected = (name, asset) => ({ name, size: asset.size, hash: asset.hash });
  async function select(request, ids, expectedFiles) {
    const prepare = { operationId: randomUUID(), requestId: request.id, entryIds: ids, groupId };
    const { selectionId } = await library('prepare', prepare);
    assert.equal((await library('prepare', prepare)).selectionId, selectionId);
    const count = events.filter((event) => event.type === 'selected').length;
    const commit = () => rtc('selection.commit', { requestId: request.id, selectionId });
    const commitReply = await commit();
    assert(['selected', 'validating'].includes(commitReply.state));
    const selected = await until(
      'native FileList callback',
      () => events.filter((event) => event.type === 'selected')[count],
    );
    assert.deepEqual(selected.files, expectedFiles);
    const finished = await until('durable selection receipt', async () => {
      const result = await library('finish', { selectionId });
      return result.state === 'selected' && result;
    });
    const replay = await raw(
      'selection.commit',
      { requestId: request.id, selectionId },
      { rtc: true, timeout: 2500 },
    );
    assert(
      replay.timeout || replay.error || ['selected', 'cancelled', 'unknown'].includes(replay.result?.state),
      JSON.stringify(replay),
    );
    const repeated = await library('finish', { selectionId });
    assert.equal(repeated.state, 'selected');
    assert.deepEqual(repeated.snapshot.basket, finished.snapshot.basket);
    assert.equal(events.filter((event) => event.type === 'selected').length, count + 1);
    for (const id of ids) {
      assert(!finished.snapshot.basket.includes(id));
      const entry = finished.snapshot.entries.find((entry) => entry.id === id);
      assert(entry.archived && entry.groupId === groupId);
    }
  }
  await expectRejection('library.prepare', {
    operationId: randomUUID(),
    requestId: single.id,
    entryIds: [a, b],
    groupId,
  });
  await select(single, [a], [expected('中文-字节.txt', assetA)]);
  assert.deepEqual((await library('get')).basket, [b, c]);
  await wait((css) => !document.querySelector(css), basketDialog);
  await tapRemote('later');
  assert.deepEqual(
    (await until('held browser file bytes', () => events.find((event) => event.type === 'delayed'))).files,
    [expected('中文-字节.txt', assetA)],
  );
  const multiple = await chooser('multiple');
  assert.equal(multiple.multiple, true);
  await select(multiple, [b, c], [expected('empty.bin', assetB), expected('third.txt', assetC)]);
  assert.deepEqual((await library('get')).basket, []);
  assert.deepEqual(await identity(), baseline);
  await log(stage, { anchor, files: events.filter((event) => event.type === 'selected') });

  stage = 'photo-processing';
  // Encode fixtures with built-in Canvas so the harness has no image-codec dependency.
  async function png(variant) {
    const { width, height } = photoSize;
    const gray = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) gray[y * width + x] = pixels(x, y, variant);
    const url = await page.evaluate(
      ({ width, height, base64 }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const drawing = canvas.getContext('2d'),
          image = drawing.createImageData(width, height);
        const gray = atob(base64);
        for (let index = 0; index < gray.length; index++) {
          image.data.fill(gray.charCodeAt(index), index * 4, index * 4 + 3);
          image.data[index * 4 + 3] = 255;
        }
        drawing.putImageData(image, 0, 0);
        return canvas.toDataURL('image/png');
      },
      { width, height, base64: gray.toString('base64') },
    );
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
  await expectRejection(
    'photo.process',
    { requestId: 'library', assetId: blank.assetId, mode: 'rectify' },
    { rtc: true },
  );
  const rectify = await rtc('photo.process', { assetId: original.assetId, mode: 'rectify' });
  const scan = await rtc('photo.process', { assetId: original.assetId, mode: 'scan' });
  for (const asset of [rectify, scan]) {
    assert(asset.width > 0 && asset.height > 0);
    assert.equal(asset.type, 'image/png');
    assert.notEqual(asset.hash, original.hash);
    assert.equal((await read(asset)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.notEqual(scan.hash, rectify.hash);
  assert.deepEqual(await read(original), originalBytes);
  snapshot = await importAsset(scan, 'scan.png', {
    destination: 'library',
    originalAssetId: original.assetId,
    groupId,
  });
  const scanEntry = snapshot.entries.find((entry) => entry.assetId === scan.assetId);
  assert(scanEntry.archived && scanEntry.originalAssetId === original.assetId);
  snapshot = await operation('move', { ids: [scanEntry.id], groupId: null });
  assert.equal(snapshot.entries.find((entry) => entry.id === scanEntry.id).groupId, null);
  await log(stage, { ranking, singleRank, original, rectify, scan });

  stage = 'camera-color-scan-stamp';
  const stampedData = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 700;
    const ink = canvas.getContext('2d');
    const light = ink.createLinearGradient(0, 0, canvas.width, 180);
    light.addColorStop(0, '#85807b');
    light.addColorStop(0.7, '#ece8e2');
    light.addColorStop(1, '#f0ede5');
    ink.fillStyle = light;
    ink.fillRect(0, 0, canvas.width, canvas.height);
    ink.fillStyle = '#263d71';
    ink.font = '24px sans-serif';
    for (let y = 30; y < 700; y += 38) ink.fillText('EDGE / Blue ink / partial-page record', -6, y);
    ink.fillStyle = '#9f988f';
    ink.font = 'italic 22px serif';
    ink.fillText('faint pencilled note', 240, 602);
    ink.strokeStyle = ink.fillStyle = '#a02d38';
    ink.lineWidth = 6;
    ink.beginPath();
    ink.arc(732, 380, 80, 0, Math.PI * 2);
    ink.stroke();
    ink.font = 'bold 30px sans-serif';
    ink.fillText('STAMP', 678, 390);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const stampedBytes = Buffer.from(stampedData, 'base64');
  const stamped = await upload('color-partial.png', 'image/png', stampedBytes);
  const stampedScan = await rtc('photo.process', { assetId: stamped.assetId, mode: 'scan' });
  assert.equal(stampedScan.geometry, 'unchanged');
  assert.deepEqual([stampedScan.width, stampedScan.height], [1000, 700]);
  const stampedOutput = await read(stampedScan);
  const stampRgb = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + encoded;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const draw = canvas.getContext('2d');
    draw.drawImage(image, 0, 0);
    return [...draw.getImageData(732, 300, 1, 1).data.slice(0, 3)];
  }, stampedOutput.toString('base64'));
  assert(stampRgb[0] - stampRgb[1] > 50, JSON.stringify(stampRgb));
  await writeFile(join(run, 'color-partial-input.png'), stampedBytes);
  await writeFile(join(run, 'color-partial-scan.png'), stampedOutput);
  await log(stage, { stampRgb, geometry: stampedScan.geometry });

  stage = 'camera-cover-and-sampling';
  const camera = '[role="dialog"][aria-label="摄像头拍照"]';
  const shutter = camera + ' button[aria-label="拍照"]';
  const scanMode = camera + ' button[aria-pressed][value="scan"]';
  const photoMode = camera + ' button[aria-pressed][value="photo"]';
  const cameraFixture = (name) =>
    page.evaluate((name) => {
      fileQA.cameraFixture = name;
    }, name);
  const basketSend = basketDialog + ' button[aria-label="发送"]';
  const basketAdd = basketDialog + ' button[aria-label="添加文件"]';
  const openCamera = async () => {
    await click(basketAdd);
    await click(basketDialog + ' button', '摄像头拍照');
    if ((await page.evaluate(() => fileQA.cameraFixture)) !== 'denied')
      await wait((css) => !document.querySelector(css)?.disabled && document.querySelector(css), shutter);
  };
  const cameraReturn = () => click(camera + ' button[aria-label^="返回文件篮，"]');
  const assertCameraLayout = async (width, height, safe = {}) => {
    const actual = await page.evaluate(
      ({ camera, shutter }) => {
        const dialog = document.querySelector(camera);
        const video = dialog.querySelector('video');
        const button = document.querySelector(shutter);
        return {
          view: [innerWidth, innerHeight],
          dialog: dialog.getBoundingClientRect().toJSON(),
          video: video.getBoundingClientRect().toJSON(),
          cover: getComputedStyle(video).objectFit,
          position: getComputedStyle(video).objectPosition,
          shutter: button.getBoundingClientRect().toJSON(),
        };
      },
      { camera, shutter },
    );
    for (const bounds of [actual.dialog, actual.video]) {
      assert.equal(bounds.x, 0);
      assert.equal(bounds.y, 0);
      assert.equal(bounds.width, width);
      assert.equal(bounds.height, height);
    }
    assert.equal(actual.cover, 'cover');
    assert.equal(actual.position, '50% 50%');
    const button = actual.shutter;
    if (width > height) {
      assert.equal(button.y + button.height / 2, height / 2);
      assert.equal(width - button.right, 18 + (safe.right ?? 0));
    } else {
      assert.equal(button.x + button.width / 2, width / 2);
      assert.equal(height - button.bottom, 18 + (safe.bottom ?? 0));
    }
    return actual;
  };
  const take = async () => {
    const start = await page.evaluate((css) => {
      const button = document.querySelector(css);
      fileQA.samplingEndedAt = undefined;
      button.addEventListener(
        'click',
        () => {
          fileQA.shutterAt = performance.now();
        },
        { capture: true, once: true },
      );
      return fileQA.photoWire.length;
    }, shutter);
    await click(shutter);
    return start;
  };
  const sampleTrace = async (start) => {
    await wait(
      (start) =>
        fileQA.photoWire.slice(start).some((event) => event.method === 'photo.burst.end' && event.result),
      start,
    );
    const trace = await page.evaluate((start) => {
      const tail = fileQA.photoWire.slice(start);
      const end = tail.find((event) => event.method === 'photo.burst.end');
      return {
        begin: tail.find((event) => event.method === 'photo.burst.begin'),
        end,
        samples: tail.filter(
          (event) => event.method === 'photo.burst.sample' && event.params.burstId === end.params.burstId,
        ),
        samplingMs: fileQA.samplingEndedAt - fileQA.shutterAt,
        stillCalls: fileQA.stillCalls,
      };
    }, start);
    assert(trace.samples.length > 0 && trace.samples.length <= 20);
    assert.equal(new Set(trace.samples.map((sample) => sample.params.frameId)).size, trace.samples.length);
    assert(trace.samples.every((sample) => sample.jpeg && sample.bytes <= 44 * 1024));
    const presented = trace.samples.map((sample) => sample.frame);
    assert(
      presented.every(
        (frame, index) =>
          frame &&
          (!index ||
            (frame.presentedFrames > presented[index - 1].presentedFrames &&
              frame.mediaTime > presented[index - 1].mediaTime)),
      ),
      JSON.stringify(presented),
    );
    assert.equal(trace.stillCalls, 0);
    return trace;
  };
  const waitForPhoto = (length) =>
    until('persisted camera photo count ' + length, async () => {
      const current = await library('get');
      return current.basket.length === length && current;
    });
  const assetOf = (id) => page.evaluate((id) => fileQA.sealed.get(id), id);
  const assertCrop = async (asset, width, height, fixture) => {
    assert.equal(asset.type, 'image/png');
    const bytes = await read(asset);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const outputWidth = bytes.readUInt32BE(16);
    const outputHeight = bytes.readUInt32BE(20);
    const scale = Math.max(width / fixture.width, height / fixture.height);
    const croppedWidth = Math.floor(width / scale + 1e-8);
    const croppedHeight = Math.floor(height / scale + 1e-8);
    assert(Math.abs(outputWidth - croppedWidth) <= 1);
    assert(Math.abs(outputHeight - croppedHeight) <= 1);
    const compared = await page.evaluate(
      async ({ png, width, height, outputWidth, outputHeight, fixture }) => {
        const image = new Image();
        image.src = 'data:image/png;base64,' + png;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = outputWidth;
        canvas.height = outputHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const photo = context.getImageData(0, 0, outputWidth, outputHeight);
        const scale = Math.max(width / fixture.width, height / fixture.height);
        const left = (fixture.width - width / scale) / 2;
        const top = (fixture.height - height / scale) / 2;
        return [
          [0.05, 0.5],
          [0.95, 0.5],
          [0.5, 0.05],
          [0.5, 0.95],
        ].map(([x, y]) => {
          const px = Math.floor(x * outputWidth),
            py = Math.floor(y * outputHeight);
          const sx = Math.round(left + px),
            sy = Math.round(top + py);
          const index = (sx + sy * fixture.width) * 4;
          return {
            x,
            y,
            sx,
            sy,
            expected: fixture.probes[String(index)],
            actual: [...photo.data.slice((px + py * outputWidth) * 4, (px + py * outputWidth) * 4 + 3)],
          };
        });
      },
      { png: bytes.toString('base64'), width, height, outputWidth, outputHeight, fixture },
    );
    for (const sample of compared) {
      assert(
        sample.expected &&
          sample.actual.every((value, index) => Math.abs(value - sample.expected[index]) <= 20),
        JSON.stringify(sample),
      );
    }
    await writeFile(join(run, 'captured-' + width + 'x' + height + '.png'), bytes);
    return compared;
  };
  const cropFixture = (width, height) =>
    page.evaluate(
      ({ width, height, camera }) => {
        // Sample the local camera video, after browser color conversion, independently of the application capture.
        const video = document.querySelector(camera + ' video');
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0);
        const source = context.getImageData(0, 0, canvas.width, canvas.height);
        const scale = Math.max(width / source.width, height / source.height);
        const left = (source.width - width / scale) / 2;
        const top = (source.height - height / scale) / 2;
        const probes = {};
        for (const [x, y] of [
          [0.05, 0.5],
          [0.95, 0.5],
          [0.5, 0.05],
          [0.5, 0.95],
        ]) {
          const px = Math.floor(x * Math.floor(width / scale + 1e-8));
          const py = Math.floor(y * Math.floor(height / scale + 1e-8));
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const index = (Math.round(left + px) + dx + (Math.round(top + py) + dy) * source.width) * 4;
              probes[String(index)] = [...source.data.slice(index, index + 3)];
            }
        }
        return { width: source.width, height: source.height, probes };
      },
      { width, height, camera },
    );
  const watchSampling = () =>
    page.evaluate((css) => {
      const shutter = document.querySelector(css);
      fileQA.samplingEndedAt = undefined;
      let disabled = false;
      const observer = new MutationObserver(() => {
        if (shutter.disabled) disabled = true;
        else if (disabled) {
          fileQA.samplingEndedAt = performance.now();
          observer.disconnect();
        }
      });
      observer.observe(shutter, { attributes: true, attributeFilter: ['disabled'] });
    }, shutter);
  const hidden = await chooser('hidden');
  assert.equal(hidden.multiple, true);
  await wait(
    (id) => fileQA.state.fileRequests.some((request) => request.id === id && !request.anchor),
    hidden.id,
  );
  await cameraFixture('markers');
  await openCamera();
  if (userAgent.includes('Chrome/157.')) {
    stage = 'camera-android-tablet-simulation';
    const tablet = await context.newCDPSession(page);
    await tablet.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const tap = async (selector) => {
      const { x, y } = await center(selector);
      await tablet.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await tablet.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const tabletLayouts = [];
    try {
      for (const [width, height] of [
        [1280, 800],
        [800, 1280],
        [1024, 768],
      ]) {
        await tablet.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 2,
          mobile: false,
          screenOrientation: {
            type: width > height ? 'landscapePrimary' : 'portraitPrimary',
            angle: width > height ? 90 : 0,
          },
        });
        await wait(
          ({ camera, width, height }) => {
            const bounds = document.querySelector(camera)?.getBoundingClientRect();
            return devicePixelRatio === 2 && bounds?.width === width && bounds.height === height;
          },
          { camera, width, height },
        );
        await tap(scanMode);
        assert.equal(await page.locator(scanMode).getAttribute('aria-pressed'), 'true');
        await tap(photoMode);
        assert.equal(await page.locator(photoMode).getAttribute('aria-pressed'), 'true');
        const layout = await assertCameraLayout(width, height);
        // Playwright's screenshot helper restores its configured viewport.
        // Capture through the same CDP session that owns the tablet metrics.
        const png = await tablet.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        });
        const screen = Buffer.from(png.data, 'base64');
        assert.deepEqual([screen.readUInt32BE(16), screen.readUInt32BE(20)], [width * 2, height * 2]);
        await writeFile(join(run, 'camera-tablet-' + width + 'x' + height + '.png'), screen);
        tabletLayouts.push({ ...layout, dpr: 2 });
      }
      const wireStart = await page.evaluate(() => fileQA.photoWire.length);
      await tap(shutter);
      await sampleTrace(wireStart);
      const tabletPhoto = await waitForPhoto(1);
      await cameraReturn();
      await operation('basket', { ids: [], expectedRevision: tabletPhoto.revision });
      await openCamera();
    } finally {
      await tablet.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await tablet.send('Emulation.clearDeviceMetricsOverride');
      await tablet.detach();
    }
    await log(stage, tabletLayouts);
    stage = 'camera-cover-and-sampling';
  }
  const layouts = [];
  for (const [width, height] of [
    [390, 844],
    [844, 390],
    [320, 568],
    [568, 320],
    [1280, 720],
  ]) {
    await page.setViewportSize({ width, height });
    await wait(
      ({ camera, width, height }) => {
        const bounds = document.querySelector(camera)?.getBoundingClientRect();
        return bounds?.width === width && bounds.height === height;
      },
      { camera, width, height },
    );
    layouts.push(await assertCameraLayout(width, height));
    await screenshot('camera-' + width + 'x' + height);
  }
  const safe = { left: 32, right: 38, bottom: 24, top: 18 };
  await page.evaluate((safe) => {
    for (const [side, pixels] of Object.entries(safe))
      document.documentElement.style.setProperty('--remotekit-safe-area-' + side, pixels + 'px');
  }, safe);
  for (const [width, height] of [
    [320, 568],
    [568, 320],
  ]) {
    await page.setViewportSize({ width, height });
    await wait(
      ({ camera, width, height }) => {
        const bounds = document.querySelector(camera)?.getBoundingClientRect();
        return bounds?.width === width && bounds.height === height;
      },
      { camera, width, height },
    );
    const actual = await assertCameraLayout(width, height, safe);
    const back = await bounds(camera + ' button[aria-label="返回"]');
    assert.equal(back.x, safe.left + 8);
    assert.equal(back.y, safe.top + 8);
    await screenshot('camera-safe-' + width + 'x' + height);
    layouts.push({ ...actual, safe, back });
  }
  await page.evaluate((safe) => {
    for (const side of Object.keys(safe))
      document.documentElement.style.removeProperty('--remotekit-safe-area-' + side);
  }, safe);
  await log('camera-layout', layouts);
  for (const [width, height] of [
    [390, 844],
    [844, 390],
  ]) {
    await page.setViewportSize({ width, height });
    await wait(
      ({ camera, width, height }) => {
        const bounds = document.querySelector(camera)?.getBoundingClientRect();
        return bounds?.width === width && bounds.height === height;
      },
      { camera, width, height },
    );
    const fixture = await cropFixture(width, height);
    await watchSampling();
    const trace = await sampleTrace(await take());
    assert(
      trace.samples.some((sample) => sample.result?.stop),
      'Sharp fixture must receive Endpoint early-stop',
    );
    assert(trace.samplingMs > 0 && trace.samplingMs < 950, JSON.stringify(trace));
    snapshot = await waitForPhoto(width > height ? 2 : 1);
    const photo = snapshot.entries.find((entry) => entry.id === snapshot.basket.at(-1));
    assert.equal(photo.photo.mode, 'photo');
    assert.equal(photo.photo.pending, undefined);
    const crop = await assertCrop(await assetOf(photo.assetId), width, height, fixture);
    await log('camera-sharp', { trace, crop });
  }

  stage = 'camera-queue-orientation-retake';
  await cameraFixture('soft');
  await sleep(100);
  const orientationStart = await take();
  await wait(
    (start) => fileQA.photoWire.slice(start).some((event) => event.method === 'photo.burst.sample'),
    orientationStart,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await wait((css) => document.querySelector(css)?.textContent.includes('取景尺寸已改变'), camera);
  await wait(
    (start) => fileQA.photoWire.slice(start).some((event) => event.method === 'photo.burst.cancel'),
    orientationStart,
  );
  assert.equal((await library('get')).basket.length, 2);

  await page.evaluate(() => {
    fileQA.holdPhotoUploads = true;
  });
  await click(scanMode);
  await watchSampling();
  const soft = await sampleTrace(await take());
  assert(soft.samplingMs >= 900 && soft.samplingMs <= 1100, JSON.stringify(soft));
  assert(soft.samples.every((sample) => !sample.result?.stop));
  await wait(() => fileQA.heldUploads.length === 1);
  const firstJob = (await order()).find((id) => !snapshot.basket.includes(id));
  assert(firstJob);
  await click(photoMode);
  const queued = await take();
  await sampleTrace(queued);
  await wait((css) => document.querySelector(css)?.textContent.includes('处理中，稍候再拍'), camera);
  assert(await isDisabled(shutter));
  await page.evaluate((css) => document.querySelector(css).click(), shutter);
  assert.equal(
    await page.evaluate(
      (start) => fileQA.photoWire.slice(start).filter((event) => event.method === 'photo.burst.begin').length,
      queued,
    ),
    1,
  );
  await cameraReturn();
  await wait(() => fileQA.cameraTracks.every((track) => track.readyState === 'ended'));
  assert(await isDisabled(basketSend));
  await screenshot('camera-queue-in-basket');
  await log('camera-soft', { samplingMs: soft.samplingMs, samples: soft.samples.length, trace: soft });

  // Discard the queued second job before releasing the first transfer.
  const queueIds = (await order()).filter((id) => !snapshot.basket.includes(id));
  assert.equal(queueIds.length, 2);
  assert.equal(queueIds[0], firstJob);
  await scrollIntoView(cardButton(queueIds[1]));
  await click(cardButton(queueIds[1]));
  await click(basketDialog + ' button', '移除照片');
  await wait((id) => !document.querySelector('li[data-sort-item="' + id + '"]'), queueIds[1]);
  await page.evaluate(() => {
    fileQA.holdPhotoUploads = false;
    fileQA.heldUploads.shift()();
  });
  snapshot = await waitForPhoto(3);
  assert.equal(snapshot.entries.find((entry) => entry.id === snapshot.basket.at(-1)).photo.mode, 'scan');
  assert.equal(
    snapshot.entries.find((entry) => entry.id === snapshot.basket.at(-1)).photo.pending,
    undefined,
  );
  assert.equal((await order()).includes(queueIds[1]), false);
  assert(!(await isDisabled(basketSend)));

  const oldEntry = snapshot.entries.find((entry) => entry.id === snapshot.basket[0]);
  await click(cardButton(oldEntry.id));
  await click(basketDialog + ' button', '重拍');
  await click(camera + ' button[aria-label="取消重拍"]');
  assert.deepEqual(
    (await library('get')).entries.find((entry) => entry.id === oldEntry.id),
    oldEntry,
  );
  await cameraFixture('denied');
  if (!(await page.locator('button[aria-label="收起项目"]').count())) await click(cardButton(oldEntry.id));
  await click(basketDialog + ' button', '重拍');
  await wait((css) => document.querySelector(css)?.textContent.includes('无法使用摄像头'), camera);
  await click(camera + ' button[aria-label="取消重拍"]');
  assert.deepEqual(
    (await library('get')).entries.find((entry) => entry.id === oldEntry.id),
    oldEntry,
  );
  assert.deepEqual(await identity(), baseline);

  const prepared = await library('prepare', {
    operationId: randomUUID(),
    requestId: hidden.id,
    entryIds: snapshot.basket.slice(0, 1),
    groupId: null,
  });
  const remoteTab = (await state()).workspace.windows.find(
    (window) => window.id === hidden.windowId,
  ).activeTabId;
  await action({ type: 'tab.navigate', tabId: remoteTab, url: fixtureOrigin + '/retired' });
  const retired = await until('prepared chooser retires without consuming basket', async () => {
    const result = await library('finish', prepared);
    return result.state === 'cancelled' && result;
  });
  assert.deepEqual(retired.snapshot.basket, snapshot.basket);
  const photos = snapshot.basket.map((id) => snapshot.entries.find((entry) => entry.id === id));
  await chooser('single');
  await wait(() => document.querySelectorAll('input[name="chooser-file"]').length === 3);
  await screenshot('chooser-photo-cards');
  const stripBox = await bounds(basketDialog);
  const toolbar = await Promise.all([basketSend, basketAdd, more].map((selector) => bounds(selector)));
  assert(stripBox.height >= 135 && stripBox.height <= 165, JSON.stringify(stripBox));
  assert(
    toolbar.every(
      (box, index) =>
        box.width === 44 &&
        box.height === 44 &&
        box.x === toolbar[0].x &&
        box.y === toolbar[0].y + index * 46,
    ),
    JSON.stringify(toolbar),
  );
  assert(await isDisabled(basketSend));
  await click(listRow(photos[1].id) + ' input[name="chooser-file"]');
  assert(!(await isDisabled(basketSend)));
  await click(basketSend);
  await click(basketDialog + ' button', '确认');
  const photoSelected = await until(
    'radio choice delivers exactly one photo',
    () => events.filter((event) => event.type === 'selected')[2],
  );
  const chosenPhoto = await assetOf(photos[1].assetId);
  assert.deepEqual(photoSelected.files, [expected(photos[1].name, chosenPhoto)]);
  await waitForPhoto(2);
  await ready();
  await log(stage, { outcome: retired.state, originalEntry: oldEntry.id, stripBox, toolbar });

  stage = 'inline-candidate';
  await cameraFixture('alternate');
  const pendingChooser = await chooser('hidden');
  await openCamera();
  await click(camera + ' button[aria-label="连续拍摄已开启"]');
  await click(scanMode);
  await page.evaluate(() => {
    fileQA.holdPhotoUploads = true;
  });
  const alternateStart = await take();
  await wait((css) => !document.querySelector(css), camera);
  const alternate = await sampleTrace(alternateStart);
  await wait(() => fileQA.heldUploads.length === 1);
  assert.equal((await library('get')).basket.length, 2);
  assert(await isDisabled(basketSend));
  await page.evaluate(() => {
    fileQA.holdPhotoUploads = false;
    fileQA.heldUploads.shift()();
  });
  assert(alternate.end.result.uncertain, JSON.stringify(alternate));
  snapshot = await waitForPhoto(3);
  const candidateEntry = snapshot.entries.find((entry) => entry.id === snapshot.basket.at(-1));
  assert.equal(candidateEntry.photo.mode, 'scan');
  assert.equal(candidateEntry.photo.pending, 'choice');
  assert.equal(candidateEntry.photo.candidateAssetIds.length, 2);
  assert(await isDisabled(basketSend));
  await expectRejection('library.prepare', {
    operationId: randomUUID(),
    requestId: pendingChooser.id,
    entryIds: snapshot.basket,
    groupId: null,
  });
  await scrollIntoView(cardButton(candidateEntry.id));
  await click(cardButton(candidateEntry.id));
  await wait(() =>
    [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === '使用这张'),
  );
  assert.equal(await page.locator('[role="dialog"]').count(), 1);
  await click(basketDialog + ' button[aria-label="候选 2"]');
  assert.equal(
    await page.locator(basketDialog + ' button[aria-label="候选 2"]').getAttribute('aria-pressed'),
    'true',
  );
  await screenshot('camera-inline-candidate');
  await click(basketDialog + ' button', '使用这张');
  await until('chosen candidate processed with frozen scan mode', async () => {
    const entry = (await library('get')).entries.find((entry) => entry.id === candidateEntry.id);
    return (
      entry?.photo.mode === 'scan' &&
      !entry.photo.pending &&
      entry.originalAssetId &&
      entry.assetId !== entry.originalAssetId
    );
  });
  assert(!(await isDisabled(basketSend)));
  await click(more);
  await click(basketDialog + ' button', '取消文件选择');
  await wait((css) => !document.querySelector(css), basketDialog);
  assert.deepEqual(await identity(), baseline);
  await log(stage, { candidates: candidateEntry.photo.candidateAssetIds, decision: alternate.end.result });

  stage = 'authorization';
  const originalEpoch = await page.evaluate(() => fileQA.peerEpoch);
  const pendingUpload = await rtc('asset.begin', {
    operationId: randomUUID(),
    name: 'abandon.txt',
    size: 3,
    type: 'text/plain',
  });
  assert((await call('auth.lock', { reason: 'manual' })).locked);
  await wait(() => document.querySelector('.viewer-lock-blank'));
  await expectRejection('library.get', {});
  const locked = await raw(
    'asset.read',
    { requestId: 'library', assetId: assetA.assetId, offset: 0 },
    { rtc: true, authEpoch: originalEpoch, timeout: 1500 },
  );
  assert(
    !locked.unsent && !locked.result,
    'Stale RTC peer obtained locked file bytes or could not send the probe',
  );
  assert(!(await call('auth.verify', { method: 'password', secret: password })).locked);
  await ready();
  await until('rotated auth epoch', () => page.evaluate((old) => fileQA.peerEpoch !== old, originalEpoch));
  await expectRejection(
    'asset.chunk',
    { requestId: 'library', uploadId: pendingUpload.uploadId, offset: 0, data: 'YWJj' },
    { rtc: true },
  );
  assert.equal((await identity()).peer, baseline.peer);
  assert.deepEqual((await identity()).channels, baseline.channels);
  const disconnectedUpload = await rtc('asset.begin', {
    operationId: randomUUID(),
    name: 'disconnect.txt',
    size: 3,
    type: 'text/plain',
  });
  await log(stage, { originalEpoch, lockedReply: locked.timeout ? 'no reply' : 'rejected' });

  stage = 'files-tab-and-reattach';
  const windowId = (await state()).workspace.activeWindowId;
  await click('button[aria-label="更多"]');
  await click('[role="menuitem"]', '我的文件');
  await action({ type: 'tab.files', windowId });
  const files = await until('singleton native files tab', async () => {
    const { tabs, windows } = (await state()).workspace;
    const native = tabs.filter((tab) => tab.windowId === windowId && tab.kind === 'files');
    return (
      native.length === 1 &&
      windows.find((window) => window.id === windowId).activeTabId === native[0].id &&
      native[0]
    );
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
  await until(
    'deleted archived file is absent',
    async () => !(await library('get')).entries.some((entry) => entry.id === b),
  );
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
  assert.equal(snapshot.groups.find((group) => group.id === groupId).name, 'QA receipts');
  await wait(() => fileQA.fileChannel?.readyState === 'open' && fileQA.auth?.peerEpoch > 0);
  const thumb = await wait(
    ({ assetId, name }) => {
      const thumbnail = fileQA.thumbnails.get(assetId);
      const images = Array.from(document.querySelectorAll('img')).filter(
        (img) => img.complete && img.naturalWidth > 0 && img.src.startsWith('blob:'),
      );
      const named = images.find(
        (img) =>
          img.closest('[data-file-card]')?.querySelector('button')?.getAttribute('aria-label') === name,
      );
      return (
        thumbnail?.assetId &&
        fileQA.imageReads.has(thumbnail.assetId) &&
        (named ??
          images.find(
            (img) => img.naturalWidth === thumbnail.width && img.naturalHeight === thumbnail.height,
          )) && {
          width: thumbnail.width,
          height: thumbnail.height,
          bytes: thumbnail.size,
          originalRead: fileQA.imageReads.has(assetId),
        }
      );
    },
    { assetId: scan.assetId, name: scanEntry.name },
  ).then((value) => value.jsonValue());
  assert(thumb.width <= 320 && thumb.height <= 320 && thumb.bytes > 0 && !thumb.originalRead);
  await screenshot('files-tab-thumbnail-after-reload');
  await expectRejection(
    'asset.chunk',
    { requestId: 'library', uploadId: disconnectedUpload.uploadId, offset: 0, data: 'YWJj' },
    { rtc: true },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(() => document.body.textContent.includes('我的文件'));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await containedImages('[data-file-card] img');
  await screenshot('files-tab-narrow');
  await page.setViewportSize({ width: 1152, height: 820 });
  await action({ type: 'tab.navigate', tabId: files.id, url: fixtureOrigin + '/files-converted' });
  await until(
    'files tab converts to remote',
    async () => (await state()).workspace.tabs.find((tab) => tab.id === files.id)?.kind === 'remote',
  );
  await ready();
  await log(stage, { filesTab: files.id, basket: snapshot.basket, thumb });

  stage = 'anchor-visibility-revocation';
  const moving = await chooser('single');
  const visible = await waitForAnchor(moving.id);
  const beforeHide = await bounds('.remote-viewport');
  await until('remote hides actual input', () => events.some((event) => event.type === 'anchor-hidden'));
  await wait(
    ({ id, css }) => {
      const current = fileQA.state.fileRequests.find((request) => request.id === id);
      const paper = document.querySelector(css);
      return current && !current.anchor && paper && getComputedStyle(paper).position !== 'fixed';
    },
    { id: moving.id, css: basketDialog },
  );
  assert.deepEqual(await bounds('.remote-viewport'), beforeHide);
  await click(more);
  await click(basketDialog + ' button', '取消文件选择');
  await until(
    'cancel native request after fallback',
    async () => !(await state()).fileRequests.some((request) => request.id === moving.id),
  );
  await log(stage, { visible, contentBounds: beforeHide });
  if (scanFixtures) {
    stage = 'camera-color-scan-fixtures';
    for (const name of [
      'partial_soft-input.png',
      'partial_hard-input.png',
      'book-input.png',
      'receipt.jpg',
    ]) {
      const input = await readFile(join(scanFixtures, name));
      const source = await upload(name, name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', input);
      const start = performance.now();
      const result = await rtc('photo.process', { assetId: source.assetId, mode: 'scan' });
      const processingMs = performance.now() - start;
      const actual = await read(result);
      assert.equal(result.type, 'image/png');
      assert.equal(actual.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      if (name.startsWith('partial')) {
        assert.equal(result.geometry, 'unchanged');
        assert.deepEqual([result.width, result.height], [input.readUInt32BE(16), input.readUInt32BE(20)]);
      }
      assert.deepEqual(await read(source), input);
      await writeFile(join(run, name + '-scan.png'), actual);
      await log(stage, { name, source, result, processingMs });
    }
  }

  await log('pass');
} catch (error) {
  process.exitCode = 1;
  const probe = await page
    ?.evaluate(async (css) => {
      const paper = document.querySelector(css);
      const camera = document.querySelector('[role="dialog"][aria-label="摄像头拍照"]');
      const qa = window.fileQA;
      const stats = await qa?.peers[0]?.getStats().catch(() => undefined);
      const inbound = Array.from(stats?.values() ?? [])
        .filter((entry) => entry.type === 'inbound-rtp' && (entry.kind ?? entry.mediaType) === 'video')
        .map((entry) => ({
          framesDecoded: entry.framesDecoded,
          keyFramesDecoded: entry.keyFramesDecoded,
          packetsReceived: entry.packetsReceived,
        }));
      const workspace = qa?.state?.workspace;
      const activeTab = workspace?.tabs.find(
        (tab) =>
          workspace.windows.find((window) => window.id === workspace.activeWindowId)?.activeTabId === tab.id,
      );
      return {
        requests: window.fileQA?.state?.fileRequests,
        position: paper && getComputedStyle(paper).position,
        auth: window.fileQA?.auth && { locked: fileQA.auth.locked, peerEpoch: fileQA.auth.peerEpoch },
        media: window.fileQA?.sample(),
        viewport: document.querySelector('.remote-viewport')?.className,
        input: document.querySelector('canvas[data-video-input]')?.className,
        inbound,
        timeline: qa?.timeline,
        activeTab: activeTab && {
          id: activeTab.id,
          webviewId: activeTab.webviewId,
          restoring: activeTab.restoring,
          residency: activeTab.residency,
          kind: activeTab.kind,
        },
        photoWire: qa?.photoWire.slice(-30),
        camera: camera && {
          bounds: camera.getBoundingClientRect().toJSON(),
          maxHeight: getComputedStyle(camera).maxHeight,
          inner: [innerWidth, innerHeight],
          visual: [visualViewport?.width, visualViewport?.height],
          secure: isSecureContext,
          cameraApi: !!navigator.mediaDevices?.getUserMedia,
        },
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]'), (dialog) =>
          dialog.textContent.slice(0, 600),
        ),
      };
    }, basketDialog)
    .catch(() => null);
  await log('failure', { stage, error: error.stack, probe });
  await page?.screenshot({ path: join(run, 'failure.png'), timeout: 3000 }).catch(() => {});
} finally {
  clearTimeout(deadline);
  try {
    await context?.close();
  } finally {
    if (control.connected) control.disconnect();
    fixture.closeAllConnections();
    await new Promise((done) => fixture.close(done));
    await stopped;
  }
}
