import { launchPersistentViewer } from './kit/viewer.mjs';

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStack } from './kit/stack.mjs';
import { registerViewer } from './kit/viewer.mjs';
/**
 * H264 mobile IME regression with a desktop Chromium renderer, CDP preedit,
 * and synthetic Android-style geometry. Chrome 89 uses DOM composition events;
 * newer Viewers use Input.imeSetComposition.
 * node tests/e2e/test-mobile-ime.mjs <playwright module> <viewer exe> <endpoint exe> <remote browser exe> <unused output dir> [port]
 */

const [playwright, viewer, endpoint, browser, output, listenPort = '34120'] = process.argv.slice(2);
if (![playwright, viewer, endpoint, browser, output].every(Boolean)) {
  throw Error(
    'Expected Playwright module, Viewer exe, Endpoint exe, RemoteKit Browser exe and an unused output directory',
  );
}
const run = resolve(output);
const port = Number(listenPort);
const origin = 'http://127.0.0.1:' + port;
const fixtureOrigin = 'http://127.0.0.1:' + (port + 1);

await mkdir(run, { recursive: true });

const fixtureEvents = [];

const stack = await startStack({
  seed: false,
  fixtures: { kind: 'test-mobile-ime', context: { fixtureEvents } },
  ports: { control: port + 3, viewer: port, fixture: port + 1, peer: port + 2 },
  run,
  port,
  endpoint,
  browser,
});
const log = async (stage, value) => {
  await appendFile(join(run, 'keyboard-results.jsonl'), JSON.stringify({ stage, value }) + '\n');
  console.log(stage);
};
const assert = (condition, message) => {
  if (!condition) throw Error(message);
};
const pause = (ms) => new Promise((accept) => setTimeout(accept, ms));

