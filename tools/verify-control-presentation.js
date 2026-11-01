// Host Playwright entry. Functional renderer/ROI checks, not a performance run.
async hostPage => {
  const config = /* CONFIG */ { origin: 'http://127.0.0.1:3001', directory: 'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/presentation-v3' };
  const browser = await hostPage.context().browser().browserType().launch({ executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: false, args: ['--no-first-run', '--no-default-browser-check', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true }), page = await context.newPage(), errors = [], stages = [];
  page.on('pageerror', error => errors.push(error.message));
  const action = body => page.evaluate(async body => { const r = await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(JSON.stringify(data)); return data; }, body);
  const evidence = async (stage, extra = {}) => {
    let report;
    for (let attempt = 0; attempt < 40 && !report; ++attempt) {
      report = await page.evaluate(async ({ stage, extra }) => {
        const t = window.remotekitDiagnostics.transport, state = await (await fetch('/api/state')).json();
        const planes = t.layout?.views.map(view => window.rkReadPlane(view.id));
        if (!planes?.length || planes.some(plane => !plane?.marker) || (stage === 'single-direct' && planes[0].kind !== 'plane')) return null;
        return { kind: 'presentation-functional-v3', stage, ...extra, state, layout: t.layout, presentation: t.getPresentationDiagnostics(), diagnostics: t.diagnostics, planes, inputResults: t.inputResults, inputTrace: t.inputTrace };
      }, { stage, extra });
      if (!report) await page.waitForTimeout(25);
    }
    if (!report) throw new Error('No matching painted plane for evidence ' + stage);
    if (errors.length || report.diagnostics.error || report.state.endpointError || report.inputResults.some(reply => reply.ok === false)) throw new Error(JSON.stringify({ stage, errors, diagnostics: report.diagnostics, endpointError: report.state.endpointError, inputResults: report.inputResults }));
    const stored = await page.evaluate(async report => { const r = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }); if (!r.ok) throw new Error(`metrics ${r.status}`); return r.json(); }, report);
    await page.screenshot({ path: `${config.directory}/${stage}.png`, fullPage: true });
    const summaryExtra = JSON.parse(JSON.stringify(extra, (key, value) => key === 'markerPng' ? undefined : value));
    stages.push({ stage, stored, layout: report.layout, planes: report.planes, routing: report.presentation.presentationRouting, extra: summaryExtra });
  };
  const ready = async count => page.waitForFunction(count => { const t = window.remotekitDiagnostics.transport; return t.layout?.views.length === count && t.layout.views.every(view => window.rkReadPlane(view.id)?.marker) && document.querySelectorAll('.view-pane canvas:not(.no-frame)').length === count; }, count, { timeout: 20000 });
  try {
    await page.goto(config.origin); await page.waitForFunction(() => document.querySelector('button[aria-label="新建标签页"]')?.disabled === false);
    await page.evaluate(async () => {
      const t = window.remotekitDiagnostics.transport, { decodeMarker } = await import('/marker-codec.js');
      window.rkDecodeMarker = decodeMarker; t.presentationMode = 'single-plane-direct'; t.receiveProfile = 'chrome89-h264-42';
      const register = t.registerPlane.bind(t); window.rkRawRegister = register; window.rkMounts = new Map(); window.rkUniquePaints = 0;
      t.subscribePresentedFrames(() => ++window.rkUniquePaints);
      t.registerPlane = (identity, canvas, ready) => { const record = { identity, canvas, ready, remove: register(identity, canvas, ready) }; window.rkMounts.set(canvas, record); return () => { record.remove(); window.rkMounts.delete(canvas); }; };
      window.rkReadPlane = id => {
        const frame = t.getLastPresentation(id), source = frame && t.getPresentedPlane(id, frame.rtpTimestamp); if (!source) return null;
        if (source.rtpTimestamp !== frame.rtpTimestamp || source.layoutEpoch !== frame.layoutEpoch) throw new Error('Presentation/source tag mismatch');
        const c = document.createElement('canvas'); c.width = 256; c.height = 112;
        c.getContext('2d').drawImage(source.image, source.sourceRect.x, source.sourceRect.y, 256 * source.pixelsPerDip, 112 * source.pixelsPerDip, 0, 0, 256, 112);
        return { frame, kind: source.kind, sourceRect: source.sourceRect, encodedWidth: source.encodedWidth, encodedHeight: source.encodedHeight, pixelsPerDip: source.pixelsPerDip, marker: decodeMarker(c.getContext('2d').getImageData(0, 0, 256, 112)) };
      };
    });
    await action({ type: 'device.set', device: { mode: 'desktop', width: 1280, height: 720, deviceScaleFactor: 1 } });
    const first = await action({ type: 'tab.create', title: 'Static remount', url: config.origin + '/test-pattern.html?mode=change-stop&stopAfter=3500&title=Static-Remount' }), a = first.activeTabId;
    await page.evaluate(() => window.remotekitDiagnostics.transport.connect()); await ready(1);
    // Remove keyboard focus so a caret cannot keep damaging the static page.
    await page.evaluate(() => { document.activeElement?.blur?.(); const t = window.remotekitDiagnostics.transport; t.focus(t.layout.views[0], false); });
    await page.waitForFunction(() => { const t = window.remotekitDiagnostics.transport, s = window.rkReadPlane(t.layout.views[0].id); if (!s || s.kind !== 'plane') return false; const key = s.frame.layoutEpoch + ':' + s.frame.rtpTimestamp; if (window.rkStable?.key !== key) window.rkStable = { key, since: performance.now() }; return performance.now() - window.rkStable.since > 850; }, null, { timeout: 10000 });
    const remount = await page.evaluate(() => {
      const t = window.remotekitDiagnostics.transport, original = document.querySelector('.view-pane canvas'), record = window.rkMounts.get(original), before = window.rkReadPlane(record.identity.view.id), paints = window.rkUniquePaints, redraws = t.presentationDiagnostics.presentationRouting.retainedPlaneRedraws;
      if (before.kind !== 'plane' || t.displayFrame) throw new Error('Static check requires the direct plane, without an atlas cache');
      record.remove(); const replacement = original.cloneNode(false); original.replaceWith(replacement);
      const remove = window.rkRawRegister(record.identity, replacement, record.ready), after = window.rkReadPlane(record.identity.view.id);
      window.rkRemount = { record, original, replacement, remove, before, paints };
      if (JSON.stringify(before.frame) !== JSON.stringify(after.frame) || JSON.stringify(before.marker) !== JSON.stringify(after.marker) || window.rkUniquePaints !== paints || t.presentationDiagnostics.presentationRouting.retainedPlaneRedraws !== redraws + 1) throw new Error('Static renderer remount changed RTP, marker, sample count or original paint time');
      return { before, after, uniquePaintsBefore: paints, uniquePaintsAfter: window.rkUniquePaints, retainedRedrawsBefore: redraws, retainedRedrawsAfter: t.presentationDiagnostics.presentationRouting.retainedPlaneRedraws };
    });
    await evidence('static-renderer-remount', remount);
    await page.evaluate(() => {
      const m = window.rkRemount, t = window.remotekitDiagnostics.transport;
      if (window.rkUniquePaints !== m.paints || window.rkReadPlane(m.record.identity.view.id)?.frame.rtpTimestamp !== m.before.frame.rtpTimestamp) throw new Error('A new stream frame contaminated the static remount interval');
      m.remove(); m.replacement.replaceWith(m.original); m.record.remove = window.rkRawRegister(m.record.identity, m.original, m.record.ready); window.rkRemount = null;
    });
    // The original product DOM and React cleanup are restored before navigation.
    await action({ type: 'tab.navigate', id: a, url: config.origin + '/test-pattern.html?mode=animation&title=Plane-A' }); await ready(1);
    await page.waitForFunction(() => window.remotekitDiagnostics.transport.presentationDiagnostics.presentationRouting.directFrames > 0);
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '诊断').click()); await page.waitForFunction(() => document.querySelector('.overlay-toggle input'));
    await page.evaluate(() => { const c = document.querySelector('.overlay-toggle input'); if (!c.checked) c.click(); document.querySelector('[aria-label="关闭侧栏"]').click(); });
    await evidence('single-direct');
    const second = await action({ type: 'tab.create', title: 'Plane B', url: config.origin + '/test-pattern.html?mode=static&title=Plane-B' }), b = second.activeTabId;
    await ready(1); await action({ type: 'split.set', id: a }); await ready(2);
    const split = await page.evaluate(() => { const t = window.remotekitDiagnostics.transport; return t.layout.views.map(view => window.rkReadPlane(view.id)); });
    if (split.some(plane => plane.kind !== 'atlas')) throw new Error('Multi-plane layout bypassed the snapshot fallback');
    for (const [tabId, stimulus] of [[b, 71], [a, 72]]) {
      const point = await page.evaluate(async tabId => { const state = await (await fetch('/api/state')).json(), t = window.remotekitDiagnostics.transport, tab = state.tabs.find(tab => tab.id === tabId), view = t.layout.views.find(view => view.id === tab.webviewId), index = state.activeTabId === tabId ? 0 : 1, rect = document.querySelectorAll('.view-pane canvas')[index].getBoundingClientRect(), scale = view.deviceScaleFactor * (view.mediaScale ?? 1); return { id: view.id, x: rect.left + 350 * scale / view.width * rect.width, y: rect.top + 30 * scale / view.height * rect.height }; }, tabId);
      await page.mouse.click(point.x, point.y);
      await page.evaluate(({ id, stimulus }) => { const t = window.remotekitDiagnostics.transport, view = t.layout.views.find(view => view.id === id); t.focus(view, true); if (!t.sendInput(view, { type: 'ime_commit', text: `RK:${stimulus};` })) throw new Error('Plane IME was blocked'); }, { id: point.id, stimulus });
      await page.waitForFunction(({ id, stimulus }) => window.rkReadPlane(id)?.marker?.stimulus === stimulus, { id: point.id, stimulus }, { timeout: 5000 });
    }
    await evidence('split-fallback-input');
    const tabletChange = await action({ type: 'device.set', device: { mode: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2 } });
    await page.evaluate(async result => { const t = window.remotekitDiagnostics.transport; const r = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'live-device-transition-response', result, layout: t.layout, diagnostics: t.diagnostics }) }); if (!r.ok) throw new Error('transition metrics ' + r.status); }, tabletChange);
    if (tabletChange.endpointError) throw new Error('Device configuration failed: ' + tabletChange.endpointError);
    await ready(2);
    await page.waitForFunction(() => window.remotekitDiagnostics.transport.layout.views.every(view => view.deviceScaleFactor === 2), null, { timeout: 15000 });
    const crops = await page.evaluate(async () => {
      const t = window.remotekitDiagnostics.transport;
      for (let attempt = 0; attempt < 50; ++attempt) {
        const views = t.layout?.views ?? [], sources = views.map(view => { const frame = t.getLastPresentation(view.id); return frame && t.getPresentedPlane(view.id, frame.rtpTimestamp); });
        if (views.length !== 2 || sources.some(source => !source)) { await new Promise(resolve => setTimeout(resolve, 30)); continue; }
        return views.map((view, index) => { const source = sources[index], crop = source.sourceRect, c = document.createElement('canvas'); c.width = source.encodedWidth; c.height = source.encodedHeight; c.getContext('2d').drawImage(source.image, crop.x, crop.y, crop.width, crop.height, 0, 0, c.width, c.height); if (c.width !== view.width || c.height !== view.height) throw new Error('Encoded crop was scaled twice'); const m = document.createElement('canvas'); m.width = 256; m.height = 112; m.getContext('2d').drawImage(c, 0, 0, 256 * source.pixelsPerDip, 112 * source.pixelsPerDip, 0, 0, 256, 112); return { viewId: view.id, rtpTimestamp: source.rtpTimestamp, layoutEpoch: source.layoutEpoch, pageDpr: view.deviceScaleFactor, mediaScale: view.mediaScale, sourceRect: crop, encodedCrop: [c.width, c.height], marker: window.rkDecodeMarker(m.getContext('2d').getImageData(0, 0, 256, 112)), markerPng: m.toDataURL('image/png') }; });
      }
      throw new Error('No current painted sources for the quality crop');
    });
    if (crops.some(crop => !crop.marker)) throw new Error('High-DPR crop has no CRC-valid marker');
    await evidence('tablet-high-dpr-roi', { crops });
    const routing = await page.evaluate(() => window.remotekitDiagnostics.transport.presentationDiagnostics.presentationRouting);
    if (!routing.directFrames || !routing.fallback['plane-count']) throw new Error('Direct and multi-plane fallback were not both exercised');
    return { passed: true, browserVersion: browser.version(), stages, errors, routing };
  } catch (error) {
    await page.screenshot({ path: `${config.directory}/failure.png`, fullPage: true }).catch(() => {});
    await page.evaluate(async failure => { const t = window.remotekitDiagnostics?.transport; await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'presentation-functional-v3-failure', failure, layout: t?.layout, diagnostics: t?.diagnostics, presentation: t?.presentationDiagnostics, uniquePaints: window.rkUniquePaints }) }); }, String(error)).catch(() => {});
    throw error;
  } finally { await page.evaluate(() => window.remotekitDiagnostics?.transport.disconnect()).catch(() => {}); await browser.close(); }
}
