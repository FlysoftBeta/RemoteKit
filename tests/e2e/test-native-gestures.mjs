import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startStack } from './kit/stack.mjs';

import { prepareNativeViewer as prepareViewer } from './kit/viewer.mjs';

const { values } = parseArgs({
  options: {
    browser: { type: 'string', default: 'edge' },
    out: { type: 'string' },
    port: { type: 'string', default: '34180' },
    'peer-port': { type: 'string', default: '34189' },
    only: { type: 'string', multiple: true },
  },
});
if (!values.out || !['edge', 'chrome89'].includes(values.browser))
  throw Error('Expected --out and --browser edge|chrome89');
const run = resolve(values.out);
await mkdir(run, { recursive: true });
const stack = await startStack({
  scenario: 'native-gestures',
  run,
  seed: false,
  fixtures: 'gestures',
  ports: {
    control: Number(values.port) + 3,
    viewer: Number(values.port),
    fixture: Number(values.port) + 1,
    peer: Number(values['peer-port']),
  },
});
const viewerExe =
  values.browser === 'edge'
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    : 'C:/src/tmp/chrome89-google/app/chrome.exe';
const host = { viewerExe };
const results = [];
try {
  await prepareViewer(host);
  await prepareGestures(host);
  await prepareRetirement(host);
  const qa = host._clientGestureQA;
  await qa.openViewer({
    ready: true,
    gpuGranted: true,
    version: values.browser === 'chrome89' ? 89 : 157,
    port: Number(values.port),
    run,
    password: 'native-gesture-fixture-password',
  });
  const journeys = [
    ...[
      'tap',
      'root-scroll',
      'nested',
      'action-pan-x',
      'action-pan-y',
      'action-none',
      'action-pinch-zoom',
      'off-axis-pan-x',
      'off-axis-pan-y',
      'prevent-start',
      'prevent-firstmove',
      'pinch',
      'pinch-none',
      'pinch-only',
      'second-finger-none',
      'oopif',
    ].map((name) => [name, () => qa.functionalCases({ only: [name] })]),
    ...['invalidationCases', 'lifecycleCases'].map((name) => [name, () => qa[name]()]),
    ...Object.entries(host._retirementQA),
  ];
  for (const name of values.only ?? []) {
    if (!journeys.some(([journey]) => journey === name)) throw Error('Unknown journey: ' + name);
  }
  for (const [name, journey] of journeys) {
    if (values.only && !values.only.includes(name)) continue;
    try {
      results.push({ name, result: await journey() });
      console.log('Verified', name);
    } catch (error) {
      results.push({ name, error: error.stack });
      process.exitCode = 1;
      console.log('Failed', name, error.message);
      await qa.base.page.screenshot({ path: join(run, name + '-failure.png') }).catch(() => {});
    }
    await writeFile(join(run, 'results.json'), JSON.stringify(results, null, 2));
  }
} catch (error) {
  const page = host._robustViewerQA?.page;
  if (page) {
    await page.screenshot({ path: join(run, 'failure.png') }).catch(() => {});
    await writeFile(
      join(run, 'failure.json'),
      JSON.stringify(
        await page.evaluate(() => ({
          text: document.body.innerText,
          html: document.querySelector('#root')?.innerHTML,
          state: window.robustQA?.state,
        })),
        null,
        2,
      ),
    ).catch(() => {});
  }
  throw error;
} finally {
  await host._clientGestureQA?.close();
  await stack.stop();
}