let context, page;
const deadline = setTimeout(() => void context?.close().catch(() => {}), 300000);
try {
  context = await launchPersistentViewer(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer),
    headless: true,
    viewport: { width: 820, height: 1040 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'no-preference',
    timeout: 45000,
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
  });
  page = context.pages()[0] ?? (await context.newPage());
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.method === 'viewport')
        void appendFile(join(run, 'viewport-requests.jsonl'), JSON.stringify(message) + '\n');
    });
  });
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
      epochs: [],
    });
    const ids = new WeakMap();
    let nextId = 0;
    probe.id = (value) => {
      if (!value) return null;
      if (!ids.has(value)) ids.set(value, ++nextId);
      return ids.get(value);
    };
    const nativeHeight = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'height').get;
    Object.defineProperty(viewport, 'height', {
      get: () => probe.viewport.height ?? nativeHeight.call(viewport),
    });
    probe.resize = (height) => {
      probe.viewport.height = height;
      viewport.dispatchEvent(new Event('resize'));
    };
    probe.animateHeight = (kind, value) => {
      const feedback = probe.keyboardFeedback;
      feedback.geometry.push({ kind, height: value, at: performance.now() });
      if (kind === 'innerHeight') {
        Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => value });
        window.dispatchEvent(new Event('resize'));
      } else probe.resize(value);
    };
    for (const type of [
      'focusin',
      'focusout',
      'beforeinput',
      'input',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'keydown',
      'keyup',
    ]) {
      document.addEventListener(
        type,
        (event) => {
          if (event.target.matches?.('.remote-input')) {
            probe.events.push({
              type,
              at: performance.now(),
              trusted: event.isTrusted,
              key: event.key,
              keyCode: event.keyCode,
              inputType: event.inputType,
              isComposing: event.isComposing,
              cancelable: event.cancelable,
              data: event.data,
            });
            const feedback = probe.keyboardFeedback;
            if (!feedback?.armed || (type !== 'focusin' && type !== 'focusout')) return;
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
      if (feedback.geometry.length > 0 && !feedback.graceInput && message.editable?.type === 0) {
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
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 45000 });
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
    await page.focus(css);
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(value);
  };
  await wait(() => !!document.querySelector('.viewer-lock-blank'));
  await pause(650);
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
    await pause(55);
  }
  await registerViewer({ click, fill, username: 'keyboard-qa', password: randomBytes(18).toString('hex') });
  await wait(() => keyboardQA.channels.filter((channel) => channel.readyState === 'open').length === 2);
  await click('button', '打开开始屏幕');
  await fill('.launcher-search input', fixtureOrigin + '/?replace-search');
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
      const { id, peers, channels, wire, events, epochs } = keyboardQA;
      const [peer] = peers;
      return {
        focus: !!editor && document.activeElement === editor,
        inputMode: editor?.inputMode,
        viewport: section?.getBoundingClientRect().toJSON(),
        epochs,
        video: id(video),
        stream: id(video?.srcObject),
        peer: id(peer),
        peerCount: peers.length,
        connected: peer?.connectionState,
        tracks: peer?.getReceivers().map((x) => id(x.track)),
        channels: channels.map((x) => [id(x), x.readyState]),
        events: events.slice(-20),
        wire: wire.slice(-30),
      };
    });
  const identity = (first, latest) =>
    latest.connected === 'connected' &&
    latest.peerCount === first.peerCount &&
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
  const tap = async (target) => {
    const remote = await observe((event) => !!event.geometry?.[target], 'Fixture did not provide geometry');
    const box = remote.geometry[target];
    const { viewport } = await sample();
    const scale = viewport.width / remote.width;
    const x = viewport.x + (box.x + box.width / 2) * scale;
    const y = viewport.y + (box.y + box.height / 2) * scale;
    await wait(({ x, y }) => document.elementFromPoint(x, y)?.matches('canvas[data-video-input]'), { x, y });
    await page.touchscreen.tap(x, y);
  };
  const text = (field, value) =>
    observe(
      (event) => event.type === field && event[field] === value,
      'Fixture did not receive ' + field + '=' + value,
    );
  const screenshot = (name) => page.screenshot({ path: join(run, name + '.png') });

  await ready();
  await observe((event) => event.type === 'ready', 'Remote search fixture did not load');
  await ready();
  const baseline = await sample();
  const platform = await page.evaluate(() => ({
    ua: navigator.userAgent,
    touch: navigator.maxTouchPoints,
    coarse: matchMedia('(pointer: coarse)').matches,
    dpr: devicePixelRatio,
    innerHeight,
    vvHeight: visualViewport.height,
    vvWidth: visualViewport.width,
  }));
  await log('mobile-emulation', { platform, baseline });
  assert(
    platform.touch > 0 && platform.coarse && Math.abs(platform.dpr - 2) < 0.01,
    'Mobile emulation was not active',
  );
  const cdp = await context.newCDPSession(page);
  const version = await cdp.send('Browser.getVersion');
  await log('browser-version', version.product);
  await tap('text');
  await wait(
    () => document.activeElement?.matches('.remote-input') && document.activeElement.inputMode === 'search',
  );
  const first = (await sample()).wire.findLast(
    (event) => event.type === 'input.editable' && event.editable > 0,
  )?.target;
  assert(first, 'First touch did not grant a remote editable target');
  await page.evaluate(() => {
    keyboardQA.keyboardFeedback = {
      openHeight: 620,
      closedHeight: visualViewport.height,
      focus: [],
      geometry: [],
      armed: false,
    };
  });
  const ime229 = async (operation) => {
    const key = { key: 'Unidentified', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 };
    await cdp.send('Input.dispatchKeyEvent', { ...key, type: 'rawKeyDown' });
    try {
      await operation();
    } finally {
      await cdp.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
    }
  };
  const domComposition = /\/89\./.test(version.product);
  await log('composition-driver', domComposition ? 'DOM composition events' : 'CDP IME');
  let composing = false;
  const compose = (text, commit) =>
    ime229(async () => {
      if (domComposition) {
        await page.evaluate(
          ({ text, commit, begin }) => {
            const editor = document.activeElement;
            if (!editor?.matches('.remote-input')) throw Error('Composition proxy is not focused');
            const emit = (type, data) =>
              editor.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
            if (begin) emit('compositionstart', '');
            editor.value = text;
            editor.setSelectionRange(text.length, text.length);
            emit(commit ? 'compositionend' : 'compositionupdate', text);
            editor.dispatchEvent(
              new InputEvent('input', {
                bubbles: true,
                data: text,
                inputType: commit ? 'insertFromComposition' : 'insertCompositionText',
                isComposing: !commit,
              }),
            );
          },
          { text, commit, begin: !composing },
        );
      } else if (commit) await cdp.send('Input.insertText', { text });
      else
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
      composing = !commit;
    });
  const preedit = (text) => compose(text, false);
  const commit = (text) => compose(text, true);
  const from = fixtureEvents.length;
  await preedit('ni');
  await observe(
    (event) =>
      fixtureEvents.indexOf(event) >= from && event.type === 'compositionupdate' && event.data === 'ni',
    'Initial local CDP preedit did not reach the original remote target',
  );
  await preedit('你好');
  await observe(
    (event) =>
      fixtureEvents.indexOf(event) >= from && event.type === 'compositionupdate' && event.data === '你好',
    'Updated local CDP preedit did not reach the original remote target',
  );
  const wireStart = await page.evaluate(() => keyboardQA.wire.length);
  await page.evaluate(() => {
    keyboardQA.keyboardFeedback.armed = true;
  });
  for (const [kind, height] of [
    ['visualViewport', 900],
    ['innerHeight', 925],
    ['visualViewport', 795],
    ['innerHeight', 820],
    ['visualViewport', 690],
    ['innerHeight', 690],
    ['visualViewport', 620],
  ]) {
    await page.evaluate(([kind, height]) => keyboardQA.animateHeight(kind, height), [kind, height]);
    await pause(25);
  }
  await observe(
    (event) => event.type === 'search-replaced',
    'Resize did not replace the focused search input',
  );
  await ready();
  await pause(1800);
  const feedback = await page.evaluate(() => {
    const { geometry, focus, graceInput } = keyboardQA.keyboardFeedback;
    const gracePackets = keyboardQA.editPackets.filter((packet) => packet.event.text === 'grace probe');
    return { geometry, focus, graceInput, gracePackets };
  });
  const remount = await sample();
  assert(remount.epochs.at(-1) === baseline.epochs.at(-1), 'Keyboard occlusion rebuilt the output layout');
  const remountWire = await page.evaluate((from) => keyboardQA.wire.slice(from), wireStart);
  const replacementTarget = remountWire.findLast(
    (event) => event.type === 'input.editable' && event.editable > 0,
  )?.target;
  await log('mobile-ime-remount', { first, replacementTarget, feedback, remount, remountWire });
  await screenshot('mobile-ime-remount');
  assert(
    remount.focus &&
      feedback.focus.length === 0 &&
      feedback.geometry.length === 7 &&
      replacementTarget &&
      replacementTarget !== first &&
      !feedback.gracePackets.length &&
      identity(baseline, remount),
    'The first-touch keyboard moved focus during the remote resize/remount',
  );
  await commit('你好');
  await pause(120);
  const oldCommit = await page.evaluate(() =>
    keyboardQA.editPackets.filter(
      (packet) => packet.event.type === 'ime_commit' && packet.event.text === '你好',
    ),
  );
  await log('old-composition-commit', oldCommit);
  assert(!oldCommit.length, 'Old local CDP composition committed into the replacement target');
  const latest = fixtureEvents.findLast((event) => event.type === 'search-replaced');
  const nextStart = fixtureEvents.length;
  await preedit('xin');
  await observe(
    (event) =>
      fixtureEvents.indexOf(event) >= nextStart && event.type === 'compositionupdate' && event.data === 'xin',
    'Replacement target did not receive new CDP composition',
  );
  await preedit('新');
  await observe(
    (event) =>
      fixtureEvents.indexOf(event) >= nextStart && event.type === 'compositionupdate' && event.data === '新',
    'Replacement target did not receive new preedit update',
  );
  await commit('新');
  const caret = fixtureEvents
    .slice(0, fixtureEvents.indexOf(latest))
    .findLast((event) => event.type === 'focus' && event.field === 'text').selection[0];
  const committed = latest.text.slice(0, caret) + '新' + latest.text.slice(caret);
  await observe(
    (event) =>
      fixtureEvents.indexOf(event) >= nextStart &&
      event.type === 'compositionend' &&
      event.data === '新' &&
      event.text === committed,
    'Replacement target did not confirm the new composition',
  );
  const newCommits = await page.evaluate(() =>
    keyboardQA.editPackets.filter(
      (packet) => packet.event.type === 'ime_commit' && packet.event.text === '新',
    ),
  );
  assert(
    newCommits.length === 1 && newCommits[0].event.editableTarget === replacementTarget,
    'The new composition did not commit exactly once to the replacement target',
  );
  await log('mobile-ime-replacement-commit', {
    sample: await sample(),
    events: fixtureEvents.slice(nextStart),
    newCommits,
  });
  await screenshot('mobile-ime-replacement-commit');
  // Android Back can close the IME without blurring the HTML editing proxy.
  // Restore layout and visible heights independently while retaining DOM focus.
  const backStart = await page.evaluate(() => keyboardQA.keyboardFeedback.focus.length);
  await page.evaluate(() => {
    const feedback = keyboardQA.keyboardFeedback;
    keyboardQA.animateHeight('innerHeight', feedback.closedHeight);
    keyboardQA.animateHeight('visualViewport', feedback.closedHeight);
  });
  await ready();
  await wait(() => document.querySelector('.remote-open-keyboard')?.textContent.trim() === '显示键盘');
  await pause(230);
  const afterBack = await page.evaluate(() => ({
    focus: document.activeElement?.matches('.remote-input'),
    focusCount: keyboardQA.keyboardFeedback.focus.length,
    height: visualViewport.height,
    expected: keyboardQA.keyboardFeedback.closedHeight,
  }));
  assert(
    afterBack.focus && afterBack.focusCount === backStart && afterBack.height === afterBack.expected,
    'Simulated Back moved DOM focus or automatically reopened the IME',
  );
  await log('mobile-ime-system-back', afterBack);
  await click('.remote-open-keyboard', '显示键盘');
  await wait(
    () =>
      document.querySelector('.remote-open-keyboard')?.textContent.trim() === '隐藏键盘' &&
      visualViewport.height === keyboardQA.keyboardFeedback.openHeight,
  );
  await ready();
  await log('mobile-ime-manual-reopen', await sample());
  const blurStart = await page.evaluate(() => keyboardQA.wire.length);
  await tap('tl');
  await wait(
    (start) =>
      keyboardQA.wire.slice(start).some((event) => event.type === 'input.editable' && event.editable === 0),
    blurStart,
  );
  await wait(
    () => !document.activeElement?.matches('.remote-input') || document.activeElement.inputMode === 'none',
  );
  await ready();
  await tap('second');
  await wait(
    () => document.activeElement?.matches('.remote-input') && document.activeElement.inputMode === 'text',
  );
  await page.keyboard.insertText('Latin resumes');
  await text('second', 'Latin resumes');
  const end = await sample();
  assert(identity(baseline, end), 'Mobile IME reconnect changed media identity');
  await log('mobile-ime-post-blur-latin', end);
  const trace = await page.evaluate(() => ({
    events: keyboardQA.events,
    epochs: keyboardQA.epochs,
    wire: keyboardQA.wire,
    editPackets: keyboardQA.editPackets,
  }));
  await writeFile(join(run, 'mobile-ime-trace.json'), JSON.stringify(trace, null, 2));
} catch (error) {
  await log('failure', { message: error.message, stack: error.stack });
  if (page) {
    const probe = await page
      .evaluate(
        () =>
          window.keyboardQA && {
            events: keyboardQA.events,
            epochs: keyboardQA.epochs,
            wire: keyboardQA.wire.slice(-60),
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
    await stack.stop();
  }
}
