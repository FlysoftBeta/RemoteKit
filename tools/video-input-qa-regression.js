// Run after video-input-qa-browser.js through the host-managed Playwright tool.
async (host) => {
  const q = host._videoInputQA;
  q.regression = async (tag) => {
    const p = q.page,
      results = [];
    const inspect = async () => await (await p.request.get('http://127.0.0.1:33372/inspect')).json();
    const sample = async (name) => {
      const s = await q.sample(tag + '-' + name),
        i = await inspect();
      const r = {
        name,
        peerCount: s.peerCount,
        connectionId: s.connectionId,
        planes: s.planes.map((v) => ({
          view: v.viewId,
          video: v.videoId,
          stream: v.streamId,
          ready: v.ready,
          track: v.trackIds,
          canvas: v.canvas,
        })),
        inbound: s.stats
          .filter((v) => v.type === 'inbound-rtp')
          .map((v) => ({ id: v.id, kind: v.kind ?? v.mediaType, track: v.trackIdentifier })),
        trace: s.inputTrace.slice(-35),
        events: i.events.slice(-15),
      };
      results.push(r);
      return s;
    };
    const navigate = async (label = 'A') => {
      await p.evaluate((label) => {
        const tab = videoInputQA.state.workspace.tabs.find((t) => t.url.includes('label=' + label));
        return videoInputQA.rpc('action', {
          type: 'tab.navigate',
          tabId: tab.id,
          url: 'http://127.0.0.1:33372/?label=' + label + '&case=' + Date.now(),
        });
      }, label);
      await q.ready();
      await p.waitForTimeout(150);
    };
    const point = async (view, x, y) =>
      await p.evaluate(
        ({ view, x, y }) => {
          const [r] = [...videoInputQA.transport().videoPlanes].find(([r]) => r.view.id === view),
            b = r.canvas.getBoundingClientRect();
          return { x: b.x + x, y: b.y + y };
        },
        { view, x, y },
      );
    // CDP mouse injection avoids Chrome89's unsupported Input.setInterceptDrags.
    const cdp = await q.context.newCDPSession(p);
    const drag = async (from, to) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from, button: 'none', buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...from,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await p.waitForTimeout(100);
      for (let n = 1; n <= 20; n++) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + ((to.x - from.x) * n) / 20,
          y: from.y + ((to.y - from.y) * n) / 20,
          button: 'left',
          buttons: 1,
        });
        await p.waitForTimeout(12);
      }
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...to,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await p.waitForTimeout(400);
    };
    await navigate();
    let s = await sample('navigation');
    const a = s.planes[0].viewId;
    await p.evaluate(() => {
      const t = videoInputQA.transport();
      t.focus(t.layout.views[0], false);
    });
    await p.waitForTimeout(100);
    let unfocused = await point(a, 450, 570);
    await p.mouse.move(unfocused.x, unfocused.y);
    await p.mouse.wheel(0, 360);
    await p.waitForTimeout(500);
    await sample('before-focus-wheel');
    await navigate();
    await q.click(a, 120, 97);
    await p.waitForTimeout(300);
    s = await sample('focus');
    let pos = await point(a, 450, 570);
    await p.mouse.move(pos.x, pos.y);
    await p.mouse.wheel(0, 480);
    await p.waitForTimeout(500);
    await sample('page-wheel');
    for (let i = 0; i < 3; i++) {
      await p.mouse.wheel(0, 120);
      await p.waitForTimeout(80);
    }
    await p.waitForTimeout(650);
    await sample('page-wheel-burst');
    await p.mouse.wheel(0, 90);
    await p.waitForTimeout(650);
    await sample('page-wheel-after-idle');
    await navigate();
    await q.click(a, 120, 97);
    await p.waitForTimeout(150);
    pos = await point(a, 300, 200);
    await p.mouse.move(pos.x, pos.y);
    await p.mouse.wheel(0, 300);
    await p.waitForTimeout(500);
    s = await sample('nested-wheel');
    await navigate();
    await q.click(a, 120, 97);
    await p.waitForTimeout(150);
    s = await sample('pre-page-drag');
    const width = s.planes[0].canvas.width;
    await drag(await point(a, width - 7, 54), await point(a, width - 7, 430));
    await sample('page-scrollbar');
    await navigate();
    await q.click(a, 120, 97);
    await p.waitForTimeout(150);
    s = await sample('pre-nested-drag');
    const nx = 24 + (Math.round(width) - 15 - 48) * 0.75 - 12;
    await drag(await point(a, nx, 151), await point(a, nx, 280));
    await sample('nested-scrollbar');
    if (s.planes.length < 2) {
      await p.evaluate(() =>
        videoInputQA.rpc('action', { type: 'window.create', url: 'http://127.0.0.1:33372/?label=B' }),
      );
      await q.ready();
    }
    s = await sample('pre-cross-focus');
    const b = s.planes[1].viewId;
    await q.click(b, 120, 97);
    await p.waitForTimeout(250);
    await sample('focus-b');
    pos = await point(b, 450, 570);
    await p.mouse.move(pos.x, pos.y);
    await p.mouse.wheel(0, 240);
    await p.waitForTimeout(450);
    await sample('cross-b-wheel');
    await q.click(a, 120, 97);
    await p.waitForTimeout(250);
    await sample('focus-a');
    pos = await point(a, 450, 570);
    await p.mouse.move(pos.x, pos.y);
    await p.mouse.wheel(0, 240);
    await p.waitForTimeout(450);
    await sample('cross-a-wheel');
    await p.setViewportSize({ width: 1100, height: 760 });
    await q.ready();
    await navigate();
    s = await sample('resized');
    pos = await point(a, 400, 520);
    await p.mouse.move(pos.x, pos.y);
    await p.mouse.wheel(0, 200);
    await p.waitForTimeout(450);
    await sample('resized-wheel');
    await p.reload();
    await q.ready();
    await navigate();
    s = await sample('reconnected');
    pos = await point(a, 400, 520);
    await p.mouse.move(pos.x, pos.y);
    await p.mouse.wheel(0, 200);
    await p.waitForTimeout(450);
    await sample('reconnected-wheel');
    await p.evaluate(() => {
      const q = videoInputQA;
      q.oldSurface = { ...q.transport().layout.views[0] };
      q.holdAck = true;
    });
    await p.evaluate(() => {
      const tab = videoInputQA.state.workspace.tabs[0];
      return videoInputQA.rpc('action', {
        type: 'tab.navigate',
        tabId: tab.id,
        url: 'http://127.0.0.1:33372/?label=A&gate=' + Date.now(),
      });
    });
    await p.waitForTimeout(350);
    const gate = await p.evaluate(() => {
      const q = videoInputQA,
        t = q.transport();
      return {
        accepted: t.sendInput(q.oldSurface, { type: 'wheel', x: 450, y: 500, dx: 0, dy: -120, modifiers: 0 }),
        held: q.heldAcks.length,
        ready: [...t.videoPlanes.values()].map((p) => p.ready),
        trace: t.inputTrace.slice(-3),
      };
    });
    await sample('old-epoch-gate');
    await p.evaluate(() => {
      const q = videoInputQA;
      q.holdAck = false;
      for (const ack of q.heldAcks) q.channels[q.channels.length - 1].qaRawSend(ack);
      q.heldAcks = [];
    });
    await q.ready();
    await sample('epoch-restored');
    results.push({ name: 'gate-result', ...gate });
    await cdp.detach();
    return results;
  };
  return { prepared: true, invoke: 'await host._videoInputQA.regression(tag)' };
};
