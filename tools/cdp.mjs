#!/usr/bin/env node
// Drive any Chromium build (including the Chrome 89 compatibility target) over the DevTools
// protocol for Viewer UI QA: launch an isolated profile, then evaluate, send real input events
// and take screenshots from separate invocations against the same debugging port.
//
//   node tools/cdp.mjs launch --chrome <exe> --profile <dir> [--port 9333] [--size 1280x800] <url> [chrome flags]
//   node tools/cdp.mjs eval "<expression>"           (awaits promises, prints JSON)
//   node tools/cdp.mjs nav <url>
//   node tools/cdp.mjs click <x> <y> [--hold <ms>]   (mouse, CSS px of the viewport)
//   node tools/cdp.mjs tap <x> <y> [--hold <ms>]     (touch; enables touch emulation first)
//   node tools/cdp.mjs drag <x1> <y1> <x2> <y2> [--steps 12] [--hold <ms before release>]
//   node tools/cdp.mjs key <Key> [...]               (DOM key names, e.g. Escape ArrowUp)
//   node tools/cdp.mjs type <text>                   (inserts text into the focused field)
//   node tools/cdp.mjs upload <selector> <file> [...] (sets a file input; fires change)
//   node tools/cdp.mjs shot <out.png> [--clip x,y,w,h]
//   node tools/cdp.mjs close
import { launchTestBrowser } from '../tests/e2e/kit/browser.mjs';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function endpoint(browser, port) {
  const base = `http://127.0.0.1:${port}`;
  if (browser) return (await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl;
  const targets = await (await fetch(`${base}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error(`no page target on port ${port}`);
  return page.webSocketDebuggerUrl;
}

export async function cdpConnect(url, { timeoutMs = 15000 } = {}) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('DevTools connection timeout'));
      socket.close();
    }, timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    socket.onopen = () => finish();
    socket.onerror = () => finish(new Error('DevTools connection failed'));
    socket.onclose = () => finish(new Error('DevTools connection closed'));
  });
  let next = 0;
  const pending = new Map();
  const rejectPending = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  let closed;
  const closedPromise = new Promise((resolve) => (closed = resolve));
  socket.onclose = () => {
    rejectPending(new Error('CDP closed'));
    closed();
  };
  socket.onerror = () => rejectPending(new Error('CDP connection failed'));
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  return {
    closed: closedPromise,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (socket.readyState !== 1) return reject(new Error('CDP closed'));
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    close() {
      rejectPending(new Error('CDP closed'));
      socket.close();
    },
  };
}

async function evaluate(send, expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function pointer(send, kind, x, y, hold) {
  if (kind === 'touch') {
    await send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    const point = [{ x, y, id: 1 }];
    await send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: point,
    });
    await sleep(hold);
    await send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    return;
  }
  const base = { x, y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(hold);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

const KEY_CODES = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const [, value] = args.splice(index, 2);
    return value;
  };
  const port = Number(option('port', process.env.REMOTEKIT_CDP_PORT ?? '9333'));
  const command = args.shift();

  if (command === 'launch') {
    const chrome = option('chrome');
    const profile = option('profile');
    const [width, height] = option('size', '1280x800').split('x').map(Number);
    if (!chrome || !profile) throw new Error('launch needs --chrome and --profile');
    const child = await launchTestBrowser({
      profile,
      executablePath: chrome,
      args: [
        `--remote-debugging-port=${port}`,
        `--window-size=${width},${height}`,
        '--no-first-run',
        '--no-default-browser-check',
        // Keep the page visible and focused while other windows cover it or the session is RDP.
        '--disable-features=Translate,CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        ...args.slice(1),
        args[0] ?? 'about:blank',
      ],
      spawnOptions: { detached: true, stdio: 'ignore' },
    });
    child.unref();
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        console.log(`${version.Browser} pid=${child.pid} port=${port}`);
        process.exit(0);
      } catch {
        await sleep(200);
      }
    }
    throw new Error('browser did not expose the debugging port');
  }

  const { send, close } = await cdpConnect(await endpoint(command === 'close', port));
  try {
    if (command === 'eval') {
      console.log(JSON.stringify(await evaluate(send, args.join(' ')), null, 2));
    } else if (command === 'nav') {
      await send('Page.enable');
      await send('Page.navigate', { url: args[0] });
    } else if (command === 'click' || command === 'tap') {
      const hold = Number(option('hold', '60'));
      await pointer(send, command === 'tap' ? 'touch' : 'mouse', Number(args[0]), Number(args[1]), hold);
    } else if (command === 'drag') {
      const [x1, y1, x2, y2] = args.map(Number);
      const steps = Number(option('steps', '12'));
      const base = { button: 'left', clickCount: 1 };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, ...base });
      for (let step = 1; step <= steps; step++) {
        const x = x1 + ((x2 - x1) * step) / steps;
        const y = y1 + ((y2 - y1) * step) / steps;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 1, button: 'left' });
        await sleep(30);
      }
      await sleep(Number(option('hold', '0')));
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, ...base });
    } else if (command === 'key') {
      for (const key of args) {
        const code = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
        const event = {
          key,
          code: key,
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
        };
        // Enter needs its character so forms submit; the other named keys produce none.
        if (key === 'Enter')
          await send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            text: '\r',
            ...event,
          });
        else await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
      }
    } else if (command === 'type') {
      await send('Input.insertText', { text: args.join(' ') });
    } else if (command === 'upload') {
      const [selector, ...files] = args;
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`no element matches ${selector}`);
      await send('DOM.setFileInputFiles', { nodeId, files: files.map((file) => resolve(file)) });
    } else if (command === 'shot') {
      const clip = option('clip');
      const params = { format: 'png' };
      if (clip) {
        const [x, y, width, height] = clip.split(',').map(Number);
        params.clip = { x, y, width, height, scale: 1 };
      }
      const { data } = await send('Page.captureScreenshot', params);
      writeFileSync(args[0], Buffer.from(data, 'base64'));
      console.log(args[0]);
    } else if (command === 'close') {
      await send('Browser.close');
    } else {
      throw new Error(`unknown command ${command}`);
    }
  } finally {
    close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
