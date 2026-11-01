// Host Playwright browser_run_code_unsafe filename entry. The driver rewrites
// only the CONFIG literal in a temporary copy for each bounded experiment.
async (hostPage) => {
  const config = /* CONFIG */ { id: 'pilot', origin: 'http://127.0.0.1:3001', tenants: 1, width: 1280, height: 720, dpr: 1, mode: 'animation', warmupMs: 5000, sampleMs: 20000, receiveProfile: 'chrome89-h264-42', endpoint: {}, network: {} };
  const flags = ['--no-first-run', '--no-default-browser-check', '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...(config.clientExtraFlags ?? [])];
  const clientExecutablePath = config.clientExecutablePath ?? 'C:/src/tmp/chrome89-google/app/chrome.exe';
  const browser = await hostPage.context().browser().browserType().launch({ executablePath: clientExecutablePath, headless: false, args: flags });
  const pages = [], contexts = [], errors = [], closeResults = [];
  let timerPolicy = null, measurementError, clientVersion;
  try {
    const versionSession = await browser.newBrowserCDPSession();
    try { clientVersion = await versionSession.send('Browser.getVersion'); }
    finally { await versionSession.detach(); }
    for (let i = 0; i < config.tenants; ++i) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push({ tenant: i, error: error.message }));
      await page.goto(config.origin);
      await page.waitForFunction(() => document.querySelector('button[aria-label="新建标签页"]')?.disabled === false);
      await page.evaluate(async ({ config, index }) => {
        const action = async body => { const response = await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data; };
        await action({ type: 'device.set', device: { mode: 'desktop', width: config.width, height: config.height, deviceScaleFactor: config.dpr } });
        await action({ type: 'tab.create', title: `Benchmark ${config.id}/${index}`, url: `${config.fixtureOrigin || config.origin}/test-pattern.html?mode=${encodeURIComponent(config.mode)}&fps=60&probeRun=${encodeURIComponent(config.id + '-' + index)}${config.captureQuality ? '&quality=1&stopAfter=8000' : ''}` });
        const transport = window.remotekitDiagnostics.transport;
        if (config.callbackRegistration) transport.frameCallbackRegistration = config.callbackRegistration;
        if (config.presentationMode) {
          if (!transport.registerPlane) throw new Error('This client does not support the requested presentation experiment');
          transport.presentationMode = config.presentationMode;
        }
        transport.receiveProfile = config.receiveProfile;
        await transport.connect();
        if (config.visibleVideoPreview) {
          Object.assign(transport.video.style, { position: 'fixed', top: '70px', right: '12px', width: '160px', height: '90px', opacity: '1', zIndex: '2147483647', pointerEvents: 'none', display: 'block', visibility: 'visible' });
          document.body.appendChild(transport.video);
        }
        window.rkBenchmarkReceivers = (transport.peer?.getReceivers() ?? []).filter(receiver => receiver.track?.kind === 'video').map(receiver => {
          const supported = 'playoutDelayHint' in receiver;
          const result = { supported, original: supported ? receiver.playoutDelayHint : null, requestedMs: config.playoutDelayHintMs ?? null };
          if (supported && config.playoutDelayHintMs >= 0) {
            try { receiver.playoutDelayHint = config.playoutDelayHintMs / 1000; }
            catch (error) { result.error = String(error); }
          }
          result.actual = supported ? receiver.playoutDelayHint : null;
          return result;
        });
      }, { config, index: i });
      await page.waitForFunction(() => { const t = window.remotekitDiagnostics.transport; return t.displayReady && t.layout?.views.length && t.video.videoWidth > 0; }, null, { timeout: 20000 });
    }
    if (config.honorClientTimerResolution) {
      const cdp = await browser.newBrowserCDPSession();
      const processes = await cdp.send('SystemInfo.getProcessInfo');
      const browserProcess = processes.processInfo.find(process => process.type === 'browser');
      if (!browserProcess) throw new Error('Cannot identify this test browser PID');
      await pages[0].evaluate(async ({ pid, runId }) => {
        const response = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'timer-policy-root', runId, rootPid: pid }) });
        if (!response.ok) throw new Error(`Timer PID handoff failed ${response.status}`);
      }, { pid: browserProcess.id, runId: config.id });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const response = await pages[0].request.get(`${config.fixtureOrigin}/timer-policy`);
        if (response.ok()) { timerPolicy = await response.json(); break; }
        await pages[0].waitForTimeout(100);
      }
      await cdp.detach();
      if (!timerPolicy?.allSucceeded) throw new Error(`Timer policy not applied to all selected test PIDs: ${JSON.stringify(timerPolicy)}`);
    }
    if (config.resourceProfile) {
      const cdp = await browser.newBrowserCDPSession();
      const info = await cdp.send('SystemInfo.getProcessInfo');
      const root = info.processInfo.find(process => process.type === 'browser');
      if (!root) throw new Error('Cannot identify receiver process for resource attribution');
      await pages[0].evaluate(async ({ receiverRootPid, runId }) => {
        const saved = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'resource-process-root', receiverRootPid, runId }) });
        if (!saved.ok) throw new Error(`Resource root handoff failed ${saved.status}`);
      }, { receiverRootPid: root.id, runId: config.id });
      await cdp.detach();
    }
    // All peers stay alive together. No parameter groups overlap.
    await Promise.all(pages.map(page => page.waitForTimeout(config.warmupMs)));
    const results = await Promise.all(pages.map((page, index) => page.evaluate(async ({ config, index, flags, clientVersion }) => {
      const transport = window.remotekitDiagnostics.transport;
      transport.resetPresentationDiagnostics?.();
      const { decodeMarker, percentiles } = await import('/marker-codec.js');
      const markerCanvas = document.createElement('canvas'); markerCanvas.width = 256; markerCanvas.height = 112;
      const context = markerCanvas.getContext('2d');
      const samples = [], presentations = [], paintedFrames = [], rtcSamples = [], inputSamples = [], inputTimeouts = [], clientRaf = [], rawVideoFrames = [], inputs = new Map();
      const hasPaint = typeof transport.subscribePresentedFrames === 'function';
      if (config.requirePaint && !hasPaint) throw new Error('This case requires Viewport paint instrumentation');
      let observing = true, rafId, videoCallbackId;
      const raf = now => { if (!observing) return; clientRaf.push(now); rafId = requestAnimationFrame(raf); };
      if (config.observeClientRaf !== false) rafId = requestAnimationFrame(raf);
      if (transport.video.requestVideoFrameCallback) {
        const videoFrame = (now, metadata) => { if (!observing) return; rawVideoFrames.push({ now, ...metadata }); videoCallbackId = transport.video.requestVideoFrameCallback(videoFrame); };
        videoCallbackId = transport.video.requestVideoFrameCallback(videoFrame);
      }
      let previousFrame, previousRtp, previousPaintRtp, lastMarkerAt = -Infinity, invalid = 0, skipped = 0, missingPaintSnapshot = 0;
      const started = performance.now(), startedWall = Date.now();
      const clockSample = { performanceBefore: started, wallTime: startedWall, performanceAfter: performance.now() };
      const visibility = [{ at: started, value: document.visibilityState }];
      const visibilityChanged = () => visibility.push({ at: performance.now(), value: document.visibilityState });
      document.addEventListener('visibilitychange', visibilityChanged);
      const recordAuthorized = () => {
        const rtp = transport.presentedFrame?.rtpTimestamp;
        if (rtp !== undefined && rtp !== previousRtp) {
          presentations.push({ observedAt: performance.now(), rtp, epoch: transport.presentedFrame?.layoutEpoch ?? null });
          previousRtp = rtp;
        }
      };
      const read = painted => {
        const view = transport.layout?.views[0];
        if (!view || !transport.displayReady) return;
        if (painted && String(painted.viewId) !== String(view.id)) return;
        const observedAt = painted?.paintedAt ?? performance.now(), observedWall = painted?.paintedWallTime ?? Date.now();
        for (const [sequence, sentAt] of inputs) if (observedAt - sentAt > 2000) { inputTimeouts.push({ sequence, ageMs: observedAt - sentAt }); inputs.delete(sequence); }
        const rtp = painted?.rtpTimestamp ?? transport.presentedFrame?.rtpTimestamp ?? null;
        const epoch = painted?.layoutEpoch ?? transport.presentedFrame?.layoutEpoch ?? null;
        if (painted && rtp !== previousPaintRtp) {
          paintedFrames.push({ observedAt, rtp, epoch, authorizedAt: painted.authorizedAt });
          previousPaintRtp = rtp;
        }
        if (config.markerHz === 0 || (config.markerHz > 0 && observedAt - lastMarkerAt < 1000 / config.markerHz && !inputs.size)) return;
        lastMarkerAt = observedAt;
        const legacy = transport.getPresentedPlane ? undefined : (painted ? transport.getPaintedFrame(view.id, rtp) : transport.displayFrame);
        const source = transport.getPresentedPlane ? transport.getPresentedPlane(view.id, rtp) : legacy && { image: legacy, kind: 'atlas', sourceRect: view, pixelsPerDip: view.deviceScaleFactor * (view.mediaScale ?? transport.layout.mediaScale ?? 1), rtpTimestamp: rtp, layoutEpoch: epoch };
        if (!source || source.rtpTimestamp !== rtp || source.layoutEpoch !== epoch) { ++missingPaintSnapshot; return; }
        const drawStarted = performance.now();
        const pixelsPerDip = source.pixelsPerDip;
        context.drawImage(source.image, source.sourceRect.x, source.sourceRect.y, 256 * pixelsPerDip, 112 * pixelsPerDip, 0, 0, 256, 112);
        transport.recordPresentationCost?.('markerDraw', drawStarted, performance.now() - drawStarted);
        const readbackStarted = performance.now();
        const pixels = context.getImageData(0, 0, 256, 112);
        transport.recordPresentationCost?.('markerReadback', readbackStarted, performance.now() - readbackStarted);
        const decodeStarted = performance.now();
        const marker = decodeMarker(pixels);
        transport.recordPresentationCost?.('markerDecode', decodeStarted, performance.now() - decodeStarted);
        if (!marker) { ++invalid; return; }
        if (marker.frameId === previousFrame) return;
        if (previousFrame !== undefined) { const delta = (marker.frameId - previousFrame) >>> 0; if (delta > 0 && delta < 100000) skipped += delta - 1; }
        previousFrame = marker.frameId;
        const delay = ((observedWall >>> 0) - marker.timestamp) >>> 0;
        const sample = { observedAt, markerCompletedAt: performance.now(), frameId: marker.frameId, stimulus: marker.stimulus, rtp, epoch, sourceKind: source.kind ?? 'atlas', renderToObservedMs: delay < 60000 ? delay : null };
        samples.push(sample);
        const sent = inputs.get(marker.stimulus);
        if (sent !== undefined) { inputSamples.push({ sequence: marker.stimulus, delayMs: observedAt - sent, observedAt, frameId: marker.frameId }); inputs.delete(marker.stimulus); }
      };
      const unsubscribeAuthorized = transport.subscribeFrames(recordAuthorized);
      const unsubscribe = hasPaint ? transport.subscribePresentedFrames(read) : transport.subscribeFrames(() => read(null));
      const collect = async () => {
        const reports = transport.peer ? Array.from((await transport.peer.getStats()).values()) : [];
        const selectedTransport = reports.find(item => item.type === 'transport' && item.selectedCandidatePairId);
        const candidatePair = reports.find(item => item.id === selectedTransport?.selectedCandidatePairId) ??
          reports.find(item => item.type === 'candidate-pair' && item.state === 'succeeded' && (item.selected || (item.nominated && item.writable)));
        const inbound = reports.find(item => item.type === 'inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video'));
        const codec = inbound && reports.find(item => item.id === inbound.codecId);
        rtcSamples.push({ at: performance.now(), rtc: inbound ?? null, jitterBufferFieldAvailability: Object.fromEntries(['jitterBufferDelay', 'jitterBufferEmittedCount', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay'].map(name => [name, name in (inbound ?? {})])), codec: codec ?? null, candidatePair: candidatePair ?? null, endpoint: transport.diagnostics.endpoint ?? null, networkSimulation: transport.diagnostics.networkSimulation ?? null, selectedCandidates: transport.diagnostics.selectedCandidates ?? null, presentation: transport.getPresentationDiagnostics?.() ?? null, displayReady: transport.displayReady, video: { width: transport.video.videoWidth, height: transport.video.videoHeight, decoded: transport.video.webkitDecodedFrameCount }, visibilityState: document.visibilityState });
      };
      await collect();
      let tick = 0, polling = false;
      const timer = setInterval(() => { if (!polling) { polling = true; collect().finally(() => { polling = false; }); } }, 1000);
      const stimulus = config.inputIntervalMs === 0 ? undefined : setInterval(() => { const view = transport.layout?.views[0]; if (!view || !transport.displayReady) return; const sequence = (++tick + index * 1000) & 65535; inputs.set(sequence, performance.now()); if (tick === 1) transport.focus(view, true); transport.sendInput(view, { type: 'ime_commit', text: `RK:${sequence};` }); }, config.inputIntervalMs ?? 5000);
      await new Promise(resolve => setTimeout(resolve, config.sampleMs));
      clearInterval(timer); clearInterval(stimulus); unsubscribe(); unsubscribeAuthorized(); document.removeEventListener('visibilitychange', visibilityChanged);
      observing = false; cancelAnimationFrame(rafId);
      if (videoCallbackId !== undefined) transport.video.cancelVideoFrameCallback?.(videoCallbackId);
      await collect();
      const ended = performance.now();
      const elapsedMs = ended - started;
      const buckets = Array.from({ length: Math.ceil(config.sampleMs / 1000) }, () => 0);
      for (const sample of samples) { const bucket = Math.floor((sample.observedAt - started) / 1000); if (bucket >= 0 && bucket < buckets.length) ++buckets[bucket]; }
      const displayBuckets = buckets.map(() => 0);
      for (const frame of presentations) { const bucket = Math.floor((frame.observedAt - started) / 1000); if (bucket >= 0 && bucket < displayBuckets.length) ++displayBuckets[bucket]; }
      const paintBuckets = buckets.map(() => 0);
      for (const frame of paintedFrames) { const bucket = Math.floor((frame.observedAt - started) / 1000); if (bucket >= 0 && bucket < paintBuckets.length) ++paintBuckets[bucket]; }
      const render = samples.flatMap(sample => sample.renderToObservedMs === null ? [] : [sample.renderToObservedMs]);
      const presentation = transport.presentationDiagnostics ?? null;
      const raw = JSON.stringify(transport.getPresentationDiagnostics?.(true) ?? null);
      const report = { kind: 'streaming-benchmark', config, clientVersion, tenantIndex: index, flags, timeOrigin: performance.timeOrigin, startedAt: started, startedWall, clockSample, elapsedMs, actualLayout: transport.layout, signaling: transport.signaling, visibility, clock: 'same-machine-wall-clock', frameCountStage: hasPaint ? 'viewport-canvas-paint' : 'authorized-snapshot; Viewport paint not measured', observedFps: config.markerHz === undefined ? samples.length * 1000 / elapsedMs : null, markerSamplesPerSecond: samples.length * 1000 / elapsedMs, markerTimestampMeaning: hasPaint ? 'canvas draw submission time; synchronous same-RTP plane source; CRC completion separate' : 'authorized snapshot; not Viewport paint', authorizedFrameFps: presentations.length * 1000 / elapsedMs, authorizedPerSecondFrames: displayBuckets, displayFps: hasPaint ? paintedFrames.length * 1000 / elapsedMs : null, displayPerSecondFrames: hasPaint ? paintBuckets : null, perSecondFrames: buckets, perSecondFps: percentiles(buckets), renderToObservedMs: percentiles(render), inputToObservedMs: percentiles(inputSamples.map(sample => sample.delayMs)), invalid, missingPaintSnapshot, skippedMarkerFrames: config.markerHz === undefined ? skipped : null, markerFrameIdGaps: skipped, pendingInputs: inputs.size, samples, presentations, paintedFrames, inputSamples, rtcSamples, clientRaf, rawVideoFrames, presentation };
      report.inputTimeouts = inputTimeouts;
      report.inputSampleCount = inputSamples.length;
      report.markerSampleCount = samples.length;
      report.receiverPlayout = window.rkBenchmarkReceivers;
      const videoRect = transport.video.getBoundingClientRect(), videoStyle = getComputedStyle(transport.video);
      report.videoElement = { connected: transport.video.isConnected, rect: { x: videoRect.x, y: videoRect.y, width: videoRect.width, height: videoRect.height }, opacity: videoStyle.opacity, display: videoStyle.display, visibility: videoStyle.visibility };
      const response = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      if (!response.ok) throw new Error(`Metrics upload failed ${response.status}`);
      const chunks = Math.ceil(raw.length / 200000);
      for (let part = 0; part < chunks; ++part) {
        const saved = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'presentation-raw-chunk', runId: config.id, tenantIndex: index, part, chunks, text: raw.slice(part * 200000, (part + 1) * 200000) }) });
        if (!saved.ok) throw new Error(`Presentation raw upload failed ${saved.status}`);
      }
      if (config.markerHz !== 0 && ['animation', 'text'].includes(config.mode) && !samples.length) {
        throw new Error(`No CRC-valid marker samples: invalid=${invalid}, missingSnapshot=${missingPaintSnapshot}; raw metrics saved`);
      }
      if (config.captureQuality) {
        const view = transport.layout.views[0], frame = transport.presentedFrame;
        const legacy = transport.getPresentedPlane ? undefined : transport.getPaintedFrame(view.id, frame.rtpTimestamp);
        const source = transport.getPresentedPlane ? transport.getPresentedPlane(view.id, frame.rtpTimestamp) : legacy && { image: legacy, kind: 'atlas', sourceRect: view, pixelsPerDip: view.deviceScaleFactor * (view.mediaScale ?? transport.layout.mediaScale ?? 1), rtpTimestamp: frame.rtpTimestamp, layoutEpoch: frame.layoutEpoch };
        if (!source || source.rtpTimestamp !== frame.rtpTimestamp || source.layoutEpoch !== frame.layoutEpoch) throw new Error('Quality source no longer matches current painted RTP');
        const scale = source.pixelsPerDip;
        const image = document.createElement('canvas');
        // Layout width/height are already encoded pixels; apply no second DPR.
        image.width = view.width; image.height = view.height;
        const crop = source.sourceRect;
        image.getContext('2d').drawImage(source.image, crop.x, crop.y, crop.width, crop.height, 0, 0, image.width, image.height);
        context.drawImage(image, 0, 0, 256 * scale, 112 * scale, 0, 0, 256, 112);
        const marker = decodeMarker(context.getImageData(0, 0, 256, 112));
        const artifact = { kind: 'decoded-reference', run: config.id + '-' + index, marker, rtpTimestamp: frame.rtpTimestamp, layoutEpoch: frame.layoutEpoch, sourceKind: source.kind, sourceRect: crop, pixelsPerDip: scale, width: image.width, height: image.height, capturedAfterMeasurement: true, image: image.toDataURL('image/png') };
        const saved = await fetch(`${config.fixtureOrigin}/decoded-artifact?probeRun=${encodeURIComponent(artifact.run)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RK-Artifact': config.artifactToken }, body: JSON.stringify(artifact) });
        if (!saved.ok) throw new Error(`Decoded quality artifact upload failed ${saved.status}`);
      }
      return { tenantIndex: index, observedFps: report.observedFps, authorizedFrameFps: report.authorizedFrameFps, displayFps: report.displayFps, markerSamplesPerSecond: report.markerSamplesPerSecond, renderToObservedMs: report.renderToObservedMs, inputToObservedMs: report.inputToObservedMs, perSecondFrames: buckets, authorizedPerSecondFrames: displayBuckets, invalid, samples: samples.length, visibility, actualLayout: transport.layout, presentation, lastCounters: rtcSamples[rtcSamples.length - 1] };
    }, { config, index, flags, clientVersion })));
    await Promise.all(pages.map(page => page.waitForTimeout(1200)));
    return { id: config.id, browser: browser.version(), clientVersion, config, flags, timerPolicy, results, errors, closeResults };
  } catch (error) { measurementError = error; throw error;
  } finally {
    for (const [tenant, page] of pages.entries()) {
      try {
        const result = await page.evaluate(async () => {
          const t = window.remotekitDiagnostics?.transport, connectionId = t?.diagnostics.connectionId;
          try {
            if (!connectionId) return { connectionId: null, status: null };
            const started = performance.now(), response = await fetch('/api/rtc/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId }) });
            if (!response.ok) throw new Error(`RTC close ${response.status}`);
            return { connectionId, status: response.status, elapsedMs: performance.now() - started };
          } finally { t?.disconnect(); }
        });
        closeResults.push({ tenant, ...result });
      } catch (error) { closeResults.push({ tenant, error: String(error) }); }
    }
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
    if (!measurementError && closeResults.some(result => result.error)) throw new Error('RTC shutdown failed: ' + JSON.stringify(closeResults));
  }
}
