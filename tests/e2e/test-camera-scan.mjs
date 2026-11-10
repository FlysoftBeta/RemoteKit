/** Real fake-camera capture, document processing, rotation and native FileList delivery. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instrumentViewer } from "./cluster-test-support.mjs";
import { startProductStack, until } from "./kit/stack.mjs";

const [
  modulePath,
  viewerExe,
  endpoint,
  browser,
  output,
  listenPort = "33791",
  server,
] = process.argv.slice(2);
assert([modulePath, viewerExe, endpoint, browser, output].every(Boolean));
const run = resolve(output);
const port = Number(listenPort);
const origin = `http://127.0.0.1:${port}`;
const fixtureOrigin = `http://127.0.0.1:${port + 1}`;
await mkdir(run, { recursive: true });

function cameraFile(sample) {
  const source = fileURLToPath(
    new URL(`./fixtures/camera-scan-${sample}.jpg`, import.meta.url),
  );
  const target = join(run, `camera-${sample}.y4m`);
  const ffmpeg = process.env.REMOTEKIT_FFMPEG ?? "ffmpeg";
  if (
    spawnSync(ffmpeg, ["-version"], { windowsHide: true, stdio: "ignore" })
      .status === 0
  ) {
    execFileSync(
      ffmpeg,
      [
        "-y",
        "-i",
        source,
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
        "-frames:v",
        "1",
        "-r",
        "30",
        "-pix_fmt",
        "yuv420p",
        target,
      ],
      { windowsHide: true, stdio: "pipe" },
    );
  } else {
    const python =
      process.env.REMOTEKIT_CAMERA_PYTHON ??
      fileURLToPath(
        new URL(
          "../../develop/tmp/doc-scan/exp/venv/Scripts/python.exe",
          import.meta.url,
        ),
      );
    execFileSync(
      python,
      [
        "-c",
        `
import cv2, pathlib, sys
image = cv2.imread(sys.argv[1])
height, width = image.shape[:2]
scale = max(1920 / width, 1080 / height)
image = cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_CUBIC)
y, x = (image.shape[0] - 1080) // 2, (image.shape[1] - 1920) // 2
frame = cv2.cvtColor(image[y:y + 1080, x:x + 1920], cv2.COLOR_BGR2YUV_I420)
pathlib.Path(sys.argv[2]).write_bytes(b'YUV4MPEG2 W1920 H1080 F30:1 Ip A1:1 C420jpeg\\nFRAME\\n' + frame.tobytes())
`,
        source,
        target,
      ],
      { windowsHide: true, stdio: "pipe" },
    );
  }
  return target;
}
const cameras = new Map([3, 4].map((sample) => [sample, cameraFile(sample)]));
const events = [];
const results = [];
const rpcEvidence = [];
const fixture = createServer(async (request, response) => {
  if (request.method === "POST") {
    let body = "";
    for await (const bytes of request) body += bytes;
    events.push(JSON.parse(body));
    return response.end("ok");
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    .end(`<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Camera scan selection</title>
    <style>body{font:18px system-ui;margin:24px;background:#eaf2fc}input{display:block;margin:24px 0;height:44px;width:320px}</style>
    <h1>Camera scan selection</h1>
    <input id="single" type="file" accept="image/png">
    <input id="multiple" type="file" accept="image/*" multiple>
    <script>
      const report = event => fetch('/event', {method:'POST', body:JSON.stringify(event)});
      const inputs = [...document.querySelectorAll('input')];
      const geometry = () => report({type:'geometry', width:innerWidth, height:innerHeight,
        boxes:Object.fromEntries(inputs.map(input => [input.id, input.getBoundingClientRect().toJSON()]))});
      geometry(); addEventListener('resize', geometry);
      for (const input of inputs) input.onchange = async event => {
        const files = await Promise.all([...input.files].map(async file => {
          try {
            const bitmap = await createImageBitmap(file);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const drawing = canvas.getContext('2d'); drawing.drawImage(bitmap, 0, 0);
            const pixel = [...drawing.getImageData(0, 0, 1, 1).data];
            bitmap.close();
            return {name:file.name, type:file.type, size:file.size,
              width:canvas.width, height:canvas.height, pixel};
          } catch (error) { return {name:file.name, type:file.type, error:String(error)}; }
        }));
        await report({type:'selected', id:input.id, trusted:event.isTrusted, files});
        input.value = '';
      };
    </script>`);
});
await new Promise((done) => fixture.listen(port + 1, "127.0.0.1", done));
const control = startProductStack({
  run,
  port,
  endpoint,
  browser,
  ...(server ? { server: resolve(server) } : {}),
});
for (const stream of ["stdout", "stderr"]) {
  control[stream].on(
    "data",
    (bytes) => void appendFile(join(run, `control.${stream}.log`), bytes),
  );
}
const stopped = new Promise((done) => control.once("exit", done));
const { chromium } = createRequire(import.meta.url)(resolve(modulePath));
const password = randomUUID();
let chrome;
let viewer;
let registered = false;
let win;

async function stage(name, work) {
  const started = Date.now();
  const evidence = await work();
  results.push({ name, durationMs: Date.now() - started, ...evidence });
  await writeFile(join(run, "results.json"), JSON.stringify(results, null, 2));
  console.log(name, JSON.stringify(evidence));
}
async function saveRPCs() {
  if (viewer) rpcEvidence.push(...(await viewer.page.evaluate(() => cameraQA)));
}
async function openViewer(sample) {
  if (viewer) await saveRPCs();
  await chrome?.close();
  viewer = undefined;
  chrome = await chromium.launch({
    executablePath: resolve(viewerExe),
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${cameras.get(sample)}`,
      "--use-fake-ui-for-media-stream",
    ],
  });
  const context = await chrome.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const response = await context.request.post(
    origin + `/api/auth/${registered ? "login" : "setup"}`,
    {
      headers: { Origin: origin },
      data: { username: "camera-scan", password },
    },
  );
  assert.equal(response.status(), 200, await response.text());
  registered = true;
  await context.addInitScript(() => {
    window.cameraQA = [];
    window.cameraRotationClicks = [];
    document.addEventListener("click", (event) => {
      const item = event.target.closest('[role="menuitem"]');
      if (item?.textContent === "向右旋转") {
        cameraRotationClicks.push({
          at: performance.now(),
          trusted: event.isTrusted,
        });
      }
    });
    const send = RTCDataChannel.prototype.send;
    const observed = new WeakSet();
    RTCDataChannel.prototype.send = function (data) {
      if (!observed.has(this)) {
        observed.add(this);
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const reply = JSON.parse(event.data);
          const record = cameraQA.find(
            (item) => item.request.requestId === reply.requestId,
          );
          if (record) {
            record.reply = reply;
            record.receivedAt = performance.now();
          }
        });
      }
      if (typeof data === "string") {
        const message = JSON.parse(data);
        if (message.method === "photo.process")
          cameraQA.push({ request: message, sentAt: performance.now() });
      }
      return send.call(this, data);
    };
  });
  viewer = await instrumentViewer(
    context,
    run,
    `sample-${sample}-${Date.now()}`,
  );
  await viewer.page.goto(origin);
  await viewer.ready();
  await viewer.call("auth.settings", {
    currentPassword: password,
    settings: { lockOnHidden: false, lockOnIdle: false },
  });
  if (!win) {
    await viewer.action({
      type: "window.open",
      appId: "browser",
      placement: { mode: "space" },
    });
    win = (await viewer.state()).workspace.windows[0];
    await viewer.action({
      type: "tab.navigate",
      tabId: win.activeTabId,
      url: fixtureOrigin,
    });
  }
  await viewer.media();
}
const rtc = (method, params) =>
  viewer.call(method, { requestId: "library", ...params }, true);
const library = () => viewer.call("library.get");
const dialog = () =>
  viewer.page.getByRole("dialog", { name: "文件篮", exact: true });
async function chooser(id) {
  await viewer.page.waitForFunction(() => {
    const viewport = document.querySelector(".remote-viewport");
    return (
      viewport &&
      !viewport.classList.contains("resize-waiting") &&
      !viewport.querySelector("canvas").classList.contains("no-frame")
    );
  });
  const box = await viewer.page.locator(".remote-viewport").boundingBox();
  const geometry = await until(
    () =>
      events.findLast(
        (event) =>
          event.type === "geometry" &&
          Math.abs(event.width - box.width) < 2 &&
          Math.abs(event.height - box.height) < 2,
      ),
    "remote geometry",
  );
  const target = geometry.boxes[id];
  await viewer.page.mouse.click(
    box.x + ((target.x + 20) * box.width) / geometry.width,
    box.y + ((target.y + 20) * box.height) / geometry.height,
  );
  const request = await until(
    async () =>
      (await viewer.state()).fileRequests.find(
        (item) => item.state === "pending",
      ),
    "native chooser",
  );
  await dialog().waitFor();
  assert.equal(request.multiple, id === "multiple");
  assert(request.accept.includes(id === "single" ? "image/png" : "image/*"));
  return request;
}
async function cancelChooser() {
  await dialog()
    .getByRole("button", { name: "取消文件选择", exact: true })
    .click();
  await until(
    async () => !(await viewer.state()).fileRequests.length,
    "chooser cancelled",
  );
}
async function dimensions(assetId) {
  const asset = await rtc("asset.describe", { assetId });
  const chunks = [];
  let offset = 0;
  while (offset < asset.size) {
    const chunk = await rtc("asset.read", { assetId, offset });
    assert(chunk.offset > offset);
    chunks.push(Buffer.from(chunk.data, "base64"));
    offset = chunk.offset;
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, asset.size);
  const size = await viewer.page.evaluate(
    async ({ data, type }) => {
      const image = await createImageBitmap(
        await (await fetch(`data:${type};base64,${data}`)).blob(),
      );
      const result = { width: image.width, height: image.height };
      image.close();
      return result;
    },
    { data: bytes.toString("base64"), type: asset.type },
  );
  return { ...size, type: asset.type, bytes: asset.size };
}
async function shoot(mode) {
  const before = await library();
  await dialog().getByRole("button", { name: "添加文件", exact: true }).click();
  await viewer.page
    .getByRole("menuitem", { name: "摄像头拍照", exact: true })
    .click();
  const camera = viewer.page.getByRole("dialog", {
    name: "摄像头拍照",
    exact: true,
  });
  await camera
    .getByRole("button", {
      name: mode === "scan" ? "文档扫描" : "普通照片",
      exact: true,
    })
    .click();
  const shutter = camera.getByRole("button", { name: "拍照", exact: true });
  await shutter.waitFor();
  await until(() => shutter.isEnabled(), "camera ready");
  const capture = await camera
    .locator("video")
    .evaluate((video) => ({
      width: video.videoWidth,
      height: video.videoHeight,
    }));
  assert.deepEqual(capture, { width: 1920, height: 1080 });
  await shutter.click();
  const entry = await until(
    async () => {
      const snapshot = await library();
      return snapshot.entries.find(
        (item) =>
          snapshot.basket.includes(item.id) &&
          !before.basket.includes(item.id) &&
          item.type === "image/webp" &&
          !item.photo?.pending,
      );
    },
    `${mode} WebP entry`,
    90000,
  );
  assert.match(entry.name, /\.webp$/i);
  assert.equal(entry.photo.mode, mode);
  assert(entry.originalAssetId);
  const original = await dimensions(entry.originalAssetId);
  assert.equal(original.type, "image/jpeg");
  assert.deepEqual([original.width, original.height], [1920, 1080]);
  const derivative = await dimensions(entry.assetId);
  assert.equal(derivative.type, "image/webp");
  const processing = await viewer.page.evaluate(
    (assetId) =>
      cameraQA.find((item) => item.reply?.result?.assetId === assetId),
    entry.assetId,
  );
  assert(processing, "observed photo.process result");
  assert.equal(processing.request.params.assetId, entry.originalAssetId);
  assert.equal(processing.request.params.mode, mode);
  assert(!Object.hasOwn(processing.request.params, "quarterTurns"));
  await camera.getByRole("button", { name: "返回", exact: true }).click();
  await dialog().waitFor();
  return { entry, original, derivative, processing: processing.reply.result };
}

try {
  await until(
    async () => (await fetch(origin + "/api/auth/setup").catch(() => null))?.ok,
    "Control ready",
  );
  await openViewer(3);
  await stage("1-native-chooser", async () => {
    const request = await chooser("single");
    return {
      accept: request.accept,
      multiple: request.multiple,
      media: (await viewer.media()).framesDecoded,
    };
  });
  let scan3;
  let scan4;
  let photo3;
  await stage("2-scan-3-orientation", async () => {
    scan3 = await shoot("scan");
    assert.equal(scan3.entry.photo.quarterTurns, 1);
    assert.equal(scan3.processing.quarterTurns, 1);
    assert.equal(scan3.processing.orientation, "text");
    assert(scan3.derivative.height > scan3.derivative.width);
    return scan3;
  });
  await cancelChooser();
  await openViewer(4);
  await chooser("single");
  await stage("3-scan-4-perspective", async () => {
    scan4 = await shoot("scan");
    assert(!Object.hasOwn(scan4.entry.photo, "quarterTurns"));
    assert.equal(scan4.processing.quarterTurns, 0);
    assert.equal(scan4.processing.geometry, "perspective");
    assert.notDeepEqual(
      [scan4.derivative.width, scan4.derivative.height],
      [1920, 1080],
    );
    return scan4;
  });
  await cancelChooser();
  await openViewer(3);
  await chooser("single");
  await stage("4-photo-3-orientation", async () => {
    photo3 = await shoot("photo");
    assert.equal(photo3.entry.photo.quarterTurns, 1);
    assert.equal(photo3.processing.orientation, "text");
    assert.equal(photo3.processing.geometry, "unchanged");
    assert.deepEqual(
      [photo3.derivative.width, photo3.derivative.height],
      [1080, 1920],
    );
    return photo3;
  });
  await stage("5-debounced-manual-rotation", async () => {
    const before = await library();
    const count = await viewer.page.evaluate(() => cameraQA.length);
    const card = dialog().locator(`[data-file-card="${photo3.entry.id}"]`);
    const clickRotation = async () => {
      await card
        .getByRole("button", { name: photo3.entry.name, exact: true })
        .click();
      // Menu animation must not consume the rotation debounce window.
      await viewer.page
        .getByRole("menuitem", { name: "向右旋转", exact: true })
        .click({ force: true });
    };
    await clickRotation();
    await clickRotation();
    const clicks = await viewer.page.evaluate(() => cameraRotationClicks);
    assert.equal(clicks.length, 2);
    assert(clicks.every((click) => click.trusted));
    const clickIntervalMs = clicks[1].at - clicks[0].at;
    assert(
      clickIntervalMs < 600,
      `rotations exceeded debounce window: ${clickIntervalMs} ms`,
    );
    const rotated = await until(
      async () =>
        (await library()).entries.find(
          (item) =>
            item.id === photo3.entry.id && item.photo?.quarterTurns === 3,
        ),
      "rotation committed",
      90000,
    );
    const after = await library();
    assert.deepEqual(after.basket, before.basket);
    assert.equal(rotated.id, photo3.entry.id);
    assert.equal(rotated.originalAssetId, photo3.entry.originalAssetId);
    const requests = await viewer.page.evaluate(
      (count) => cameraQA.slice(count),
      count,
    );
    assert.equal(requests.length, 1, JSON.stringify(requests));
    assert.equal(requests[0].request.params.quarterTurns, 3);
    assert.equal(
      requests[0].request.params.assetId,
      photo3.entry.originalAssetId,
    );
    assert.equal(requests[0].reply.result.orientation, "manual");
    const derivative = await dimensions(rotated.assetId);
    assert.deepEqual([derivative.width, derivative.height], [1080, 1920]);
    await viewer.page.screenshot({ path: join(run, "rotated-basket.png") });
    return {
      clickIntervalMs,
      requests,
      basketBefore: before.basket,
      basketAfter: after.basket,
      rotated,
      derivative,
    };
  });
  await stage("6-native-selection-handoff", async () => {
    await dialog()
      .getByRole("radio", { name: `选择 ${scan3.entry.name}`, exact: true })
      .check();
    await dialog().getByRole("button", { name: "发送", exact: true }).click();
    const png = await until(
      () =>
        events.find(
          (event) => event.type === "selected" && event.id === "single",
        ),
      "PNG native FileList",
    );
    assert.equal(png.trusted, true);
    assert.equal(png.files.length, 1);
    assert.equal(png.files[0].type, "image/png");
    assert.match(png.files[0].name, /\.png$/i);
    assert.deepEqual(
      [png.files[0].width, png.files[0].height],
      [scan3.derivative.width, scan3.derivative.height],
    );
    assert.equal(png.files[0].pixel.length, 4);
    await until(
      async () => !(await viewer.state()).fileRequests.length,
      "PNG chooser completed",
    );
    await chooser("multiple");
    const basket = await library();
    const expected = basket.basket.map((id) =>
      basket.entries.find((entry) => entry.id === id),
    );
    assert(expected.length > 0);
    await dialog().getByRole("button", { name: "发送", exact: true }).click();
    const webp = await until(
      () =>
        events.find(
          (event) => event.type === "selected" && event.id === "multiple",
        ),
      "WebP native FileList",
    );
    assert.equal(webp.trusted, true);
    assert.equal(webp.files.length, expected.length);
    for (const [index, file] of webp.files.entries()) {
      assert.equal(file.type, "image/webp");
      assert.equal(file.name, expected[index].name);
      assert.match(file.name, /\.webp$/i);
      assert(file.width > 0 && file.height > 0);
      assert.equal(file.pixel.length, 4);
    }
    return { png, webp };
  });
} catch (error) {
  await viewer?.page.screenshot({ path: join(run, "failure.png") });
  await writeFile(
    join(run, "failure.json"),
    JSON.stringify(
      { error: error.stack, state: await viewer?.state() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await saveRPCs();
  await writeFile(
    join(run, "photo-rpcs.json"),
    JSON.stringify(rpcEvidence, null, 2),
  );
  await writeFile(
    join(run, "fixture-events.json"),
    JSON.stringify(events, null, 2),
  );
  await chrome?.close();
  if (control.connected) control.disconnect();
  const timeout = setTimeout(() => {
    if (control.exitCode === null)
      execFileSync("taskkill", ["/pid", String(control.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  }, 10000);
  await stopped;
  clearTimeout(timeout);
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
}