async function prepareGestures(host) {
  const base = host._robustViewerQA;
  if (!base) throw Error('Load robust-viewer-qa-browser.js first');
  const inspect = base.gestureInspectOriginal ?? base.inspect.bind(base);
  base.gestureInspectOriginal = inspect;
  base.inspect = async () => {
    const value = await inspect(),
      telemetry = qa.case
        ? Object.fromEntries(Object.entries(value.telemetry).filter(([key]) => key.startsWith(qa.case + ':')))
        : value.telemetry;
    return { ...value, telemetry, events: Object.values(telemetry).flatMap((item) => item.events ?? []) };
  };
  const qa = (host._clientGestureQA = { base, results: [] });
  const assert = (value, message) => {
    if (!value) throw Error(message);
  };
  qa.openViewer = async (options) => {
    assert(
      options?.ready === true && options?.gpuGranted === true,
      'Explicit root READY and GPU grant required',
    );
    const result = await base.openViewer({ port: 33581, ...options });
    await base.ready();
    await base.context.addInitScript(() => {
      const q = (window.clientGestureQA = {
        pointers: [],
        sent: [],
        received: [],
        heldResults: [],
        holdResults: false,
        delayMoveMs: 0,
        delayMoveAt: 4,
        moveCount: 0,
        delayEndMs: 0,
        tail: Promise.resolve(),
        rafPaused: false,
        rafQueue: [],
        marks: [],
      });
      const push = (list, item) => {
        list.push(item);
        if (list.length > 12000) list.shift();
      };
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
        addEventListener(
          type,
          (e) => {
            if (e.pointerType === 'touch')
              push(q.pointers, {
                type,
                id: e.pointerId,
                x: e.clientX,
                y: e.clientY,
                ts: e.timeStamp,
                at: performance.now(),
                trusted: e.isTrusted,
                target: e.target.className,
              });
          },
          true,
        );
      const PC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends PC {
        createDataChannel(...args) {
          const dc = super.createDataChannel(...args),
            send = dc.send.bind(dc);
          if (dc.label !== 'remotekit') return dc;
          q.channel = dc;
          dc.send = (data) => {
            let m;
            try {
              m = JSON.parse(data);
            } catch {
              return send(data);
            }
            const e = m.event ?? m.input ?? m,
              isTouch = e.type === 'touch' || e.type === 'gesture';
            if (e.type === 'touch' && e.action === 'start' && q.staleStartEpoch) {
              m.layoutEpoch = q.staleStartEpoch;
              q.staleStartEpoch = undefined;
              data = JSON.stringify(m);
            }
            const record = { at: performance.now(), wire: null, message: m };
            push(q.sent, record);
            if (q.dropNextEnd && e.type === 'touch' && e.action === 'end') {
              q.dropNextEnd = false;
              push(q.marks, { type: 'dropped-end', sequence: e.sequenceId });
              return;
            }

            if (!isTouch) {
              record.wire = performance.now();
              return send(data);
            }
            const delay =
              e.type === 'touch' && e.action === 'move' && ++q.moveCount === q.delayMoveAt
                ? q.delayMoveMs
                : e.type === 'touch' && e.action === 'end'
                  ? q.delayEndMs
                  : 0;
            q.tail = q.tail
              .then(() => new Promise((resolve) => setTimeout(resolve, delay)))
              .then(() => {
                record.wire = performance.now();
                send(data);
              })
              .catch((error) =>
                push(q.marks, { type: 'send-error', error: String(error), at: performance.now() }),
              );
          };
          dc.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return;
            let m;
            try {
              m = JSON.parse(event.data);
            } catch {
              return;
            }
            push(q.received, { at: performance.now(), message: m });
            if (m.type === 'input.result' && q.holdResults) {
              q.heldResults.push(event.data);
              event.stopImmediatePropagation();
            }
          });
          return dc;
        }
      };
      const raf = window.requestAnimationFrame.bind(window);
      q.originalRaf = raf;
      window.requestAnimationFrame = (callback) =>
        raf((time) => {
          if (q.rafPaused) q.rafQueue.push(callback);
          else callback(time);
        });
      q.resumeRaf = () => {
        q.rafPaused = false;
        const callbacks = q.rafQueue.splice(0);
        for (const callback of callbacks) raf(callback);
      };
    });
    await base.page.reload();
    await base.page.waitForSelector('.viewer-lock-blank');
    await base.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    for (const key of [
      'ArrowUp',
      'ArrowUp',
      'ArrowDown',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowLeft',
      'ArrowRight',
    ])
      await base.page.keyboard.press(key);
    await base.uiFill({ css: 'input[autocomplete="current-password"]' }, options.password);
    await base.page.keyboard.press('Enter');
    await base.page.waitForFunction(() => robustQA.state);
    if (!(await base.page.evaluate(() => robustQA.state.workspace.windows.length))) {
      if (!(await base.page.locator('.launcher-search input').isVisible()))
        await base.uiClick({ css: 'button', text: '开始' });
      await base.uiClick({ css: '[data-tile-key="app:browser"]' });
      await base.page.waitForFunction(() => robustQA.state.workspace.windows.length > 0);
    }
    await base.ready();
    qa.cdp = await base.context.newCDPSession(base.page);
    await qa.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    return { ...result, newPathPrepared: true };
  };
  qa.navigate = async ({ id, action = 'auto', block = '', tight = false, live = false } = {}) => {
    assert(id && /^[\w-]+$/.test(id), 'Simple unique case id required');
    qa.case = id;
    const prior = (await base.inspect()).telemetry[id + ':root']?.timeOrigin;
    const url = `http://127.0.0.1:${base.fixturePort}/?case=${id}&action=${encodeURIComponent(action)}&block=${block}${tight ? '&tight=1' : ''}${live ? '&live=1' : ''}`;
    const page = base.page;
    const previousDocument = await page.evaluate(
      () => robustQA.transport().presentation.layout?.views[0]?.document,
    );
    await base.uiFill({ css: 'input[aria-label="搜索或输入网址"]', index: 'last' }, url);
    await page.keyboard.press('Enter');
    await page.waitForFunction((url) => robustQA.state.workspace.tabs.some((t) => t.url === url), url);
    await base.ready();
    await page.waitForFunction(() => robustQA.transport().presentation.videoPlanes.size > 0);
    qa.viewId = await page.evaluate(() => [...robustQA.transport().presentation.videoPlanes][0][0].view.id);
    let arrived = false;
    for (let n = 0; n < 100; n++) {
      const inspection = await base.inspect(),
        fixture = inspection.telemetry[id + ':root'];
      if (fixture && fixture.timeOrigin !== prior) {
        arrived = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    assert(arrived, 'Fresh fixture document telemetry not observed');
    await page.waitForFunction(
      (url) =>
        robustQA.state.workspace.tabs.some((t) => t.url === url && !t.loading) &&
        !document.querySelector('.page-overlay'),
      url,
    );
    await page.waitForFunction((previous) => {
      const view = robustQA.transport().presentation.layout?.views[0];
      return view && view.document !== previous;
    }, previousDocument);
    await base.ready();
    await qa.mark(id);
    return { url, viewId: qa.viewId };
  };
  qa.mark = async (name) => {
    qa.markStart = await base.page.evaluate((name) => {
      const q = clientGestureQA,
        t = robustQA.transport();
      const mark = {
        name,
        at: performance.now(),
        sent: q.sent.length,
        received: q.received.length,
        pointers: q.pointers.length,
        connectionId: t.rtc.connectionId,
        peerCount: robustQA.peers.length,
        planes: [...t.presentation.videoPlanes.values()].map((p) => ({
          videoId: robustQA.id(p.video),
          streamId: robustQA.id(p.video.srcObject),
          tracks: p.video.srcObject?.getTracks().map((track) => track.id),
        })),
      };
      q.marks.push(mark);
      return mark;
    }, name);
    return qa.markStart;
  };
  qa.setDelay = async ({ move = 0, end = 0, moveAt = 4 } = {}) =>
    base.page.evaluate(
      ({ move, end, moveAt }) => {
        clientGestureQA.delayMoveMs = move;
        clientGestureQA.delayEndMs = end;
        clientGestureQA.delayMoveAt = moveAt;
        clientGestureQA.moveCount = 0;
      },
      { move, end, moveAt },
    );
  qa.touch = async (type, points, offsetMs) => {
    const mapped = [];
    for (const point of points) {
      const p = await base.point(qa.viewId, point.x, point.y);
      mapped.push({ ...p, id: point.id ?? 1, radiusX: 5, radiusY: 5, force: 0.5 });
    }
    const timestamp = offsetMs === undefined ? Date.now() / 1000 : qa.sourceEpoch + offsetMs / 1000;
    await qa.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: mapped, timestamp });
  };
  // steps: [{at:0,type:'touchStart',points:[{id:1,x:100,y:600}]}, ...].
  // Actual CDP source timestamps stay identical when only DC sending is delayed.
  qa.trajectory = async (steps, { settleMs = 3000 } = {}) => {
    qa.sourceEpoch = Date.now() / 1000;
    let before = 0;
    for (const step of steps) {
      if (step.at > before) await base.page.waitForTimeout(step.at - before);
      await qa.touch(step.type, step.points, step.at);
      before = step.at;
    }
    await base.page.evaluate(() => clientGestureQA.tail);
    if (settleMs) await base.page.waitForTimeout(settleMs);
  };
  qa.tap = async (x = 120, y = 110) =>
    qa.trajectory([
      { at: 0, type: 'touchStart', points: [{ x, y }] },
      { at: 80, type: 'touchEnd', points: [] },
    ]);
  qa.swipe = async ({ x = 120, y = 650, dx = 0, dy = -220, duration = 160, settleMs = 3000 } = {}) => {
    const steps = [{ at: 0, type: 'touchStart', points: [{ x, y }] }];
    for (let n = 1; n <= 8; n++)
      steps.push({
        at: (duration * n) / 8,
        type: 'touchMove',
        points: [{ x: x + (dx * n) / 8, y: y + (dy * n) / 8 }],
      });
    steps.push({ at: duration + 10, type: 'touchEnd', points: [] });
    await qa.trajectory(steps, { settleMs });
  };
  qa.pinch = async ({ x = 610, y = 160, span = 50, growth = 90, settleMs = 3000 } = {}) => {
    const pair = (s) => [
      { id: 1, x: x - s, y },
      { id: 2, x: x + s, y },
    ];
    const steps = [
      { at: 0, type: 'touchStart', points: [pair(span)[0]] },
      { at: 20, type: 'touchStart', points: pair(span) },
    ];
    for (let n = 1; n <= 8; n++)
      steps.push({ at: 20 + n * 25, type: 'touchMove', points: pair(span + (growth * n) / 8) });
    steps.push({ at: 240, type: 'touchEnd', points: [] });
    await qa.trajectory(steps, { settleMs });
  };
  qa.holdInputResults = async (held) =>
    base.page.evaluate((held) => {
      clientGestureQA.holdResults = held;
    }, held);
  qa.releaseInputResults = async () =>
    base.page.evaluate(() => {
      const q = clientGestureQA;
      q.holdResults = false;
      for (const data of q.heldResults.splice(0))
        q.channel.dispatchEvent(new MessageEvent('message', { data }));
    });
  qa.pauseRaf = async () =>
    base.page.evaluate(() => {
      clientGestureQA.rafPaused = true;
    });
  qa.resumeRaf = async () => base.page.evaluate(() => clientGestureQA.resumeRaf());
  qa.sample = async (name) => {
    assert(/^[\w-]+$/.test(name), 'Simple evidence name required');
    const common = await base.sample(name),
      data = await base.page.evaluate((mark) => {
        const q = clientGestureQA;
        return {
          pointers: q.pointers.slice(mark.pointers),
          sent: q.sent.slice(mark.sent),
          received: q.received.slice(mark.received),
          marks: q.marks,
          rafQueued: q.rafQueue.length,
        };
      }, qa.markStart);
    const packets = data.sent
      .map((r) => ({ record: r, event: r.message.event ?? r.message.input ?? r.message }))
      .filter((r) => ['touch', 'gesture'].includes(r.event.type));
    const inputResults = data.received.filter((r) => r.message.type === 'input.result');
    const terminalRequests = packets
      .filter((r) => r.event.type === 'touch' && ['end', 'cancel'].includes(r.event.action))
      .map((r) => ({
        sequence: r.record.message.sequence,
        touchSequence: r.event.sequenceId,
        action: r.event.action,
      }));
    const terminalResults = terminalRequests.map((request) => ({
      ...request,
      result: inputResults
        .slice()
        .reverse()
        .find((a) => String(a.message.clientSequence) === String(request.sequence))?.message,
    }));
    const cumulative = packets
      .filter((r) => r.event.type === 'gesture')
      .map((r) => ({
        action: r.event.action,
        elapsed: r.event.sampleElapsedUs,
        x: r.event.cumulativeX,
        y: r.event.cumulativeY,
        sequence: r.event.sequenceId,
      }));
    const scroll = packets.flatMap((r) => (r.event.gestures ?? []).filter((g) => g.type === 'scrollUpdate'));
    const mediaStable =
      common.connectionId === qa.markStart.connectionId &&
      common.peerCount === qa.markStart.peerCount &&
      JSON.stringify(
        common.planes.map((p) => ({ videoId: p.videoId, streamId: p.streamId, tracks: p.tracks })),
      ) === JSON.stringify(qa.markStart.planes);
    const evidence = {
      name,
      version: base.version,
      case: qa.case,
      common,
      data,
      summary: {
        packetCount: packets.length,
        allClientV1: packets.every((r) => r.event.gestureMode === 'client-v1'),
        trustedPointerCount: data.pointers.filter((p) => p.trusted).length,
        inputResultCount: inputResults.length,
        terminalResults,
        mediaStable,
        rejections: inputResults.filter((r) => r.message.ok === false),
        deltaX: scroll.reduce((s, g) => s + (g.deltaX ?? 0), 0),
        deltaY: scroll.reduce((s, g) => s + (g.deltaY ?? 0), 0),
        momentum: cumulative,
      },
    };
    const saved = JSON.parse(JSON.stringify(evidence));
    for (const key of ['events', 'dcSent', 'wsSent']) saved.common[key] = saved.common[key].slice(-100);
    if (saved.common.presentation?.raw) delete saved.common.presentation.raw;
    const response = await base.page.request.post(`http://127.0.0.1:${base.port + 1}/record`, {
      headers: { Origin: `http://127.0.0.1:${base.port}` },
      data: { kind: 'client-gesture-qa', ...saved },
    });
    assert(response.ok(), 'Evidence persistence failed ' + response.status());
    qa.results.push(evidence);
    return evidence;
  };
  qa.assertClientPath = (e) => {
    assert(e.summary.packetCount > 0, 'No Viewer touch packets');
    assert(e.summary.allClientV1, 'Legacy gesture mode observed');
    assert(e.summary.trustedPointerCount > 0, 'No trusted Viewer pointer events');
    assert(e.summary.inputResultCount > 0, 'No final input.result recorded');
    assert(
      e.summary.terminalResults.length > 0 && e.summary.terminalResults.every((r) => r.result),
      'Physical terminal missing matching final input.result',
    );
    assert(e.summary.mediaStable, 'Gesture rebuilt peer/video/stream/track identity');
    return true;
  };
  qa.functionalCases = async ({ from, only } = {}) => {
    const output = [];
    let started = !from;
    const run = async (name, config, gesture, check) => {
      if (name === from) started = true;
      if (!started || (only && !only.includes(name))) return;
      await qa.setDelay();
      await qa.navigate({ id: `v${base.version}-${name}`, ...config });
      await gesture();
      const e = await qa.sample(`v${base.version}-${name}`);
      qa.assertClientPath(e);
      assert(
        e.summary.rejections.every(
          (r) =>
            config.allowMomentumDenied &&
            r.message.error?.code === 'outcome_unknown' &&
            r.message.inputAdmitted === true &&
            r.message.error?.message === 'Momentum was not allowed' &&
            e.data.sent.some(
              (s) =>
                String(s.message.sequence) === String(r.message.clientSequence) &&
                s.message.event?.type === 'gesture' &&
                s.message.event.action === 'momentum',
            ),
        ),
        `${name}: unexpected rejected input`,
      );
      await check(e);
      output.push({ name, summary: e.summary });
    };
    const root = (e) => e.common.fixture.telemetry[e.case + ':root'];
    await run(
      'tap',
      {},
      () => qa.tap(),
      (e) => assert(root(e).clicks === 1, 'Tap must produce exactly one real click'),
    );
    await run(
      'root-scroll',
      {},
      () => qa.swipe(),
      async (e) => {
        const end = e.summary.momentum.filter((m) => m.action === 'momentumEnd').slice(-1)[0];
        assert(end, 'No Client momentumEnd');
        const expected = -e.summary.deltaY - end.y;
        for (let attempt = 0; attempt < 50; ++attempt) {
          if (Math.abs(root(e).positions.rootY - expected) <= 3) break;
          await base.page.waitForTimeout(100);
          e.common.fixture = await base.inspect();
        }
        const settled = await qa.sample(e.name + '-settled');
        assert(root(settled).positions.rootY > 220, 'Root scroll must include Client momentum');
        assert(
          Math.abs(root(settled).positions.rootY - expected) <= 3,
          'DOM distance differs from Client integral (possible native fling double execution)',
        );
      },
    );
    await run(
      'nested',
      {},
      () => qa.swipe({ x: 350, y: 240, dy: -140 }),
      (e) => {
        assert(root(e).positions.nestedY > 100, 'Nested target did not scroll');
        assert(root(e).positions.rootY === 0, 'Nested gesture scrolled root unexpectedly');
      },
    );
    for (const action of ['none', 'pan-x', 'pan-y', 'pinch-zoom'])
      await run(
        'action-' + action,
        { action },
        () =>
          qa.swipe({
            x: 680,
            y: 240,
            dx: action === 'pan-x' ? -130 : -90,
            dy: action === 'pan-x' ? -90 : -130,
          }),
        (e) => {
          const p = root(e).positions;
          assert(p.rootY === 0, 'CSS action gesture escaped to root');
          if (action === 'pan-x') {
            assert(p.actionX > 0 && p.actionY === 0, 'pan-x leaked Y or denied X');
          } else if (action === 'pan-y') {
            assert(p.actionY > 0 && p.actionX === 0, 'pan-y leaked X or denied Y');
          } else assert(p.actionX === 0 && p.actionY === 0, action + ' unexpectedly scrolled');
        },
      );
    for (const action of ['pan-x', 'pan-y'])
      await run(
        'off-axis-' + action,
        { action },
        () =>
          qa.swipe({
            x: 680,
            y: 240,
            dx: action === 'pan-y' ? -130 : -90,
            dy: action === 'pan-y' ? -90 : -130,
          }),
        (e) => {
          const p = root(e).positions;
          assert(
            p.rootY === 0 && p.actionX === 0 && p.actionY === 0,
            'Off-axis CSS gesture unexpectedly scrolled',
          );
        },
      );
    for (const block of ['start', 'firstmove'])
      await run(
        'prevent-' + block,
        { block, allowMomentumDenied: true },
        () => qa.swipe({ x: 820, y: 240, dy: -140 }),
        (e) => {
          const f = root(e);
          if (block === 'start')
            assert(
              f.positions.customY === 0 && f.positions.rootY === 0,
              'Consumed custom raw touch scrolled',
            );
          else assert(f.positions.rootY === 0, 'First-move custom gesture escaped to root');
          assert(
            f.events.some((x) => x.type === 'handler-preventDefault' && x.defaultPrevented),
            'No actual preventDefault evidence',
          );
          assert((f.counts.touchend ?? 0) > 0, 'Custom raw lifecycle did not reach touchend');
          assert(
            e.summary.terminalResults.every((r) => r.result?.ok),
            'Consumed raw terminal was not processed',
          );
        },
      );
    await run(
      'pinch',
      {},
      () => qa.pinch({ x: 140, y: 430, span: 30, growth: 60 }),
      (e) => assert(root(e).pageScale > 1, 'Allowed root pinch did not change pageScale'),
    );
    await run(
      'pinch-none',
      { action: 'none' },
      () => qa.pinch({ x: 610, y: 170, span: 30, growth: 40 }),
      (e) => assert(root(e).pageScale === 1, 'touch-action:none allowed pinch'),
    );
    await run(
      'pinch-only',
      { action: 'pinch-zoom' },
      () => qa.pinch({ x: 610, y: 170, span: 30, growth: 40 }),
      (e) => assert(root(e).pageScale > 1, 'pinch-zoom denied allowed pinch'),
    );
    await run(
      'second-finger-none',
      { tight: true },
      () =>
        qa.trajectory([
          { at: 0, type: 'touchStart', points: [{ id: 1, x: 550, y: 180 }] },
          {
            at: 40,
            type: 'touchStart',
            points: [
              { id: 1, x: 550, y: 180 },
              { id: 2, x: 650, y: 180 },
            ],
          },
          {
            at: 80,
            type: 'touchMove',
            points: [
              { id: 1, x: 525, y: 160 },
              { id: 2, x: 680, y: 160 },
            ],
          },
          {
            at: 120,
            type: 'touchMove',
            points: [
              { id: 1, x: 515, y: 145 },
              { id: 2, x: 690, y: 145 },
            ],
          },
          { at: 160, type: 'touchEnd', points: [] },
        ]),
      (e) => {
        const f = root(e);
        assert(
          f.pageScale === 1 && f.positions.actionX === 0 && f.positions.actionY === 0,
          'Second contact touch-action:none did not tighten permissions',
        );
      },
    );
    await run(
      'oopif',
      {},
      () => qa.swipe({ x: 400, y: 530, dy: -130 }),
      (e) => {
        const child = e.common.fixture.telemetry[e.case + ':child'];
        assert(child?.positions.rootY > 100, 'Child did not scroll');
        const views = e.common.fixture.users.flatMap((u) => u.snapshot?.views ?? []);
        assert(
          views.some((v) => v.renderer_pids?.length >= 2),
          'OOPIF not proved: snapshot must contain >=2 renderer_pids for tested view',
        );
      },
    );
    return output;
  };
  // Invalidation deliberately allows explicit input failures. Inspect identities and DOM
  // evidence; rejecting an old input is success, injecting it into a new document is not.
  qa.invalidationCases = async () => {
    const output = [];
    await qa.navigate({ id: `v${base.version}-targetloss` });
    qa.sourceEpoch = Date.now() / 1000;
    await qa.touch('touchStart', [{ x: 400, y: 500 }], 0);
    await qa.touch('touchMove', [{ x: 400, y: 470 }], 40);
    const response = await base.page.request.post(
      `http://127.0.0.1:${base.fixturePort}/command?id=${qa.case}`,
      { data: { type: 'remove-child' } },
    );
    assert(response.ok(), 'Fixture command rejected');
    await base.page.waitForTimeout(250);
    await qa.touch('touchMove', [{ x: 400, y: 430 }], 300);
    await qa.touch('touchEnd', [], 330);
    await base.page.waitForTimeout(400);
    output.push(await qa.sample(`v${base.version}-targetloss`));
    await qa.navigate({ id: `v${base.version}-oldlayout` });
    qa.sourceEpoch = Date.now() / 1000;
    await qa.touch('touchStart', [{ x: 120, y: 650 }], 0);
    await qa.touch('touchMove', [{ x: 120, y: 610 }], 40);
    const viewport = base.page.viewportSize();
    await base.page.setViewportSize({ width: viewport.width + 37, height: viewport.height });
    await base.ready();
    await qa.touch('touchEnd', []);
    await base.page.waitForTimeout(400);
    output.push(await qa.sample(`v${base.version}-oldlayout`));
    await base.page.setViewportSize(viewport);
    await base.ready();
    await qa.navigate({ id: `v${base.version}-olddoc-before` });
    const mark = qa.markStart;
    qa.sourceEpoch = Date.now() / 1000;
    await qa.touch('touchStart', [{ x: 120, y: 650 }], 0);
    await qa.touch('touchMove', [{ x: 120, y: 600 }], 40);
    await qa.navigate({ id: `v${base.version}-olddoc-after` });
    qa.markStart = mark;
    await qa.touch('touchEnd', []);
    await base.page.waitForTimeout(400);
    const e = await qa.sample(`v${base.version}-olddoc`),
      f = e.common.fixture.telemetry[e.case + ':root'];
    assert(!f.counts.touchstart && !f.counts.touchmove, 'Old gesture reached new document');
    output.push(e);
    return output.map((e) => ({ name: e.name, summary: e.summary }));
  };
  qa.compareTiming = async () => {
    const runs = [];
    for (const [name, delay] of [
      ['normal', {}],
      ['middle70', { move: 70 }],
      ['lateup100', { end: 100 }],
    ]) {
      await qa.navigate({ id: `v${base.version}-timing-${name}` });
      await qa.setDelay(delay);
      await qa.swipe();
      const e = await qa.sample(`v${base.version}-timing-${name}`);
      qa.assertClientPath(e);
      assert(e.summary.rejections.length === 0, 'Timing group rejected input');
      runs.push(e);
    }
    await qa.setDelay();
    const final = (e) => e.summary.momentum.filter((m) => m.action === 'momentumEnd').slice(-1)[0],
      reference = final(runs[0]);
    assert(reference, 'Baseline momentumEnd absent');
    for (const e of runs.slice(1)) {
      const end = final(e);
      assert(end, 'Delayed momentumEnd absent');
      assert(Math.abs(e.summary.deltaY - runs[0].summary.deltaY) < 0.5, 'Source drag displacement changed');
      assert(Math.abs(end.y - reference.y) < 1, 'Source-integrated momentum tail changed');
      const a = runs[0].common.fixture.telemetry[runs[0].case + ':root'].positions.rootY,
        b = e.common.fixture.telemetry[e.case + ':root'].positions.rootY;
      assert(Math.abs(a - b) <= 3, 'Final DOM scroll differs >3 DIP');
    }
    return runs.map((e) => ({
      name: e.name,
      summary: e.summary,
      root: e.common.fixture.telemetry[e.case + ':root'].positions,
    }));
  };
  qa.lifecycleCases = async () => {
    const unwrap = (r) => r.message.event ?? r.message.input ?? r.message,
      output = [];
    await qa.navigate({ id: `v${base.version}-terminal-held` });
    await qa.holdInputResults(true);
    const tap = [
      { at: 0, type: 'touchStart', points: [{ x: 120, y: 110 }] },
      { at: 60, type: 'touchEnd', points: [] },
    ];
    await qa.trajectory(tap, { settleMs: 100 });
    let e = await qa.sample(`v${base.version}-terminal-held-before`);
    const first = e.data.sent.map(unwrap).find((p) => p.type === 'touch' && p.action === 'start')?.sequenceId;
    assert(first, 'First held sequence missing');
    await qa.trajectory(tap, { settleMs: 100 });
    e = await qa.sample(`v${base.version}-terminal-held-newdown`);
    assert(
      e.data.sent
        .map(unwrap)
        .some((p) => p.type === 'touch' && p.action === 'start' && p.sequenceId !== first),
      'New sequence blocked by held input results',
    );
    await qa.releaseInputResults();
    await base.page.waitForTimeout(100);
    await qa.trajectory(tap, { settleMs: 200 });
    e = await qa.sample(`v${base.version}-terminal-held-released`);
    assert(
      e.data.sent
        .map(unwrap)
        .some((p) => p.type === 'touch' && p.action === 'start' && p.sequenceId !== first),
      'New sequence failed after late input results',
    );
    output.push(e.summary);
    await qa.navigate({ id: `v${base.version}-momentum-cancel` });
    await qa.swipe({ settleMs: 80 });
    await qa.trajectory(tap, { settleMs: 400 });
    e = await qa.sample(`v${base.version}-momentum-cancel`);
    const packets = e.data.sent.map(unwrap).filter((p) => ['touch', 'gesture'].includes(p.type)),
      starts = packets.filter((p) => p.type === 'touch' && p.action === 'start');
    assert(starts.length === 2, 'New physical down sequence missing');
    const newAt = packets.indexOf(starts[1]);
    assert(
      packets
        .slice(0, newAt)
        .some((p) => p.type === 'gesture' && p.action === 'cancel' && p.sequenceId === starts[0].sequenceId),
      'New down did not cancel old momentum first',
    );
    output.push(e.summary);
    await qa.navigate({ id: `v${base.version}-cancel` });
    await qa.trajectory(
      [
        { at: 0, type: 'touchStart', points: [{ x: 120, y: 600 }] },
        { at: 40, type: 'touchMove', points: [{ x: 120, y: 560 }] },
        { at: 70, type: 'touchCancel', points: [] },
      ],
      { settleMs: 300 },
    );
    e = await qa.sample(`v${base.version}-cancel`);
    assert(
      e.data.sent.map(unwrap).some((p) => p.type === 'touch' && p.action === 'cancel'),
      'CDP cancel failed to reach Client touch cancellation',
    );
    output.push(e.summary);
    await qa.navigate({ id: `v${base.version}-raf-pause` });
    await qa.swipe({ settleMs: 0 });
    await qa.pauseRaf();
    await base.page.waitForTimeout(2600);
    await qa.resumeRaf();
    await base.page.waitForTimeout(400);
    e = await qa.sample(`v${base.version}-raf-pause`);
    assert(
      e.summary.momentum.every((m) => m.elapsed <= 2200000),
      'Background rAF produced unbounded elapsed momentum',
    );
    const count = e.summary.momentum.length;
    await base.page.waitForTimeout(400);
    const tail = await qa.sample(`v${base.version}-raf-pause-tail`);
    assert(
      tail.summary.momentum.length === count,
      'Momentum kept running after paused curve should have ended',
    );
    output.push(tail.summary);
    return output;
  };
  qa.close = () => base.close();
  return {
    prepared: true,
    started: false,
    launch:
      'host._clientGestureQA.launch({ready:true,gpuGranted:true,version:89|157,run:absolutePath,password:disposablePassword})',
    methods: Object.keys(qa),
  };
}

