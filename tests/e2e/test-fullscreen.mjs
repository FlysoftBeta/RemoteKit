/**
 * Real H.264 fullscreen regression on an isolated loopback instance.
 * node tests/e2e/test-fullscreen.mjs <playwright module> <viewer exe> <endpoint exe> <remote browser exe> <unused output dir> [port]
 */
import { startProductStack, registerViewer } from './product-stack.mjs';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const [playwright, viewer, endpoint, browser, output, listenPort = '33785'] = process.argv.slice(2);
assert(
  [playwright, viewer, endpoint, browser, output].every(Boolean),
  'Expected Playwright, Viewer, Endpoint, Browser and output paths',
);
const { chromium } = createRequire(import.meta.url)(resolve(playwright));
const root = fileURLToPath(new URL('../../', import.meta.url));
const run = resolve(output);
const port = Number(listenPort);
const origin = 'http://127.0.0.1:' + port;
const fixtureOrigin = 'http://127.0.0.1:' + (port + 1);
await mkdir(run);
const log = async (stage, value) => {
  await appendFile(join(run, 'fullscreen-results.jsonl'), JSON.stringify({ stage, value }) + '\n');
  console.log(stage);
};
const fixturePage = `<!doctype html><meta charset="utf-8"><title>Fullscreen fixture</title>
<style>
  body { margin:0; font:16px Arial; background:#d0e5fc; }
  main { position:relative; width:100vw; height:100vh; background:#d0e5fc; }
  main:fullscreen { background:#125267; color:white; }
  button { font:inherit; padding:12px; margin:8px; }
  #hit { position:absolute; bottom:8%; right:5%; }
  canvas { position:absolute; bottom:8px; left:8px; }
</style>
<main><button id="enter">Enter fullscreen</button><button id="exit">Exit fullscreen</button>
<button id="navigate">Navigate in fullscreen</button><button id="hit">Hit bottom right</button>
<canvas width="24" height="24"></canvas></main>
<script>
  const main = document.querySelector('main');
  const buttons = Array.from(main.querySelectorAll('button'));
  const context = document.querySelector('canvas').getContext('2d');
  let tick = 0;
  setInterval(() => {
    context.fillStyle = tick++ % 2 ? '#ef512a' : '#0463aa';
    context.fillRect(0, 0, 24, 24);
  }, 80);
  const report = (type, details) => fetch('/event', {
    method:'POST', keepalive:true, headers:{'Content-Type':'application/json'},
    body:JSON.stringify({type, documentId:performance.timeOrigin, path:location.pathname,
      width:innerWidth, height:innerHeight, fullscreen:document.fullscreenElement?.id || document.fullscreenElement?.tagName || null,
      geometry:Object.fromEntries(buttons.map(button => [button.id, button.getBoundingClientRect().toJSON()])), ...details}),
  }).catch(() => {});
  for (const button of buttons) button.addEventListener('click', async event => {
    const details = {target:button.id, trusted:event.isTrusted, active:navigator.userActivation.isActive,
      x:event.clientX, y:event.clientY};
    void report('click', details);
    try {
      if (button.id === 'enter') await main.requestFullscreen();
      if (button.id === 'exit') await document.exitFullscreen();
      if (button.id === 'navigate') location.assign('/navigated');
    } catch (error) { void report('fullscreen-error', {...details, error:String(error)}); }
  });
  document.addEventListener('fullscreenchange', event => void report('fullscreenchange', {trusted:event.isTrusted}));
  addEventListener('resize', () => void report('resize'));
  void report('ready');
</script>`;
const fixtureEvents = [];
const fixture = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/event') {
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 16384) {
          response.writeHead(413).end();
          return;
        }
      }
      const event = JSON.parse(body);
      fixtureEvents.push(event);
      await appendFile(join(run, 'fixture-events.jsonl'), JSON.stringify(event) + '\n');
      response.end();
    } catch {
      response.writeHead(400).end();
    }
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(fixturePage);
});
await new Promise((accept, reject) => {
  fixture.once('error', reject);
  fixture.listen(port + 1, '127.0.0.1', accept);
});
const control = startProductStack({ run, port, endpoint, browser });
control.stdout.on('data', (data) => void appendFile(join(run, 'control.stdout.log'), data));
control.stderr.on('data', (data) => void appendFile(join(run, 'control.stderr.log'), data));
const stopped = new Promise((accept, reject) => {
  control.once('exit', accept);
  control.once('error', reject);
});
void stopped.catch(() => {});

