// Load with host-managed Playwright browser_run_code_unsafe using filename.
// Then call host.osrFirstOpen({origin, evidence, executablePath}).
async (host) => {
  host.osrFirstOpen = async ({ origin, evidence, executablePath, profile = evidence + '/viewer',
    password = 'Disposable-first-open-917', resume = false, delayReadyMs = 0,
    expectedBackend = delayReadyMs ? undefined : 'video', checkRefresh = false, signIn = false }) => {
    if (signIn && !resume) throw Error('Sign-in requires an existing static workspace');
    const context = await host.context().browser().browserType().launchPersistentContext(profile, {
      executablePath, headless: true, viewport: { width: 1920, height: 864 },
      deviceScaleFactor: 1, args: ['--no-first-run'],
    });
    const report = {};
    const fixture = new URL(origin);
    fixture.port = Number(fixture.port) + 1;
    fixture.pathname = '/static-fixture';
    const url = fixture.href;
    const record = async (page, label, duration = 6000) => {
      const samples = report[label] = [];
      const until = Date.now() + duration;
      do {
        samples.push(await page.evaluate(() => firstOpen.sample()));
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < until);
      await page.screenshot({ path: evidence + '/' + label + '.png' });
    };
    try {
      await context.addInitScript(delayReadyMs => {
        const q = window.firstOpen = { events: [], peers: [], videoTracks: [], refreshRequests: 0 };
        const record = (type, details) => {
          if (q.events.length < 2048) q.events.push({ at: performance.now(), type, ...details });
        };
        const WS = WebSocket;
        window.WebSocket = class extends WS {
          constructor(...args) {
            super(...args);
            this.addEventListener('open', () => record('ws-open'));
            this.addEventListener('message', event => {
              try {
                const message = JSON.parse(event.data);
                if (message.type === 'state') q.state = message.state;
                if (message.type === 'auth') q.auth = { locked: message.auth.locked };
              } catch {}
            });
          }
        };
        const Peer = RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer {
          constructor(...args) {
            super(...args);
            q.peers.push(this);
            this.addEventListener('connectionstatechange', () => record('peer', { state: this.connectionState }));
            this.addEventListener('track', event => {
              if (event.track.kind === 'video') q.videoTracks.push(event.track);
              record('track', { kind: event.track.kind });
            });
          }
          createDataChannel(...args) {
            const channel = super.createDataChannel(...args);
            if (channel.label !== 'remotekit') return channel;
            q.channel = channel;
            channel.addEventListener('open', () => record('dc-open'));
            const observe = (direction, raw) => {
              if (typeof raw !== 'string') return;
              try {
                const m = JSON.parse(raw);
                if (direction === 'out' && m.type === 'media.refresh') q.refreshRequests++;
                if (m.type === 'stats' && m.comp) {
                  const { idle, targetFps, presentationRefreshPending: pending, presentationRefreshAttempts: attempts,
                    presentationRefreshForcedBegins: forcedBegins, presentationRefreshSuccesses: successes } = m.comp;
                  q.refresh = { at: performance.now(), idle, targetFps, pending, attempts, forcedBegins, successes };
                }
                if (['layout', 'frame', 'media.refresh', 'media.presentation'].includes(m.type) || m.type.startsWith('presentation.')) {
                  record(m.type, { direction, epoch: m.epoch ?? m.layoutEpoch, generation: m.generation,
                    width: m.width, height: m.height, rtp: m.rtpTimestamp, keyframe: m.keyframe, backend: m.backend });
                }
              } catch {}
            };
            channel.addEventListener('message', event => observe('in', event.data));
            const send = channel.send;
            channel.send = function (raw) {
              let message;
              if (delayReadyMs && typeof raw === 'string') {
                try { message = JSON.parse(raw); } catch {}
              }
              if (message?.type === 'presentation.ready') {
                record('ready-held');
                setTimeout(() => {
                  if (this.readyState !== 'open') return;
                  observe('out', raw);
                  send.call(this, raw);
                }, delayReadyMs);
                return;
              }
              observe('out', raw);
              return send.call(this, raw);
            };
            return channel;
          }
        };
        const rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
        HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
          return rvfc.call(this, (now, metadata) => {
            record('rvfc', { rtp: metadata.rtpTimestamp, width: metadata.width, height: metadata.height,
              presented: metadata.presentedFrames });
            callback(now, metadata);
          });
        };
        q.transport = () => {
          for (const el of document.querySelectorAll('.remote-viewport, video, canvas')) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
            for (let fiber = key && el[key]; fiber; fiber = fiber.return) {
              for (let hook = fiber.memoizedState; hook; hook = hook.next) {
                const transport = hook.memoizedState?.current;
                if (typeof transport?.getPresentationDiagnostics === 'function') return transport;
              }
            }
          }
        };
        q.sample = async () => {
          const t = q.transport(), peer = q.peers[q.peers.length - 1];
          const rtp = [], report = await peer?.getStats().catch(() => null);
          report?.forEach(stat => {
            if (stat.type === 'inbound-rtp' && (stat.kind ?? stat.mediaType) === 'video') {
              const keys = ['ssrc', 'packetsReceived', 'bytesReceived', 'framesReceived', 'framesDecoded',
                'keyFramesDecoded', 'framesDropped', 'pliCount', 'nackCount', 'frameWidth', 'frameHeight'];
              rtp.push({ ...Object.fromEntries(keys.map(key => [key, stat[key]])),
                codec: report.get(stat.codecId)?.mimeType });
            }
          });
          return { at: performance.now(), wall: Date.now(), rtp, peers: q.peers.length, videoTracks: q.videoTracks.length,
            channel: q.channel?.readyState, ready: t?.displayReady, epoch: t?.layout?.epoch, refresh: q.refresh,
            refreshRequests: q.refreshRequests, presentationError: t?.presentationError,
            barrier: t?.presentationBarrier, ack: t?.presentationBarrierAcknowledged,
            rendering: t?.getRenderingDiagnostics(), connection: t?.connectionAttempts,
            tabs: q.state?.workspace?.tabs?.map(({ url, pendingUrl, title }) => ({ url, pendingUrl, title })),
            restoring: document.body.textContent.includes('正在恢复页面'), events: q.events.splice(0) };
        };
      }, delayReadyMs);
      let page = context.pages()[0] ?? await context.newPage();
      await page.goto(origin);
      if (!resume || signIn) {
        await page.evaluate(async ({ password, route }) => {
          const response = await fetch('/api/auth/' + route, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'first-open', password }),
          });
          if (!response.ok) throw Error('Isolated authentication failed: ' + response.status);
        }, { password, route: resume ? 'login' : 'register' });
        await page.reload();
      }
      if (!resume) {
        await page.waitForFunction(() => firstOpen.state?.workspace && firstOpen.channel?.readyState === 'open', null, { timeout: 15000 });
        await page.getByRole('button', { name: '新建窗口', exact: true }).first().click();
        await record(page, 'first-static-start-page');
        const address = page.locator('.address-form input[aria-label="搜索或输入网址"]');
        await address.fill(url);
        await address.press('Enter');
        await record(page, 'first-static-navigation');
        await page.close();
        await new Promise(resolve => setTimeout(resolve, 1000));
        page = await context.newPage();
        await page.goto(origin);
      }
      if (!signIn) {
        await page.waitForFunction(() => firstOpen.auth?.locked && document.querySelector('.viewer-lock-blank'), null, { timeout: 7000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right']) {
          await page.keyboard.press('Arrow' + direction);
        }
        await page.getByLabel('账户密码').fill(password, { timeout: 7000 });
        await page.getByRole('button', { name: '解锁', exact: true }).click();
      }
      const savedLabel = signIn ? 'saved-static-after-sign-in' : 'saved-static-after-unlock';
      await record(page, savedLabel, checkRefresh ? 11000 : 9000);
      const saved = report[savedLabel];
      const final = saved.at(-1);
      let settled;
      if (expectedBackend && (!final.ready || final.restoring || final.rendering?.backend !== expectedBackend ||
          !final.rtp.some(stat => stat.framesDecoded > 0 && stat.codec?.toLowerCase() === 'video/h264') ||
          !final.tabs?.some(tab => tab.url === url && !tab.pendingUrl))) {
        throw Error('Saved static page did not recover through ' + expectedBackend);
      }
      if (checkRefresh) {
        const firstReady = saved.find(sample => sample.ready);
        const events = saved.flatMap(sample => sample.events);
        const firstSettled = saved.find(sample => sample.refresh?.at >= firstReady?.at &&
          sample.refresh.pending === false && sample.refresh.successes > 0 &&
          final.refresh?.at - sample.refresh.at >= 2000);
        const counters = ['attempts', 'forcedBegins', 'successes'];
        if (!firstSettled || final.refresh.pending !== false ||
            counters.some(counter => firstSettled.refresh[counter] !== final.refresh[counter]) ||
            firstSettled.refreshRequests !== final.refreshRequests ||
            saved.some(sample => sample.peers > 1 || sample.presentationError || sample.rendering?.backend === 'unavailable') ||
            events.some(event => event.type === 'media.presentation' && event.direction === 'out' && event.backend !== 'video') ||
            final.peers !== 1 || final.videoTracks !== 1 || final.channel !== 'open') {
          throw Error('First-frame refresh did not settle on the original peer');
        }
        settled = [firstSettled.refresh, final.refresh];
        if (delayReadyMs) {
          const released = events.find(event => event.type === 'presentation.ready' && event.epoch === firstReady.epoch);
          const prematureFrame = events.some(event => event.type === 'frame' && event.at < released?.at) ||
            saved.some(sample => sample.at < released?.at && sample.rtp.some(stat => stat.packetsReceived > 0));
          if (!released || firstReady.at < released.at || prematureFrame) {
            throw Error('First-frame release did not wait for the actual layout ACK');
          }
        }
      }
      return Object.fromEntries(Object.entries(report).map(([label, samples]) => [label, {
        firstReady: samples.find(s => s.ready)?.at ?? null,
        firstRtp: samples.find(s => s.rtp.some(stat => stat.framesDecoded > 0))?.at ?? null,
        settled: label === savedLabel ? settled : undefined,
        last: { ...samples[samples.length - 1], events: undefined },
        timeline: samples.flatMap(s => s.events).filter(e => e.type !== 'rvfc').slice(0, 48),
      }]));
    } finally {
      try {
        const page = context.pages()[0];
        await page?.request.post(new URL('/report', fixture).href, { data: report });
      } finally {
        await context.close();
      }
    }
  };
}

