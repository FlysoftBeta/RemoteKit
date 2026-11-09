// Run with the approved host Playwright browser_run_code_unsafe tool. This
// launches only its own isolated Chrome157 receiver and never uses OS input.
async (hostPage) => {
  const failedOnly = hostPage._rkTouchFailedOnly === true;
  const trajectoriesOnly = hostPage._rkTouchTrajectoriesOnly === true;
  const origin = 'http://127.0.0.1:33281',
    fixture = 'http://127.0.0.1:33282';
  const browser = await hostPage
    .context()
    .browser()
    .browserType()
    .launch({
      executablePath: 'C:/src/chromium/src/out/rel/chrome.exe',
      headless: true,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--fake-vsync-rate=60',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 850 },
    deviceScaleFactor: 1,
    hasTouch: true,
  });
  const report = {
    kind: 'real-production-touch-source',
    at: Date.now(),
    version: await browser.version(),
    cases: [],
    errors: [],
  };
  try {
    await context.addInitScript(() => {
      window.touchQA = {
        sent: [],
        results: [],
        layout: null,
        state: null,
        delayMode: 'normal',
        move: 0,
        queue: [],
        hold: false,
      };
      const qa = window.touchQA;
      const WS = window.WebSocket;
      window.WebSocket = class extends WS {
        constructor(...args) {
          super(...args);
          qa.socket = this;
          this.addEventListener('message', (e) => {
            try {
              const m = JSON.parse(e.data);
              if (m.type === 'state') qa.state = m.state;
            } catch {}
          });
        }
      };
      qa.rpc = (method, params) =>
        new Promise((resolve, reject) => {
          const id = 'touch-qa-' + Math.random(),
            ws = qa.socket;
          const timer = setTimeout(() => {
            ws.removeEventListener('message', receive);
            reject(Error('RPC timeout ' + method));
          }, 20000);
          function receive(e) {
            const r = JSON.parse(e.data);
            if (r.id === id) {
              clearTimeout(timer);
              ws.removeEventListener('message', receive);
              r.type === 'error' ? reject(Error(JSON.stringify(r.error))) : resolve(r.result);
            }
          }
          ws.addEventListener('message', receive);
          ws.send(JSON.stringify({ id, method, params }));
        });
      qa.action = (action) =>
        new Promise((resolve, reject) => {
          const operationId = crypto.randomUUID(),
            channel = qa.channel;
          const timer = setTimeout(() => {
            channel.removeEventListener('message', receive);
            reject(Error('Product action timeout'));
          }, 20000);
          function receive(event) {
            const message = JSON.parse(event.data);
            if (message.type !== 'product.result' || message.operationId !== operationId) return;
            clearTimeout(timer);
            channel.removeEventListener('message', receive);
            if (message.result?.status === 'failed')
              reject(Object.assign(Error(message.result.error.message), { code: message.result.error.code }));
            else resolve(message.result);
          }
          channel.addEventListener('message', receive);
          channel.send(
            JSON.stringify({
              type: 'product.action',
              version: 1,
              operationId,
              operationGeneration: qa.state.operationGeneration,
              authEpoch: qa.authEpoch,
              action,
            }),
          );
        });
      const PC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends PC {
        createDataChannel(...args) {
          const channel = super.createDataChannel(...args),
            original = channel.send.bind(channel);
          if (channel.label !== 'remotekit') return channel;
          qa.channel = channel;
          channel.addEventListener('message', (e) => {
            try {
              const m = JSON.parse(e.data);
              if (m.type === 'layout') qa.layout = m;
              if (Number.isInteger(m.authEpoch)) qa.authEpoch = m.authEpoch;
              if (m.type === 'input.result' || m.type === 'focus')
                qa.results.push({ receivedAt: performance.now(), ...m });
            } catch {}
          });
          const deliver = (data, record) => {
            record.sentAt = performance.now();
            original(data);
          };
          channel.send = (data) => {
            let m;
            try {
              m = JSON.parse(data);
            } catch {}
            if (m?.type !== 'input' || m.event?.type !== 'touch') return original(data);
            const record = { capturedAt: performance.now(), event: m.event, clientSequence: m.sequence };
            qa.sent.push(record);
            if (m.event.action === 'move') qa.move++;
            if (qa.delayMode === 'stall70' && qa.move === 4 && m.event.action === 'move' && !qa.hold) {
              qa.hold = true;
              setTimeout(() => {
                const queue = qa.queue.splice(0);
                qa.hold = false;
                for (const [bytes, item] of queue) deliver(bytes, item);
              }, 70);
            }
            if (qa.hold) {
              qa.queue.push([data, record]);
              return;
            }
            if (qa.delayMode === 'up100' && m.event.action === 'end') {
              setTimeout(() => deliver(data, record), 100);
              return;
            }
            deliver(data, record);
          };
          return channel;
        }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.goto(origin);
    await page.waitForSelector('.viewer-lock-blank');
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
    await page.locator('input[autocomplete="username"]').fill('touch-qa-' + Date.now());
    await page.locator('input[autocomplete="new-password"]').fill(crypto.randomUUID());
    await page.locator('button[type="submit"]').click();
    await page.waitForFunction(() => window.touchQA?.state && window.touchQA.socket?.readyState === 1);
    await page.waitForFunction(() => touchQA.channel?.readyState === 'open' && touchQA.authEpoch > 0);
    await page.evaluate(() => touchQA.action({ type: 'window.create', url: 'about:blank' }));
    await page.waitForFunction(() => touchQA.state.workspace.windows.length > 0);
    const initial = await page.evaluate(() => touchQA.state);
    const win = initial.workspace.windows.find((w) => w.id === initial.workspace.activeWindowId),
      tabId = win.activeTabId;
    await page.waitForFunction(
      () =>
        document.querySelector('.remote-viewport canvas:not(.no-frame)') &&
        window.touchQA.layout?.views?.length,
    );
    await page.waitForTimeout(6500);
    const cdp = await context.newCDPSession(page);
    const inspect = async () => await (await context.request.get(fixture + '/inspect')).json();
    async function navigate(id, dpr) {
      await page.evaluate(
        async ({ id, tabId, dpr, fixture }) => {
          const qa = window.touchQA;
          await qa.rpc('action', {
            type: 'settings.update',
            settings: { qualityPreference: dpr === 2 ? 'quality' : 'smooth' },
          });
          await qa.action({ type: 'tab.navigate', tabId, url: fixture + '/fixture?case=' + id });
        },
        { id, tabId, dpr, fixture },
      );
      const deadline = Date.now() + 18000;
      let value;
      while (Date.now() < deadline) {
        value = await inspect();
        if (
          value.telemetry[id + ':root'] &&
          (await page.locator('.remote-viewport canvas:not(.no-frame)').count())
        )
          break;
        await page.waitForTimeout(100);
      }
      if (!value?.telemetry[id + ':root']) throw Error('fixture readiness ' + id);
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const qa = window.touchQA;
        qa.sent = [];
        qa.results = [];
        qa.move = 0;
        qa.hold = false;
        qa.queue = [];
      });
    }
    async function swipe(id, mode, x = 100, y0 = 500, y1 = 180, terminal = 'end', dpr = 1) {
      await navigate(id, dpr);
      await page.evaluate((mode) => (window.touchQA.delayMode = mode), mode);
      const geometry = await page.evaluate(
        ({ x, y0, y1 }) => {
          const r = document.querySelector('.remote-viewport canvas:not(.no-frame)').getBoundingClientRect(),
            view = window.touchQA.layout.views[0],
            scale = view.deviceScaleFactor * (view.mediaScale ?? 1);
          return {
            view,
            viewerDpr: devicePixelRatio,
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            x: r.left + (x * scale * r.width) / view.width,
            y0: r.top + (y0 * scale * r.height) / view.height,
            y1: r.top + (y1 * scale * r.height) / view.height,
          };
        },
        { x, y0, y1 },
      );
      const stamp = Date.now() / 1000,
        started = Date.now(),
        pending = [],
        injection = [];
      const inject = (command) => {
        injection.push({
          type: command.type,
          sourceElapsedMs: (command.timestamp - stamp) * 1000,
          issuedElapsedMs: Date.now() - started,
        });
        pending.push(
          cdp.send('Input.dispatchTouchEvent', command).catch((error) => ({ error: String(error) })),
        );
      };
      inject({
        type: 'touchStart',
        touchPoints: [{ x: geometry.x, y: geometry.y0, id: 1, radiusX: 2, radiusY: 2, force: 0.5 }],
        timestamp: stamp,
      });
      // CDP replies can wait for a frame. Awaiting each reply would turn 16ms
      // source samples into ~33ms arrivals and manufacture an ever-growing age.
      for (let i = 1; i <= 20; i++) {
        const wait = started + i * 16 - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        inject({
          type: 'touchMove',
          touchPoints: [
            {
              x: geometry.x,
              y: geometry.y0 + ((geometry.y1 - geometry.y0) * i) / 20,
              id: 1,
              radiusX: 2,
              radiusY: 2,
              force: 0.5,
            },
          ],
          timestamp: stamp + i * 0.016,
        });
      }
      const wait = started + 336 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (terminal === 'lostcapture')
        await page.evaluate(() => {
          const canvas = document.querySelector('.remote-viewport canvas:not(.no-frame)');
          for (let id = 0; id < 20; id++) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
        });
      inject({
        type: terminal === 'cancel' ? 'touchCancel' : 'touchEnd',
        touchPoints: [],
        timestamp: stamp + 0.336,
      });
      const responses = await Promise.all(pending);
      const failed = responses.find((response) => response?.error);
      if (failed) throw Error(failed.error);
      await page.waitForTimeout(2800);
      const observation = await inspect(),
        client = await page.evaluate(() => ({
          sent: window.touchQA.sent,
          results: window.touchQA.results,
          layout: window.touchQA.layout,
        }));
      report.run = observation.run;
      report.browserDisableFeatures = observation.browserDisableFeatures;
      const record = {
        id,
        mode,
        terminal,
        dpr,
        injection,
        geometry,
        quality: observation.state?.quality,
        client,
        remote: observation.telemetry[id + ':root'],
        child: observation.telemetry[id + ':child'],
        snapshot: observation.snapshot,
      };
      report.cases.push(record);
      return record;
    }
    for (const mode of hostPage._rkTouchModes ?? ['normal', 'stall70', 'up100'])
      await swipe('trajectory-' + mode, mode);
    if (!trajectoriesOnly) {
      await swipe('nested', 'normal', 480, 250, 90);
      await swipe('frame', 'normal', 480, 550, 390);
      if (!failedOnly) {
        await swipe('touch-action-none', 'normal', 750, 250, 90);
        await swipe('prevent-default', 'normal', 750, 550, 390);
      }
      await swipe('cancel', 'normal', 100, 500, 180, 'cancel');
      await swipe('lostcapture', 'normal', 100, 500, 180, 'lostcapture');
      await page.setViewportSize({ width: 700, height: 700 });
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 700,
        height: 700,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await swipe('dpr2', 'normal', 100, 500, 180, 'end', 2);
    }
    const trajectories = report.cases.slice(0, 3),
      normal = trajectories[0].remote?.positions.root;
    report.checks = {
      sourceClock: trajectories.every(
        (r) => r.client.sent.length > 0 && r.client.sent.every((s) => s.event.clockMode === 'source'),
      ),
      trajectoryConsistent:
        typeof normal === 'number' &&
        normal > 0 &&
        trajectories.every((r) => Math.abs(r.remote.positions.root - normal) <= Math.max(30, normal * 0.12)),
      flingObserved: trajectories.every((r) => r.remote.positions.root > 320),
      noRejectedInput: report.cases.every((r) => r.client.results.every((m) => m.ok !== false)),
      ...(!trajectoriesOnly
        ? {
            nested:
              report.cases.find((r) => r.id === 'nested').remote.positions.nested > 0 &&
              report.cases.find((r) => r.id === 'nested').remote.positions.root === 0,
            crossOriginFrame: report.cases.find((r) => r.id === 'frame').child?.positions.root > 0,
            oopifRenderer: report.cases
              .find((r) => r.id === 'frame')
              .snapshot.views.some((view) => view.renderer_pids?.length >= 2),
            ...(!failedOnly
              ? {
                  touchActionNone:
                    report.cases.find((r) => r.id === 'touch-action-none').remote.positions.root === 0,
                  preventDefault:
                    report.cases.find((r) => r.id === 'prevent-default').remote.positions.root === 0 &&
                    report.cases.find((r) => r.id === 'prevent-default').remote.positions.blocked === 0,
                }
              : {}),
            cancel: report.cases.find((r) => r.id === 'cancel').remote.counts.touchcancel >= 1,
            lostcapture: report.cases.find((r) => r.id === 'lostcapture').remote.counts.touchcancel >= 1,
            dpr2:
              report.cases.find((r) => r.id === 'dpr2').remote.dpr === 2 &&
              report.cases.find((r) => r.id === 'dpr2').geometry.viewerDpr === 2,
            coordinateMapping: ['trajectory-normal', 'dpr2'].every((id) => {
              const start = report.cases
                .find((r) => r.id === id)
                .remote.events.find((e) => e.type === 'touchstart');
              return start && Math.abs(start.x - 100) <= 1 && Math.abs(start.y - 500) <= 1;
            }),
          }
        : {}),
    };
    await page.screenshot({ path: report.run + '/final.png', fullPage: true });
    report.finishedAt = Date.now();
    await context.request.post(fixture + '/record', { data: report });
    return {
      version: report.version,
      checks: report.checks,
      cases: report.cases.map((r) => ({
        id: r.id,
        mode: r.mode,
        dpr: r.remote?.dpr,
        positions: r.remote?.positions,
        child: r.child?.positions,
        counts: r.remote?.counts,
        sourceModes: [...new Set(r.client.sent.map((s) => s.event.clockMode))],
        inputErrors: r.client.results.filter((m) => m.ok === false),
      })),
      errors: report.errors,
    };
  } catch (error) {
    report.failure = String(error);
    await context.request.post(fixture + '/record', { data: report }).catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
};