const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(75);
  }
  throw Error(message);
}
let context, page, readProbe;
const deadline = setTimeout(() => void context?.close().catch(() => {}), 150000);
try {
  await until(async () => {
    const response = await fetch(origin + '/api/auth/setup', {
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined);
    return response?.ok && (await response.json()).setupRequired === true;
  }, 'Fresh isolated Control did not start');
  context = await chromium.launchPersistentContext(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer),
    headless: process.env.REMOTEKIT_QA_HEADLESS === '1',
    viewport: { width: 1152, height: 820 },
    deviceScaleFactor: 1,
    timeout: 15000,
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
  });
  page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (error) => void log('client-error', { message: error.message, stack: error.stack }));
  page.setDefaultTimeout(5000);
  await page.addInitScript(() => {
    const probe = (window.fullscreenQA = { attempts: [], peers: [], channels: [], events: [], input: [] });
    const record = (event) => {
      probe.events.push({
        type: event.type,
        trusted: event.isTrusted,
        at: performance.now(),
        active: navigator.userActivation.isActive,
        focused: document.hasFocus(),
        native: !!document.fullscreenElement,
      });
      if (probe.events.length > 40) probe.events.shift();
    };
    for (const type of ['focus', 'blur', 'pointerup', 'fullscreenchange'])
      window.addEventListener(type, record, true);
    const ids = new WeakMap();
    let nextId = 0;
    probe.id = (value) => {
      if (!value) return null;
      if (!ids.has(value)) ids.set(value, ++nextId);
      return ids.get(value);
    };
    const nativeFullscreen = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (...args) {
      const attempt = {
        active: navigator.userActivation.isActive,
        at: performance.now(),
        target: this.tagName,
      };
      probe.attempts.push(attempt);
      return nativeFullscreen.apply(this, args).then(
        (value) => {
          attempt.result = 'fulfilled';
          return value;
        },
        (error) => {
          attempt.result = 'rejected';
          attempt.error = String(error);
          throw error;
        },
      );
    };
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) {
        super(...args);
        probe.peers.push(this);
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        probe.channels.push(channel);
        if (channel.label === 'remotekit') {
          const recordInput = (raw, direction) => {
            if (typeof raw !== 'string') return;
            const message = JSON.parse(raw);
            if (!['focus', 'input', 'input.result', 'layout', 'presentation.prepare'].includes(message.type))
              return;
            probe.input.push({ direction, at: performance.now(), message });
            if (probe.input.length > 96) probe.input.shift();
          };
          channel.addEventListener('message', (event) => recordInput(event.data, 'in'));
          const send = channel.send.bind(channel);
          channel.send = (raw) => {
            recordInput(raw, 'out');
            return send(raw);
          };
        }
        return channel;
      }
    };
    probe.sample = () => {
      const visible = (el) => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
      const rect = (el) => el.getBoundingClientRect().toJSON();
      const peer = probe.peers.at(-1);
      return {
        attempts: probe.attempts,
        events: probe.events,
        input: probe.input,
        native: !!document.fullscreenElement,
        focused: document.hasFocus(),
        visibility: document.visibilityState,
        fullscreenEnabled: document.fullscreenEnabled,
        viewport: {
          x: visualViewport.offsetLeft,
          y: visualViewport.offsetTop,
          width: visualViewport.width,
          height: visualViewport.height,
        },
        toolbar: [...document.querySelectorAll('.navigation-bar')].filter(visible).length,
        tabs: [...document.querySelectorAll('.tab-bar')].filter(visible).length,
        visibleWindows: [...document.querySelectorAll('.window-frame')].filter(visible).length,
        panes: [...document.querySelectorAll('.remote-viewport')].filter(visible).map((el) => {
          const clip = el.querySelector('.remote-video-plane');
          return {
            bounds: rect(el),
            ready: !!(
              clip?.querySelector('video')?.videoWidth &&
              visible(clip) &&
              Number(getComputedStyle(clip).opacity) > 0 &&
              !el.classList.contains('resize-waiting')
            ),
          };
        }),
        peer: probe.id(peer),
        peerCount: probe.peers.length,
        connected: peer?.connectionState,
        tracks: peer?.getReceivers().map((receiver) => probe.id(receiver.track)),
        channels: probe.channels.map((channel) => [probe.id(channel), channel.label, channel.readyState]),
      };
    };
  });
  // Playwright page.evaluate may set Runtime's userGesture bit. Read without it
  // so measuring an automatic request cannot accidentally grant activation.
  const cdp = await context.newCDPSession(page);
  const read = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      userGesture: false,
      awaitPromise: true,
    });
    assert(!exceptionDetails, exceptionDetails?.exception?.description || exceptionDetails?.text);
    return result.value;
  };
  const sample = () => read('window.fullscreenQA?.sample()');
  readProbe = sample;
  const allReady = (count) =>
    until(async () => {
      const state = await sample();
      return (
        state?.visibleWindows === count &&
        state.panes.length === count &&
        state.panes.every((pane) => pane.ready) &&
        state
      );
    }, `Expected ${count} decoded and input-ready remote viewport(s)`);
  const click = async (selector, name) => {
    const locate = () =>
      read(`(() => {
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = elements.find(candidate => candidate.getClientRects().length &&
        !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true' &&
        (${JSON.stringify(name ?? null)} === null ||
          (candidate.getAttribute('aria-label') || candidate.textContent.trim()) === ${JSON.stringify(name ?? null)}));
      if (!el) return null;
      el.scrollIntoView({block:'nearest', inline:'nearest'});
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      return el.contains(document.elementFromPoint(x, y)) ? {x, y} : null;
    })()`);
    const point = await until(
      async () => {
        const first = await locate();
        if (!first) return false;
        await sleep(90);
        const settled = await locate();
        return settled && Math.abs(first.x - settled.x) < 1 && Math.abs(first.y - settled.y) < 1 && settled;
      },
      'Missing stable control ' + (name ?? selector),
    );
    await page.mouse.click(point.x, point.y);
  };
  const find = (selector, index = 0) =>
    until(
      () => read(`Boolean(document.querySelectorAll(${JSON.stringify(selector)})[${index}])`),
      'Missing element ' + selector,
    );
  const fill = async (selector, value, index = 0) => {
    await until(async () => {
      const point = await read(`(() => {
        const input = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!input || input.disabled || input.readOnly) return null;
        const box = input.getBoundingClientRect();
        return box.width && {x:box.x + box.width / 2, y:box.y + box.height / 2};
      })()`);
      if (!point) return false;
      await page.mouse.click(point.x, point.y);
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(value);
      return await read(`document.activeElement === document.querySelectorAll(${JSON.stringify(selector)})[${index}] &&
        document.activeElement?.value === ${JSON.stringify(value)}`);
    }, 'Could not fill ' + selector);
  };
  const navigate = async (path, index) => {
    await fill('.address-form input', fixtureOrigin + path, index);
    await page.keyboard.press('Enter');
    return until(
      () => fixtureEvents.find((event) => event.type === 'ready' && event.path === path),
      'Remote page did not navigate to ' + path,
    );
  };
  const identity = (baseline, latest) => {
    assert.equal(latest.connected, 'connected');
    assert.equal(latest.peerCount, baseline.peerCount);
    for (const key of ['peer', 'tracks', 'channels'])
      assert.deepEqual(latest[key], baseline[key], key + ' changed');
  };
  const unlock = async () => {
    await until(
      async () => {
        if (!(await read('Boolean(document.querySelector(".viewer-lock-blank"))'))) return true;
        for (const key of [
          'ArrowUp',
          'ArrowUp',
          'ArrowDown',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'ArrowLeft',
          'ArrowRight',
        ]) {
          await page.keyboard.press(key);
        }
        await sleep(200);
        return !(await read('Boolean(document.querySelector(".viewer-lock-blank"))'));
      },
      'Trusted reveal sequence did not open the authentication panel',
      5000,
    );
  };
  const accountPassword = randomBytes(18).toString('hex');

  await page.goto(origin, { timeout: 12000 });
  await find('.viewer-lock-blank');
  await unlock();
  await registerViewer({ click, fill, username: 'fullscreen-qa', password: accountPassword });
  await click('button', '新建窗口');
  const outerOnly = process.env.REMOTEKIT_QA_FULLSCREEN_OUTER_ONLY === '1';
  const outerWindowCount = outerOnly ? 1 : 2;
  if (outerOnly) {
    await navigate('/first', 0);
    await allReady(1);
  } else {
    const first = await navigate('/first', 0);
    await allReady(1);
    await click('button', '更多');
    await click('[role=menuitem]', '新建窗口');
    await until(() => read('!document.querySelector("[role=menu]")'), 'Window menu did not close');
    const second = await navigate('/second', 1);
    const baseline = await allReady(2);
    assert.equal(baseline.toolbar, 2);
    assert.equal(baseline.tabs, 2);
    assert.equal(baseline.channels.filter((channel) => channel[2] === 'open').length, 2);
    const codecs = await until(async () => {
      const values = await read(`(async () => {
        const stats = await fullscreenQA.peers.at(-1).getStats();
        return [...stats.values()].filter(stat => stat.type === 'inbound-rtp' &&
          (stat.kind || stat.mediaType) === 'video' && stat.framesDecoded > 0)
          .map(stat => stats.get(stat.codecId)?.mimeType);
      })()`);
      return values.some((value) => value?.toLowerCase() === 'video/h264') && values;
    }, 'No decoded H.264 inbound RTP');
    await log('two-window-baseline', {
      baseline,
      first: first.documentId,
      second: second.documentId,
      codecs,
    });

    const target = async (documentId, button, paneIndex) => {
      const before = fixtureEvents.length;
      const remote = fixtureEvents.findLast((event) => event.documentId === documentId);
      const box = remote.geometry[button];
      const { bounds } = (await sample()).panes[paneIndex];
      await page.mouse.click(
        bounds.x + ((box.x + box.width / 2) * bounds.width) / remote.width,
        bounds.y + ((box.y + box.height / 2) * bounds.height) / remote.height,
      );
      const received = await until(
        () =>
          fixtureEvents
            .slice(before)
            .find(
              (event) => event.type === 'click' && event.documentId === documentId && event.target === button,
            ),
        'Input did not hit remote button ' + button,
      );
      assert.equal(received.trusted, true);
      if (button === 'hit') {
        const sent = (await sample()).input.findLast(
          (row) =>
            row.direction === 'out' && row.message.type === 'input' && row.message.event.action === 'up',
        ).message;
        await until(async () => {
          const state = await sample();
          const layout = state.input.findLast(
            (row) => row.direction === 'in' && row.message.type === 'layout',
          )?.message;
          return layout?.views.some(
            (view) => view.id === sent.view && view.document === sent.document && view.focus === sent.focus,
          );
        }, 'Focus metadata did not settle before switching panes');
      }
      assert(
        Math.abs(received.x - box.x - box.width / 2) <= 3 &&
          Math.abs(received.y - box.y - box.height / 2) <= 3,
        'Remote click coordinates differed from the selected target centre',
      );
      return received;
    };
    const expectRemoteFullscreen = async (start, documentId = second.documentId) => {
      const remote = await until(
        () =>
          fixtureEvents
            .slice(start)
            .find(
              (event) =>
                event.type === 'fullscreenchange' &&
                event.documentId === documentId &&
                event.fullscreen === 'MAIN',
            ),
        'Remote document did not enter fullscreen',
      );
      assert.equal(remote.trusted, true);
      const active = await until(async () => {
        const state = await sample();
        return (
          state?.visibleWindows === 1 &&
          state.panes.length === 1 &&
          state.panes[0].ready &&
          state.toolbar === 0 &&
          state.tabs === 0 &&
          ['x', 'y', 'width', 'height'].every(
            (key) => Math.abs(state.panes[0].bounds[key] - state.viewport[key]) <= 1,
          ) &&
          state
        );
      }, 'Fullscreen viewport did not settle with decoded video');
      assert.equal(active.toolbar, 0);
      assert.equal(active.tabs, 0);
      assert.equal(active.native, false);
      assert.equal(active.attempts.length, 0);
      for (const key of ['x', 'y', 'width', 'height']) {
        assert(
          Math.abs(active.panes[0].bounds[key] - active.viewport[key]) <= 1,
          'Fullscreen bounds mismatch for ' + key,
        );
      }
      await until(
        () =>
          fixtureEvents.findLast(
            (event) =>
              event.documentId === documentId &&
              event.fullscreen === 'MAIN' &&
              Math.abs(event.width - active.viewport.width) <= 2 &&
              Math.abs(event.height - active.viewport.height) <= 2,
          ),
        'Remote document did not receive fullscreen viewport dimensions',
      );
      identity(baseline, active);
      return active;
    };

    const enteredAt = fixtureEvents.length;
    assert.equal((await target(second.documentId, 'enter', 1)).active, true);
    const inner = await expectRemoteFullscreen(enteredAt);
    const hit = await target(second.documentId, 'hit', 0);
    assert.equal(hit.fullscreen, 'MAIN');
    await page.screenshot({ path: join(run, 'web-fullscreen.png') });
    await log('web-fullscreen-enter-and-hit', { inner, hit });
    if (process.env.REMOTEKIT_QA_FULLSCREEN_NARROW === '1') {
      const exitAt = fixtureEvents.length;
      await page.keyboard.press('Escape');
      await until(
        () =>
          fixtureEvents
            .slice(exitAt)
            .find(
              (event) =>
                event.type === 'fullscreenchange' &&
                event.documentId === second.documentId &&
                !event.fullscreen,
            ),
        'Escape did not exit fullscreen',
      );
      identity(baseline, await allReady(2));
      await log('web-fullscreen-escape', { documentId: second.documentId });
    } else {
      const exitAt = fixtureEvents.length;
      await target(second.documentId, 'exit', 0);
      await until(
        () =>
          fixtureEvents
            .slice(exitAt)
            .find(
              (event) =>
                event.type === 'fullscreenchange' &&
                event.documentId === second.documentId &&
                !event.fullscreen,
            ),
        'Remote document did not exit fullscreen',
      );
      const restored = await allReady(2);
      assert.equal(restored.toolbar, 2);
      identity(baseline, restored);
      const reenterAt = fixtureEvents.length;
      await target(second.documentId, 'enter', 1);
      await expectRemoteFullscreen(reenterAt);
      await target(second.documentId, 'navigate', 0);
      const navigated = await until(
        () => fixtureEvents.find((event) => event.type === 'ready' && event.path === '/navigated'),
        'In-page cross-document navigation did not commit',
      );
      assert.notEqual(navigated.documentId, second.documentId);
      assert.equal(navigated.fullscreen, null);
      const afterNavigation = await allReady(2);
      assert.equal(afterNavigation.toolbar, 2);
      assert.equal(afterNavigation.attempts.length, 0);
      identity(baseline, afterNavigation);
      const firstHit = await target(first.documentId, 'hit', 0);
      await log('web-fullscreen-exit-and-navigation', { restored, navigated, afterNavigation, firstHit });

      const cleanupEnterAt = fixtureEvents.length;
      await target(navigated.documentId, 'enter', 1);
      // Use the overlay exit, which must address the currently fullscreen document
      // even after the preceding navigation retired a fullscreen document.
      await expectRemoteFullscreen(cleanupEnterAt, navigated.documentId);
      await click('.floating-ball');
      await click('button', '退出网页全屏');
      await until(
        () =>
          fixtureEvents
            .slice(cleanupEnterAt)
            .find(
              (event) =>
                event.type === 'fullscreenchange' &&
                event.documentId === navigated.documentId &&
                !event.fullscreen,
            ),
        'Viewer exit did not exit the current document fullscreen',
      );
      identity(baseline, await allReady(2));
      await log('web-fullscreen-viewer-exit', { documentId: navigated.documentId });
    }
  }

  const openSettings = async () => {
    await click('button', '更多');
    await click('[role=menuitem]', '设置');
  };
  const autoToggleLabel = '打开或激活时全屏';
  const autoChecked = () =>
    read(`[...document.querySelectorAll('label')].find(label =>
    label.textContent.trim() === ${JSON.stringify(autoToggleLabel)})?.querySelector('input')?.checked`);
  await openSettings();
  assert.equal(await autoChecked(), false);
  await click('label', autoToggleLabel);
  await until(
    () =>
      read(
        `[...document.querySelectorAll('[role="status"]')].some(el => el.textContent.trim() === '已保存')`,
      ),
    'Control did not acknowledge the fullscreen setting',
  );
  await click('button', '关闭设置');

  // The default reattachment may lock a saved account.
  const password = 'input[autocomplete="current-password"]';
  await page.reload({ timeout: 12000 });
  await until(
    () =>
      read(`Boolean(document.querySelector('.viewer-shell') ||
    (document.querySelector('.viewer-lock-blank') && window.fullscreenQA?.channels.filter(channel =>
      channel.readyState === 'open').length === 2))`),
    'Viewer did not reattach after reload',
  );
  if (await read('Boolean(document.querySelector(".viewer-lock-blank"))')) {
    await unlock();
    await fill(password, accountPassword);
    await until(() => read('!navigator.userActivation.isActive'), 'Unlock sequence activation did not clear');
    await read('document.querySelector(\'input[autocomplete="current-password"]\').form.requestSubmit()');
  }
  await allReady(outerWindowCount);
  await page.bringToFront();
  const startupRejected = await until(
    async () => (await sample()).attempts.find((attempt) => !attempt.active && attempt.result === 'rejected'),
    'Viewer activation without transient gesture did not attempt native fullscreen',
  );
  await openSettings();
  assert.equal(await autoChecked(), true);
  await click('button', '关闭设置');
  if (!(await sample()).native) await page.mouse.click(10, 400);
  const activeOuter = await until(async () => {
    const state = await sample();
    return (
      state.native &&
      state.attempts.some((attempt) => attempt.active && attempt.result === 'fulfilled') &&
      state
    );
  }, 'Saved preference did not request native fullscreen on trusted interaction');

  // Invoke native exit without granting activation. Explicitly deliver the
  // focus event for a deterministic resume regression in the isolated viewer.
  await read('document.exitFullscreen()');
  const outerRestored = await allReady(outerWindowCount);
  identity(activeOuter, outerRestored);
  await until(async () => !(await sample()).native, 'Native Viewer fullscreen did not exit');
  const afterNativeExit = (await sample()).attempts.length;
  await page.mouse.click(10, 400);
  assert.equal(
    (await sample()).attempts.length,
    afterNativeExit,
    'Ordinary click after exit requested fullscreen again',
  );
  await until(() => read('!navigator.userActivation.isActive'), 'Transient viewer activation did not clear');
  const beforeFocus = (await sample()).attempts.length;
  await read('window.dispatchEvent(new FocusEvent("blur")); window.dispatchEvent(new FocusEvent("focus"))');
  const rejected = await until(async () => {
    const state = await sample();
    return state.attempts
      .slice(beforeFocus)
      .find((attempt) => !attempt.active && attempt.result === 'rejected');
  }, 'Automatic resume attempt did not record a real browser activation rejection');
  const afterReject = (await sample()).attempts.length;
  await page.mouse.move(10, 400);
  await page.mouse.down();
  assert.equal(await read('navigator.userActivation.isActive'), true);
  await read('window.dispatchEvent(new PointerEvent("pointerup", { bubbles:true }))');
  assert.equal((await sample()).attempts.length, afterReject, 'Synthetic pointer input retried fullscreen');
  await page.mouse.up();
  const retried = await until(async () => {
    const state = await sample();
    return (
      state.native &&
      state.attempts.slice(afterReject).some((attempt) => attempt.active && attempt.result === 'fulfilled') &&
      state
    );
  }, 'Trusted pointer input did not retry fullscreen');
  identity(activeOuter, retried);
  await log('outer-fullscreen-persistence-rejection-and-retry', {
    startupRejected,
    activeOuter,
    rejected,
    retried,
  });
} catch (error) {
  await log('failure', { message: error.message, stack: error.stack });
  const probe = await readProbe?.().catch(() => null);
  if (probe) await log('failure-probe', probe);
  await page?.screenshot({ path: join(run, 'failure.png'), timeout: 3000 }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try {
    await context?.close();
  } finally {
    if (control.connected) control.disconnect();
    fixture.closeAllConnections();
    await new Promise((accept) => fixture.close(accept));
    await stopped;
  }
}
