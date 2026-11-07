#!/usr/bin/env node
// Drive any Chromium build (including the Chrome 89 compatibility target) over the DevTools
// protocol for Viewer UI QA: launch an isolated profile, then evaluate, send real input events
// and take screenshots from separate invocations against the same debugging port.
//
//   node tools/cdp.mjs launch --chrome <exe> --profile <dir> [--port 9333] [--size 1280x800] <url>
//   node tools/cdp.mjs eval "<expression>"           (awaits promises, prints JSON)
//   node tools/cdp.mjs nav <url>
//   node tools/cdp.mjs click <x> <y> [--hold <ms>]   (mouse, CSS px of the viewport)
//   node tools/cdp.mjs tap <x> <y> [--hold <ms>]     (touch; enables touch emulation first)
//   node tools/cdp.mjs key <Key> [...]               (DOM key names, e.g. Escape ArrowUp)
//   node tools/cdp.mjs type <text>                   (inserts text into the focused field)
//   node tools/cdp.mjs shot <out.png> [--clip x,y,w,h]
//   node tools/cdp.mjs close
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const [, value] = args.splice(index, 2);
  return value;
};
const port = Number(option("port", process.env.REMOTEKIT_CDP_PORT ?? "9333"));
const command = args.shift();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function endpoint(browser) {
  const base = `http://127.0.0.1:${port}`;
  if (browser)
    return (await (await fetch(`${base}/json/version`)).json())
      .webSocketDebuggerUrl;
  const targets = await (await fetch(`${base}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error(`no page target on port ${port}`);
  return page.webSocketDebuggerUrl;
}

async function connect(browser = false) {
  const socket = new WebSocket(await endpoint(browser));
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("DevTools connection failed"));
  });
  let next = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

async function evaluate(send, expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (exceptionDetails)
    throw new Error(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  return result.value;
}

async function pointer(send, kind, x, y, hold) {
  if (kind === "touch") {
    await send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    const point = [{ x, y, id: 1 }];
    await send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point,
    });
    await sleep(hold);
    await send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    return;
  }
  const base = { x, y, button: "left", clickCount: 1 };
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await sleep(hold);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
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

if (command === "launch") {
  const chrome = option("chrome");
  const profile = option("profile");
  const [width, height] = option("size", "1280x800").split("x").map(Number);
  if (!chrome || !profile)
    throw new Error("launch needs --chrome and --profile");
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Keep the page visible and focused while other windows cover it or the session is RDP.
      "--disable-features=Translate,CalculateNativeWinOcclusion",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      args[0] ?? "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const version = await (
        await fetch(`http://127.0.0.1:${port}/json/version`)
      ).json();
      console.log(`${version.Browser} pid=${child.pid} port=${port}`);
      process.exit(0);
    } catch {
      await sleep(200);
    }
  }
  throw new Error("browser did not expose the debugging port");
}

const { send, close } = await connect(command === "close");
try {
  if (command === "eval") {
    console.log(JSON.stringify(await evaluate(send, args.join(" ")), null, 2));
  } else if (command === "nav") {
    await send("Page.enable");
    await send("Page.navigate", { url: args[0] });
  } else if (command === "click" || command === "tap") {
    const hold = Number(option("hold", "60"));
    await pointer(
      send,
      command === "tap" ? "touch" : "mouse",
      Number(args[0]),
      Number(args[1]),
      hold,
    );
  } else if (command === "key") {
    for (const key of args) {
      const code = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
      const event = {
        key,
        code: key,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
      };
      // Enter needs its character so forms submit; the other named keys produce none.
      if (key === "Enter")
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          text: "\r",
          ...event,
        });
      else
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    }
  } else if (command === "type") {
    await send("Input.insertText", { text: args.join(" ") });
  } else if (command === "shot") {
    const clip = option("clip");
    const params = { format: "png" };
    if (clip) {
      const [x, y, width, height] = clip.split(",").map(Number);
      params.clip = { x, y, width, height, scale: 1 };
    }
    const { data } = await send("Page.captureScreenshot", params);
    writeFileSync(args[0], Buffer.from(data, "base64"));
    console.log(args[0]);
  } else if (command === "close") {
    await send("Browser.close");
  } else {
    throw new Error(`unknown command ${command}`);
  }
} finally {
  close();
}
