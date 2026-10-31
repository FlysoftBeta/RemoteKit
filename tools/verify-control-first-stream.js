// Host Playwright browser_run_code_unsafe filename entry; no OS mouse/keyboard use.
async (hostPage) => {
  const browser = await hostPage.context().browser().browserType().launch({ executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: false, args: ['--no-first-run', '--no-default-browser-check', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const pageErrors = []; const exchanges = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (response.url().endsWith('/api/rtc/offer')) exchanges.push(response.json().then(answer => ({ offer: response.request().postDataJSON(), answer, status: response.status() })).catch(error => ({ error: String(error) }))); });
  let failure;
  try {
    await page.goto('http://127.0.0.1:3001');
    await page.waitForFunction(() => document.querySelector('button[aria-label="新建标签页"]')?.disabled === false);
    await page.evaluate(async () => {
      const action = async body => { const res = await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await res.json(); if (!res.ok) throw new Error(JSON.stringify(value)); return value; };
      await action({ type: 'device.set', device: { mode: 'desktop', width: 1920, height: 1080, deviceScaleFactor: 1 } });
      await action({ type: 'tab.create', url: 'http://127.0.0.1:3001/test-pattern.html?mode=animation&fps=60', title: 'Pixel marker first stream' });
      window.remotekitDiagnostics.transport.receiveProfile = 'chrome89-h264-42';
      window.rkReceiveCapabilities = await window.remotekitDiagnostics.transport.probeReceiveCapabilities();
      await window.remotekitDiagnostics.transport.connect();
    });
    await page.waitForFunction(() => { const t = window.remotekitDiagnostics.transport; return t.video.videoWidth > 0 && t.layout?.views.length > 0 && t.diagnostics.channel === '已连接' && t.displayReady; }, null, { timeout: 15000 });
    await page.evaluate(async () => {
      const transport = window.remotekitDiagnostics.transport, video = transport.video;
      const callbacks = []; window.rkVideoFrameMetadata = { supported: typeof video.requestVideoFrameCallback === 'function', callbacks };
      if (video.requestVideoFrameCallback) await new Promise(resolve => { let finished = false; const finish = () => { if (!finished) { finished = true; resolve(); } }; setTimeout(finish, 2000); const callback = (now, metadata) => { callbacks.push({ now, keys: Object.keys(metadata), metadata: { ...metadata }, rtpTimestamp: metadata.rtpTimestamp ?? null }); if (callbacks.length < 5 && !finished) video.requestVideoFrameCallback(callback); else finish(); }; video.requestVideoFrameCallback(callback); });
      const { decodeMarker } = await import('/marker-codec.js'); const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 112; const ctx = canvas.getContext('2d');
      const read = () => { const view = transport.layout?.views[0]; if (!view || !transport.displayReady) return null; ctx.drawImage(transport.displayFrame, view.x, view.y, 256 * view.deviceScaleFactor * (view.mediaScale ?? 1), 112 * view.deviceScaleFactor * (view.mediaScale ?? 1), 0, 0, 256, 112); return decodeMarker(ctx.getImageData(0, 0, 256, 112)); };
      window.rkFirstMarker = read(); const view = transport.layout.views[0]; transport.focus(view, true); transport.sendInput(view, { type: 'ime_commit', text: 'RK:42;' });
      const deadline = performance.now() + 4000; while (performance.now() < deadline) { const marker = read(); if (marker?.stimulus === 42) { window.rkStimulusMarker = marker; break; } await new Promise(resolve => setTimeout(resolve, 20)); }
    });
  } catch (error) { failure = String(error); }
  try {
    const observed = await page.evaluate(async () => { const transport = window.remotekitDiagnostics?.transport; const reports = transport?.peer ? Array.from((await transport.peer.getStats()).values()) : []; return { diagnostics: transport?.diagnostics, layout: transport?.layout, displayReady: transport?.displayReady, presentedFrame: transport?.presentedFrame, receiveCapabilities: window.rkReceiveCapabilities, signaling: transport?.signaling, state: await (await fetch('/api/state')).json(), video: { width: transport?.video.videoWidth, height: transport?.video.videoHeight, decodedFrames: transport?.video.webkitDecodedFrameCount }, reports, requestVideoFrameCallback: window.rkVideoFrameMetadata, markerBefore: window.rkFirstMarker, markerAfterStimulus: window.rkStimulusMarker }; });
    const report = { kind: 'first-stream-functional-debug', browserVersion: browser.version(), failure, pageErrors, exchanges: await Promise.all(exchanges), ...observed };
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '诊断')?.click());
    await page.waitForFunction(() => document.querySelector('.overlay-toggle input'));
    await page.evaluate(() => document.querySelector('.overlay-toggle input').click());
    await page.evaluate(() => document.querySelector('[aria-label="关闭侧栏"]').click());
    await page.screenshot({ path: 'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/first-stream/chrome89.png', fullPage: true });
    report.rtcClose = await page.evaluate(async () => { const transport = window.remotekitDiagnostics.transport; if (!transport.diagnostics.connectionId) return null; const start = performance.now(); const response = await fetch('/api/rtc/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: transport.diagnostics.connectionId }) }); return { elapsedMs: performance.now() - start, status: response.status }; });
    await page.evaluate(() => window.remotekitDiagnostics.transport.disconnect());
    await page.evaluate(async report => { await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }); }, report);
    return { browserVersion: report.browserVersion, failure, pageErrors, diagnostics: observed.diagnostics, video: observed.video, markerBefore: observed.markerBefore, markerAfterStimulus: observed.markerAfterStimulus, requestVideoFrameCallback: observed.requestVideoFrameCallback, codec: observed.reports.filter(item => item.type === 'codec' && item.mimeType?.includes('H264')), stateError: observed.state.endpointError, layout: observed.layout, receiveCapabilities: observed.receiveCapabilities, displayReady: observed.displayReady, presentedFrame: observed.presentedFrame, rtcClose: report.rtcClose };
  } finally {
    await page.evaluate(() => window.remotekitDiagnostics?.transport.disconnect()).catch(() => {});
    await browser.close();
  }
}
