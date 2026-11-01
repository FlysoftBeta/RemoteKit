// Headed Chrome89 correctness run. No FPS or latency conclusions are drawn.
async hostPage => {
  const config = /* CONFIG */ { origin: 'http://127.0.0.1:3001', directory: 'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/presentation-v4-live' };
  const browser = await hostPage.context().browser().browserType().launch({ executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: false, args: ['--no-first-run', '--no-default-browser-check', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true })).newPage(), errors = [], stages = [];
  page.on('pageerror', error => errors.push(error.message));
  const action = body => page.evaluate(async body => { const r = await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok || data.endpointError) throw new Error(JSON.stringify(data)); return data; }, body);
  const ready = async (count, dpr) => page.waitForFunction(({ count, dpr }) => { const t = window.remotekitDiagnostics.transport; return t.layout?.views.length === count && t.layout.views.every(v => !v.stale && v.deviceScaleFactor === dpr && window.rkRead(v.id)?.marker) && document.querySelectorAll('.view-pane canvas:not(.no-frame)').length === count; }, { count, dpr }, { timeout: 20000 });
  const device = async (mode, count) => {
    const docs = await page.evaluate(() => Object.fromEntries(window.remotekitDiagnostics.transport.layout.views.map(v => [v.id, v.document])));
    await action({ type: 'device.set', device: mode === 'tablet' ? { mode, width: 820, height: 1180, deviceScaleFactor: 2 } : { mode, width: 1280, height: 720, deviceScaleFactor: 1 } });
    await page.waitForFunction(docs => window.remotekitDiagnostics.transport.layout.views.every(v => v.document !== docs[v.id]), docs, { timeout: 10000 });
    await ready(count, mode === 'tablet' ? 2 : 1);
  };
  let stimulus = 100;
  const input = async (mode, count) => {
    const ids = await page.evaluate(() => window.remotekitDiagnostics.transport.layout.views.map(v => v.id));
    for (const id of ids) {
      const point = await page.evaluate(async id => { const state = await (await fetch('/api/state')).json(), t = window.remotekitDiagnostics.transport, tab = state.tabs.find(tab => tab.webviewId === id), view = t.layout.views.find(v => v.id === id), index = state.activeTabId === tab.id ? 0 : 1, r = document.querySelectorAll('.view-pane canvas')[index].getBoundingClientRect(), scale = view.deviceScaleFactor * (view.mediaScale ?? 1); return { x: r.left + 350 * scale / view.width * r.width, y: r.top + 30 * scale / view.height * r.height }; }, id);
      if (mode === 'tablet') { await page.touchscreen.tap(point.x, point.y); await page.waitForFunction(id => window.rkRead(id)?.marker?.stimulus >= 32769, id, { timeout: 5000 }); }
      else await page.mouse.click(point.x, point.y);
      const expected = ++stimulus;
      await page.evaluate(({ id, expected }) => { const t = window.remotekitDiagnostics.transport, v = t.layout.views.find(v => v.id === id); t.focus(v, true); if (!t.sendInput(v, { type: 'ime_commit', text: `RK:${expected};` })) throw new Error('IME blocked'); }, { id, expected });
      await page.waitForFunction(({ id, expected }) => window.rkRead(id)?.marker?.stimulus === expected, { id, expected }, { timeout: 5000 });
    }
    await ready(count, mode === 'tablet' ? 2 : 1);
  };
  const record = async name => {
    const result = await page.evaluate(name => { const t = window.remotekitDiagnostics.transport; return { name, layout: t.layout, planes: t.layout.views.map(v => window.rkRead(v.id)), routing: t.presentationDiagnostics.presentationRouting, diagnostics: t.diagnostics, stalePaintViolations: window.rkStalePaintViolations }; }, name);
    if (result.planes.some(p => !p?.marker) || result.diagnostics.error || result.stalePaintViolations.length) throw new Error('Invalid presentation ' + JSON.stringify(result));
    stages.push(result); await page.screenshot({ path: `${config.directory}/${name}.png`, fullPage: true });
  };
  try {
    await page.goto(config.origin); await page.waitForFunction(() => document.querySelector('button[aria-label="新建标签页"]')?.disabled === false);
    await action({ type: 'device.set', device: { mode: 'desktop', width: 1280, height: 720, deviceScaleFactor: 1 } });
    const first = await action({ type: 'tab.create', url: config.origin + '/test-pattern.html?mode=animation&title=Roundtrip-A' }), a = first.activeTabId;
    await page.evaluate(async () => {
      const t = window.remotekitDiagnostics.transport, { decodeMarker } = await import('/marker-codec.js');
      window.rkStalePaintViolations = []; window.rkLayoutTransitions = [];
      t.subscribePresentedFrames(frame => { const v = t.layout?.views.find(v => v.id === frame.viewId); if (v?.stale || frame.layoutEpoch !== t.layout?.epoch) window.rkStalePaintViolations.push({ frame, current: t.layout }); });
      window.rkRead = id => { const frame = t.getLastPresentation(id), s = frame && t.getPresentedPlane(id, frame.rtpTimestamp); if (!s) return null; const c = document.createElement('canvas'); c.width = 256; c.height = 112; c.getContext('2d').drawImage(s.image, s.sourceRect.x, s.sourceRect.y, 256 * s.pixelsPerDip, 112 * s.pixelsPerDip, 0, 0, 256, 112); return { frame, kind: s.kind, sourceRect: s.sourceRect, marker: decodeMarker(c.getContext('2d').getImageData(0, 0, 256, 112)) }; };
      t.receiveProfile = 'chrome89-h264-42'; t.presentationMode = 'single-plane-direct'; await t.connect();
      const channel = t.channel, receive = channel.onmessage;
      channel.onmessage = event => { const m = JSON.parse(String(event.data)); receive(event); if (m.type === 'layout') window.rkLayoutTransitions.push({ epoch: m.epoch, views: m.views.map(v => ({ id: v.id, stale: v.stale, document: v.document })) }); };
    });
    await ready(1, 1);
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === '诊断').click()); await page.waitForFunction(() => document.querySelector('.overlay-toggle input'));
    await page.evaluate(() => { document.querySelector('.overlay-toggle input').click(); document.querySelector('[aria-label="关闭侧栏"]').click(); });
    for (const count of [1, 2]) {
      if (count === 2) { await action({ type: 'tab.create', url: config.origin + '/test-pattern.html?mode=static&title=Roundtrip-B' }); await action({ type: 'split.set', id: a }); await ready(2, 1); }
      for (const path of ['single-plane-direct', 'snapshot']) {
        await page.evaluate(path => { window.remotekitDiagnostics.transport.presentationMode = path; }, path);
        await device('tablet', count); await input('tablet', count); await record(`${path}-${count}-tablet`);
        await device('desktop', count); await input('desktop', count); await record(`${path}-${count}-desktop`);
      }
    }
    const oldEpoch = stages[0].layout.epoch;
    const rejected = await page.evaluate(async oldEpoch => {
      const t = window.remotekitDiagnostics.transport, v = t.layout.views[0], count = t.inputResults.length;
      t.channel.send(JSON.stringify({ type: 'input', view: v.id, session: v.session, instance: v.instance, document: v.document, focus: v.focus, outputGeneration: t.layout.generation, layoutEpoch: oldEpoch, sequence: String(++t.sequence), event: { type: 'mouse', action: 'move', x: 1, y: 1, button: 0, modifiers: 0 } }));
      const end = performance.now() + 3000; while (performance.now() < end) { const reply = t.inputResults.slice(count).find(r => r.type === 'input.result'); if (reply) return reply; await new Promise(r => setTimeout(r, 10)); } return null;
    }, oldEpoch);
    if (rejected?.ok !== false || rejected.error !== 'stale_layout_epoch' || errors.length) throw new Error('Old epoch was not rejected ' + JSON.stringify({ rejected, errors }));
    const report = await page.evaluate(({ stages, rejected, errors }) => ({ kind: 'live-device-roundtrip-v4', passed: true, stages, expectedOldEpochRejection: rejected, errors, layoutTransitions: window.rkLayoutTransitions, stalePaintViolations: window.rkStalePaintViolations }), { stages, rejected, errors });
    await page.evaluate(async report => { const r = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }); if (!r.ok) throw new Error('metrics ' + r.status); }, report);
    return { passed: true, stages: stages.map(s => ({ name: s.name, epoch: s.layout.epoch, planes: s.planes.map(p => ({ kind: p.kind, marker: p.marker, sourceRect: p.sourceRect })) })), expectedOldEpochRejection: rejected, stalePaintViolations: report.stalePaintViolations, staleLayoutsObserved: report.layoutTransitions.filter(l => l.views.some(v => v.stale)).length, errors };
  } catch (error) {
    await page.screenshot({ path: `${config.directory}/roundtrip-failure.png`, fullPage: true }).catch(() => {});
    await page.evaluate(async ({ failure, stages, errors }) => { const t = window.remotekitDiagnostics.transport; await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'live-device-roundtrip-v4-failure', failure, stages, errors, layout: t.layout, diagnostics: t.diagnostics, inputTrace: t.inputTrace, inputResults: t.inputResults, layoutTransitions: window.rkLayoutTransitions, stalePaintViolations: window.rkStalePaintViolations }) }); }, { failure: String(error), stages, errors }).catch(() => {});
    throw error;
  } finally { await page.evaluate(async () => { const t = window.remotekitDiagnostics?.transport; if (t?.diagnostics.connectionId) await fetch('/api/rtc/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: t.diagnostics.connectionId }) }); t?.disconnect(); }).catch(() => {}); await browser.close(); }
}
