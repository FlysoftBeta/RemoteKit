// Host Playwright browser_run_code_unsafe entry; dedicated Chrome89, no OS input.
// Server must explicitly enable REMOTEKIT_DIAGNOSTICS=1. Tests /automation media/input.
// Override only CONFIG in a temporary copy for a package test or another port.
async (hostPage) => {
  const config = /* CONFIG */ { origin: 'http://127.0.0.1:3001', screenshotPath: 'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/first-stream/chrome89.png', profileDirectory: null };
  const browserType = hostPage.context().browser().browserType();
  const options = { executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: false, args: ['--no-first-run', '--no-default-browser-check', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] };
  const context = config.profileDirectory ? await browserType.launchPersistentContext(config.profileDirectory, { ...options, viewport: { width: 1440, height: 1000 } }) : await (await browserType.launch(options)).newContext({ viewport: { width: 1440, height: 1000 } });
  const browser = context.browser(), page = context.pages()[0] ?? await context.newPage();
  const pageErrors = [], exchanges = []; let failure;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (response.url().endsWith('/api/rtc/offer')) exchanges.push(response.json().then(answer => ({ offer: response.request().postDataJSON(), answer, status: response.status() })).catch(error => ({ error: String(error) }))); });
  const readMarker = async expected => page.evaluate(async expected => {
    const { decodeMarker } = await import('/marker-codec.js'), t = window.remotekitDiagnostics.transport;
    const c = document.createElement('canvas'); c.width = 256; c.height = 112; const ctx = c.getContext('2d'), deadline = performance.now() + 4000;
    while (performance.now() < deadline) {
      const view = t.layout?.views[0], frame = view && t.getLastPresentation(view.id);
      const source = frame && t.getPresentedPlane(view.id, frame.rtpTimestamp);
      if (source && source.rtpTimestamp === frame.rtpTimestamp && source.layoutEpoch === frame.layoutEpoch) { const scale = source.pixelsPerDip; ctx.drawImage(source.image, source.sourceRect.x, source.sourceRect.y, 256 * scale, 112 * (source.pixelsPerDipY ?? scale), 0, 0, 256, 112); const marker = decodeMarker(ctx.getImageData(0, 0, 256, 112)); if (marker && (expected === null || marker.stimulus === expected)) return marker; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return null;
  }, expected);
  try {
    await page.goto(config.origin + '/automation');
    await page.waitForFunction(() => window.remotekitDiagnostics?.state);
    await page.evaluate(async ({ origin }) => {
      const action = window.remotekitDiagnostics.action;
      await action({ type: 'device.set', device: { mode: 'desktop', width: 1920, height: 1080, deviceScaleFactor: 1 } });
      await action({ type: 'tab.create', url: origin + '/test-pattern.html?mode=animation&fps=60&activationMarker=1', title: 'Pixel marker first stream' });
      const t = window.remotekitDiagnostics.transport; t.receiveProfile = 'chrome89-h264-42';
      window.rkReceiveCapabilities = await t.probeReceiveCapabilities(); await t.connect();
    }, config);
    await page.waitForFunction(() => { const t = window.remotekitDiagnostics.transport, view = t.layout?.views[0]; return view && t.diagnostics.channel === '已连接' && t.getLastPresentation(view.id); }, null, { timeout: 20000 });
    const before = await page.evaluate(() => { const t = window.remotekitDiagnostics.transport, s = t.layout.views[0], r = document.querySelector('.remote-viewport canvas').getBoundingClientRect(), scale = s.deviceScaleFactor * (s.mediaScale ?? 1); return { focus: s.focus, epoch: t.layout.epoch, activeLabel: document.activeElement?.getAttribute('aria-label'), resultCount: t.inputResults.length, point: { x: r.left + 350 / (s.width / scale) * r.width, y: r.top + 30 / (s.height / scale) * r.height } }; });
    await page.mouse.move(before.point.x, before.point.y);
    await page.waitForFunction(count => window.remotekitDiagnostics.transport.inputResults.slice(count).some(result => result.type === 'input.result'), before.resultCount, { timeout: 5000 });
    const hover = await page.evaluate(before => { const t = window.remotekitDiagnostics.transport; return { before, after: { focus: t.layout.views[0].focus, epoch: t.layout.epoch, activeLabel: document.activeElement?.getAttribute('aria-label') }, replies: t.inputResults.slice(before.resultCount), error: t.diagnostics.error }; }, before);
    await page.evaluate(hover => { window.rkHover = hover; }, hover);
    if (hover.replies.some(reply => reply.ok === false) || hover.error) throw new Error('Initial no-button hover was rejected: ' + JSON.stringify(hover));
    if (hover.after.focus !== before.focus || hover.after.epoch !== before.epoch || hover.after.activeLabel !== before.activeLabel) throw new Error('Hover changed focus or layout: ' + JSON.stringify(hover));
    const first = await readMarker(null); await page.evaluate(marker => { window.rkFirstMarker = marker; }, first);
    if (!first) throw new Error('No CRC-valid marker from the authorized video plane');
    await page.mouse.click(before.point.x, before.point.y);
    const clicked = await readMarker(60001); await page.evaluate(marker => { window.rkClickMarker = marker; }, clicked);
    if (!clicked) throw new Error('No received-video activation marker after the real input-field click');
    await page.evaluate(() => { const t = window.remotekitDiagnostics.transport, view = t.layout.views[0]; t.focus(view, true); if (!t.sendInput(view, { type: 'ime_commit', text: 'RK:42;' })) throw new Error('IME input was not accepted by client transport'); });
    const response = await readMarker(42); await page.evaluate(marker => { window.rkStimulusMarker = marker; }, response);
    if (!response) throw new Error('No CRC-valid IME stimulus 42 response from received video');
    await page.evaluate(async () => {
      const t = window.remotekitDiagnostics.transport, view = t.layout.views[0], frame = t.getLastPresentation(view.id);
      const video = frame && t.getPresentedPlane(view.id, frame.rtpTimestamp)?.image, callbacks = []; window.rkVideoFrameMetadata = { supported: typeof video?.requestVideoFrameCallback === 'function', callbacks };
      if (video?.requestVideoFrameCallback) await new Promise(resolve => { let finished = false; const finish = () => { if (!finished) { finished = true; resolve(); } }; setTimeout(finish, 1000); const callback = (now, metadata) => { callbacks.push({ now, keys: Object.keys(metadata), metadata: { ...metadata } }); if (callbacks.length < 3 && !finished) video.requestVideoFrameCallback(callback); else finish(); }; video.requestVideoFrameCallback(callback); });
    });
    if (pageErrors.length) throw new Error('Client page errors: ' + pageErrors.join('; '));
  } catch (error) { failure = String(error); }
  try {
    const observed = await page.evaluate(async () => { const t = window.remotekitDiagnostics?.transport, video = t && [...t.videoPlanes.values()][0]?.video; return { diagnostics: t?.diagnostics, layout: t?.layout, displayReady: t?.displayReady, presentedFrame: t?.presentedFrame, presentation: t?.presentationDiagnostics, inputTrace: t?.inputTrace, inputResults: t?.inputResults, hover: window.rkHover, receiveCapabilities: window.rkReceiveCapabilities, signaling: t?.signaling, state: await (await fetch('/api/state')).json(), video: { width: video?.videoWidth, height: video?.videoHeight, decodedFrames: video?.webkitDecodedFrameCount }, reports: t?.peer ? Array.from((await t.peer.getStats()).values()) : [], requestVideoFrameCallback: window.rkVideoFrameMetadata, markerBefore: window.rkFirstMarker, markerAfterClick: window.rkClickMarker, markerAfterStimulus: window.rkStimulusMarker }; });
    if (!failure && (observed.diagnostics?.error || observed.state.endpointError || observed.inputResults?.some(reply => reply.ok === false))) failure = 'Remote input or endpoint reported an error: ' + JSON.stringify({ error: observed.diagnostics?.error, endpointError: observed.state.endpointError, rejected: observed.inputResults?.filter(reply => reply.ok === false) });
    const report = { kind: 'first-stream-functional-debug', passed: !failure, config, browserVersion: browser.version(), failure, pageErrors, exchanges: await Promise.all(exchanges), ...observed };
    await page.screenshot({ path: config.screenshotPath, fullPage: true });
    report.rtcClose = await page.evaluate(async () => { const t = window.remotekitDiagnostics.transport; if (!t.diagnostics.connectionId) return null; const start = performance.now(), r = await fetch('/api/rtc/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: t.diagnostics.connectionId }) }); return { elapsedMs: performance.now() - start, status: r.status }; });
    await page.evaluate(() => window.remotekitDiagnostics.transport.disconnect());
    if (!report.rtcClose || report.rtcClose.status !== 200) { failure ??= 'RTC close did not return 200'; report.failure = failure; report.passed = false; }
    await page.evaluate(async report => { const r = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }); if (!r.ok) throw new Error('Metrics upload ' + r.status); }, report);
    if (failure) throw new Error('First-stream validation failed: ' + failure);
    return { passed: true, browserVersion: report.browserVersion, pageErrors, hover: observed.hover, video: observed.video, markerBefore: observed.markerBefore, markerAfterClick: observed.markerAfterClick, markerAfterStimulus: observed.markerAfterStimulus, displayReady: observed.displayReady, layout: observed.layout, rtcClose: report.rtcClose };
  } finally { await page.evaluate(() => window.remotekitDiagnostics?.transport.disconnect()).catch(() => {}); await browser.close(); }
}
