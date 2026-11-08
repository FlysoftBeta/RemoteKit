/**
 * Real H264 keyboard regression on an isolated loopback instance.
 * node tests/e2e/test-keyboard-viewport.mjs <playwright module path> <viewer exe> <endpoint exe> <remote browser exe> <unused output dir> [port]
 */
import { createServer } from 'node:http';
import { startProductStack } from './kit/stack.mjs';
import { registerViewer } from './product-stack.mjs';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const [playwright, viewer, endpoint, browser, output, listenPort = '33781'] = process.argv.slice(2);
if (![playwright, viewer, endpoint, browser, output].every(Boolean)) {
  throw Error(
    'Expected Playwright module, Viewer exe, Endpoint exe, RemoteKit Browser exe and an unused output directory',
  );
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const run = resolve(output);
const port = Number(listenPort);
const origin = 'http://127.0.0.1:' + port;
const fixtureOrigin = 'http://127.0.0.1:' + (port + 1);
const { chromium } = createRequire(import.meta.url)(resolve(playwright));
await mkdir(run);
const fixturePage = await readFile(new URL('test-keyboard-viewport.html', import.meta.url));
const fixtureEvents = [];
const fixture = createServer(async (request, response) => {
  if (request.url === '/event' && request.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 65536) {
          response.writeHead(413).end();
          return;
        }
      }
      const event = JSON.parse(body);
      fixtureEvents.push(event);
      if (fixtureEvents.length > 2048) fixtureEvents.shift();
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
await writeFile(
  join(run, 'service.json'),
  JSON.stringify(
    {
      controlPid: control.pid,
      viewer: resolve(viewer),
      endpoint: resolve(endpoint),
      browser: resolve(browser),
      port,
    },
    null,
    2,
  ),
);

const log = async (stage, value) => {
  await appendFile(join(run, 'keyboard-results.jsonl'), JSON.stringify({ stage, value }) + '\n');
  console.log(stage);
};
const assert = (condition, message) => {
  if (!condition) throw Error(message);
};
const pause = (ms) => new Promise((accept) => setTimeout(accept, ms));

let context, page;
const deadline = setTimeout(() => void context?.close().catch(() => {}), 120000);
try {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(origin + '/api/auth/setup', {
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined);
    if (response?.ok && (await response.json()).setupRequired === true) break;
    assert(attempt < 50 && control.exitCode === null, 'Fresh isolated Control did not start');
    await pause(100);
  }
  context = await chromium.launchPersistentContext(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer),
    headless: false,
    viewport: { width: 1152, height: 820 },
    deviceScaleFactor: 1,
    hasTouch: true,
    reducedMotion: 'no-preference',
    timeout: 15000,
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
  });
  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(5000);
  await page.addInitScript(() => {
    const viewport = visualViewport;
    const probe = (window.keyboardQA = {
      viewport: {},
      events: [],
      wire: [],
      peers: [],
      channels: [],
      editPackets: [],
      touchWire: [],
      epochs: [],
      waitingEntries: 0,
    });
    probe.session = () => {
      for (const element of document.querySelectorAll('*')) {
        const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
        for (let fiber = key && element[key]; fiber; fiber = fiber.return)
          for (let hook = fiber.memoizedState; hook; hook = hook.next) {
            const session = hook.memoizedState;
            if (session?.presentation && session?.input) return session;
          }
      }
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (message.type === 'state') probe.state = message.state;
        });
      }
    };
    const ids = new WeakMap();
    let nextId = 0;
    probe.id = (value) => {
      if (!value) return null;
      if (!ids.has(value)) ids.set(value, ++nextId);
      return ids.get(value);
    };
    for (const property of ['width', 'height', 'offsetTop', 'offsetLeft']) {
      const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), property).get;
      Object.defineProperty(viewport, property, {
        get: () => probe.viewport[property] ?? native.call(viewport),
      });
    }
    probe.resize = (height) => {
      probe.viewport.height = height;
      viewport.dispatchEvent(new Event('resize'));
    };
    probe.scroll = (offsetTop, offsetLeft) => {
      Object.assign(probe.viewport, { offsetTop, offsetLeft });
      viewport.dispatchEvent(new Event('scroll'));
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (
          record.type === 'attributes' &&
          record.target.matches('.remote-viewport') &&
          record.oldValue?.split(/\s+/).includes('resize-waiting') &&
          !record.target.classList.contains('resize-waiting')
        )
          probe.waitingEntries++;
      }
      if (document.querySelector('.remote-viewport.resize-waiting')) probe.waitingEntries++;
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
    });
    for (const type of ['focusin', 'focusout', 'input', 'compositionstart', 'compositionend']) {
      document.addEventListener(
        type,
        (event) => {
          if (event.target.matches?.('.remote-input')) {
            probe.events.push({ type, at: performance.now(), trusted: event.isTrusted });
            const feedback = probe.keyboardFeedback;
            if (!feedback || (type !== 'focusin' && type !== 'focusout')) return;
            feedback.focus.push({ type, at: performance.now(), mode: event.target.inputMode });
            clearTimeout(feedback.timer);
            feedback.timer = setTimeout(() => {
              const editor = document.activeElement;
              const open = editor?.matches('.remote-input') && editor.inputMode !== 'none';
              const height = open ? feedback.openHeight : feedback.closedHeight;
              if (viewport.height === height) return;
              feedback.geometry.push({ height, at: performance.now() });
              probe.resize(height);
            }, 110);
          }
        },
        true,
      );
    }
    const record = (message, direction) => {
      if (direction === 'in' && message.type === 'layout') {
        if (probe.epochs[probe.epochs.length - 1] !== message.epoch) probe.epochs.push(message.epoch);
      }
      if (direction === 'out' && message.type === 'input' && message.event?.type === 'touch') {
        const { sequenceId, action, points } = message.event;
        probe.touchWire.push({
          type: 'input',
          at: performance.now(),
          client: message.sequence,
          id: sequenceId,
          action,
          points: points.map((point) => point.id),
        });
      }
      if (
        message.type === 'input.result' &&
        probe.staleSent &&
        message.clientSequence === probe.staleSent.sequence
      ) {
        probe.staleReply = {
          sequence: message.clientSequence,
          ok: message.ok,
          error: message.error,
        };
      }
      if (!['focus', 'input.editable'].includes(message.type)) return;
      probe.wire.push({
        type: message.type,
        direction,
        at: performance.now(),
        focus: message.focus,
        epoch: message.layoutEpoch,
        request: message.focusRequestId,
        editable: message.editable?.type,
        target: message.editable?.target,
        focused: message.focused,
        revision: message.revision,
      });
      const feedback = probe.keyboardFeedback;
      if (!feedback || direction !== 'in' || message.type !== 'input.editable') return;
      feedback.latestEditable = message;
      if (feedback.geometry.length === 1 && !feedback.graceInput && message.editable?.type === 0) {
        setTimeout(() => {
          const editor = document.activeElement;
          if (feedback.graceInput || feedback.latestEditable !== message || !editor?.matches('.remote-input'))
            return;
          feedback.graceInput = { at: performance.now(), revision: message.revision };
          editor.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: 'grace probe',
            }),
          );
        }, 0);
      }
    };
    const nativeSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (raw) {
      if (typeof raw === 'string' && this.label !== 'remotekit-auth') {
        try {
          const message = JSON.parse(raw);
          record(message, 'out');
          if (
            message.type === 'input' &&
            ['ime_set', 'ime_commit'].includes(message.event?.type) &&
            probe.editPackets.length < 1024
          ) {
            const { type, text, editableTarget } = message.event;
            probe.editPackets.push({ sequence: message.sequence, event: { type, text, editableTarget } });
          }
          if (probe.staleTarget && message.type === 'input' && message.event?.editableTarget) {
            probe.staleSent = {
              original: message.event.editableTarget,
              substituted: probe.staleTarget,
              sequence: message.sequence,
              epoch: message.layoutEpoch,
            };
            message.event.editableTarget = probe.staleTarget;
            probe.staleTarget = null;
            raw = JSON.stringify(message);
          }
        } catch {}
      }
      return nativeSend.call(this, raw);
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
        if (channel.label !== 'remotekit-auth')
          channel.addEventListener('message', (event) => {
            try {
              record(JSON.parse(event.data), 'in');
            } catch {}
          });
        return channel;
      }
    };
  });
  await page.goto(origin, { timeout: 12000 });

  const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 10000 });
  const click = async (css, text) => {
    const point = await (
      await wait(
        ({ css, text }) => {
          const button = [...document.querySelectorAll(css)].find(
            (el) =>
              (text === undefined || el.textContent.trim() === text) &&
              !el.disabled &&
              el.getAttribute('aria-disabled') !== 'true',
          );
          const box = button?.getBoundingClientRect();
          return box?.width && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        },
        { css, text },
      )
    ).jsonValue();
    await page.mouse.click(point.x, point.y);
  };
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
  await wait(() => !!document.querySelector('.viewer-lock-blank'));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
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
  await registerViewer({ click, fill, username: 'keyboard-qa', password: randomBytes(18).toString('hex') });
  await wait(() => keyboardQA.channels.filter((channel) => channel.readyState === 'open').length === 2);
  await click('button', '新建窗口');
  await fill('.address-form input', fixtureOrigin);
  await page.keyboard.press('Enter');

  const ready = () =>
    wait(() => {
      const element = document.querySelector('.remote-viewport');
      const canvas = element?.querySelector('canvas[data-video-input]');
      const clip = element?.querySelector('.remote-video-plane');
      const video = clip?.querySelector('video');
      if (
        !canvas ||
        canvas.classList.contains('no-frame') ||
        element.classList.contains('resize-waiting') ||
        !(video?.videoWidth > 0)
      )
        return false;
      const style = getComputedStyle(clip);
      return (
        style.visibility === 'visible' && Number(style.opacity) > 0 && clip.getBoundingClientRect().width > 0
      );
    });
  const sample = () =>
    page.evaluate(() => {
      const section = document.querySelector('.remote-viewport');
      const editor = section?.querySelector('textarea');
      const video = section?.querySelector('video');
      const overlay = document.querySelector('.remote-resize-freeze');
      const bounds = (element) => element?.getBoundingClientRect().toJSON() ?? null;
      const overlayStyle = overlay && getComputedStyle(overlay);
      const {
        id,
        peers: [peer],
        channels,
        wire,
        events,
      } = keyboardQA;
      const { epochs, waitingEntries } = keyboardQA;
      return {
        focus: !!editor && document.activeElement === editor,
        inputMode: editor?.inputMode,
        viewport: bounds(section),
        shell: bounds(document.querySelector('.viewer-shell')),
        scroll: [scrollX, scrollY],
        epochs,
        waitingEntries,
        waiting: section?.classList.contains('resize-waiting'),
        video: id(video),
        stream: id(video?.srcObject),
        peer: id(peer),
        peerCount: keyboardQA.peers.length,
        connected: peer?.connectionState,
        tracks: peer?.getReceivers().map((x) => id(x.track)),
        channels: channels.map((x) => [id(x), x.readyState]),
        events: events.slice(-20),
        wire: wire.slice(-30),
        overlay: overlay
          ? {
              bounds: bounds(overlay),
              filter: overlayStyle.filter,
              animation: overlayStyle.animationName,
              targetWidth: parseFloat(overlayStyle.width),
              targetHeight: parseFloat(overlayStyle.height),
              parentOverflow: getComputedStyle(overlay.parentElement).overflow,
              width: overlay.width,
              height: overlay.height,
            }
          : null,
      };
    });
  const identity = (first, latest) =>
    latest.connected === 'connected' &&
    latest.peerCount === 1 &&
    ['video', 'stream', 'peer', 'tracks', 'channels'].every(
      (key) => JSON.stringify(first[key]) === JSON.stringify(latest[key]),
    );
  const observe = async (predicate, message) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const event = fixtureEvents.findLast(predicate);
      if (event) return event;
      await pause(75);
    }
    throw Error(message);
  };
  const point = async (target, offsetX = 0.5, offsetY = 0.5) => {
    const remote = await observe((event) => !!event.geometry?.[target], 'Fixture did not provide geometry');
    const box = remote.geometry[target];
    const { viewport } = await sample();
    return {
      x: viewport.x + ((box.x + box.width * offsetX) * viewport.width) / remote.width,
      y: viewport.y + ((box.y + box.height * offsetY) * viewport.height) / remote.height,
    };
  };
  const tap = async (target) => {
    const { x, y } = await point(target);
    await wait(({ x, y }) => document.elementFromPoint(x, y)?.matches('canvas[data-video-input]'), { x, y });
    await page.touchscreen.tap(x, y);
  };
  const resize = (height) => page.evaluate((value) => keyboardQA.resize(value), height);
  const text = (field, value) =>
    observe(
      (event) => event.type === field && event[field] === value,
      'Fixture did not receive ' + field + '=' + value,
    );
  const screenshot = (name) => page.screenshot({ path: join(run, name + '.png') });
  const snapshotReady = () =>
    wait(() => {
      const presentation = keyboardQA.session()?.presentation;
      const view = presentation?.layout?.views[0];
      return view && presentation.getLastPresentation(view.id);
    });

  await ready();
  await observe((event) => event.type === 'ready', 'Remote fixture did not load');
  await ready();
  await tap('text');
  await wait(
    () =>
      document.activeElement?.classList.contains('remote-input') &&
      document.activeElement.inputMode === 'text',
  );
  await page.keyboard.insertText('before');
  await text('text', 'before');
  const before = await sample();
  await log('before', before);
  const targetA = before.wire.findLast((event) => event.type === 'input.editable' && event.target)?.target;
  assert(targetA, 'No editable target A observed');

  const cdp = await context.newCDPSession(page);
  let localCompositionMode = 'cdp';
  const startComposition = async (value) => {
    if (localCompositionMode === 'cdp') {
      try {
        await cdp.send('Input.imeSetComposition', {
          text: value,
          selectionStart: value.length,
          selectionEnd: value.length,
        });
        return;
      } catch (error) {
        if (!String(error.message).includes("'Input.imeSetComposition' wasn't found")) throw error;
        localCompositionMode = 'synthetic-dom';
      }
    }
    await page.evaluate((value) => {
      const target = document.activeElement;
      if (!target?.classList.contains('remote-input')) throw Error('Remote input is not focused');
      for (const [type, data] of [
        ['compositionstart', ''],
        ['compositionupdate', value],
      ]) {
        target.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
      }
    }, value);
  };
  await startComposition('dur');
  await log('composition-capability', { localCompositionMode, remoteComposition: 'native' });
  await wait(() => keyboardQA.events.some((event) => event.type === 'compositionstart'));
  await observe(
    (event) => event.type === 'compositionstart' && event.field === 'text',
    'Remote composition did not start',
  );
  await snapshotReady();
  await resize(665);
  await wait(() => document.querySelector('.remote-viewport')?.classList.contains('resize-waiting'));
  await resize(625);
  await pause(60);
  const firstPeek = await sample();
  await log('keyboard-first-peek', firstPeek);
  assert(
    firstPeek.focus &&
      firstPeek.overlay &&
      firstPeek.overlay.filter === 'none' &&
      firstPeek.overlay.parentOverflow === 'hidden' &&
      Math.abs(
        firstPeek.overlay.bounds.width / firstPeek.overlay.bounds.height -
          before.viewport.width / before.viewport.height,
      ) < 0.01 &&
      Math.abs(firstPeek.overlay.bounds.top - before.viewport.top) < 1,
    'Keyboard peek lost focus, top anchor or aspect ratio',
  );
  await screenshot('keyboard-peek');
  await ready();
  await observe(
    (event) => event.type === 'resize' && event.height < before.viewport.height,
    'Remote layout did not resize with active composition',
  );
  assert(
    !fixtureEvents.some((event) => event.type === 'compositionend'),
    'Remote composition ended on resize before the local commit',
  );
  const composing = await sample();
  assert(
    composing.wire.findLast((event) => event.type === 'input.editable' && event.target)?.target === targetA,
    'Resize changed the active editable target',
  );
  await log('remote-composition-still-active', composing);
  await resize(520);
  await wait(() => document.querySelector('.remote-viewport')?.classList.contains('resize-waiting'));
  if (localCompositionMode === 'cdp') {
    await cdp.send('Input.insertText', { text: 'during' });
  } else {
    await page.evaluate(() => {
      const target = document.activeElement;
      if (!target?.classList.contains('remote-input')) throw Error('Remote input is not focused');
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'during' }));
    });
  }
  const middle = await sample();
  await log('keyboard-first-step', middle);
  assert(middle.focus, 'Resize removed local editor focus');
  await pause(60);
  const peek = await sample();
  await log('keyboard-peek', peek);
  assert(
    peek.focus &&
      identity(before, peek) &&
      peek.overlay &&
      peek.overlay.filter === 'none' &&
      Math.abs(
        peek.overlay.bounds.width / peek.overlay.bounds.height -
          composing.viewport.width / composing.viewport.height,
      ) < 0.01 &&
      Math.abs(peek.overlay.bounds.top - before.viewport.top) < 1,
    'Keyboard peek lost focus, media, top anchor or aspect ratio',
  );
  await screenshot('keyboard-peek-commit');
  await ready();
  await text('text', 'beforeduring');
  await page.keyboard.insertText('after');
  await text('text', 'beforeduringafter');
  const settled = await sample();
  await log('keyboard-ready', settled);
  assert(settled.focus && identity(before, settled), 'Local focus or media identity changed');
  assert(
    settled.events.filter((event) => event.type === 'focusout').length ===
      before.events.filter((event) => event.type === 'focusout').length,
    'Keyboard transition emitted a local blur',
  );
  const composition = fixtureEvents.filter(
    (event) => event.field === 'text' && event.type.startsWith('composition'),
  );
  const delivery = fixtureEvents
    .filter((event) => event.type === 'text')
    .map((event) => ({ text: event.text, selection: event.selection }));
  const editPackets = await page.evaluate(() => keyboardQA.editPackets);
  await log('remote-editing', {
    composition: composition.map((event) => [event.type, event.data]),
    delivery,
    editPackets,
  });
  assert(
    composition.filter((event) => event.type === 'compositionend').length === 1 &&
      editPackets.filter((packet) => packet.event.type === 'ime_commit' && packet.event.text === 'during')
        .length === 1 &&
      delivery.at(-1)?.text === 'beforeduringafter',
    'Expected exactly one composition commit and end with the final value',
  );

  const resizeCount = () => fixtureEvents.filter((event) => event.type === 'resize').length;
  const beforeOffset = await sample();
  const remoteResizeCount = resizeCount();
  assert(beforeOffset.epochs.length > 0, 'No authoritative layout epoch observed');
  const offsetEvidence = [];
  const near = (a, b) => Math.abs(a - b) < 1;
  for (const offset of [8, 16, 0]) {
    await page.evaluate((offset) => keyboardQA.scroll(offset, offset / 2), offset);
    await pause(150);
    const moved = await sample();
    offsetEvidence.push({
      offset,
      shell: moved.shell,
      viewport: moved.viewport,
      scroll: moved.scroll,
      epochs: moved.epochs,
      waitingEntries: moved.waitingEntries,
      remoteResizeCount: resizeCount(),
    });
    assert(
      near(moved.shell.top - beforeOffset.shell.top, offset) &&
        near(moved.shell.left - beforeOffset.shell.left, offset / 2) &&
        near(moved.viewport.top - beforeOffset.viewport.top, offset) &&
        near(moved.viewport.left - beforeOffset.viewport.left, offset / 2) &&
        near(moved.shell.width, beforeOffset.shell.width) &&
        near(moved.shell.height, beforeOffset.shell.height) &&
        near(moved.viewport.width, beforeOffset.viewport.width) &&
        near(moved.viewport.height, beforeOffset.viewport.height) &&
        moved.scroll.every((value) => value === 0),
      'Visual viewport scroll did not only translate the Viewer shell',
    );
    assert(
      moved.focus &&
        identity(before, moved) &&
        !moved.waiting &&
        moved.waitingEntries === beforeOffset.waitingEntries &&
        resizeCount() === remoteResizeCount &&
        JSON.stringify(moved.epochs) === JSON.stringify(beforeOffset.epochs),
      'Visual viewport scroll changed focus, media or remote layout',
    );
  }
  await log('visual-viewport-offset-only', offsetEvidence);

  await resize(655);
  await pause(60);
  await resize(null);
  await ready();
  const restored = await sample();
  await log('keyboard-restored', restored);
  assert(
    identity(before, restored) && Math.abs(restored.viewport.height - before.viewport.height) < 1,
    'Restoring visual viewport changed size or media identity',
  );
  const wireStart = await page.evaluate(() => keyboardQA.wire.length);
  await tap('second');
  await wait(
    ({ target, start }) =>
      keyboardQA.wire
        .slice(start)
        .some(
          (event) =>
            event.type === 'input.editable' &&
            event.editable > 0 &&
            event.target &&
            event.target !== '0' &&
            event.target !== target,
        ) &&
      document.activeElement?.classList.contains('remote-input') &&
      document.activeElement.inputMode === 'text',
    { target: targetA, start: wireStart },
  );
  await page.keyboard.insertText('B');
  await text('second', 'B');
  // Keep the live envelope and sequence, substituting only the previous editable target.
  await page.evaluate((target) => {
    keyboardQA.staleTarget = target;
  }, targetA);
  await page.keyboard.insertText('reject');
  await wait(() => !!keyboardQA.staleReply);
  const rejection = await page.evaluate(() => keyboardQA.staleReply);
  assert(
    rejection.ok === false &&
      rejection.error?.code === 'conflict' &&
      rejection.error?.message === 'Editable input target changed',
    'Unexpected stale-target response: ' + JSON.stringify(rejection),
  );
  await page.keyboard.insertText('C');
  await text('second', 'BC');
  assert(
    !fixtureEvents.some((event) => event.type === 'second' && event.second.includes('reject')),
    'Stale target modified field B',
  );
  const stale = await page.evaluate(() => keyboardQA.staleSent);
  assert(
    stale.original !== targetA && stale.substituted === targetA,
    'Stale-target probe did not replace target B',
  );
  await log('target-switch', { stale, rejection, sample: await sample() });
  await tap('tl');
  await observe((event) => event.type === 'blur' && event.field === 'second', 'Fixture did not blur');
  await wait(
    () =>
      !document.activeElement?.classList.contains('remote-input') &&
      document.querySelector('.remote-input')?.inputMode === 'none',
  );
  await log('remote-blur', await sample());

  await snapshotReady();
  await Promise.all([
    wait(() => !!document.querySelector('.remote-resize-freeze')),
    page.setViewportSize({ width: 900, height: 690 }),
  ]);
  const resized = await sample();
  await log('ordinary-resize', resized);
  assert(
    resized.overlay?.filter.includes('blur') &&
      resized.overlay.animation === 'remote-resize-stretch' &&
      Math.abs(
        resized.overlay.targetWidth / resized.overlay.targetHeight -
          before.viewport.width / before.viewport.height,
      ) > 0.015,
    'Ordinary resize did not display a blurred and stretched last frame',
  );
  await screenshot('ordinary-resize');
  await ready();
  const final = await sample();
  await log('ordinary-ready', final);
  assert(identity(before, final) && !final.focus, 'Ordinary resize changed media identity or stole focus');

  const siteSwitches = () =>
    page.evaluate(() => {
      const menu = document.querySelector('[aria-label="网页兼容性处理"]');
      return {
        checks: Object.fromEntries(
          [...menu.querySelectorAll('[role=menuitemcheckbox]')].map((item) => [
            item.textContent.trim(),
            item.getAttribute('aria-checked'),
          ]),
        ),
        inputs: menu.querySelectorAll('input[type=checkbox]').length,
      };
    });
  const toggleManualKeyboard = async (enabled) => {
    await click('button[aria-label="更多"]');
    await click('[role=menuitem]', '网页兼容性处理');
    await wait(() => !!document.querySelector('[aria-label="网页兼容性处理"]'));
    const initial = await siteSwitches();
    assert(
      initial.checks['使用平板版网站'] === 'false' && initial.inputs === 2,
      'Compatibility submenu is missing an independent site switch',
    );
    assert(
      initial.checks['不自动弹出键盘'] === String(!enabled),
      'Unexpected initial manual keyboard preference',
    );
    await click('[aria-label="网页兼容性处理"] [role=menuitemcheckbox]', '不自动弹出键盘');
    await wait((enabled) => {
      const item = [
        ...document.querySelectorAll('[aria-label="网页兼容性处理"] [role=menuitemcheckbox]'),
      ].find((element) => element.textContent.trim() === '不自动弹出键盘');
      return (
        item?.getAttribute('aria-checked') === String(enabled) &&
        item.getAttribute('aria-disabled') !== 'true'
      );
    }, enabled);
    assert(
      (await siteSwitches()).checks['使用平板版网站'] === initial.checks['使用平板版网站'],
      'Manual keyboard switch changed tablet UA',
    );
    if (enabled) await screenshot('site-compatibility-menu');
    await page.keyboard.press('Escape');
    await wait(() => !document.querySelector('.MuiPopover-root'));
  };
  const hiddenKeyboard = () =>
    wait(
      () =>
        !document.activeElement?.classList.contains('remote-input') &&
        document.querySelector('.remote-open-keyboard')?.textContent.trim() === '显示键盘' &&
        !document.querySelector('.remote-open-keyboard').disabled,
    );
  const shownKeyboard = () =>
    wait(
      () =>
        document.activeElement?.classList.contains('remote-input') &&
        document.querySelector('.remote-open-keyboard')?.textContent.trim() === '隐藏键盘',
    );
  const localFocusCount = () =>
    page.evaluate(() => keyboardQA.events.filter((event) => event.type === 'focusin').length);
  const afterFixture = (start, predicate, message) =>
    observe((event) => fixtureEvents.indexOf(event) >= start && predicate(event), message);
  const initialDocument = fixtureEvents.find((event) => event.type === 'ready').documentId;
  await toggleManualKeyboard(true);
  const manualStart = fixtureEvents.length;
  await tap('third');
  await afterFixture(
    manualStart,
    (event) => event.type === 'focus' && event.field === 'third',
    'Manual mode did not allow remote focus',
  );
  await hiddenKeyboard();
  const manualBefore = await sample();
  await screenshot('manual-keyboard-hidden');
  await click('.remote-open-keyboard', '显示键盘');
  await shownKeyboard();
  await screenshot('manual-keyboard-shown');
  await startComposition('manual');
  await afterFixture(
    manualStart,
    (event) => event.type === 'compositionupdate' && event.field === 'third' && event.data === 'manual',
    'Native composition did not update before manual hide',
  );
  await click('.remote-open-keyboard', '隐藏键盘');
  await hiddenKeyboard();
  await text('third', 'manual');
  await afterFixture(
    manualStart,
    (event) => event.type === 'compositionend' && event.field === 'third' && event.data === 'manual',
    'Manual hide did not finish the original native composition',
  );
  const focusAfterHide = await localFocusCount();
  await tap('third');
  const manualResizeStart = fixtureEvents.length;
  await resize(640);
  await ready();
  await afterFixture(
    manualResizeStart,
    (event) => event.type === 'resize' && event.height < final.viewport.height,
    'Remote layout did not resize in manual mode',
  );
  await hiddenKeyboard();
  await resize(null);
  await ready();
  await hiddenKeyboard();
  const manualRetained = await sample();
  const currentTarget = (state) =>
    state.wire.findLast((event) => event.type === 'input.editable' && event.editable > 0)?.target;
  assert(
    currentTarget(manualBefore) && currentTarget(manualRetained) === currentTarget(manualBefore),
    'The active editable changed during repeated manual focus and resize',
  );
  const switchStart = fixtureEvents.length;
  await tap('second');
  await afterFixture(
    switchStart,
    (event) => event.type === 'focus' && event.field === 'second',
    'Manual mode did not reach a new target',
  );
  await hiddenKeyboard();
  assert(
    (await localFocusCount()) === focusAfterHide,
    'Manual touch or resize reopened the local keyboard after hide',
  );
  await toggleManualKeyboard(false);
  const autoStart = fixtureEvents.length;
  await tap('text');
  await afterFixture(
    autoStart,
    (event) => event.type === 'focus' && event.field === 'text',
    'Auto mode did not reach a new target',
  );
  // A desktop Viewer can expose a coarse pointer without a physical soft keyboard.
  await wait(
    () =>
      document.activeElement?.classList.contains('remote-input') &&
      document.activeElement.inputMode === 'text',
  );
  await tap('tl');
  await afterFixture(
    autoStart,
    (event) => event.type === 'blur' && event.field === 'text',
    'Auto mode did not observe remote blur',
  );
  await wait(
    () =>
      !document.activeElement?.classList.contains('remote-input') &&
      !document.querySelector('.remote-open-keyboard'),
  );
  const keyboardAfterMenu = await sample();
  const manualCommits = await page.evaluate(
    () =>
      keyboardQA.editPackets.filter(
        (packet) => packet.event.type === 'ime_commit' && packet.event.text === 'manual',
      ).length,
  );
  assert(
    manualCommits === 1 &&
      fixtureEvents
        .slice(manualStart)
        .filter((event) => event.type === 'compositionend' && event.field === 'third').length === 1,
    'Manual hide should commit the current composition exactly once',
  );
  assert(
    fixtureEvents.filter((event) => event.type === 'ready').length === 1 &&
      fixtureEvents.every((event) => event.documentId === initialDocument) &&
      identity(before, keyboardAfterMenu),
    'Manual-only site updates navigated the remote page or changed the peer',
  );
  await log('manual-keyboard-compatibility', {
    manualBefore,
    manualRetained,
    keyboardAfterMenu,
    manualCommits,
    initialDocument,
  });

  const gesture = (type, touchPoints = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const touchMark = () => page.evaluate(() => keyboardQA.touchWire.length);
  const touchRecords = (mark) => page.evaluate((mark) => keyboardQA.touchWire.slice(mark), mark);
  const tapAndWait = async () => {
    const start = fixtureEvents.length;
    await tap('tl');
    await afterFixture(
      start,
      (event) => event.type === 'click' && event.trusted,
      'Touch tap did not deliver a trusted remote click',
    );
  };
  await tapAndWait();
  await tapAndWait();

  const contactsStart = fixtureEvents.length;
  const multiMark = await touchMark();
  const finger1 = { ...(await point('contacts', 0.25)), id: 1 };
  const finger2 = { ...(await point('contacts', 0.75)), id: 2 };
  await gesture('touchStart', [finger1, finger2]);
  await afterFixture(
    contactsStart,
    (event) => event.type === 'touchstart' && event.trusted && event.active.length === 2,
    'Two-finger start did not reach the remote fixture',
  );
  // A populated touchEnd releases the specified contact. The empty final touchEnd releases the rest.
  await gesture('touchEnd', [finger2]);
  const partialEnd = await afterFixture(
    contactsStart,
    (event) => event.type === 'touchend' && event.trusted && event.active.length === 1,
    'Partial release did not preserve one remote touch',
  );
  await gesture('touchMove', [{ ...finger1, y: finger1.y + 24 }]);
  const remainingMove = await afterFixture(
    contactsStart,
    (event) =>
      event.type === 'touchmove' &&
      event.trusted &&
      event.active.length === 1 &&
      event.changed[0] === partialEnd.active[0],
    'Remaining contact did not deliver a remote move',
  );
  await gesture('touchEnd');
  await afterFixture(
    contactsStart,
    (event) =>
      event.type === 'touchend' &&
      event.trusted &&
      event.active.length === 0 &&
      event.changed[0] === remainingMove.changed[0],
    'Final release did not end the remote touch',
  );
  const multiWire = (await touchRecords(multiMark)).filter((event) => event.type === 'input');
  assert(
    JSON.stringify(multiWire.map((event) => event.action)) ===
      JSON.stringify(['start', 'start', 'end', 'move', 'end']) &&
      new Set(multiWire.map((event) => event.id)).size === 1 &&
      multiWire[2].points[0] === multiWire[1].points[0] &&
      multiWire[3].points[0] === multiWire[0].points[0] &&
      multiWire[4].points[0] === multiWire[0].points[0],
    'Viewer wire did not retain one gesture through partial release and final end',
  );
  await log('two-finger-partial-release', { partialEnd, remainingMove, multiWire });

  const dragMark = await touchMark();
  const dragStart = fixtureEvents.length;
  const drag = { ...(await point('scroll', 0.65, 0.23)), id: 1 };
  await gesture('touchStart', [drag]);
  for (const delta of [25, 50, 75, 100, 125, 150]) {
    await pause(16);
    await gesture('touchMove', [{ ...drag, y: drag.y - delta }]);
  }
  await pause(130);
  await gesture('touchEnd');
  const remoteScroll = await afterFixture(
    dragStart,
    (event) => event.type === 'scroll' && event.scrollY > 30,
    'Trusted remote drag did not scroll the fixture',
  );
  await tapAndWait();
  await log('remote-touch-scroll', { remoteScroll, wire: await touchRecords(dragMark) });

  const successiveMark = await touchMark();
  const clickStart = fixtureEvents.length;
  await tap('tl');
  await tap('tl');
  await afterFixture(
    clickStart,
    () => fixtureEvents.slice(clickStart).filter((event) => event.type === 'click').length === 2,
    'Successive taps did not deliver exactly two remote clicks',
  );
  const successiveWire = (await touchRecords(successiveMark)).filter((event) => event.type === 'input');
  assert(
    JSON.stringify(successiveWire.map((event) => event.action)) ===
      JSON.stringify(['start', 'end', 'start', 'end']) &&
      new Set(successiveWire.map((event) => event.id)).size === 2,
    'Successive taps did not retain distinct touch sequences',
  );
  const afterTouch = await sample();
  assert(
    identity(before, afterTouch) && afterTouch.scroll.every((value) => value === 0),
    'Touch handling lost the original peer or scrolled the Viewer',
  );
  await log('successive-touch', { successiveWire, afterTouch });

  // Follow actual local editor focus with synthetic keyboard occlusion. A
  // remote search field that remounts on resize must not drive a feedback loop.
  const previousDocument = fixtureEvents.findLast((event) => event.type === 'ready').documentId;
  await fill('.address-form input', fixtureOrigin + '/?replace-search');
  await page.keyboard.press('Enter');
  const searchPage = await observe(
    (event) => event.type === 'ready' && event.documentId !== previousDocument,
    'Search replacement fixture did not load',
  );
  await wait(
    (url) => keyboardQA.state?.workspace.tabs.some((tab) => tab.url === url && !tab.loading),
    fixtureOrigin + '/?replace-search',
  );
  await ready();
  const openHeight = 520;
  const searchStart = fixtureEvents.length;
  await page.evaluate((openHeight) => {
    keyboardQA.keyboardFeedback = {
      openHeight,
      closedHeight: visualViewport.height,
      wireStart: keyboardQA.wire.length,
      focus: [],
      geometry: [],
    };
  }, openHeight);
  await tap('text');
  await observe(
    (event) => event.type === 'search-replaced' && event.documentId === searchPage.documentId,
    'Keyboard occlusion did not replace the focused search input',
  );
  await ready();
  await pause(1300);
  const afterSearch = await sample();
  const readSearchFeedback = () =>
    page.evaluate(() => {
      const { focus, geometry, wireStart, closedHeight, graceInput } = keyboardQA.keyboardFeedback;
      return {
        focus,
        geometry,
        closedHeight,
        graceInput,
        wire: keyboardQA.wire.slice(wireStart),
        gracePackets: keyboardQA.editPackets.filter((packet) => packet.event.text === 'grace probe'),
      };
    });
  const searchFeedback = await readSearchFeedback();
  const searchEvents = fixtureEvents
    .slice(searchStart)
    .filter((event) => event.documentId === searchPage.documentId);
  const replacements = searchEvents.filter((event) => event.type === 'search-replaced');
  const searchEditors = searchFeedback.wire.filter(
    (event) => event.type === 'input.editable' && event.editable > 0,
  );
  const searchResizes = searchEvents.filter((event) => event.type === 'resize');
  await log('search-resize-feedback', { feedback: searchFeedback, replacements, searchResizes, afterSearch });
  assert(
    replacements.length === 1 &&
      searchResizes.length === 1 &&
      searchFeedback.geometry.length === 1 &&
      searchFeedback.geometry[0].height === openHeight &&
      searchFeedback.focus.length === 1 &&
      searchFeedback.focus[0].type === 'focusin' &&
      afterSearch.focus &&
      afterSearch.inputMode === 'search' &&
      searchEditors.length > 1 &&
      searchEditors[0].target !== searchEditors.at(-1).target &&
      !searchFeedback.gracePackets.length &&
      identity(before, afterSearch),
    'Search replacement caused focus or viewport oscillation, delivered text during blur, or lost the new editor',
  );
  await page.keyboard.insertText('replacement editor');
  await text('text', 'replacement editor');
  await screenshot('search-replacement-stable');
  await tap('tl');
  await wait(
    () =>
      !document.activeElement?.classList.contains('remote-input') &&
      !document.querySelector('.remote-open-keyboard'),
  );
  await wait(() => keyboardQA.keyboardFeedback.geometry.length >= 2);
  await ready();
  const searchBlur = await readSearchFeedback();
  assert(
    searchBlur.geometry.length === 2 &&
      searchBlur.geometry[1].height === searchBlur.closedHeight &&
      searchBlur.focus.length === 2 &&
      searchBlur.focus[1].type === 'focusout' &&
      identity(before, await sample()),
    'Persistent remote blur did not close and restore the simulated keyboard once',
  );
  await log('search-resize-blur', searchBlur);
  await screenshot('search-blur');
} catch (error) {
  await log('failure', { message: error.message, stack: error.stack });
  if (page) {
    const probe = await page
      .evaluate(
        () =>
          window.keyboardQA && {
            touchWire: keyboardQA.touchWire,
            epochs: keyboardQA.epochs,
            waitingEntries: keyboardQA.waitingEntries,
            wire: keyboardQA.wire.slice(-60),
            session: (() => {
              const session = keyboardQA.session();
              return (
                session && {
                  layout: session.presentation.layout,
                  input: session.input.inputTrace,
                  results: session.input.inputResults,
                  editing: session.editing.getSnapshot(),
                }
              );
            })(),
          },
      )
      .catch(() => undefined);
    if (probe) await log('failure-probe', probe);
  }
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
