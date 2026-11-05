// Host Playwright browser_run_code_unsafe filename entry. The driver rewrites
// only the CONFIG literal in a temporary copy for each bounded experiment.
async (hostPage) => {
  const config = /* CONFIG */ {
    id: 'pilot',
    origin: 'http://127.0.0.1:3001',
    tenants: 1,
    width: 1280,
    height: 720,
    dpr: 1,
    mode: 'animation',
    warmupMs: 5000,
    sampleMs: 20000,
    receiveProfile: 'chrome89-h264-42',
    endpoint: {},
    network: {},
  };
  const retired = [
    'presentationMode',
    'frameSource',
    'processorScheduler',
    'processorProfile',
    'visibleVideoPreview',
    'requirePaint',
  ].filter((key) => key in config);
  if (retired.length)
    throw new Error(`Archived canvas benchmark options: ${retired.join(', ')}. Generate a new video case.`);
  const flags = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...(config.clientExtraFlags ?? []),
  ];
  const clientExecutablePath = config.clientExecutablePath ?? 'C:/src/tmp/chrome89-google/app/chrome.exe';
  const browser = await hostPage
    .context()
    .browser()
    .browserType()
    .launch({ executablePath: clientExecutablePath, headless: false, args: flags });
  const pages = [],
    contexts = [],
    errors = [],
    closeResults = [];
  let timerPolicy = null,
    measurementError,
    clientVersion;
  try {
    const versionSession = await browser.newBrowserCDPSession();
    try {
      clientVersion = await versionSession.send('Browser.getVersion');
    } finally {
      await versionSession.detach();
    }
    for (let i = 0; i < config.tenants; ++i) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      page.on('pageerror', (error) => errors.push({ tenant: i, error: error.message }));
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
      await page.evaluate(
        async ({ config, index }) => {
          if (window.remotekitDiagnostics.automaticQualityPolicy !== false)
            throw Error('Controlled automation requires adaptive quality disabled');
          const action = window.remotekitDiagnostics.action;
          await action({
            type: 'device.set',
            device: {
              mode: 'desktop',
              width: config.width,
              height: config.height,
              deviceScaleFactor: config.dpr,
            },
          });
          await action({
            type: 'tab.create',
            title: `Benchmark ${config.id}/${index}`,
            url: `${config.fixtureOrigin || config.origin}/test-pattern.html?mode=${encodeURIComponent(config.mode)}&fps=60&probeRun=${encodeURIComponent(config.id + '-' + index)}${config.captureQuality ? '&quality=1&stopAfter=8000' : ''}`,
          });
          const transport = window.remotekitDiagnostics.transport;
          window.remotekitDiagnostics.configure({ receiveProfile: config.receiveProfile });
          await window.remotekitDiagnostics.refresh();
          await transport.connect();
          window.rkBenchmarkReceivers = (transport.peer?.getReceivers() ?? [])
            .filter((receiver) => receiver.track?.kind === 'video')
            .map((receiver) => {
              const supported = 'playoutDelayHint' in receiver;
              const result = {
                supported,
                original: supported ? receiver.playoutDelayHint : null,
                requestedMs: config.playoutDelayHintMs ?? null,
              };
              if (supported && config.playoutDelayHintMs >= 0) {
                try {
                  receiver.playoutDelayHint = config.playoutDelayHintMs / 1000;
                } catch (error) {
                  result.error = String(error);
                }
              }
              result.actual = supported ? receiver.playoutDelayHint : null;
              return result;
            });
        },
        { config, index: i },
      );
      await page.waitForFunction(
        () => {
          const t = window.remotekitDiagnostics.transport;
          return (
            t.displayReady &&
            t.layout?.views.length &&
            t.diagnostics.videoWidth > 0 &&
            t.diagnostics.videoHeight > 0 &&
            t.getLastPresentation?.(t.layout.views[0].id)
          );
        },
        null,
        { timeout: 20000 },
      );
    }
    if (config.honorClientTimerResolution) {
      const cdp = await browser.newBrowserCDPSession();
      const processes = await cdp.send('SystemInfo.getProcessInfo');
      const browserProcess = processes.processInfo.find((process) => process.type === 'browser');
      if (!browserProcess) throw new Error('Cannot identify this test browser PID');
      await pages[0].evaluate(
        async ({ pid, runId }) => {
          const response = await fetch('/api/metrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'timer-policy-root', runId, rootPid: pid }),
          });
          if (!response.ok) throw new Error(`Timer PID handoff failed ${response.status}`);
        },
        { pid: browserProcess.id, runId: config.id },
      );
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const response = await pages[0].request.get(`${config.fixtureOrigin}/timer-policy`);
        if (response.ok()) {
          timerPolicy = await response.json();
          break;
        }
        await pages[0].waitForTimeout(100);
      }
      await cdp.detach();
      if (!timerPolicy?.allSucceeded)
        throw new Error(`Timer policy not applied to all selected test PIDs: ${JSON.stringify(timerPolicy)}`);
    }
    if (config.resourceProfile) {
      const cdp = await browser.newBrowserCDPSession();
      const info = await cdp.send('SystemInfo.getProcessInfo');
      const root = info.processInfo.find((process) => process.type === 'browser');
      if (!root) throw new Error('Cannot identify receiver process for resource attribution');
      await pages[0].evaluate(
        async ({ receiverRootPid, runId }) => {
          const saved = await fetch('/api/metrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'resource-process-root', receiverRootPid, runId }),
          });
          if (!saved.ok) throw new Error(`Resource root handoff failed ${saved.status}`);
        },
        { receiverRootPid: root.id, runId: config.id },
      );
      await cdp.detach();
    }
    // All peers stay alive together. No parameter groups overlap.
    await Promise.all(pages.map((page) => page.waitForTimeout(config.warmupMs)));
    const results = await Promise.all(
      pages.map((page, index) =>
        page.evaluate(
          async ({ config, index, flags, clientVersion }) => {
            const transport = window.remotekitDiagnostics.transport;
            transport.resetPresentationDiagnostics?.();
            const { decodeMarker, percentiles } = await import('/marker-codec.js');
            const markerReadbackMode = config.markerReadback ?? 'sync';
            if (!['sync', 'worker'].includes(markerReadbackMode))
              throw new Error('Unknown markerReadback mode');
            const markerReader =
              markerReadbackMode === 'worker'
                ? await new (await import('/benchmark-marker-readback.js')).BenchmarkMarkerReadback().start()
                : null;
            const markerJobs = [],
              markerFailures = [];
            let markerCompletion = Promise.resolve();
            const markerCanvas = document.createElement('canvas');
            markerCanvas.width = 256;
            markerCanvas.height = 112;
            const context = markerCanvas.getContext('2d');
            const samples = [],
              videoObservations = [],
              rtcSamples = [],
              inputSamples = [],
              inputTimeouts = [],
              clientRaf = [],
              rawVideoFrames = [],
              inputs = new Map();
            const measuredView = transport.layout.views[0].id;
            const currentSource = () => {
              const frame = transport.getLastPresentation(measuredView);
              return frame && transport.getPresentedPlane(measuredView, frame.rtpTimestamp);
            };
            const video = currentSource()?.image;
            if (
              !(video instanceof HTMLVideoElement) ||
              transport.presentationDiagnostics.presentationEndpoint !== 'video-compositor-observation'
            ) {
              throw new Error('Video benchmark requires an authorized HTML video plane');
            }
            let observing = true,
              rafId,
              videoCallbackId;
            const raf = (now) => {
              if (!observing) return;
              clientRaf.push(now);
              rafId = requestAnimationFrame(raf);
            };
            if (config.observeClientRaf !== false) rafId = requestAnimationFrame(raf);
            const videoFrame = (now, metadata) => {
              if (!observing) return;
              rawVideoFrames.push({ now, ...metadata });
              videoCallbackId = video.requestVideoFrameCallback(videoFrame);
            };
            videoCallbackId = video.requestVideoFrameCallback(videoFrame);
            let previousFrame,
              lastMarkerAt = -Infinity,
              invalid = 0,
              skipped = 0,
              missingVideoSource = 0;
            const started = performance.now(),
              startedWall = Date.now();
            const clockSample = {
              performanceBefore: started,
              wallTime: startedWall,
              performanceAfter: performance.now(),
            };
            const visibility = [{ at: started, value: document.visibilityState }];
            const visibilityChanged = () =>
              visibility.push({ at: performance.now(), value: document.visibilityState });
            document.addEventListener('visibilitychange', visibilityChanged);
            const acceptMarker = (marker, identity, extra = {}) => {
              const { observedAt, observedWall, rtp, epoch, sourceKind } = identity;
              if (!marker) {
                ++invalid;
                return;
              }
              if (marker.frameId === previousFrame) return;
              if (previousFrame !== undefined) {
                const delta = (marker.frameId - previousFrame) >>> 0;
                if (delta > 0 && delta < 100000) skipped += delta - 1;
              }
              previousFrame = marker.frameId;
              const delay = ((observedWall >>> 0) - marker.timestamp) >>> 0;
              const sample = {
                observedAt,
                observedWall,
                markerCompletedAt: performance.now(),
                frameId: marker.frameId,
                stimulus: marker.stimulus,
                rtp,
                epoch,
                sourceKind,
                renderToObservedMs: delay < 60000 ? delay : null,
                ...extra,
              };
              samples.push(sample);
              const sent = inputs.get(marker.stimulus);
              if (sent !== undefined) {
                inputSamples.push({
                  sequence: marker.stimulus,
                  delayMs: observedAt - sent,
                  observedAt,
                  frameId: marker.frameId,
                });
                inputs.delete(marker.stimulus);
              }
            };
            const read = (frame) => {
              if (frame.viewId !== measuredView) return;
              const {
                rtpTimestamp: rtp,
                layoutEpoch: epoch,
                paintedAt: observedAt,
                paintedWallTime: observedWall,
              } = frame;
              for (const [sequence, sentAt] of inputs)
                if (observedAt - sentAt > 2000) {
                  inputTimeouts.push({ sequence, ageMs: observedAt - sentAt });
                  inputs.delete(sequence);
                }
              videoObservations.push({ observedAt, rtp, epoch, authorizedAt: frame.authorizedAt });
              if (
                config.markerHz === 0 ||
                (config.markerHz > 0 && observedAt - lastMarkerAt < 1000 / config.markerHz && !inputs.size)
              )
                return;
              const source = transport.getPresentedPlane(measuredView, rtp);
              if (!source || source.layoutEpoch !== epoch || !(source.image instanceof HTMLVideoElement)) {
                ++missingVideoSource;
                return;
              }
              lastMarkerAt = observedAt;
              const identity = { observedAt, observedWall, rtp, epoch, sourceKind: 'video' };
              if (markerReader) {
                const rect = {
                  x: source.sourceRect.x,
                  y: source.sourceRect.y,
                  width: 256 * source.pixelsPerDip,
                  height: 112 * (source.pixelsPerDipY ?? source.pixelsPerDip),
                };
                if (
                  !Object.values(rect).every(Number.isFinite) ||
                  rect.x < 0 ||
                  rect.y < 0 ||
                  rect.x + rect.width > source.image.videoWidth ||
                  rect.y + rect.height > source.image.videoHeight
                ) {
                  markerFailures.push({
                    ...identity,
                    error: 'worker marker requires a finite in-bounds video ROI',
                  });
                  return;
                }
                const task = markerReader.submit(source.image, rect, identity).then(
                  (result) => ({ result }),
                  (error) => ({ error: String(error) }),
                );
                // Capture synchronously and consume worker results in observation order.
                markerCompletion = markerCompletion.then(async () => {
                  const { result, error } = await task;
                  if (error) {
                    markerFailures.push({ ...identity, error });
                    return;
                  }
                  markerJobs.push({
                    id: result.id,
                    ...identity,
                    sourceRect: result.sourceRect,
                    costs: result.costs,
                    crcValid: !!result.marker,
                  });
                  acceptMarker(result.marker, result.identity, {
                    markerJobId: result.id,
                    sourceRect: result.sourceRect,
                    readbackCosts: result.costs,
                  });
                });
                return;
              }
              const drawStarted = performance.now();
              const pixelsPerDip = source.pixelsPerDip;
              context.drawImage(
                source.image,
                source.sourceRect.x,
                source.sourceRect.y,
                256 * pixelsPerDip,
                112 * (source.pixelsPerDipY ?? pixelsPerDip),
                0,
                0,
                256,
                112,
              );
              transport.recordPresentationCost?.('markerDraw', drawStarted, performance.now() - drawStarted);
              const readbackStarted = performance.now();
              const pixels = context.getImageData(0, 0, 256, 112);
              transport.recordPresentationCost?.(
                'markerReadback',
                readbackStarted,
                performance.now() - readbackStarted,
              );
              const decodeStarted = performance.now();
              const marker = decodeMarker(pixels);
              transport.recordPresentationCost?.(
                'markerDecode',
                decodeStarted,
                performance.now() - decodeStarted,
              );
              acceptMarker(marker, identity);
            };
            const unsubscribe = transport.subscribePresentedFrames(read);
            const collect = async () => {
              const reports = transport.peer ? Array.from((await transport.peer.getStats()).values()) : [];
              const selectedTransport = reports.find(
                (item) => item.type === 'transport' && item.selectedCandidatePairId,
              );
              const candidatePair =
                reports.find((item) => item.id === selectedTransport?.selectedCandidatePairId) ??
                reports.find(
                  (item) =>
                    item.type === 'candidate-pair' &&
                    item.state === 'succeeded' &&
                    (item.selected || (item.nominated && item.writable)),
                );
              const inbound = reports.find(
                (item) =>
                  item.type === 'inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video'),
              );
              const codec = inbound && reports.find((item) => item.id === inbound.codecId);
              rtcSamples.push({
                at: performance.now(),
                rtc: inbound ?? null,
                jitterBufferFieldAvailability: Object.fromEntries(
                  [
                    'jitterBufferDelay',
                    'jitterBufferEmittedCount',
                    'jitterBufferTargetDelay',
                    'jitterBufferMinimumDelay',
                  ].map((name) => [name, name in (inbound ?? {})]),
                ),
                codec: codec ?? null,
                candidatePair: candidatePair ?? null,
                endpoint: transport.diagnostics.endpoint ?? null,
                networkSimulation: transport.diagnostics.networkSimulation ?? null,
                selectedCandidates: transport.diagnostics.selectedCandidates ?? null,
                presentation: transport.getPresentationDiagnostics?.() ?? null,
                displayReady: transport.displayReady,
                video: {
                  width: video.videoWidth,
                  height: video.videoHeight,
                  decoded: video.webkitDecodedFrameCount,
                },
                visibilityState: document.visibilityState,
              });
            };
            await collect();
            let tick = 0,
              polling = false;
            const timer = setInterval(() => {
              if (!polling) {
                polling = true;
                collect().finally(() => {
                  polling = false;
                });
              }
            }, 1000);
            const stimulus =
              config.inputIntervalMs === 0
                ? undefined
                : setInterval(() => {
                    const view = transport.layout?.views[0];
                    if (!view || !transport.displayReady) return;
                    const sequence = (++tick + index * 1000) & 65535;
                    inputs.set(sequence, performance.now());
                    if (tick === 1) transport.focus(view, true);
                    transport.sendInput(view, { type: 'ime_commit', text: `RK:${sequence};` });
                  }, config.inputIntervalMs ?? 5000);
            await new Promise((resolve) => setTimeout(resolve, config.sampleMs));
            clearInterval(timer);
            clearInterval(stimulus);
            unsubscribe();
            document.removeEventListener('visibilitychange', visibilityChanged);
            observing = false;
            cancelAnimationFrame(rafId);
            if (videoCallbackId !== undefined) video.cancelVideoFrameCallback?.(videoCallbackId);
            const measurementEnded = performance.now();
            await markerCompletion;
            const markerDrainMs = performance.now() - measurementEnded;
            markerReader?.close();
            await collect();
            const elapsedMs = measurementEnded - started;
            const buckets = Array.from({ length: Math.ceil(elapsedMs / 1000) }, () => 0);
            for (const sample of samples) {
              const bucket = Math.floor((sample.observedAt - started) / 1000);
              if (bucket >= 0 && bucket < buckets.length) ++buckets[bucket];
            }
            const videoObservationBuckets = buckets.map(() => 0);
            for (const frame of videoObservations) {
              const bucket = Math.floor((frame.observedAt - started) / 1000);
              if (bucket >= 0 && bucket < videoObservationBuckets.length) ++videoObservationBuckets[bucket];
            }
            const render = samples.flatMap((sample) =>
              sample.renderToObservedMs === null ? [] : [sample.renderToObservedMs],
            );
            const presentation = transport.presentationDiagnostics ?? null;
            const raw = JSON.stringify(transport.getPresentationDiagnostics?.(true) ?? null);
            const report = {
              kind: 'streaming-benchmark',
              config,
              clientVersion,
              tenantIndex: index,
              flags,
              timeOrigin: performance.timeOrigin,
              startedAt: started,
              startedWall,
              clockSample,
              elapsedMs,
              actualLayout: transport.layout,
              signaling: transport.signaling,
              visibility,
              clock: 'same-machine-wall-clock',
              frameCountStage: 'video-compositor-observation',
              markerTimestampMeaning:
                'exact-RTP video callback observation; CRC completion recorded separately',
              videoObservationFps: (videoObservations.length * 1000) / elapsedMs,
              videoObservationPerSecondFrames: videoObservationBuckets,
              observedFps: config.markerHz === undefined ? (samples.length * 1000) / elapsedMs : null,
              markerSamplesPerSecond: (samples.length * 1000) / elapsedMs,
              perSecondFrames: buckets,
              perSecondFps: percentiles(buckets),
              renderToObservedMs: percentiles(render),
              inputToObservedMs: percentiles(inputSamples.map((sample) => sample.delayMs)),
              invalid,
              missingVideoSource,
              skippedMarkerFrames: config.markerHz === undefined ? skipped : null,
              markerFrameIdGaps: skipped,
              pendingInputs: inputs.size,
              samples,
              videoObservations,
              inputSamples,
              rtcSamples,
              clientRaf,
              rawVideoFrames,
              presentation,
            };
            report.inputTimeouts = inputTimeouts;
            report.markerReadback = {
              requested: markerReadbackMode,
              effective: markerReadbackMode,
              drainMs: markerDrainMs,
              jobs: markerJobs,
              failures: markerFailures,
              ownership: markerReader?.stats ?? null,
              costsMs: Object.fromEntries(
                [
                  'captureCallMs',
                  'bitmapReadyMs',
                  'turnaroundMs',
                  'workerDrawMs',
                  'workerReadbackMs',
                  'workerDecodeMs',
                  'workerTotalMs',
                ].map((name) => [name, percentiles(markerJobs.map((job) => job.costs[name]))]),
              ),
            };
            report.inputSampleCount = inputSamples.length;
            report.markerSampleCount = samples.length;
            report.markerExpectedMinimum =
              markerReader && config.markerHz > 0
                ? Math.floor((config.sampleMs * config.markerHz) / 1000)
                : null;
            report.receiverPlayout = window.rkBenchmarkReceivers;
            const videoRect = video.getBoundingClientRect(),
              videoStyle = getComputedStyle(video);
            report.videoElement = {
              connected: video.isConnected,
              rect: { x: videoRect.x, y: videoRect.y, width: videoRect.width, height: videoRect.height },
              opacity: videoStyle.opacity,
              display: videoStyle.display,
              visibility: videoStyle.visibility,
            };
            // Upload only after the measurement has ended. Keep the complete report,
            // including arrays, when it grows beyond Control's 1 MiB request limit.
            const reportText = JSON.stringify(report);
            const reportBytes = new TextEncoder().encode(reportText);
            const saveMetrics = async (body) => {
              const response = await fetch('/api/metrics', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });
              if (!response.ok) throw new Error(`Metrics upload failed ${response.status}`);
            };
            if (reportBytes.length <= 900000) {
              await saveMetrics(report);
            } else {
              const digest = await crypto.subtle.digest('SHA-256', reportBytes);
              const sha256 = Array.from(new Uint8Array(digest), (byte) =>
                byte.toString(16).padStart(2, '0'),
              ).join('');
              const chunks = Math.ceil(reportText.length / 200000);
              const identity = { runId: config.id, tenantIndex: index, chunks };
              for (let part = 0; part < chunks; ++part) {
                await saveMetrics({
                  kind: 'benchmark-report-chunk',
                  ...identity,
                  part,
                  text: reportText.slice(part * 200000, (part + 1) * 200000),
                });
              }
              await saveMetrics({
                kind: 'benchmark-report-manifest',
                ...identity,
                encoding: 'utf-8',
                characters: reportText.length,
                bytes: reportBytes.length,
                sha256,
                summary: {
                  videoObservationFps: report.videoObservationFps,
                  renderToObservedMs: report.renderToObservedMs,
                  markerSampleCount: report.markerSampleCount,
                  invalid: report.invalid,
                  startedWall,
                  elapsedMs,
                },
              });
            }
            const chunks = Math.ceil(raw.length / 200000);
            for (let part = 0; part < chunks; ++part) {
              const saved = await fetch('/api/metrics', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  kind: 'presentation-raw-chunk',
                  runId: config.id,
                  tenantIndex: index,
                  part,
                  chunks,
                  text: raw.slice(part * 200000, (part + 1) * 200000),
                }),
              });
              if (!saved.ok) throw new Error(`Presentation raw upload failed ${saved.status}`);
            }
            if (markerFailures.length)
              throw new Error(`worker marker failed ${markerFailures.length} jobs; raw metrics saved`);
            if (report.markerExpectedMinimum !== null && samples.length < report.markerExpectedMinimum)
              throw new Error(
                `worker marker has ${samples.length}/${report.markerExpectedMinimum} required CRC-valid samples; raw metrics saved`,
              );
            if (config.markerHz !== 0 && ['animation', 'text'].includes(config.mode) && !samples.length) {
              throw new Error(
                `No CRC-valid marker samples: invalid=${invalid}, missingVideoSource=${missingVideoSource}; raw metrics saved`,
              );
            }
            if (config.captureQuality) {
              const source = currentSource();
              if (!source) throw new Error('Quality source has no current video RTP observation');
              const scale = source.pixelsPerDip;
              const image = document.createElement('canvas');
              // Layout width/height are already encoded pixels; apply no second DPR.
              image.width = source.encodedWidth;
              image.height = source.encodedHeight;
              const crop = source.sourceRect;
              image
                .getContext('2d')
                .drawImage(
                  source.image,
                  crop.x,
                  crop.y,
                  crop.width,
                  crop.height,
                  0,
                  0,
                  image.width,
                  image.height,
                );
              context.drawImage(
                image,
                0,
                0,
                256 * scale,
                112 * (source.pixelsPerDipY ?? scale),
                0,
                0,
                256,
                112,
              );
              const marker = decodeMarker(context.getImageData(0, 0, 256, 112));
              const artifact = {
                kind: 'decoded-reference',
                run: config.id + '-' + index,
                marker,
                rtpTimestamp: source.rtpTimestamp,
                layoutEpoch: source.layoutEpoch,
                sourceKind: 'video',
                sourceRect: crop,
                pixelsPerDip: scale,
                width: image.width,
                height: image.height,
                capturedAfterMeasurement: true,
                image: image.toDataURL('image/png'),
              };
              const saved = await fetch(
                `${config.fixtureOrigin}/decoded-artifact?probeRun=${encodeURIComponent(artifact.run)}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-RK-Artifact': config.artifactToken },
                  body: JSON.stringify(artifact),
                },
              );
              if (!saved.ok) throw new Error(`Decoded quality artifact upload failed ${saved.status}`);
            }
            return {
              tenantIndex: index,
              observedFps: report.observedFps,
              videoObservationFps: report.videoObservationFps,
              markerSamplesPerSecond: report.markerSamplesPerSecond,
              renderToObservedMs: report.renderToObservedMs,
              inputToObservedMs: report.inputToObservedMs,
              perSecondFrames: buckets,
              videoObservationPerSecondFrames: videoObservationBuckets,
              invalid,
              samples: samples.length,
              visibility,
              actualLayout: transport.layout,
              presentation,
              lastCounters: rtcSamples[rtcSamples.length - 1],
            };
          },
          { config, index, flags, clientVersion },
        ),
      ),
    );
    await Promise.all(pages.map((page) => page.waitForTimeout(1200)));
    return {
      id: config.id,
      browser: browser.version(),
      clientVersion,
      config,
      flags,
      timerPolicy,
      results,
      errors,
      closeResults,
    };
  } catch (error) {
    measurementError = error;
    throw error;
  } finally {
    for (const [tenant, page] of pages.entries()) {
      try {
        const result = await page.evaluate(async () => {
          const t = window.remotekitDiagnostics?.transport,
            connectionId = t?.diagnostics.connectionId;
          try {
            if (!connectionId) return { connectionId: null, status: null };
            const started = performance.now(),
              response = await fetch('/api/rtc/close', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId }),
              });
            if (!response.ok) throw new Error(`RTC close ${response.status}`);
            return { connectionId, status: response.status, elapsedMs: performance.now() - started };
          } finally {
            t?.disconnect();
          }
        });
        closeResults.push({ tenant, ...result });
      } catch (error) {
        closeResults.push({ tenant, error: String(error) });
      }
    }
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
    if (!measurementError && closeResults.some((result) => result.error))
      throw new Error('RTC shutdown failed: ' + JSON.stringify(closeResults));
  }
};
