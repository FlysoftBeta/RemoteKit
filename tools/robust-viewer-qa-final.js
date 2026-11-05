// Supplementary bounded final QA helpers. Load only through host-managed Playwright.
// Loading this file does not start a browser, service, or product operation.
async (host) => {
  const qa = host._robustViewerQA;
  if (!qa) throw Error('Load robust-viewer-qa-browser.js first');
  const assert = (condition, message) => {
    if (!condition) throw Error(message);
  };
  qa.final = {};
  const f = qa.final;
  f.state = () => qa.page.evaluate(() => robustQA.state);
  f.navigate = async (url, index = 'last') => {
    await qa.uiFill({ css: 'input[aria-label="搜索或输入网址"]', index }, url);
    await qa.page.keyboard.press('Enter');
  };
  f.media = () =>
    qa.page.evaluate(() => {
      const q = robustQA,
        t = q.transport();
      return {
        peer: q.id(t.peer),
        connectionId: t.connectionId,
        peerCount: q.peers.length,
        backend: t.getPresentationDiagnostics().rendering.backend,
        draws: q.draws,
        mstp: q.mstp,
        freezeCopies: t.getPresentationDiagnostics().rendering.freezeCopies,
        freezeNodes: document.querySelectorAll('.remote-resize-freeze').length,
        planes: [...t.videoPlanes].map(([r, p]) => ({
          viewId: r.view.id,
          current: t.rendererCurrent(r),
          video: q.id(p.video),
          stream: q.id(p.video.srcObject),
          tracks: p.video.srcObject?.getTracks().map((t) => t.id),
          ready: p.ready,
          controls: p.video.controls,
          pip: p.video.disablePictureInPicture,
          remote: p.video.disableRemotePlayback,
          inline: p.video.playsInline,
        })),
      };
    });
  f.defaultVideo = async (name) => {
    await qa.page.waitForFunction(
      () => {
        const t = robustQA.transport(),
          current = [...t.videoPlanes].filter(([r]) => t.rendererCurrent(r));
        return (
          t.channel?.readyState === 'open' &&
          t.peer?.connectionState === 'connected' &&
          current.length > 0 &&
          current.every(([, p]) => p.ready)
        );
      },
      null,
      { timeout: 10000 },
    );
    const before = await f.media();
    await qa.page.waitForTimeout(600);
    const after = await f.media(),
      current = after.planes.filter((p) => p.current);
    assert(after.backend === 'video', name + ': backend ' + after.backend);
    assert(after.mstp === 0, name + ': MSTP started');
    assert(after.draws === before.draws, name + ': steady drawImage');
    assert(
      current.length > 0 && current.every((p) => p.ready && !p.controls && p.pip && p.remote && p.inline),
      name + ': media plane capabilities/readiness',
    );
    return { before, after };
  };
  f.sameMedia = (before, after, { samePlanes = true } = {}) => {
    assert(
      before.peer === after.peer &&
        before.connectionId === after.connectionId &&
        before.peerCount === after.peerCount,
      'RTC identity changed',
    );
    if (samePlanes)
      assert(
        JSON.stringify(before.planes.map((p) => [p.viewId, p.video, p.stream, p.tracks])) ===
          JSON.stringify(after.planes.map((p) => [p.viewId, p.video, p.stream, p.tracks])),
        'Video/stream/track identity changed',
      );
  };
  f.noBanner = async () => {
    const text = await qa.page.evaluate(() => document.body.innerText);
    assert(
      !text.includes("reading 'workspace'") && !text.includes('Cannot read properties'),
      'Workspace error banner',
    );
    return true;
  };
  f.audio = () =>
    qa.page.evaluate(() => {
      const q = robustQA,
        t = q.transport(),
        a = t.audio,
        c = a.context;
      if (!c) throw Error('No actual Viewer audio context');
      if (!q.finalAudio || q.finalAudio.context !== c) {
        const merge = a.nodes.find((n) => n instanceof ChannelMergerNode);
        if (!merge) throw Error('No post-gate stereo merger');
        const sp = c.createScriptProcessor(1024, 2, 2),
          blocks = [],
          split = c.createChannelSplitter(2),
          analysers = [c.createAnalyser(), c.createAnalyser()];
        merge.connect(split);
        analysers.forEach((node, i) => {
          node.fftSize = 2048;
          split.connect(node, i);
        });
        merge.connect(sp);
        sp.connect(c.destination);
        sp.onaudioprocess = (e) => {
          blocks.push({
            at: performance.now(),
            rms: [0, 1].map((i) => {
              const d = e.inputBuffer.getChannelData(i);
              let sum = 0;
              for (const v of d) sum += v * v;
              return Math.sqrt(sum / d.length);
            }),
          });
          if (blocks.length > 60) blocks.shift();
          for (let i = 0; i < 2; i++) e.outputBuffer.getChannelData(i).fill(0);
        };
        q.finalAudio = { context: c, sp, blocks, analysers };
      }
      const s = q.finalAudio;
      return {
        context: c.state,
        channels: q.state.workspace.settings.audioChannels,
        blocks: s.blocks.slice(-8),
        tones: s.analysers.map((node) => {
          const bins = new Float32Array(node.frequencyBinCount);
          node.getFloatFrequencyData(bins);
          let peak = 0;
          for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
          return (peak * c.sampleRate) / node.fftSize;
        }),
      };
    });
  // Simulates visualViewport geometry only. This is not a physical soft keyboard.
  f.keyboardViewport = async (height) =>
    qa.page.evaluate((height) => {
      const vv = visualViewport;
      if (!vv) throw Error('visualViewport unavailable');
      if (!robustQA.originalVV)
        robustQA.originalVV = { height: Object.getOwnPropertyDescriptor(vv, 'height') };
      if (height === null) {
        const original = robustQA.originalVV.height;
        if (original) Object.defineProperty(vv, 'height', original);
        else delete vv.height;
      } else Object.defineProperty(vv, 'height', { configurable: true, get: () => height });
      vv.dispatchEvent(new Event('resize'));
      return { height: vv.height, innerHeight };
    }, height);
  f.composition = async (type, data) =>
    qa.page.evaluate(
      ({ type, data }) => {
        const editor = document.activeElement;
        if (!editor?.matches('.remote-viewport textarea')) throw Error('No focused actual remote editor');
        editor.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
        return { type, data };
      },
      { type, data },
    );
  f.remoteEvents = async (label, type) => {
    const data = await qa.inspect();
    return data.events.filter((e) => (!label || e.label === label) && (!type || e.type === type));
  };
  f.save = async (name, data) => {
    const response = await qa.page.request.post('http://127.0.0.1:' + qa.port + '/api/metrics', {
      headers: { Origin: 'http://127.0.0.1:' + qa.port },
      data: { kind: 'robust-final', name, version: qa.version, ...data },
    });
    assert(response.ok(), 'Final evidence save ' + response.status());
    return { name, ...data };
  };
  return { prepared: true, started: false, helpers: Object.keys(f) };
};
