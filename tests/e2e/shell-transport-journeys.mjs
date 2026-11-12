import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { startStack, until } from './kit/stack.mjs';
import { launch } from './kit/viewer.mjs';
// Complete network loss (HTTP plus existing WS/RTC), real input and upload closure.
import assert from 'node:assert/strict';

const root = resolve(process.argv[2] ?? 'develop/tmp/e2e/transport-journeys');
const port = Number(process.env.REMOTEKIT_E2E_PORT ?? 34080);
mkdirSync(root, { recursive: true });
const results = [];
let v, stack, network;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function viewerNetwork() {
  let online = true;
  const sockets = new Map();
  const proxy = createServer((socket) => {
    socket.once('data', (bytes) => {
      const hotReload = /^GET \/\?token=/.test(bytes.toString('utf8'));
      if (!online && !hotReload) return socket.destroy();
      const upstream = connect(port + 1, '127.0.0.1');
      for (const peer of [socket, upstream]) {
        sockets.set(peer, hotReload);
        peer.on('error', () => {});
        peer.on('close', () => {
          sockets.delete(peer);
          socket.destroy();
          upstream.destroy();
        });
      }
      upstream.write(bytes);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  await new Promise((done, reject) => {
    proxy.once('error', reject);
    proxy.listen(port + 5, '127.0.0.1', done);
  });
  const disconnect = () => {
    online = false;
    // Keep Vite's development socket alive so its reconnect does not reload the Viewer.
    for (const [socket, hotReload] of sockets) if (!hotReload) socket.destroy();
  };
  return {
    origin: `http://127.0.0.1:${port + 5}`,
    disconnect,
    reconnect: () => {
      online = true;
    },
    close: async () => {
      disconnect();
      for (const socket of sockets.keys()) socket.destroy();
      await new Promise((done) => proxy.close(done));
    },
  };
}
try {
  for (const browser of process.env.QA_BROWSER ? [process.env.QA_BROWSER] : ['edge', 'chrome89'])
    for (const phone of process.env.QA_PHONE !== undefined ? [process.env.QA_PHONE === '1'] : [false, true]) {
      const label = browser + (phone ? '-phone' : '-desktop'),
        out = join(root, label);
      network = await viewerNetwork();
      stack = await startStack({
        scenario: 'shell-transport',
        port,
        viewerOrigin: network.origin,
        run: join(out, 'stack'),
      });
      v = await launch({ browser, pointer: phone ? 'touch' : 'mouse', stack, out });
      const { page, context } = v;
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await page.addInitScript(() => {
        window.netQA = { peers: [], sockets: [], wire: [], dom: [] };
        for (const type of ['keydown', 'beforeinput', 'input', 'focusin', 'pointerdown'])
          document.addEventListener(
            type,
            (e) =>
              netQA.dom.push({
                at: performance.now(),
                type,
                key: e.key,
                data: e.data,
                target: e.target.tagName,
                className: e.target.className,
              }),
            true,
          );
        const Peer = RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer {
          constructor(...args) {
            super(...args);
            netQA.peers.push(this);
          }
          createDataChannel(...args) {
            let c = super.createDataChannel(...args);
            c.addEventListener('message', (e) => {
              try {
                const m = JSON.parse(e.data);
                if (m.error || m.type === 'input.result') netQA.wire.push(m);
              } catch {}
            });
            return c;
          }
        };
        const Socket = WebSocket;
        window.WebSocket = class extends Socket {
          constructor(...args) {
            super(...args);
            netQA.sockets.push(this);
          }
          send(raw) {
            try {
              const message = JSON.parse(raw);
              if (message.method === 'operation.submit')
                netQA.wire.push({ direction: 'out', at: performance.now(), message });
            } catch {}
            return super.send(raw);
          }
        };
        const send = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (raw) {
          if (this.label === 'remotekit' && typeof raw === 'string') {
            try {
              const m = JSON.parse(raw);
              if (['input', 'focus'].includes(m.type))
                netQA.wire.push({ direction: 'out', at: performance.now(), message: m });
            } catch {}
          }
          return send.call(this, raw);
        };
      });
      await page.reload();
      await v.unlock();
      const shot = async (name) => {
        await page.screenshot({ path: join(out, name + '.png') });
        writeFileSync(
          join(out, name + '.json'),
          JSON.stringify(
            await page.evaluate(() => ({
              state: __remotekitTest.state(),
              text: document.body.innerText,
              peers: netQA.peers.map((p) => p.connectionState),
              sockets: netQA.sockets.map((s) => ({ url: s.url, state: s.readyState })),
              wire: netQA.wire,
              dom: netQA.dom,
              navigationResult: netQA.navigationResult,
              navigationError: netQA.navigationError,
            })),
            null,
            2,
          ),
        );
      };
      const tap = async (x, y) => {
        if (!phone) return page.mouse.click(x, y, { delay: 80 });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y, id: 1, radiusX: 3, radiusY: 3, force: 1 }],
        });
        await pause(90);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const click = async (locator) => {
        await locator.waitFor();
        await locator.scrollIntoViewIfNeeded();
        await pause(300);
        const b = await locator.boundingBox();
        await tap(b.x + b.width / 2, b.y + b.height / 2);
        await pause(400);
      };
      const offline = async () => {
        network.disconnect();
        await cdp.send('Network.emulateNetworkConditions', {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        });
        await page.evaluate(() => {
          netQA.sockets.filter((s) => s.url.includes('/api/socket')).forEach((s) => s.close());
          netQA.peers.forEach((p) => p.close());
        });
        await pause(2500);
        assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 0);
      };
      const online = async () => {
        network.reconnect();
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        await until(
          () =>
            page.evaluate(() =>
              netQA.sockets.some((s) => s.url.includes('/api/socket') && s.readyState === 1),
            ),
          'WS restored',
          90000,
        );
        const password = page.locator('input[autocomplete="current-password"]');
        const start = page.getByRole('button', { name: '开始', exact: true });
        const blank = page.locator('.viewer-lock-blank');
        await until(
          async () => (await start.isVisible()) || (await password.isVisible()) || (await blank.isVisible()),
          'authentication controls restored',
          90000,
        );
        if (await password.isVisible()) {
          await password.fill(stack.password);
          await click(page.getByRole('button', { name: '解锁', exact: true }));
        } else if (await blank.isVisible()) await v.unlock();
        await start.waitFor({ timeout: 90000 });
        console.log(label + ': Control restored');
        await until(
          () =>
            page.evaluate(() =>
              netQA.peers.some(
                (p) =>
                  p.connectionState === 'connected' &&
                  p.getTransceivers().some((t) => t.receiver.track.kind === 'video'),
              ),
            ),
          'RTC restored',
          90000,
        );
        await page.locator('canvas[data-video-input]:not(.no-frame)').first().waitFor({ timeout: 90000 });
        console.log(label + ': browser restored');
        await pause(1800);
      };
      const revealConnection = async () => {
        if (await page.locator('.viewer-lock-blank').isVisible()) {
          if (phone) {
            const { width, height } = page.viewportSize();
            for (const [x, y] of [
              [0.5, 0.25],
              [0.5, 0.25],
              [0.5, 0.75],
              [0.5, 0.75],
              [0.25, 0.5],
              [0.75, 0.5],
              [0.25, 0.5],
              [0.75, 0.5],
            ]) {
              await tap(x * width, y * height);
              await pause(80);
            }
          } else
            for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right']) {
              await page.keyboard.press('Arrow' + direction);
              await pause(80);
            }
        }
        await page.locator('.auth-page .failure-note').waitFor({ timeout: 30000 });
        assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 0);
      };
      const issues = [];
      try {
        // Launch from Start, then interact with the page at real coordinates.
        await v.openStart();
        await click(v.tile('浏览器'));
        await v.navigate(stack.fixture + '/notes/' + label);
        const note = page.locator('canvas[data-video-input]:not(.no-frame)').first();
        let b = await note.boundingBox();
        await tap(b.x + 65, b.y + 200);
        await page.keyboard.type('before', { delay: 100 });
        await offline();
        await page.keyboard.type(' during outage', { delay: 90 });
        await shot('offline-mid-typing');
        await revealConnection();
        await shot('offline-recovery-panel');
        await online();
        await shot('recovered-mid-typing');
        await v.navigate(stack.fixture + '/notes/recovered-' + label);
        b = await note.boundingBox();
        await tap(b.x + 65, b.y + 200);
        await page.keyboard.type('Recovered ' + label, { delay: 90 });
        try {
          await until(
            async () => {
              const es = await (await fetch(stack.fixture + '/events')).json();
              return es.some(
                (e) => e.path === '/notes/recovered-' + label && e.value === 'Recovered ' + label,
              );
            },
            'input delivered after restoration',
            45000,
          );
        } catch (error) {
          issues.push(error.message);
        }
        await shot('typed-after-recovery');
        const url = stack.fixture + '/flow/' + label;
        const address = page.getByRole('textbox', { name: '搜索或输入网址', exact: true }).first();
        await address.fill(url);
        const tabId = v.state.workspace.tabs.find((tab) => tab.url.endsWith('/notes/recovered-' + label)).id;
        await page.evaluate(() => {
          for (const element of document.querySelectorAll('*')) {
            const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
            for (let fiber = key && element[key]; fiber; fiber = fiber.return)
              for (let hook = fiber.memoizedState; hook; hook = hook.next) {
                const current = hook.memoizedState;
                if (current?.operations && current?.rtc && current?.endpoint) {
                  netQA.operations = current.operations;
                  return;
                }
              }
          }
          throw Error('Operations store not mounted');
        });
        await offline();
        // The lock screen replaces the address form during a complete outage.
        await page.evaluate(
          ({ tabId, url }) => {
            void netQA.operations.action({ type: 'tab.navigate', tabId, url }).then(
              (receipt) => {
                netQA.navigationResult = receipt;
              },
              (error) => {
                netQA.navigationError = { code: error.code, message: error.message, stack: error.stack };
              },
            );
          },
          { tabId, url },
        );
        await shot('offline-mid-navigation');
        await revealConnection();
        await online();
        try {
          await v.until(
            async () =>
              v.state.workspace.tabs.some((t) => t.url === url && !t.loading) ||
              (await page.getByRole('button', { name: /操作结果未知/ }).count()) > 0,
            'navigation commits or reports unknown result',
            90000,
          );
        } catch (error) {
          issues.push(error.message);
        }
        await shot('recovered-mid-navigation');
        // A real file chooser starts an upload, then the user closes its App window.
        await v.openStart();
        await click(v.tile('我的文件'));
        const files = page
          .locator('.window-frame')
          .filter({ has: page.locator('.library-tab') })
          .filter({ visible: true })
          .first();
        const choose = page.getByRole('button', { name: '从设备选择', exact: true }).first();
        if (await choose.count()) {
          const path = join(out, 'upload-close.txt');
          writeFileSync(path, Buffer.alloc(24 * 1024 * 1024, 65));
          const chooser = page.waitForEvent('filechooser');
          await click(choose);
          await (await chooser).setFiles(path);
          await pause(150);
          await click(files.getByRole('button', { name: '窗口把手' }));
          await click(page.getByRole('menuitem', { name: '关闭窗口', exact: true }));
          await pause(1500);
          await shot('closed-window-during-upload');
        }
        results.push({ variant: label, status: issues.length ? 'fail' : 'pass', issues });
      } catch (error) {
        await shot('FAIL').catch(() => {});
        results.push({ variant: label, status: 'fail', error: String(error.stack) });
      }
      writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify(results.at(-1)));
      await v.close();
      v = undefined;
      await stack.stop();
      stack = undefined;
      await network.close();
      network = undefined;
    }
} finally {
  await v?.close();
  await stack?.stop();
  await network?.close();
}
if (results.some((x) => x.status === 'fail')) process.exitCode = 1;
