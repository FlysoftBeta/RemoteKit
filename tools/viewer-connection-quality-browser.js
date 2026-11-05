// Host-managed Playwright entry after viewer-presentation-baseline-browser.js.
// Functional evidence only: no performance matrix, no production UI overrides.
async (hostPage) => {
  const run = hostPage._presentationBaseline;
  if (!run?.page) throw Error('Bootstrap the isolated production Viewer first');
  const page = run.page;
  run.qualityReports = [];
  run.qualitySnapshot = () =>
    page.evaluate(async () => {
      const t = baseline.transport(),
        stats = t.peer ? Array.from((await t.peer.getStats()).values()) : [];
      return {
        at: performance.now(),
        state: baseline.state,
        diagnostics: t.diagnostics,
        layout: t.layout,
        receiveProfile: t.receiveProfile,
        connectionAttempts: t.connectionAttempts,
        controlTiming: t.signaling?.controlNegotiationTiming,
        presentation: t.getPresentationDiagnostics(),
        inbound: stats.filter(
          (s) => s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video'),
        ),
        codecs: stats.filter((s) => s.type === 'codec'),
        videoPlanes: [...t.videoPlanes].map(([renderer, plane]) => ({
          viewId: renderer.view.id,
          ready: plane.ready,
          width: plane.video.videoWidth,
          height: plane.video.videoHeight,
          cssWidth: plane.clip.getBoundingClientRect().width,
          cssHeight: plane.clip.getBoundingClientRect().height,
        })),
        events: baseline.events,
      };
    });
  run.qualitySet = async (preference, scale = null) => {
    await page.evaluate(
      ({ preference, scale }) =>
        baseline.rpc('action', {
          type: 'settings.update',
          settings: { qualityPreference: preference, clientScaleOverride: scale },
        }),
      { preference, scale },
    );
    await page.waitForFunction(
      (preference) => baseline.state?.workspace.settings.qualityPreference === preference,
      preference,
    );
  };
  run.qualityReconnect = async (profile) => {
    await page.evaluate(async (profile) => {
      const codec =
        profile === 'h264-level52' ? 'avc1.42e034' : profile === 'h264-level51' ? 'avc1.42e033' : null;
      if (
        !codec ||
        typeof VideoDecoder === 'undefined' ||
        !(await VideoDecoder.isConfigSupported({ codec, codedWidth: 3856, codedHeight: 2176 })).supported
      )
        throw Error('Controlled receive profile requires positive decoder evidence');
      const t = baseline.transport();
      t.disconnect();
      t.productReceiveSelection = {
        profile,
        reason: 'Controlled functional QA after positive decoder probe',
      };
      await t.connect();
    }, profile);
  };
  run.qualityWait = async ({ full = false, level, codecFps } = {}) => {
    await page.waitForFunction(
      ({ full, level, codecFps }) => {
        const t = baseline.transport(),
          e = t.diagnostics.endpoint;
        if (!t.displayReady || !e || e.error || !t.layout?.views.length || !t.diagnostics.framesDecoded)
          return false;
        if (level && e.negotiatedReceiveLevel !== level) return false;
        if (
          full &&
          (e.mediaScale !== 1 || e.sourceWidth !== e.encodedWidth || e.sourceHeight !== e.encodedHeight)
        )
          return false;
        if (codecFps && e.gccTargetFps !== codecFps) return false;
        return t.layout.views.every((view) => !!t.getLastPresentation(view.id));
      },
      { full, level, codecFps },
      { timeout: 20000 },
    );
    return run.qualitySnapshot();
  };
  run.qualityRecord = async (name, windowMs = 2000) => {
    const before = await run.qualitySnapshot();
    if (windowMs) await page.waitForTimeout(windowMs);
    const after = await run.qualitySnapshot(),
      seconds = (after.at - before.at) / 1000;
    const encodedDelta =
      (after.diagnostics.endpoint?.encodeCompleted ?? 0) -
      (before.diagnostics.endpoint?.encodeCompleted ?? 0);
    const decodedDelta = (after.inbound[0]?.framesDecoded ?? 0) - (before.inbound[0]?.framesDecoded ?? 0);
    const report = {
      name,
      before,
      after,
      seconds,
      encodedFps: seconds > 0 ? encodedDelta / seconds : null,
      decodedFps: seconds > 0 ? decodedDelta / seconds : null,
    };
    run.qualityReports.push(report);
    await page.evaluate(async (report) => {
      const response = await fetch('/api/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'viewer-connection-quality', ...report }),
      });
      if (!response.ok) throw Error('quality evidence write ' + response.status);
    }, report);
    const e = after.diagnostics.endpoint;
    return {
      name,
      source: [e?.sourceWidth, e?.sourceHeight],
      encoded: [e?.encodedWidth, e?.encodedHeight],
      inbound: after.inbound.map((i) => [i.frameWidth, i.frameHeight]),
      videoPlanes: after.videoPlanes,
      mediaScale: e?.mediaScale,
      level: e?.negotiatedReceiveLevel,
      samplingFps: e?.samplingFpsBudget,
      requested: e?.mediaPolicy?.requested,
      applied: e?.mediaPolicy?.applied,
      encodedFps: report.encodedFps,
      decodedFps: report.decodedFps,
      connectionAttempts: after.connectionAttempts,
      controlTiming: after.controlTiming,
      endpointTiming: e?.connectionTimingMs,
      endpointTimingOrigin: e?.connectionTimingOrigin,
      probeDurationMs: after.diagnostics.receiveSelection?.probeDurationMs,
      error: e?.error,
    };
  };
  return { ready: true, viewport: page.viewportSize() };
};
