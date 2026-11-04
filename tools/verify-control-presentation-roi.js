// Requires REMOTEKIT_DIAGNOSTICS=1 and isolated temporary browser context.
// Configuration-driven /automation media/input correctness; does not validate product UI.
// Isolated high-DPR ROI check; configure both views before RTC negotiation.
async hostPage => {
  const config = /* CONFIG */ { origin: 'http://127.0.0.1:3001', screenshotPath: 'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/presentation-v3-roi/tablet.png' };
  const browser = await hostPage.context().browser().browserType().launch({ executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: false, args: ['--no-first-run', '--no-default-browser-check', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true })).newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const gate=await page.request.get(config.origin+'/api/state');
    if(gate.status()!==200)throw Error('Explicit diagnostics server required (REMOTEKIT_DIAGNOSTICS=1), with fresh isolated session: '+gate.status()+' '+await gate.text());
    await page.goto(config.origin+'/automation');
    await page.waitForFunction(()=>window.remotekitDiagnostics?.state);
    await page.evaluate(()=>{if(window.remotekitDiagnostics.automaticQualityPolicy!==false)throw Error('Controlled automation requires adaptive quality disabled');});
    await page.evaluate(async origin => {
      const action = window.remotekitDiagnostics.action;
      await action({ type: 'device.set', device: { mode: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2 } });
      const a = await action({ type: 'tab.create', url: origin + '/test-pattern.html?mode=static&title=Tablet-A' });
      await action({ type: 'tab.create', url: origin + '/test-pattern.html?mode=static&title=Tablet-B' });
      await action({ type: 'split.set', id: a.activeTabId });
      const t = window.remotekitDiagnostics.transport; window.remotekitDiagnostics.configure({receiveProfile:'chrome89-h264-42'});await window.remotekitDiagnostics.refresh();await t.connect();
    }, config.origin);
    await page.waitForFunction(() => { const t = window.remotekitDiagnostics.transport; return t.displayReady && t.layout?.views.length === 2 && t.layout.views.every(v => { const f = t.getLastPresentation(v.id); return v.deviceScaleFactor === 2 && f && t.getPresentedPlane(v.id, f.rtpTimestamp); }) && document.querySelectorAll('.remote-viewport canvas:not(.no-frame)').length === 2; }, null, { timeout: 15000 });
    const report = await page.evaluate(async () => {
      const t = window.remotekitDiagnostics.transport, { decodeMarker } = await import('/marker-codec.js');
      let views, sources;
      for (let attempt = 0; attempt < 50; ++attempt) {
        views = t.layout?.views ?? []; sources = views.map(view => { const frame = t.getLastPresentation(view.id); return frame && t.getPresentedPlane(view.id, frame.rtpTimestamp); });
        if (views.length === 2 && sources.every(Boolean)) break;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      if (views.length !== 2 || sources.some(source => !source)) throw new Error('No current video sources for high-DPR ROI');
      const planes = views.map((view, index) => {
        const frame = t.getLastPresentation(view.id), source = sources[index], c = document.createElement('canvas'), crop = source.sourceRect;
        c.width = source.encodedWidth; c.height = source.encodedHeight; c.getContext('2d').drawImage(source.image, crop.x, crop.y, crop.width, crop.height, 0, 0, c.width, c.height);
        const m = document.createElement('canvas'); m.width = 256; m.height = 112; m.getContext('2d').drawImage(c, 0, 0, 256 * source.pixelsPerDip, 112 * (source.pixelsPerDipY ?? source.pixelsPerDip), 0, 0, 256, 112);
        return { viewId: view.id, pageDpr: view.deviceScaleFactor, mediaScale: view.mediaScale, videoSource: source.image instanceof HTMLVideoElement, frame, sourceRect: crop, encodedCrop: [c.width, c.height], marker: decodeMarker(m.getContext('2d').getImageData(0, 0, 256, 112)), markerPng: m.toDataURL('image/png') };
      });
      const report = { kind: 'presentation-high-dpr-roi-v3', layout: t.layout, planes, presentation: t.presentationDiagnostics, diagnostics: t.diagnostics };
      report.passed = planes.every(p => p.videoSource && p.marker && p.encodedCrop[0] === p.sourceRect.width && p.encodedCrop[1] === p.sourceRect.height) && !t.diagnostics.error;
      const r = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }); if (!r.ok) throw new Error('metrics ' + r.status); return report;
    });
    await page.screenshot({ path: config.screenshotPath, fullPage: true });
    if (!report.passed || errors.length) throw new Error('ROI validation failed: ' + JSON.stringify({ planes: report.planes, errors }));
    return { passed: true, layout: report.layout, planes: report.planes.map(({ markerPng, ...plane }) => plane), rendering: report.presentation.rendering, errors };
  } finally {
    await page.evaluate(async () => { const t = window.remotekitDiagnostics?.transport; if (t?.diagnostics.connectionId) { const r = await fetch('/api/rtc/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: t.diagnostics.connectionId }) }); if (!r.ok) throw new Error('RTC close ' + r.status); } t?.disconnect(); }).catch(() => {});
    await browser.close();
  }
}
