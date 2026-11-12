// Load via host-managed Playwright browser_run_code_unsafe with filename.
// Then call host.osrVideoProfile({origin, fixture, evidence, executablePath}).
async (host) => {
  host.osrVideoProfile = async ({
    origin,
    fixture,
    evidence,
    executablePath,
    markerMode = 'sync45',
    headless = true,
    shape = true,
    monitorDisplay = false,
    displaySeconds = 60,
    cleanWindow = false,
    captureStats = false,
    touchSmoke = false,
  }) => {
    if (!['sync45', 'worker', 'none'].includes(markerMode)) throw Error('Unknown markerMode');
    if (monitorDisplay && markerMode !== 'none')
      throw Error('Display transition requires the health-only mode');
    if (!Number.isInteger(displaySeconds) || displaySeconds < 20 || displaySeconds > 60)
      throw Error('Display health window must be 20–60 seconds');
    const { pathToFileURL } = await import('node:url');
    const { dirname, join, resolve } = await import('node:path');
    const { existsSync } = await import('node:fs');
    let root = resolve(evidence);
    while (!existsSync(join(root, 'tests/e2e/kit/browser.mjs'))) {
      const parent = dirname(root);
      if (parent === root) throw Error('Evidence must be inside the RemoteKit repository');
      root = parent;
    }
    const { launchTestBrowser } = await import(pathToFileURL(join(root, 'tests/e2e/kit/browser.mjs')).href);
    const context = await launchTestBrowser({
      profile: evidence + '/viewer',
      browserType: host.context().browser().browserType(),
      executablePath,
      headless,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      hasTouch: touchSmoke,
      args: ['--fake-vsync-rate=60', '--no-first-run'],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    try {
      await context.addInitScript(() => {
        const q = (window.osrProfile = { frames: [], markers: [], inputs: [], sends: [], meta: [] });
        q.session = () => {
          for (const element of document.querySelectorAll('.remote-viewport, video, canvas')) {
            const key = Object.keys(element).find((k) => k.startsWith('__reactFiber$'));
            for (let fiber = key && element[key]; fiber; fiber = fiber.return) {
              for (let hook = fiber.memoizedState; hook; hook = hook.next) {
                const session = hook.memoizedState;
                if (
                  session?.rtc &&
                  session?.observations &&
                  typeof session?.presentation?.getPresentationDiagnostics === 'function'
                )
                  return session;
              }
            }
          }
          throw Error('Production Viewer session unavailable');
        };
        const WS = window.WebSocket;
        window.WebSocket = class extends WS {
          constructor(...args) {
            super(...args);
            q.socket = this;
            this.addEventListener('message', (e) => {
              try {
                const m = JSON.parse(e.data);
                if (m.type === 'state') q.state = m.state;
              } catch {}
            });
          }
        };
        q.rpc = (method, params) =>
          new Promise((resolve, reject) => {
            const id = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
            const on = (e) => {
              const m = JSON.parse(e.data);
              if (m.id !== id) return;
              clearTimeout(timer);
              q.socket.removeEventListener('message', on);
              if (m.type === 'error') reject(Error(JSON.stringify(m.error)));
              else resolve(m.result);
            };
            const timer = setTimeout(() => {
              q.socket.removeEventListener('message', on);
              reject(Error('Control RPC timeout: ' + method));
            }, 10000);
            q.socket.addEventListener('message', on);
            q.socket.send(JSON.stringify({ id, method, params }));
          });
        const createChannel = RTCPeerConnection.prototype.createDataChannel;
        RTCPeerConnection.prototype.createDataChannel = function (...args) {
          const channel = createChannel.apply(this, args);
          if (channel.label === 'remotekit') q.productChannel = channel;
          const send = channel.send;
          channel.send = function (value) {
            if ((q.active || q.trackTouch) && typeof value === 'string') {
              try {
                const m = JSON.parse(value);
                if (q.trackTouch && m.type === 'input' && m.event?.type === 'touch') {
                  q.touchWire.push({
                    phase: 'send',
                    at: performance.now(),
                    action: m.event.action,
                    clientSequence: m.sequence,
                    touchSequenceId: m.event.sequenceId,
                  });
                } else if (
                  q.active &&
                  m.type === 'input' &&
                  m.event?.type === 'mouse' &&
                  m.event.action === 'down'
                ) {
                  const view = q.renderer.view;
                  const width =
                    view.width / (view.deviceScaleFactor * (view.mediaScaleX ?? view.mediaScale ?? 1));
                  const stimulus = Math.floor((m.event.x * 20) / width) + 1;
                  const focusRequestId =
                    q.markerMode === 'worker' ? q.sessionInstance.input.pendingFocus?.requestId : undefined;
                  q.sends.push({ at: performance.now(), sequence: m.sequence, stimulus, focusRequestId });
                } else if (q.markerMode === 'worker' && m.type === 'focus') {
                  q.focusEvents.push({
                    phase: 'send',
                    at: performance.now(),
                    requestId: m.focusRequestId,
                    focused: m.focused,
                    stimulus: q.pendingInput?.sequence,
                  });
                }
              } catch {}
            }
            return send.call(this, value);
          };
          channel.addEventListener('message', (e) => {
            if (!(q.active || q.trackTouch) || typeof e.data !== 'string') return;
            try {
              const m = JSON.parse(e.data);
              if (q.trackTouch && m.type === 'input.result' && m.touchSequenceId) {
                q.touchWire.push({
                  phase: 'result',
                  at: performance.now(),
                  clientSequence: m.clientSequence,
                  touchSequenceId: m.touchSequenceId,
                  touchState: m.touchState,
                  ok: m.ok,
                });
              } else if (q.active && m.type === 'frame')
                q.meta.push({ at: performance.now(), rtp: m.rtpTimestamp });
              else if (q.markerMode === 'worker' && m.type === 'focus') {
                q.focusEvents.push({
                  phase: 'result',
                  at: performance.now(),
                  requestId: m.focusRequestId,
                  ok: m.ok,
                });
              }
            } catch {}
          });
          return channel;
        };
        addEventListener(
          'pointerdown',
          (event) => {
            if (q.trackTouch && event.pointerType === 'touch') {
              q.touchTrustedDown = event.isTrusted;
            }
            if (q.active && q.stimulus && event.isTrusted) {
              q.inputs.push({
                sequence: q.stimulus,
                eventAt: event.timeStamp,
                at: performance.now(),
                x: event.clientX,
                y: event.clientY,
                pointerType: event.pointerType,
              });
              q.stimulus = null;
            }
          },
          { capture: true },
        );
        const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
        HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
          return requestFrame.call(this, (now, metadata) => {
            callback(now, metadata);
            if (q.active && q.plane.video === this) q.observe(now, metadata);
          });
        };
      });
      let conditions = null,
        shaping = null;
      if (shape) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        conditions = {
          offline: false,
          matchedNetworkConditions: [
            {
              urlPattern: '',
              latency: 5,
              downloadThroughput: 6000000,
              uploadThroughput: 6000000,
              packetLoss: 0,
              packetQueueLength: 64,
              packetReordering: false,
            },
          ],
        };
        shaping = await cdp.send('Network.emulateNetworkConditionsByRule', conditions);
      }
      await page.goto(origin);
      await page.evaluate(async () => {
        const response = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'osr-profile',
            password: Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'),
          }),
        });
        if (!response.ok) throw Error('Disposable first-user registration: ' + response.status);
      });
      await page.reload();
      await page.waitForSelector('.viewer-lock-blank');
      for (const key of [
        'ArrowUp',
        'ArrowUp',
        'ArrowDown',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'ArrowLeft',
        'ArrowRight',
      ]) {
        await page.keyboard.press(key);
      }
      await page.waitForFunction(
        () => window.osrProfile?.state?.workspace && osrProfile.productChannel?.readyState === 'open',
        null,
        { timeout: 15000 },
      );
      const addressSelector = '.address-form input[aria-label="搜索或输入网址"]';
      await page.getByRole('button', { name: '新建窗口', exact: true }).first().click();
      await page.locator(addressSelector).click();
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(fixture);
      await page.waitForFunction(
        ({ selector, url }) =>
          document.activeElement?.matches(selector) && document.activeElement.value === url,
        { selector: addressSelector, url: fixture },
        { timeout: 5000 },
      );
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (url) => {
          try {
            if (!osrProfile.state.workspace.tabs.some((tab) => tab.url === url && !tab.pendingUrl))
              return false;
            const session = osrProfile.session();
            return (
              session.presentation.getPresentationDiagnostics().rendering.backend === 'video' &&
              [...session.presentation.videoPlanes.values()].some((plane) => plane.ready)
            );
          } catch {
            return false;
          }
        },
        fixture,
        { timeout: 30000 },
      );

      await page.evaluate(async (markerMode) => {
        const q = osrProfile,
          session = q.session();
        const [renderer, plane] = [...session.presentation.videoPlanes].find(
          ([, candidate]) => candidate.ready,
        );
        Object.assign(q, {
          sessionInstance: session,
          renderer,
          plane,
          initialLayout: session.presentation.layout,
        });
        const { decodeMarker, percentiles } = await import('/marker-codec.js');
        Object.assign(q, {
          percentiles,
          markerMode,
          pendingInputs: new Map(),
          readJobs: new Set(),
          markerIds: new Set(),
          readStats: { eligible: 0, submitted: 0, capacitySkipped: 0, outOfBounds: 0, failures: [] },
          readCosts: [],
          workerCosts: [],
        });
        const maxPending = 4;
        if (markerMode === 'worker') {
          const { BenchmarkMarkerReadback } = await import('/benchmark-marker-readback.js');
          q.reader = await new BenchmarkMarkerReadback({ maxPending, timeoutMs: 1000 }).start();
          session.input.subscribeInputDelivery?.((event) => {
            if (q.active && (event.phase === 'queued' || event.phase === 'submitted')) {
              q.inputDelivery.push({
                phase: event.phase,
                at: performance.now(),
                sequence: event.sequence,
                eventType: event.event.type,
                action: event.event.action,
              });
            }
          });
          // The delivery subscription emits only touch/gesture. Observe the mouse
          // call boundary separately and let the unmodified method admit it.
          const sendInput = session.input.sendInput;
          session.input.sendInput = function (surface, event, ...options) {
            if (!q.active || event.type !== 'mouse' || event.action !== 'down') {
              return sendInput.call(this, surface, event, ...options);
            }
            const at = performance.now(),
              stimulus = q.pendingInput?.sequence;
            const focusRequestId = this.pendingFocus?.requestId;
            const accepted = sendInput.call(this, surface, event, ...options);
            q.inputAdmissions.push({ at, returnedAt: performance.now(), stimulus, focusRequestId, accepted });
            return accepted;
          };
        }
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 112;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const acceptMarker = (marker, identity) => {
          if (!marker) {
            q.invalid = (q.invalid ?? 0) + 1;
            return;
          }
          if (q.markerIds.has(marker.frameId)) return;
          q.markerIds.add(marker.frameId);
          q.pendingInputs.delete(marker.stimulus);
          if (marker.stimulus === q.pendingInput?.sequence) {
            q.pendingInput = null;
            q.nextRead = identity.observedAt + 1000;
          }
          const renderToObservedMs = ((identity.observedWall >>> 0) - marker.timestamp) >>> 0;
          q.markers.push({
            ...marker,
            ...identity,
            markerCompletedAt: performance.now(),
            renderToObservedMs: renderToObservedMs < 60000 ? renderToObservedMs : null,
          });
        };
        q.observe = (now, metadata) => {
          const at = performance.now(),
            wall = Date.now(),
            view = renderer.view;
          const current =
            session.presentation.layout?.epoch === q.initialLayout.epoch &&
            session.presentation.layout?.generation === q.initialLayout.generation;
          const visible =
            current &&
            plane.ready &&
            plane.clip.style.opacity === '1' &&
            document.visibilityState === 'visible';
          const rtp = metadata.rtpTimestamp;
          const {
            presentationTime,
            expectedDisplayTime,
            presentedFrames,
            receiveTime,
            processingDuration,
            captureTime,
            mediaTime,
          } = metadata;
          const frame = {
            now,
            at,
            visible,
            epoch: renderer.layoutEpoch,
            rtpTimestamp: rtp,
            exactRtp: plane.rtp === rtp,
            presentationTime,
            expectedDisplayTime,
            presentedFrames,
            receiveTime,
            processingDuration,
            captureTime,
            mediaTime,
          };
          q.frames.push(frame);
          if (!visible || q.markerMode === 'none') return;
          for (const [sequence, start] of q.pendingInputs) {
            if (at - start > 1800) q.pendingInputs.delete(sequence);
          }
          const dense = q.markerMode === 'worker' && q.pendingInputs.size > 0;
          if (!dense && at < (q.nextRead ?? 0)) return;
          const syncPending = q.markerMode === 'sync45' && q.pendingInput && at - q.pendingInput.at < 1800;
          q.nextRead = at + (syncPending ? 45 : 1000);
          ++q.readStats.eligible;
          const sx = view.deviceScaleFactor * (view.mediaScaleX ?? view.mediaScale ?? 1);
          const sy = view.deviceScaleFactor * (view.mediaScaleY ?? view.mediaScale ?? 1);
          const width = canvas.width * sx,
            height = canvas.height * sy;
          if (width > view.width || height > view.height) {
            frame.markerSampling = 'out-of-bounds';
            ++q.readStats.outOfBounds;
            return;
          }
          const identity = {
            rtp,
            epoch: renderer.layoutEpoch,
            observedAt: at,
            observedWall: wall,
            expectedDisplayTime,
          };
          if (q.reader) {
            if (q.readJobs.size >= maxPending) {
              frame.markerSampling = 'capacity-skipped';
              ++q.readStats.capacitySkipped;
              return;
            }
            frame.markerSampling = 'worker-submitted';
            ++q.readStats.submitted;
            const job = q.reader
              .submit(plane.video, { x: view.x, y: view.y, width, height }, identity)
              .then((result) => {
                frame.markerSampling = result.marker ? 'worker-crc-valid' : 'worker-crc-invalid';
                q.workerCosts.push(result.costs);
                q.readCosts.push(result.costs.captureCallMs);
                acceptMarker(result.marker, result.identity);
              })
              .catch((error) => {
                frame.markerSampling = 'worker-failed';
                q.readStats.failures.push({ rtp, at, message: String(error) });
              })
              .finally(() => q.readJobs.delete(job));
            q.readJobs.add(job);
            return;
          }
          ++q.readStats.submitted;
          ctx.drawImage(
            plane.video,
            view.x,
            view.y,
            canvas.width * sx,
            canvas.height * sy,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          const marker = decodeMarker(ctx.getImageData(0, 0, canvas.width, canvas.height));
          frame.markerSampling = marker ? 'sync-crc-valid' : 'sync-crc-invalid';
          q.readCosts.push(performance.now() - at);
          acceptMarker(marker, identity);
        };
        q.sampleStats = async () => {
          const peer = session.rtc.peer;
          const stats = peer ? await peer.getStats().catch(() => new Map()) : new Map();
          const playback = plane.video.getVideoPlaybackQuality?.();
          const receiver = peer?.getReceivers().find((candidate) => candidate.track?.kind === 'video');
          return {
            at: performance.now(),
            rtc: [...stats.values()].filter((s) =>
              ['inbound-rtp', 'candidate-pair', 'codec', 'transport'].includes(s.type),
            ),
            peer: {
              connectionId: session.rtc.connectionId,
              state: peer?.connectionState,
              initialVideoCurrent: session.presentation.videoPlanes.get(renderer) === plane,
              documentVisibility: document.visibilityState,
              trackId: receiver?.track.id,
              dataChannel: session.endpoint.channel?.readyState,
            },
            playback: playback
              ? {
                  totalVideoFrames: playback.totalVideoFrames,
                  droppedVideoFrames: playback.droppedVideoFrames,
                  creationTime: playback.creationTime,
                }
              : null,
            receiver: receiver
              ? {
                  jitterBufferTarget: receiver.jitterBufferTarget ?? null,
                  playoutDelayHint: receiver.playoutDelayHint ?? null,
                }
              : null,
            rendering: session.presentation.getPresentationDiagnostics().rendering,
            diagnostics: session.observations.diagnostics,
          };
        };
        const clocks = [];
        for (let i = 0; i < 5; ++i) {
          const sent = Date.now(),
            reply = await q.rpc('clock.ping', { clientTime: sent }),
            received = Date.now();
          clocks.push({
            sent,
            received,
            serverTime: reply.serverTime,
            rttMs: received - sent,
            offsetMs: reply.serverTime - (sent + received) / 2,
          });
        }
        q.clock = clocks.sort((a, b) => a.rttMs - b.rttMs)[0];
      }, markerMode);
      await page.waitForTimeout(touchSmoke ? 2000 : monitorDisplay && displaySeconds < 60 ? 3000 : 10000);
      const viewer = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const intervals = [];
            let last;
            const sample = (now) => {
              if (last !== undefined) intervals.push(now - last);
              last = now;
              if (intervals.length < 30) requestAnimationFrame(sample);
              else
                resolve({
                  viewport: [innerWidth, innerHeight],
                  dpr: devicePixelRatio,
                  rafIntervalsMs: osrProfile.percentiles(intervals),
                });
            };
            requestAnimationFrame(sample);
          }),
      );
      const version = await context.browser().version();
      const postEvidence = (route, data) => page.request.post(new URL(route, fixture).href, { data });
      const ready = await postEvidence('/etw-ready', { wall: Date.now(), version });
      if (!ready.ok()) throw Error('Write Viewer readiness: ' + ready.status());
      const measure = async (mode, inputCount, sampleMs) => {
        const started = await page.evaluate(async (mode) => {
          const q = osrProfile;
          Object.assign(q, {
            frames: [],
            markers: [],
            inputs: [],
            sends: [],
            meta: [],
            markerMode: mode,
            focusEvents: [],
            inputAdmissions: [],
            inputDelivery: [],
            pendingInput: null,
            nextRead: 0,
            invalid: 0,
            readCosts: [],
            workerCosts: [],
            readStats: { eligible: 0, submitted: 0, capacitySkipped: 0, outOfBounds: 0, failures: [] },
          });
          q.pendingInputs.clear();
          q.markerIds.clear();
          q.before = await q.sampleStats();
          q.started = performance.now();
          q.startedWall = Date.now();
          q.active = true;
          return q.started;
        }, mode);
        const rtcSamples = [];
        if (monitorDisplay) {
          for (let second = 0; second < displaySeconds; ++second) {
            const delay = await page.evaluate(
              (target) => target - performance.now(),
              started + second * 1000,
            );
            if (delay > 0) await page.waitForTimeout(delay);
            const sample = await page.evaluate(() => osrProfile.sampleStats());
            rtcSamples.push(sample);
            const post = await postEvidence('/health', { second, wall: Date.now(), ...sample });
            if (!post.ok()) throw Error('Write display health evidence: ' + post.status());
          }
        }
        for (let sequence = 1; sequence <= inputCount; ++sequence) {
          const delay = await page.evaluate(
            (target) => target - performance.now(),
            started + sequence * 1000,
          );
          if (delay > 0) await page.waitForTimeout(delay);
          const point = await page.evaluate((sequence) => {
            const q = osrProfile,
              box = q.renderer.canvas.getBoundingClientRect();
            q.stimulus = sequence;
            q.pendingInput = { at: performance.now(), sequence };
            q.pendingInputs.set(sequence, q.pendingInput.at);
            q.nextRead = 0;
            return { x: box.left + box.width * ((sequence - 0.5) / 20), y: box.top + box.height * 0.65 };
          }, sequence);
          await page.mouse.click(point.x, point.y);
          if (sequence % 3 === 0) rtcSamples.push(await page.evaluate(() => osrProfile.sampleStats()));
        }
        const remainder = await page.evaluate((target) => target - performance.now(), started + sampleMs);
        if (remainder > 0) await page.waitForTimeout(remainder);
        return await page.evaluate(
          async ({ conditions, shaping, rtcSamples, version, viewer, headless, inputCount }) => {
            const q = osrProfile,
              session = q.sessionInstance;
            q.active = false;
            const ended = performance.now(),
              after = await q.sampleStats(),
              elapsedMs = ended - q.started;
            const drainStarted = performance.now();
            await Promise.allSettled([...q.readJobs]);
            const drainMs = performance.now() - drainStarted;
            q.reader?.close();
            const frameIds = q.frames.filter((frame) => frame.visible).map((frame) => frame.presentedFrames);
            const compositorDelta = frameIds.length > 1 ? frameIds[frameIds.length - 1] - frameIds[0] : 0;
            const video = (snapshot) =>
              snapshot.rtc.find((s) => s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'video');
            const first = video(q.before),
              last = video(after);
            const sameRtp = first?.id && first.id === last?.id;
            const priorQuality = q.before.playback,
              finalQuality = after.playback;
            const playbackQualityDelta =
              priorQuality &&
              finalQuality &&
              q.before.peer.initialVideoCurrent &&
              after.peer.initialVideoCurrent &&
              priorQuality.totalVideoFrames <= finalQuality.totalVideoFrames &&
              priorQuality.droppedVideoFrames <= finalQuality.droppedVideoFrames
                ? {
                    total: finalQuality.totalVideoFrames - priorQuality.totalVideoFrames,
                    dropped: finalQuality.droppedVideoFrames - priorQuality.droppedVideoFrames,
                  }
                : null;
            q.markers.sort((a, b) => a.observedAt - b.observedAt);
            const inputSamples = q.inputs.map((input) => {
              const marker = q.markers.find(
                (row) => row.stimulus === input.sequence && row.observedAt >= input.at,
              );
              return {
                ...input,
                marker,
                callbackDelayMs: marker ? marker.observedAt - input.eventAt : null,
                expectedDisplayDelayMs: marker ? marker.expectedDisplayTime - input.eventAt : null,
              };
            });
            return {
              kind: 'osr-video-profile',
              tenantIndex: 0,
              clientVersion: version,
              presentationEndpoint: 'visible-video-rVFC; expectedDisplayTime is browser estimate',
              clock: 'same-machine wall time for marker age; input latency is Viewer monotonic',
              clockSample: q.clock,
              timeOrigin: performance.timeOrigin,
              startedAt: q.started,
              startedWall: q.startedWall,
              elapsedMs,
              conditions,
              shaping,
              actualLayout: session.presentation.layout,
              viewer: { ...viewer, headless },
              visibility: document.visibilityState,
              presentation: session.presentation.getPresentationDiagnostics(),
              visibleCompositorFps: (compositorDelta * 1000) / elapsedMs,
              visibleCallbackFps: (frameIds.length * 1000) / elapsedMs,
              playbackQualityDelta,
              distinctMarkerFps: (q.markers.length * 1000) / elapsedMs,
              receivedVideoMbps: sameRtp
                ? ((last.bytesReceived - first.bytesReceived) * 0.008) / (after.at - q.before.at)
                : null,
              decodedFps: sameRtp
                ? ((last.framesDecoded - first.framesDecoded) * 1000) / (after.at - q.before.at)
                : null,
              invalid: q.invalid ?? 0,
              inputCount,
              inputSamples,
              inputSends: q.sends,
              focusEvents: q.focusEvents,
              inputAdmissions: q.inputAdmissions,
              inputDelivery: q.inputDelivery,
              markerMode: q.markerMode,
              markerReadCostMs: q.percentiles(q.readCosts),
              markerReads: q.readCosts.length,
              markerReadback: {
                ...q.readStats,
                drainMs,
                ownership: q.markerMode === 'worker' ? q.reader.stats : null,
                workerCostMs: Object.fromEntries(
                  [
                    'captureCallMs',
                    'bitmapReadyMs',
                    'turnaroundMs',
                    'workerDrawMs',
                    'workerReadbackMs',
                    'workerDecodeMs',
                    'workerTotalMs',
                  ].map((key) => [key, q.percentiles(q.workerCosts.map((cost) => cost[key]))]),
                ),
              },
              inputToObservedMs: q.percentiles(
                inputSamples.map((x) => x.callbackDelayMs).filter(Number.isFinite),
              ),
              renderToObservedMs: q.percentiles(
                q.markers.map((x) => x.renderToObservedMs).filter(Number.isFinite),
              ),
              samples: q.markers,
              rawVideoFrames: q.frames,
              frameMetadata: q.meta,
              rtcSamples: [q.before, ...rtcSamples, after],
            };
          },
          { conditions, shaping, rtcSamples, version, viewer, headless, inputCount },
        );
      };
      const inputCount = markerMode === 'none' || touchSmoke ? 0 : 18;
      const report = await measure(
        markerMode,
        inputCount,
        monitorDisplay ? displaySeconds * 1000 : touchSmoke ? 3000 : 20000,
      );
      const post = await postEvidence('/report', report);
      if (!post.ok()) throw Error('Write profile report: ' + post.status());
      let clean;
      if (cleanWindow) {
        clean = await measure('none', inputCount, 20000);
        const cleanPost = await postEvidence('/clean-report', clean);
        if (!cleanPost.ok()) throw Error('Write clean profile report: ' + cleanPost.status());
      }
      let touch;
      if (touchSmoke) {
        const point = await page.evaluate(() => {
          const q = osrProfile,
            box = q.renderer.canvas.getBoundingClientRect();
          q.trackTouch = true;
          q.touchWire = [];
          q.touchPeer = q.sessionInstance.rtc.peer;
          q.touchChannel = q.sessionInstance.endpoint.channel;
          q.touchStream = q.plane.video.srcObject;
          q.touchFrames = q.plane.video.getVideoPlaybackQuality().totalVideoFrames;
          return { x: box.left + box.width / 2, y: box.top + box.height * 0.65 };
        });
        await page.touchscreen.tap(point.x, point.y);
        await page.waitForFunction(
          () => {
            const q = osrProfile;
            const end = q.touchWire.find((row) => row.phase === 'send' && row.action === 'end');
            return (
              end &&
              q.touchWire.some(
                (row) =>
                  row.phase === 'result' &&
                  row.clientSequence === end.clientSequence &&
                  row.touchState === 'processed' &&
                  row.ok,
              ) &&
              q.plane.video.getVideoPlaybackQuality().totalVideoFrames > q.touchFrames
            );
          },
          null,
          { timeout: 6000 },
        );
        touch = await page.evaluate(() => {
          const q = osrProfile,
            session = q.sessionInstance;
          q.trackTouch = false;
          return {
            trustedDown: q.touchTrustedDown,
            wire: q.touchWire,
            samePeer: session.rtc.peer === q.touchPeer,
            sameChannel: session.endpoint.channel === q.touchChannel,
            sameVideo: session.presentation.videoPlanes.get(q.renderer) === q.plane,
            sameStream: q.plane.video.srcObject === q.touchStream,
            frameDelta: q.plane.video.getVideoPlaybackQuality().totalVideoFrames - q.touchFrames,
            backend: session.presentation.getPresentationDiagnostics().rendering.backend,
          };
        });
        const touchPost = await postEvidence('/touch-report', touch);
        if (!touchPost.ok()) throw Error('Write compatibility evidence: ' + touchPost.status());
        if (
          !touch.trustedDown ||
          !touch.samePeer ||
          !touch.sameChannel ||
          !touch.sameVideo ||
          !touch.sameStream ||
          touch.backend !== 'video'
        )
          throw Error('Touch or default-video identity check failed');
      }
      let stats;
      if (captureStats) {
        try {
          await page.getByRole('button', { name: '更多', exact: true }).click({ timeout: 5000 });
          await page.getByRole('menuitem', { name: '设置', exact: true }).click({ timeout: 5000 });
          const checkbox = page.getByRole('checkbox', { name: '显示连接统计' });
          if (!(await checkbox.isChecked())) await checkbox.click({ timeout: 5000 });
          const overlay = page.locator('.stats-overlay');
          await overlay.waitFor({ state: 'visible', timeout: 5000 });
          await page.getByRole('button', { name: '关闭设置' }).click({ timeout: 5000 });
          await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 5000 });
          if (await page.getByRole('menu').isVisible()) await page.keyboard.press('Escape');
          const ready = await page.waitForFunction(
            () => {
              const node = document.querySelector('.stats-overlay');
              if (!node) return false;
              const rows = Object.fromEntries(
                [...node.querySelectorAll('dt')].map((row) => [
                  row.textContent,
                  row.nextElementSibling?.textContent,
                ]),
              );
              const required = [
                'Video 提交 FPS',
                '解码 FPS',
                '末包→Video 提交 p95',
                '接收缓冲均值',
                '解码耗时均值',
                '接收码率',
                '编码器',
                '源 Atlas',
                'Encoded',
              ];
              if (!required.every((key) => rows[key] && rows[key] !== '—')) return false;
              return {
                title: node.firstElementChild.textContent,
                rows,
                bounds: node.getBoundingClientRect().toJSON(),
                parent: node.parentElement.getBoundingClientRect().toJSON(),
              };
            },
            null,
            { timeout: 6000 },
          );
          stats = await ready.jsonValue();
          await overlay.screenshot({ path: evidence + '/stats-overlay.png', timeout: 5000 });
        } catch (error) {
          stats = { error: String(error) };
        }
        const statsPost = await postEvidence('/stats-report', stats);
        if (!statsPost.ok()) throw Error('Write Stats evidence: ' + statsPost.status());
      }
      await page.screenshot({ path: evidence + '/final.png' });
      return {
        ...report,
        samples: report.samples.length,
        rawVideoFrames: report.rawVideoFrames.length,
        frameMetadata: report.frameMetadata.length,
        rtcSamples: undefined,
        inputSamples: report.inputSamples.length,
        unmatchedInputs: report.inputSamples.filter((sample) => !sample.marker).length,
        stats,
        touch,
        cleanWindow: clean && {
          startedAt: clean.startedAt,
          elapsedMs: clean.elapsedMs,
          inputCount: clean.inputCount,
          visibleCompositorFps: clean.visibleCompositorFps,
          visibleCallbackFps: clean.visibleCallbackFps,
          decodedFps: clean.decodedFps,
          receivedVideoMbps: clean.receivedVideoMbps,
          playbackQualityDelta: clean.playbackQualityDelta,
        },
      };
    } catch (error) {
      await page.screenshot({ path: evidence + '/failure.png', timeout: 5000 }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  };
  return 'Prepared host.osrVideoProfile';
};