async function prepareRetirement(host) {
  const qa = host._clientGestureQA;
  const base = qa.base;
  const assert = (value, message) => {
    if (!value) throw Error(message);
  };
  const root = (e) => e.common.fixture.telemetry[e.case + ':root'];
  const quickTap = () =>
    qa.trajectory(
      [
        { at: 0, type: 'touchStart', points: [{ x: 120, y: 110 }] },
        { at: 40, type: 'touchEnd', points: [] },
      ],
      { settleMs: 80 },
    );
  const ready = async () => {
    await base.ready();
    await base.page.waitForFunction((id) => !!robustQA.transport().presentation.canInput(id), qa.viewId);
  };
  const recover = async (id, clicks) => {
    await ready();
    await quickTap();
    for (let attempt = 0; attempt < 100; ++attempt) {
      const fixture = await base.inspect();
      if ((fixture.telemetry[qa.case + ':root']?.clicks ?? 0) >= clicks) break;
      await base.page.waitForTimeout(50);
    }
    const tap = await qa.sample(id + '-tap');
    assert(root(tap).clicks === clicks, 'Recovery tap missing or duplicated');
    const before = root(tap).positions.rootY;
    await qa.swipe();
    const scroll = await qa.sample(id + '-scroll');
    assert(root(scroll).positions.rootY > before + 100, 'Recovery scroll did not advance');
    assert(root(scroll).clicks === clicks, 'Scroll generated an extra click');
    assert(
      scroll.data.sent.every(({ message }) => !message.type.startsWith('input.')),
      'Touch sent an auxiliary control message',
    );
    return [tap.summary, scroll.summary];
  };
  const cases = (host._retirementQA = {});
  cases.rapidSuccessive = async () => {
    const id = `v${base.version}-successive-${Date.now()}`;
    await qa.navigate({ id });
    await qa.holdInputResults(true);
    for (let i = 0; i < 6; ++i) await quickTap();
    await base.page.waitForTimeout(400);
    const held = await qa.sample(id + '-held');
    assert(root(held).clicks === 6, 'Held input results blocked or duplicated taps');
    const starts = held.data.sent.filter(
      ({ message }) => message.event?.type === 'touch' && message.event.action === 'start',
    );
    assert(
      starts.length === 6 && new Set(starts.map(({ message }) => message.event.sequenceId)).size === 6,
      'Successive touches did not get distinct sequences',
    );
    await qa.releaseInputResults();
    await base.page.waitForTimeout(300);
    const late = await qa.sample(id + '-late');
    assert(root(late).clicks === 6, 'Late results replayed a click');
    return [held.summary, late.summary, ...(await recover(id, 7))];
  };
  cases.activeContacts = async () => {
    const id = `v${base.version}-supersede-active-${Date.now()}`;
    await qa.navigate({ id });
    await base.page.evaluate(() => {
      clientGestureQA.dropNextEnd = true;
    });
    await quickTap();
    await base.page.waitForTimeout(200);
    const abandoned = await qa.sample(id + '-abandoned');
    assert(root(abandoned).clicks === 0, 'Abandoned start generated a click');
    await quickTap();
    await base.page.waitForTimeout(300);
    const replaced = await qa.sample(id + '-replaced');
    assert(root(replaced).counts.touchcancel === 1, 'Superseding did not emit exactly one raw cancel');
    assert(root(replaced).clicks === 1, 'New start failed or duplicated the abandoned tap');
    return [replaced.summary, ...(await recover(id, 2))];
  };
  cases.pendingTerminal = async () => {
    const id = `v${base.version}-pending-terminal-${Date.now()}`;
    // Keep both terminals pending within the ACK deadline. Timeout recovery is
    // exercised separately below; it deliberately stops gesture arbitration.
    await qa.navigate({ id, block: 'ackpending' });
    await qa.trajectory(
      [
        { at: 0, type: 'touchStart', points: [{ x: 120, y: 110 }] },
        { at: 50, type: 'touchEnd', points: [] },
      ],
      { settleMs: 0 },
    );
    await quickTap();
    await base.page.waitForTimeout(1800);
    const replaced = await qa.sample(id + '-replaced');
    assert(!root(replaced).counts.touchcancel, 'Queued terminal received an extra cancel');
    assert(root(replaced).clicks === 2, 'Queued terminal or successive tap failed or duplicated');
    return [replaced.summary, ...(await recover(id, 3))];
  };
  cases.rawAckTimeout = async () => {
    const id = `v${base.version}-ack-timeout-${Date.now()}`;
    await qa.navigate({ id, block: 'ackdelay' });
    await qa.touch('touchStart', [{ x: 820, y: 110 }]);
    await base.page.evaluate(() => clientGestureQA.tail);
    await base.page.waitForTimeout(2300);
    await base.page.evaluate(() => {
      clientGestureQA.dropNextEnd = true;
    });
    await qa.touch('touchEnd', []);
    await base.page.evaluate(() => clientGestureQA.tail);
    const result = await recover(id, 1);
    const recovered = await qa.sample(id + '-recovered');
    const longPress = recovered.data.sent.find(
      ({ message }) => message.event?.type === 'gesture' && message.event.action === 'longPress',
    );
    assert(
      longPress &&
        recovered.data.received.some(
          ({ message }) =>
            message.type === 'input.result' &&
            message.ok &&
            String(message.clientSequence) === String(longPress.message.sequence),
        ),
      'Timeout recovery did not exercise an admitted long press',
    );
    assert(root(recovered).counts.touchcancel === 1, 'Timeout recovery did not cancel exactly once');
    return [...result, recovered.summary];
  };
  cases.layout = async () => {
    const id = `v${base.version}-resize-gesture-${Date.now()}`;
    await qa.navigate({ id });
    await qa.trajectory(
      [
        { at: 0, type: 'touchStart', points: [{ x: 120, y: 650 }] },
        { at: 40, type: 'touchMove', points: [{ x: 120, y: 610 }] },
      ],
      { settleMs: 100 },
    );
    const size = base.page.viewportSize();
    const oldEpoch = await base.page.evaluate(() => robustQA.transport().presentation.layout.epoch);
    await base.page.setViewportSize({ width: size.width + 37, height: size.height });
    await base.page.waitForFunction(
      (old) => robustQA.transport().presentation.layout.epoch !== old,
      oldEpoch,
    );
    await ready();
    await qa.touch('touchEnd', []);
    const result = await recover(id, 1);
    await base.page.setViewportSize(size);
    await ready();
    return result;
  };
  cases.targetloss = async () => {
    const id = `v${base.version}-target-removal-${Date.now()}`;
    await qa.navigate({ id, live: true });
    await qa.trajectory(
      [
        { at: 0, type: 'touchStart', points: [{ x: 400, y: 500 }] },
        { at: 40, type: 'touchMove', points: [{ x: 400, y: 470 }] },
        { at: 80, type: 'touchMove', points: [{ x: 400, y: 440 }] },
      ],
      { settleMs: 200 },
    );
    const before = await qa.sample(id + '-before');
    assert(
      before.common.fixture.telemetry[id + ':child']?.counts.touchstart,
      'Child did not own raw touch before removal',
    );
    const response = await base.page.request.post(`http://127.0.0.1:${base.fixturePort}/command?id=${id}`, {
      data: { type: 'remove-child' },
    });
    assert(response.ok(), 'Target removal command failed');
    let removed = false;
    for (let i = 0; i < 40; ++i) {
      if (
        (await base.inspect()).telemetry[id + ':root']?.events.some((e) => e.type === 'fixture-remove-child')
      ) {
        removed = true;
        break;
      }
      await base.page.waitForTimeout(50);
    }
    assert(removed, 'Target removal was not observed');
    await qa.touch('touchMove', [{ x: 400, y: 420 }]);
    await qa.touch('touchEnd', []);
    await base.page.waitForTimeout(300);
    const removedState = await qa.sample(id + '-removed');
    assert(
      !root(removedState).counts.touchstart && !root(removedState).counts.touchmove,
      'Old coordinates reached the replacement target',
    );
    return recover(id, 1);
  };
  cases.document = async () => {
    const id = `v${base.version}-document-gesture-${Date.now()}`;
    await qa.navigate({ id: id + '-old' });
    await qa.touch('touchStart', [{ x: 120, y: 650 }]);
    await qa.navigate({ id: id + '-new' });
    await qa.touch('touchEnd', []);
    return recover(id, 1);
  };
  return { prepared: true, cases: Object.keys(cases) };
}
