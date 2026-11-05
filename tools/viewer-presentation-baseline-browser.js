// Host-managed Playwright entry. Reads production React transport; does not override its policy.
async (hostPage) => {
  const origin = 'http://127.0.0.1:33271',
    root =
      hostPage._baselineRoot ??
      'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/viewer-presentation-baseline';
  const run = (hostPage._presentationBaseline = { reports: [], contexts: [] });
  run.launch = async (version) => {
    const context = await hostPage
      .context()
      .browser()
      .browserType()
      .launchPersistentContext(root + '/client-' + version, {
        executablePath:
          version === 89
            ? 'C:/src/tmp/chrome89-google/app/chrome.exe'
            : 'C:/src/chromium/src/out/rel/chrome.exe',
        headless: true,
        viewport: hostPage._baselineViewport ?? { width: 1440, height: 900 },
        deviceScaleFactor: hostPage._baselineDpr ?? 1,
        args: [
          '--fake-vsync-rate=60',
          '--no-first-run',
          '--no-default-browser-check',
          ...(hostPage._baselineAutoplay === false ? [] : ['--autoplay-policy=no-user-gesture-required']),
          ...(hostPage._baselineExtraArgs ?? []),
        ],
      });
    run.contexts.push(context);
    if (hostPage._baselineInit) await context.addInitScript(hostPage._baselineInit);
    await context.addInitScript(() => {
      const q = (window.baseline = { events: [], peers: [], state: null });
      const event = (type, extra = {}) => q.events.push({ type, at: performance.now(), ...extra });
      event('init');
      const WS = window.WebSocket;
      window.WebSocket = class extends WS {
        constructor(...a) {
          super(...a);
          q.socket = this;
          event('ws.construct');
          this.addEventListener('open', () => event('ws.open'));
          this.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            if (m.type === 'state') q.state = m.state;
            if (m.type === 'result' || m.type === 'error') event('ws.result', { id: m.id });
          });
        }
        send(data) {
          const m = JSON.parse(data);
          if (['rtc.offer', 'rtc.ice'].includes(m.method)) event('ws.send', { method: m.method, id: m.id });
          return super.send(data);
        }
      };
      const PC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends PC {
        constructor(...a) {
          super(...a);
          q.peers.push(this);
          event('peer.construct');
          this.addEventListener('iceconnectionstatechange', () =>
            event('peer.ice', { state: this.iceConnectionState }),
          );
          this.addEventListener('connectionstatechange', () =>
            event('peer.connection', { state: this.connectionState }),
          );
          this.addEventListener('track', () => event('peer.track'));
        }
        createDataChannel(...a) {
          const d = super.createDataChannel(...a);
          d.addEventListener('open', () => event('dc.open'));
          return d;
        }
      };
      q.rpc = (method, params) =>
        new Promise((resolve, reject) => {
          const id = 'baseline-' + Math.random(),
            s = q.socket;
          const timer = setTimeout(() => {
            s.removeEventListener('message', on);
            reject(Error('RPC timeout ' + method));
          }, 20000);
          function on(e) {
            const m = JSON.parse(e.data);
            if (m.id === id) {
              clearTimeout(timer);
              s.removeEventListener('message', on);
              m.type === 'error' ? reject(Error(JSON.stringify(m.error))) : resolve(m.result);
            }
          }
          s.addEventListener('message', on);
          s.send(JSON.stringify({ id, method, params }));
        });
      q.transport = () => {
        for (const el of document.querySelectorAll('*')) {
          const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
          for (let f = key && el[key]; f; f = f.return) {
            for (let h = f.memoizedState; h; h = h.next) {
              const o = h.memoizedState?.current;
              if (o && typeof o.getPresentationDiagnostics === 'function') return o;
            }
          }
        }
        throw Error('Production transport not found');
      };
      q.ready = () => {
        const t = q.transport();
        return t.presentationDiagnostics.rendering.backend === 'video' && t.displayReady;
      };
      const timer = setInterval(() => {
        try {
          if (q.ready()) {
            event('first.video-ready');
            clearInterval(timer);
          }
        } catch {}
      }, 20);
    });
    const page = context.pages()[0] ?? (await context.newPage());
    run.page = page;
    run.version = version;
    await page.goto(origin);
    await page.evaluate(async () => {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'baseline', password: 'independent-local-baseline-2026' }),
      });
      if (!r.ok) {
        const l = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'baseline', password: 'independent-local-baseline-2026' }),
        });
        if (!l.ok) throw Error('auth');
      }
    });
    await page.reload();
    await page.waitForFunction(() => window.baseline.state && window.baseline.socket?.readyState === 1);
    if ((await page.evaluate(() => window.baseline.state.workspace.windows.length)) === 0)
      await page.evaluate(() =>
        window.baseline.rpc('action', { type: 'window.create', url: 'http://127.0.0.1:33272/animation' }),
      );
    await page.waitForFunction(
      () => {
        try {
          return window.baseline.ready();
        } catch {
          return false;
        }
      },
      { timeout: 30000 },
    );
    return {
      version: await context.browser().version(),
      events: await page.evaluate(() => window.baseline.events),
    };
  };
  run.sample = async (name, ms = 12000) => {
    const page = run.page;
    const sample = () =>
      page.evaluate(async () => {
        const q = window.baseline,
          t = q.transport();
        const videos = [...t.videoPlanes].map(([renderer, plane]) => ({
          viewId: renderer.view.id,
          width: plane.video.videoWidth,
          height: plane.video.videoHeight,
          totalFrames: plane.video.getVideoPlaybackQuality().totalVideoFrames,
          ready: plane.ready,
        }));
        return {
          at: performance.now(),
          state: q.state,
          diagnostics: t.diagnostics,
          presentation: t.getPresentationDiagnostics(true),
          layout: t.layout,
          receiveProfile: t.receiveProfile,
          capabilities: await t.probeReceiveCapabilities(),
          videos,
          stats: t.peer ? Array.from((await t.peer.getStats()).values()) : [],
          events: q.events,
        };
      });
    const before = await sample();
    await page.waitForTimeout(ms);
    const after = await sample();
    await page.screenshot({ path: root + '/' + name + '.png' });
    const report = { name, browser: run.version, before, after };
    run.reports.push(report);
    // Raw arrays can exceed Control's 1 MiB request limit. Bounded chunks preserve all evidence.
    await page.evaluate(async (r) => {
      const data = JSON.stringify(r),
        size = 200000,
        total = Math.ceil(data.length / size);
      for (let index = 0; index < total; index++) {
        const response = await fetch('/api/metrics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'viewer-presentation-baseline-chunk',
            name: r.name,
            index,
            total,
            data: data.slice(index * size, (index + 1) * size),
          }),
        });
        if (!response.ok) throw Error('metrics upload ' + response.status);
      }
    }, report);
    const seconds = (after.at - before.at) / 1000,
      p = after.presentation;
    const byView = p.rendering.videoCompositorByView,
      prior = before.presentation.rendering.videoCompositorByView;
    return {
      name,
      seconds,
      presentationEndpoint: p.presentationEndpoint,
      compositorFpsByView: Object.fromEntries(
        Object.entries(byView).map(([view, count]) => {
          const baseline = prior[view];
          return [
            view,
            baseline && count.frames >= baseline.frames ? (count.frames - baseline.frames) / seconds : null,
          ];
        }),
      ),
      epoch: p.epoch,
      costs: p.costsMs,
      videos: after.videos,
      decodeFps: after.diagnostics.decodedFramesPerSecond,
      quality: after.state.workspace.settings.qualityPreference,
    };
  };
  return await run.launch(hostPage._baselineVersion ?? 157);
};
