/**
 * Real H264 keyboard regression on an isolated loopback instance.
 * node tools/test-keyboard-viewport.mjs <playwright module path> <viewer exe> <endpoint exe> <remote browser exe> <unused output dir> [port]
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const [playwright, viewer, endpoint, browser, output, listenPort = '33781'] = process.argv.slice(2);
if (![playwright, viewer, endpoint, browser, output].every(Boolean)) {
  throw Error('Expected Playwright module, Viewer exe, Endpoint exe, RemoteKit Browser exe and an unused output directory');
}
const root = fileURLToPath(new URL('../', import.meta.url));
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
        if (body.length > 65536) { response.writeHead(413).end(); return; }
      }
      const event = JSON.parse(body);
      fixtureEvents.push(event);
      if (fixtureEvents.length > 2048) fixtureEvents.shift();
      await appendFile(join(run, 'fixture-events.jsonl'), JSON.stringify(event) + '\n');
      response.end();
    } catch { response.writeHead(400).end(); }
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(fixturePage);
});
await new Promise((accept, reject) => {
  fixture.once('error', reject);
  fixture.listen(port + 1, '127.0.0.1', accept);
});

const control = spawn(process.execPath, [join(root, 'control/dist/server.mjs')], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: {
    ...process.env,
    PORT: String(port),
    REMOTEKIT_CONTROL_ORIGINS: origin,
    REMOTEKIT_CONTROL_DB: join(run, 'control.db'),
    REMOTEKIT_ENDPOINT: resolve(endpoint),
    REMOTEKIT_ENDPOINT_ARGS: JSON.stringify(['--browser=' + resolve(browser), '--data-path=' + join(run, 'endpoint')]),
  },
});
control.stdout.on('data', data => void appendFile(join(run, 'control.stdout.log'), data));
control.stderr.on('data', data => void appendFile(join(run, 'control.stderr.log'), data));
const stopped = new Promise((accept, reject) => {
  control.once('exit', accept);
  control.once('error', reject);
});
void stopped.catch(() => {});
await writeFile(join(run, 'service.json'), JSON.stringify({ controlPid:control.pid, viewer:resolve(viewer), endpoint:resolve(endpoint), browser:resolve(browser), port }, null, 2));

const log = async (stage, value) => {
  await appendFile(join(run, 'keyboard-results.jsonl'), JSON.stringify({stage, value}) + '\n');
  console.log(stage);
};
const assert = (condition, message) => { if (!condition) throw Error(message); };
const pause = ms => new Promise(accept => setTimeout(accept, ms));

let context, page;
const deadline = setTimeout(() => void context?.close().catch(() => {}), 120000);
try {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(origin + '/api/auth/registration', {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
    if (response?.ok && (await response.json()).hasAdmin === false) break;
    assert(attempt < 50 && control.exitCode === null, 'Fresh isolated Control did not start');
    await pause(100);
  }
  context = await chromium.launchPersistentContext(join(run, 'viewer-profile'), {
    executablePath: resolve(viewer), headless:false, viewport:{width:1152, height:820},
    deviceScaleFactor:1, hasTouch:true, reducedMotion:'no-preference', timeout:15000,
    args:['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
  });
  page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(5000);
  await page.addInitScript(() => {
    const viewport = visualViewport;
    const nativeHeight = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'height').get;
    const probe = window.keyboardQA = { height:null, events:[], wire:[], peers:[], channels:[], editPackets:[] };
    const ids = new WeakMap();
    let nextId = 0;
    probe.id = value => {
      if (!value) return null;
      if (!ids.has(value)) ids.set(value, ++nextId);
      return ids.get(value);
    };
    Object.defineProperty(viewport, 'height', { get:() => probe.height ?? nativeHeight.call(viewport) });
    probe.resize = height => {
      probe.height = height;
      viewport.dispatchEvent(new Event('resize'));
    };
    for (const type of ['focusin', 'focusout', 'input', 'compositionstart', 'compositionend']) {
      document.addEventListener(type, event => {
        if (event.target.matches?.('.remote-input')) {
          probe.events.push({type, at:performance.now(), trusted:event.isTrusted});
        }
      }, true);
    }
    const record = (message, direction) => {
      if (message.type === 'input.result' && probe.staleSent && message.clientSequence === probe.staleSent.sequence) {
        probe.staleReply = {sequence:message.clientSequence, ok:message.ok, error:message.error};
      }
      if (!['focus', 'input.editable'].includes(message.type)) return;
      probe.wire.push({type:message.type, direction, at:performance.now(), focus:message.focus,
        epoch:message.layoutEpoch, request:message.focusRequestId, editable:message.editable?.type,
        target:message.editable?.target, focused:message.focused, revision:message.revision});
    };
    const nativeSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(raw) {
      if (typeof raw === 'string' && this.label !== 'remotekit-auth') {
        try {
          const message = JSON.parse(raw);
          record(message, 'out');
          if (message.type === 'input' && ['ime_set', 'ime_commit'].includes(message.event?.type) && probe.editPackets.length < 1024) {
            const {type, text, editableTarget} = message.event;
            probe.editPackets.push({sequence:message.sequence, event:{type, text, editableTarget}});
          }
          if (probe.staleTarget && message.type === 'input' && message.event?.editableTarget) {
            probe.staleSent = {original:message.event.editableTarget, substituted:probe.staleTarget, sequence:message.sequence, epoch:message.layoutEpoch};
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
        if (channel.label !== 'remotekit-auth') channel.addEventListener('message', event => {
          try { record(JSON.parse(event.data), 'in'); } catch {}
        });
        return channel;
      }
    };
  });
  await page.goto(origin, {timeout:12000});

  const wait = (fn, arg) => page.waitForFunction(fn, arg, {timeout:10000});
  const click = async (css, text) => {
    const point = await (await wait(({css, text}) => {
      const button = [...document.querySelectorAll(css)].find(el => el.textContent.trim() === text && !el.disabled);
      const box = button?.getBoundingClientRect();
      return box?.width && { x:box.x + box.width / 2, y:box.y + box.height / 2 };
    }, {css, text})).jsonValue();
    await page.mouse.click(point.x, point.y);
  };
  const fill = async (css, value) => {
    await page.focus(css);
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(value);
  };
  await wait(() => !!document.querySelector('.viewer-lock-blank'));
  for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight']) {
    await page.keyboard.press(key);
  }
  await click('button', '创建账户');
  await fill('input[autocomplete="username"]', 'keyboard-qa');
  await fill('input[autocomplete="new-password"]', randomBytes(18).toString('hex'));
  await click('button[type="submit"]', '创建账户');
  await wait(() => keyboardQA.channels.filter(channel => channel.readyState === 'open').length === 2);
  await click('button', '新建窗口');
  await fill('.address-form input', fixtureOrigin);
  await page.keyboard.press('Enter');

  const ready = () => wait(() => {
    const element = document.querySelector('.remote-viewport');
    const canvas = element?.querySelector('canvas[data-video-input]');
    const clip = element?.querySelector('.remote-video-plane');
    const video = clip?.querySelector('video');
    if (!canvas || canvas.classList.contains('no-frame') || element.classList.contains('resize-waiting') || !(video?.videoWidth > 0)) return false;
    const style = getComputedStyle(clip);
    return style.visibility === 'visible' && Number(style.opacity) > 0 && clip.getBoundingClientRect().width > 0;
  });
  const sample = () => page.evaluate(() => {
    const section = document.querySelector('.remote-viewport');
    const editor = section?.querySelector('textarea');
    const video = section?.querySelector('video');
    const overlay = document.querySelector('.remote-resize-freeze');
    const bounds = element => element?.getBoundingClientRect().toJSON() ?? null;
    const overlayStyle = overlay && getComputedStyle(overlay);
    const { id, peers:[peer], channels, wire, events } = keyboardQA;
    return {focus:!!editor && document.activeElement === editor, inputMode:editor?.inputMode, viewport:bounds(section),
      waiting:section?.classList.contains('resize-waiting'), video:id(video), stream:id(video?.srcObject), peer:id(peer),
      peerCount:keyboardQA.peers.length, connected:peer?.connectionState, tracks:peer?.getReceivers().map(x => id(x.track)),
      channels:channels.map(x => [id(x), x.readyState]), events:events.slice(-20), wire:wire.slice(-30),
      overlay:overlay ? {bounds:bounds(overlay), filter:overlayStyle.filter, animation:overlayStyle.animationName,
        targetWidth:parseFloat(overlayStyle.width), targetHeight:parseFloat(overlayStyle.height),
        parentOverflow:getComputedStyle(overlay.parentElement).overflow, width:overlay.width, height:overlay.height} : null};
  });
  const identity = (first, latest) => latest.connected === 'connected' && latest.peerCount === 1 &&
    ['video', 'stream', 'peer', 'tracks', 'channels'].every(key => JSON.stringify(first[key]) === JSON.stringify(latest[key]));
  const observe = async (predicate, message) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const event = fixtureEvents.findLast(predicate);
      if (event) return event;
      await pause(75);
    }
    throw Error(message);
  };
  const tap = async target => {
    const remote = await observe(event => !!event.geometry?.[target], 'Fixture did not provide geometry');
    const box = remote.geometry[target];
    const {viewport} = await sample();
    await page.touchscreen.tap(viewport.x + (box.x + box.width / 2) * viewport.width / remote.width,
      viewport.y + (box.y + box.height / 2) * viewport.height / remote.height);
  };
  const resize = height => page.evaluate(value => keyboardQA.resize(value), height);
  const text = (field, value) => observe(event => event.type === field && event[field] === value,
    'Fixture did not receive ' + field + '=' + value);
  const screenshot = name => page.screenshot({path:join(run, name + '.png')});

  await ready();
  await observe(event => event.type === 'ready', 'Remote fixture did not load');
  await ready();
  await tap('text');
  await wait(() => document.activeElement?.classList.contains('remote-input') && document.activeElement.inputMode === 'text');
  await page.keyboard.insertText('before');
  await text('text', 'before');
  const before = await sample();
  await log('before', before);
  const targetA = before.wire.findLast(event => event.type === 'input.editable' && event.target)?.target;
  assert(targetA, 'No editable target A observed');

  const cdp = await context.newCDPSession(page);
  let localCompositionMode = 'cdp';
  try {
    await cdp.send('Input.imeSetComposition', {text:'dur', selectionStart:3, selectionEnd:3});
  } catch (error) {
    if (!String(error.message).includes("'Input.imeSetComposition' wasn't found")) throw error;
    localCompositionMode = 'synthetic-dom';
    await page.evaluate(() => {
      const target = document.activeElement;
      if (!target?.classList.contains('remote-input')) throw Error('Remote input is not focused');
      for (const [type, data] of [['compositionstart', ''], ['compositionupdate', 'dur']]) {
        target.dispatchEvent(new CompositionEvent(type, {bubbles:true, data}));
      }
    });
  }
  await log('composition-capability', {localCompositionMode, remoteComposition:'native'});
  await wait(() => keyboardQA.events.some(event => event.type === 'compositionstart'));
  await observe(event => event.type === 'compositionstart' && event.field === 'text', 'Remote composition did not start');
  await resize(665);
  await wait(() => document.querySelector('.remote-viewport')?.classList.contains('resize-waiting'));
  await resize(625);
  await pause(60);
  const firstPeek = await sample();
  await log('keyboard-first-peek', firstPeek);
  assert(firstPeek.focus && firstPeek.overlay && firstPeek.overlay.filter === 'none' && firstPeek.overlay.parentOverflow === 'hidden' &&
    Math.abs(firstPeek.overlay.bounds.width / firstPeek.overlay.bounds.height - before.viewport.width / before.viewport.height) < 0.01 &&
    Math.abs(firstPeek.overlay.bounds.top - before.viewport.top) < 1, 'Keyboard peek lost focus, top anchor or aspect ratio');
  await screenshot('keyboard-peek');
  await ready();
  await observe(event => event.type === 'resize' && event.height < before.viewport.height, 'Remote layout did not resize with active composition');
  assert(!fixtureEvents.some(event => event.type === 'compositionend'), 'Remote composition ended on resize before the local commit');
  const composing = await sample();
  assert(composing.wire.findLast(event => event.type === 'input.editable' && event.target)?.target === targetA,
    'Resize changed the active editable target');
  await log('remote-composition-still-active', composing);
  await resize(520);
  await wait(() => document.querySelector('.remote-viewport')?.classList.contains('resize-waiting'));
  if (localCompositionMode === 'cdp') {
    await cdp.send('Input.insertText', {text:'during'});
  } else {
    await page.evaluate(() => {
      const target = document.activeElement;
      if (!target?.classList.contains('remote-input')) throw Error('Remote input is not focused');
      target.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true, data:'during'}));
    });
  }
  const middle = await sample();
  await log('keyboard-first-step', middle);
  assert(middle.focus, 'Resize removed local editor focus');
  await pause(60);
  const peek = await sample();
  await log('keyboard-peek', peek);
  assert(peek.focus && identity(before, peek) && peek.overlay && peek.overlay.filter === 'none' &&
    Math.abs(peek.overlay.bounds.width / peek.overlay.bounds.height - composing.viewport.width / composing.viewport.height) < 0.01 &&
    Math.abs(peek.overlay.bounds.top - before.viewport.top) < 1, 'Keyboard peek lost focus, media, top anchor or aspect ratio');
  await screenshot('keyboard-peek-commit');
  await ready();
  await text('text', 'beforeduring');
  await page.keyboard.insertText('after');
  await text('text', 'beforeduringafter');
  const settled = await sample();
  await log('keyboard-ready', settled);
  assert(settled.focus && identity(before, settled), 'Local focus or media identity changed');
  assert(settled.events.filter(event => event.type === 'focusout').length === before.events.filter(event => event.type === 'focusout').length,
    'Keyboard transition emitted a local blur');
  const composition = fixtureEvents.filter(event => event.field === 'text' && event.type.startsWith('composition'));
  const delivery = fixtureEvents.filter(event => event.type === 'text').map(event => ({text:event.text, selection:event.selection}));
  const editPackets = await page.evaluate(() => keyboardQA.editPackets);
  await log('remote-editing', {composition:composition.map(event => [event.type, event.data]), delivery, editPackets});
  assert(composition.filter(event => event.type === 'compositionend').length === 1 &&
    editPackets.filter(packet => packet.event.type === 'ime_commit' && packet.event.text === 'during').length === 1 &&
    delivery.at(-1)?.text === 'beforeduringafter', 'Expected exactly one composition commit and end with the final value');

  await resize(655);
  await pause(60);
  await resize(null);
  await ready();
  const restored = await sample();
  await log('keyboard-restored', restored);
  assert(restored.focus && identity(before, restored) && Math.abs(restored.viewport.height - before.viewport.height) < 1,
    'Restoring visual viewport changed focus, size, or media identity');
  const wireStart = await page.evaluate(() => keyboardQA.wire.length);
  await tap('second');
  await wait(({target, start}) => keyboardQA.wire.slice(start).some(event => event.type === 'input.editable' &&
    event.editable > 0 && event.target && event.target !== '0' && event.target !== target) &&
    document.activeElement?.classList.contains('remote-input') && document.activeElement.inputMode === 'text',
    {target:targetA, start:wireStart});
  await page.keyboard.insertText('B');
  await text('second', 'B');
  // Keep the live envelope and sequence, substituting only the previous editable target.
  await page.evaluate(target => { keyboardQA.staleTarget = target; }, targetA);
  await page.keyboard.insertText('reject');
  await wait(() => !!keyboardQA.staleReply);
  const rejection = await page.evaluate(() => keyboardQA.staleReply);
  assert(rejection.ok === false && rejection.error?.includes('Editable input target changed'),
    'Unexpected stale-target response: ' + JSON.stringify(rejection));
  await page.keyboard.insertText('C');
  await text('second', 'BC');
  assert(!fixtureEvents.some(event => event.type === 'second' && event.second.includes('reject')), 'Stale target modified field B');
  const stale = await page.evaluate(() => keyboardQA.staleSent);
  assert(stale.original !== targetA && stale.substituted === targetA, 'Stale-target probe did not replace target B');
  await log('target-switch', {stale, rejection, sample:await sample()});
  await tap('tl');
  await observe(event => event.type === 'blur' && event.field === 'second', 'Fixture did not blur');
  await wait(() => !document.activeElement?.classList.contains('remote-input') && document.querySelector('.remote-input')?.inputMode === 'none');
  await log('remote-blur', await sample());

  await page.setViewportSize({width:900, height:690});
  await wait(() => !!document.querySelector('.remote-resize-freeze'));
  const resized = await sample();
  await log('ordinary-resize', resized);
  assert(resized.overlay?.filter.includes('blur') && resized.overlay.animation === 'remote-resize-stretch' &&
    Math.abs(resized.overlay.targetWidth / resized.overlay.targetHeight - before.viewport.width / before.viewport.height) > 0.015,
    'Ordinary resize did not display a blurred and stretched last frame');
  await screenshot('ordinary-resize');
  await ready();
  const final = await sample();
  await log('ordinary-ready', final);
  assert(identity(before, final) && !final.focus, 'Ordinary resize changed media identity or stole focus');
} catch (error) {
  await log('failure', {message:error.message, stack:error.stack});
  await page?.screenshot({path:join(run, 'failure.png'), timeout:3000}).catch(() => {});
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try {
    await context?.close();
  } finally {
    if (control.connected) control.disconnect();
    fixture.closeAllConnections();
    await new Promise(accept => fixture.close(accept));
    await stopped;
  }
}
