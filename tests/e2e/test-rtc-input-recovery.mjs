import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startStack, until } from './kit/stack.mjs';
import { launch } from './kit/viewer.mjs';

const phase = process.env.QA_PHASE ?? 'after';
const root = resolve(process.env.QA_OUT ?? 'develop/tmp/e2e-shell/rtc-input', phase, String(Date.now()));
mkdirSync(root, { recursive: true });
const stack = await startStack({
  scenario: 'rtc-input',
  run: join(root, 'stack'),
  port: Number(process.env.REMOTEKIT_E2E_PORT ?? 34040),
});
console.log('Evidence: ' + root);
let viewer;
try {
  for (const browser of process.env.QA_BROWSER ? [process.env.QA_BROWSER] : ['edge', 'chrome89']) {
    const out = join(root, browser);
    viewer = await launch({
      browser,
      dpr: browser === 'edge' ? 1 : 2,
      pointer: browser === 'edge' ? 'mouse' : 'touch',
      out,
      stack,
    });
    const { page, context } = viewer;
    if (browser === 'chrome89') await page.setViewportSize({ width: 800, height: 1280 });
    await page.addInitScript(() => {
      window.qa = { peers: [], sockets: [], trace: [] };
      const record = (type, data) => qa.trace.push({ at: performance.now(), type, ...data });
      const Peer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Peer {
        constructor(...args) {
          super(...args);
          qa.peers.push(this);
        }
        createDataChannel(...args) {
          const channel = super.createDataChannel(...args);
          const send = channel.send.bind(channel);
          channel.send = (data) => {
            try {
              record('send', { message: JSON.parse(data) });
            } catch {}
            return send(data);
          };
          channel.addEventListener('message', (event) => {
            try {
              record('receive', { message: JSON.parse(event.data) });
            } catch {}
          });
          return channel;
        }
      };
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(...args) {
          super(...args);
          qa.sockets.push(this);
          this.addEventListener('message', (event) => {
            if (!this.url.includes('/api/socket')) return;
            try {
              const message = JSON.parse(event.data);
              record('control', { type: message.type, id: message.id, error: message.error });
            } catch {}
          });
        }
      };
      for (const type of [
        'pointerdown',
        'focusin',
        'keydown',
        'keyup',
        'beforeinput',
        'input',
        'compositionstart',
        'compositionend',
      ])
        document.addEventListener(
          type,
          (event) => record(type, { key: event.key, data: event.data, target: event.target.tagName }),
          true,
        );
    });
    await page.reload();
    await page.waitForFunction(() => window.__remotekitTest);
    await viewer.unlock();
    await viewer.openStart();
    await viewer.tile('浏览器').click();
    await viewer.navigate(stack.fixture + '/notes/');
    const canvas = page.locator('canvas[data-video-input]:not(.no-frame)').first();
    await canvas.waitFor();
    await page.waitForTimeout(1500);
    assert.equal((await viewer.refresh()).workspace.settings.workspace.autoKeyboard, false);
    writeFileSync(
      join(out, 'device.json'),
      JSON.stringify(
        {
          version: viewer.browser.version(),
          dpr: await page.evaluate(() => devicePixelRatio),
          viewport: page.viewportSize(),
          pointer: browser === 'edge' ? 'mouse' : 'touch',
        },
        null,
        2,
      ),
    );
    if (browser === 'edge') {
      const results = [];
      for (let index = 0; index < 10; index++) {
        const path = '/notes/immediate-' + index;
        await viewer.navigate(stack.fixture + path);
        await canvas.waitFor();
        await page.waitForTimeout(300);
        const box = await canvas.boundingBox();
        await page.mouse.click(box.x + 70, box.y + 200);
        await page.keyboard.type('Desktop' + index, { delay: 70 });
        await page.waitForTimeout(400);
        const events = await (await fetch(stack.fixture + '/events')).json();
        const value =
          events.filter((event) => event.path === path && event.type === 'note').at(-1)?.value ?? '';
        results.push({ expected: 'Desktop' + index, value });
      }
      writeFileSync(join(out, 'typing.json'), JSON.stringify(results, null, 2));
      await viewer.shot('immediate-typing');
      if (phase === 'after')
        assert.ok(
          results.every((result) => result.value === result.expected),
          JSON.stringify(results),
        );
    } else {
      await page.evaluate(async () => {
        const { RtcSession } = await import('/client/rtc/rtc-session.ts');
        const connect = RtcSession.prototype.connect;
        RtcSession.prototype.connect = function () {
          qa.rtc = this;
          return connect.call(this);
        };
      });
      await context.setOffline(true);
      await page.evaluate(() => {
        qa.sockets.filter((socket) => socket.url.includes('/api/socket')).forEach((socket) => socket.close());
        qa.peers.forEach((peer) => peer.close());
      });
      await page.waitForTimeout(1800);
      await viewer.shot('offline');
      await context.setOffline(false);
      await until(
        () =>
          page.evaluate(() =>
            qa.sockets.some((socket) => socket.url.includes('/api/socket') && socket.readyState === 1),
          ),
        'product WebSocket reopened',
      );
      await viewer.unlock();
      await page.waitForTimeout(1200);
      assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 0);
      let recovered = false;
      let automaticUiVerified = false;
      try {
        await until(
          () =>
            page.evaluate(
              () =>
                qa.peers.some((peer) => peer.connectionState === 'connected') &&
                !!document.querySelector('canvas[data-video-input]:not(.no-frame)'),
            ),
          'automatic RTC recovery',
          20000,
        );
        recovered = true;
        await viewer.openStart();
        await viewer.tile('我的文件').click();
        await page.getByRole('button', { name: '添加文件', exact: true }).waitFor();
        await page.getByText('还没有文件', { exact: true }).waitFor();
        await viewer.shot('automatic-recovery-files');
        assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 0);
        // Keep the prolonged signaling-outage coverage while following the
        // current policy: recovery continues automatically, with no Retry button.
        await page.evaluate(async () => {
          const { RemoteKitError } = await import('/shared/errors.ts');
          qa.resumeSignaling = qa.rtc.controlRpc;
          qa.rtc.controlRpc = (method, params) =>
            method === 'rtc.offer'
              ? Promise.reject(
                  new RemoteKitError('unavailable', 'forced signaling outage', { retryAfterMs: 500 }),
                )
              : qa.resumeSignaling(method, params);
          qa.rtc.connectionFailed(
            new RemoteKitError('unavailable', 'forced signaling outage', { retryAfterMs: 500 }),
          );
        });
        await page.waitForTimeout(3500);
        assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 0);
        await viewer.shot('signaling-outage-automatic');
        await page.evaluate(() => {
          qa.rtc.controlRpc = qa.resumeSignaling;
        });
        await until(
          () => page.evaluate(() => qa.peers.some((peer) => peer.connectionState === 'connected')),
          'signaling outage recovered automatically',
          90000,
        );
        await page.getByText('还没有文件', { exact: true }).waitFor();
        automaticUiVerified = true;
      } catch (error) {
        writeFileSync(join(out, 'recovery-error.txt'), String(error));
      }
      await viewer.shot('automatic-recovery');
      writeFileSync(
        join(out, 'recovery.json'),
        JSON.stringify(
          {
            recovered,
            automaticUiVerified,
            state: await viewer.refresh(),
            peers: await page.evaluate(() => qa.peers.map((peer) => peer.connectionState)),
            text: await page.locator('body').innerText(),
          },
          null,
          2,
        ),
      );
      if (phase === 'after') {
        assert.ok(recovered, 'transport restoration did not recover');
        assert.ok(automaticUiVerified, 'automatic recovery UI did not settle');
      }
    }
    writeFileSync(join(out, 'trace.json'), JSON.stringify(await page.evaluate(() => qa.trace), null, 2));
    console.log(browser + ': complete');
    await viewer.close();
    viewer = undefined;
  }
} finally {
  if (viewer) {
    await viewer.shot('failure').catch(() => {});
    writeFileSync(
      join(viewer.out, 'failure-state.json'),
      JSON.stringify(
        await viewer.page
          .evaluate(() => ({
            state: window.__remotekitTest?.state(),
            text: document.body.innerText,
            peers: qa.peers.map((peer) => peer.connectionState),
            sockets: qa.sockets.map((socket) => ({ url: socket.url, state: socket.readyState })),
          }))
          .catch(() => ({})),
        null,
        2,
      ),
    );
    writeFileSync(
      join(viewer.out, 'trace.json'),
      JSON.stringify(await viewer.page.evaluate(() => window.qa?.trace).catch(() => []), null, 2),
    );
    await viewer.close();
  }
  await stack.stop();
}
