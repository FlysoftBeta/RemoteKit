// Requires REMOTEKIT_DIAGNOSTICS=1 and isolated temporary browser context.
// Configuration-driven /automation media/input correctness; does not validate product UI.
async (hostPage) => {
  const config = /* CONFIG */ { origin: 'http://127.0.0.1:3001' };
  const browser = await hostPage
    .context()
    .browser()
    .browserType()
    .launch({
      executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe',
      headless: false,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true }),
    page = await context.newPage();
  try {
    const gate = await page.request.get(config.origin + '/api/state');
    if (gate.status() !== 200)
      throw Error(
        'Explicit diagnostics server required (REMOTEKIT_DIAGNOSTICS=1), with fresh isolated session: ' +
          gate.status() +
          ' ' +
          (await gate.text()),
      );
    await page.goto(config.origin + '/automation');
    await page.waitForFunction(() => window.remotekitDiagnostics?.state);
    await page.evaluate(() => {
      if (window.remotekitDiagnostics.automaticQualityPolicy !== false)
        throw Error('Controlled automation requires adaptive quality disabled');
    });
    const result = await page.evaluate(async (config) => {
      const action = window.remotekitDiagnostics.action;
      await action({
        type: 'device.set',
        device: { mode: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2 },
      });
      const state = await action({
        type: 'tab.create',
        url: config.origin + '/test-pattern.html?mode=static&title=Touch-IME',
      });
      const api = window.remotekitDiagnostics;
      api.configure({ receiveProfile: 'chrome89-h264-51' });
      await api.refresh();
      await api.transport.connect();
      return { tenantId: state.tenantId, tabId: state.activeTabId };
    }, config);
    await page.waitForFunction(
      () =>
        document.querySelector('.remote-viewport canvas:not(.no-frame)') &&
        window.remotekitDiagnostics.transport.displayReady,
      null,
      { timeout: 20000 },
    );
    const point = await page.evaluate(() => {
      const r = document.querySelector('.remote-viewport canvas').getBoundingClientRect(),
        v = window.remotekitDiagnostics.transport.layout.views[0],
        scale = v.deviceScaleFactor * (v.mediaScale ?? 1);
      return { x: r.left + (r.width * 350 * scale) / v.width, y: r.top + (r.height * 30 * scale) / v.height };
    });
    await page.touchscreen.tap(point.x, point.y);
    const marker = async (expected) =>
      page.evaluate(async (expected) => {
        const { decodeMarker } = await import('/marker-codec.js'),
          t = window.remotekitDiagnostics.transport,
          c = document.createElement('canvas');
        c.width = 256;
        c.height = 112;
        const ctx = c.getContext('2d'),
          end = performance.now() + 3000;
        while (performance.now() < end) {
          const s = t.layout?.views[0],
            f = s && t.getLastPresentation(s.id),
            source = f && t.getPresentedPlane(s.id, f.rtpTimestamp);
          if (source) {
            const scale = source.pixelsPerDip;
            ctx.drawImage(
              source.image,
              source.sourceRect.x,
              source.sourceRect.y,
              256 * scale,
              112 * (source.pixelsPerDipY ?? scale),
              0,
              0,
              256,
              112,
            );
            const m = decodeMarker(ctx.getImageData(0, 0, 256, 112));
            if (m?.stimulus === expected) return m;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        return null;
      }, expected);
    result.touch = await marker(32769);
    if (!result.touch) throw Error('Touch marker missing');
    result.ime = [];
    for (const id of [81, 82]) {
      await page.evaluate((id) => {
        const t = window.remotekitDiagnostics.transport,
          s = t.layout.views[0];
        t.focus(s, true);
        if (!t.sendInput(s, { type: 'ime_commit', text: `RK:${id};` })) throw Error('IME input blocked');
      }, id);
      const observed = await marker(id);
      if (!observed) throw Error('IME marker missing: ' + id);
      result.ime.push(observed);
    }
    await page.screenshot({
      path: 'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/control-ui-final-input.png',
      fullPage: true,
    });
    const report = await page.evaluate(async (result) => {
      const t = window.remotekitDiagnostics.transport;
      return {
        ...result,
        kind: 'automation-input-functional',
        at: Date.now(),
        state: await window.remotekitDiagnostics.refresh(),
        diagnostics: t.diagnostics,
        presentation: t.presentationDiagnostics,
        inputTrace: t.inputTrace,
        inputResults: t.inputResults,
        layout: t.layout,
      };
    }, result);
    if (JSON.stringify(report).length > 900000) {
      delete report.sourceJpeg;
      report.imageOmittedForSize = true;
    }
    await page.evaluate(async (report) => {
      const response = await fetch('/api/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      if (!response.ok) throw Error(`metrics ${response.status}`);
    }, report);
    result.close = await page.evaluate(async () => {
      const t = window.remotekitDiagnostics.transport,
        start = performance.now(),
        r = await fetch('/api/rtc/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionId: t.diagnostics.connectionId }),
        });
      t.disconnect();
      return { status: r.status, elapsedMs: performance.now() - start };
    });
    await page.waitForTimeout(2200);
    result.stopped = await page.evaluate(() => ({
      peer: !!window.remotekitDiagnostics.transport.peer,
      connection: window.remotekitDiagnostics.transport.diagnostics.connection,
    }));
    if (result.close.status !== 200 || result.stopped.peer)
      throw Error('Explicit RTC close did not stop connection');
    result.passed = true;
    return result;
  } finally {
    await page.evaluate(() => window.remotekitDiagnostics?.transport.disconnect()).catch(() => {});
    await browser.close();
  }
};
