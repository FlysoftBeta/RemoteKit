import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startStack } from './input-stack.mjs';
import { launch } from './kit/viewer.mjs';

export async function keyboardOcclusion(kind) {
  const [playwright, viewer, endpoint, browser, output, , , geometry] = process.argv.slice(2);
  if (playwright) process.env.REMOTEKIT_PLAYWRIGHT = resolve(playwright);
  const browserName = /chrome89/i.test(viewer ?? '') ? 'chrome89' : 'edge';
  const mode = geometry ?? (browserName === 'chrome89' ? 'content' : 'visual');
  const run = resolve(output ?? `develop/tmp/occlusion/${kind}-${browserName}-${Date.now()}`);
  await mkdir(run, { recursive: true });
  const events = [];
  const fixture = createServer(async (request, response) => {
    if (request.method === 'POST') {
      let bytes = '';
      for await (const part of request) bytes += part;
      events.push(JSON.parse(bytes));
      return response.end();
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Occlusion</title><style>html,body{margin:0;width:100%;height:100%;background:rgb(40,90,160);overflow:hidden}
      input{position:absolute;left:24px;top:24px;width:260px;height:48px;font-size:20px}
      #footer{position:fixed;bottom:0;height:12px;left:0;right:0;background:rgb(220,20,180)}
      #motion{position:absolute;top:210px;width:8px;height:8px;background:#0f0}</style>
      <input id="text"><div id="footer"></div><div id="motion"></div><script>
      const report=type=>fetch('/event',{method:'POST',body:JSON.stringify({type,path:location.pathname,height:innerHeight,visualHeight:visualViewport.height,width:innerWidth,value:text.value,focused:document.activeElement===text,at:performance.now()})});
      for(const type of ['focus','blur','input','compositionstart','compositionend'])text.addEventListener(type,()=>report(type));
      document.addEventListener('pointerdown',e=>fetch('/event',{method:'POST',body:JSON.stringify({type:'pointer',x:e.clientX,y:e.clientY,path:location.pathname})}));
      window.addEventListener('resize',()=>report('resize'));report('ready');
      function animate(t){motion.style.left=(t/10%120)+'px';requestAnimationFrame(animate)}requestAnimationFrame(animate);
      </script>`);
  });
  await new Promise((done) => fixture.listen(Number(process.argv[7]), '127.0.0.1', done));
  const url = `http://127.0.0.1:${fixture.address().port}/page`;
  let stack, session;
  const results = [];
  const normalChanges = [];
  try {
    stack = await startStack({
      scenario: `keyboard-${kind}`,
      run,
      browser,
      endpoint,
      media: { gop: 65535 },
    });
    session = await launch({
      browser: browserName,
      dpr: 2,
      pointer: 'touch',
      stack,
      out: join(run, 'shots'),
    });
    const { page, context } = session;
    await page.setViewportSize({ width: 1100, height: 1040 });
    await context.addInitScript(
      ({ mode }) => {
        const vv = visualViewport;
        const naturalHeight = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height').get;
        const q = (window.occlusionQA = {
          mode,
          height: null,
          offset: 0,
          armed: false,
          wire: [],
          frames: [],
          videos: [],
          measuring: false,
          geometries: [],
        });
        Object.defineProperty(vv, 'height', { get: () => q.height ?? naturalHeight.call(vv) });
        Object.defineProperty(vv, 'offsetTop', { get: () => q.offset });
        if (mode === 'content') {
          const getter = Object.getOwnPropertyDescriptor(window, 'innerHeight')?.get;
          Object.defineProperty(window, 'innerHeight', {
            get: () => q.height ?? (getter ? getter.call(window) : document.documentElement.clientHeight),
          });
        }
        q.resize = (height) => {
          q.geometries.push({ at: performance.now(), height });
          q.height = height;
          if (mode === 'content') window.dispatchEvent(new Event('resize'));
          vv.dispatchEvent(new Event('resize'));
        };
        q.feedback = () => {
          if (!q.armed) return;
          clearTimeout(q.timer);
          q.timer = setTimeout(() => {
            const editor = document.activeElement;
            const open = editor?.matches('.remote-input') && editor.inputMode !== 'none';
            q.resize(open ? naturalHeight.call(vv) - 360 : null);
          }, 80);
        };
        document.addEventListener('focusin', q.feedback, true);
        document.addEventListener('focusout', q.feedback, true);
        new MutationObserver(q.feedback).observe(document, {
          subtree: true,
          attributes: true,
          attributeFilter: ['inputmode'],
        });
        const nativePeer = RTCPeerConnection;
        window.RTCPeerConnection = class extends nativePeer {
          createDataChannel(...args) {
            const channel = super.createDataChannel(...args);
            const send = channel.send.bind(channel);
            channel.send = (raw) => {
              try {
                q.wire.push({ at: performance.now(), direction: 'out', message: JSON.parse(raw) });
              } catch {}
              return send(raw);
            };
            channel.addEventListener('message', (event) => {
              try {
                q.wire.push({ at: performance.now(), direction: 'in', message: JSON.parse(event.data) });
              } catch {}
            });
            return channel;
          }
        };
        const nativeFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
        HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
          if (!q.videos.includes(this)) q.videos.push(this);
          return nativeFrame.call(this, (now, metadata) => {
            if (q.measuring) {
              const layout = [...q.wire].reverse().find((entry) => entry.message.type === 'layout')?.message;
              const viewId = this.closest('.remote-viewport')?.dataset.viewId;
              const view = layout?.views.find((item) => item.id === viewId);
              const ack = [...q.wire]
                .reverse()
                .find(
                  (entry) => entry.message.type === 'view.viewport' && entry.message.viewId === viewId,
                )?.message;
              let correct = false;
              let white = false;
              if (view && ack && layout.generation === ack.outputGeneration) {
                const scaleY = view.deviceScaleFactor * (view.mediaScaleY ?? view.mediaScale ?? 1);
                const stableHeight = Math.round(view.height / scaleY);
                const stableWidth = Math.round(
                  view.width / (view.deviceScaleFactor * (view.mediaScaleX ?? view.mediaScale ?? 1)),
                );
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                const at = (x, y) => {
                  ctx.drawImage(
                    this,
                    view.x + (x * view.width) / stableWidth,
                    view.y + (y * view.height) / stableHeight,
                    1,
                    1,
                    0,
                    0,
                    1,
                    1,
                  );
                  return [...ctx.getImageData(0, 0, 1, 1).data];
                };
                const footer = at(stableWidth / 2, ack.pageHeight - 6);
                const footerCorrect = footer[0] > 170 && footer[1] < 70 && footer[2] > 120;
                white =
                  ack.pageHeight >= stableHeight - 2 ||
                  [0.2, 0.5, 0.8].every((f) => {
                    const pixel = at(stableWidth * f, ack.pageHeight + (stableHeight - ack.pageHeight) * 0.6);
                    return pixel.slice(0, 3).every((value) => value > 235);
                  });
                correct = footerCorrect && white;
              }
              q.frames.push({
                at: performance.now(),
                rtp: metadata.rtpTimestamp,
                viewId,
                pageHeight: ack?.pageHeight,
                revision: ack?.occlusionRevision,
                correct,
                white,
              });
            }
            callback(now, metadata);
          });
        };
      },
      { mode },
    );
    await page.reload();
    await page.waitForFunction(() => window.__remotekitTest);
    await session.unlock();
    await page.waitForFunction(() => window.__remotekitTest.state());
    await session.openStart();
    await session.tile('\u6d4f\u89c8\u5668').click();
    await session.navigate(url);
    const ready = async () => {
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.remote-viewport')].some(
            (node) =>
              node.querySelector('canvas[data-video-input]:not(.no-frame)') &&
              !node.classList.contains('resize-waiting'),
          ),
        undefined,
        { timeout: 30000 },
      );
    };
    await ready();
    await page.waitForTimeout(2000);
    const initial = await page.evaluate(() => {
      const layout = [...occlusionQA.wire]
        .reverse()
        .find((entry) => entry.message.type === 'layout')?.message;
      return { layout, box: document.querySelector('.remote-viewport').getBoundingClientRect().toJSON() };
    });
    async function measure(label, action, pageHeight) {
      const before = await page.evaluate(() => {
        occlusionQA.measuring = true;
        const layout = [...occlusionQA.wire]
          .reverse()
          .find((entry) => entry.message.type === 'layout')?.message;
        return {
          at: performance.now(),
          wire: occlusionQA.wire.length,
          frames: occlusionQA.frames.length,
          layout,
        };
      });
      await action();
      await page.waitForFunction(
        ({ start, height }) =>
          occlusionQA.frames
            .slice(start)
            .some((frame) => frame.correct && Math.abs(frame.pageHeight - height) <= 1),
        { start: before.frames, height: pageHeight },
        { timeout: 45000 },
      );
      const sample = await page.evaluate(
        ({ before, pageHeight }) => {
          const frames = occlusionQA.frames.slice(before.frames);
          const frame = frames.find((frame) => frame.correct && Math.abs(frame.pageHeight - pageHeight) <= 1);
          const geometryAt = occlusionQA.geometries.find((event) => event.at >= before.at)?.at ?? before.at;
          const wire = occlusionQA.wire
            .slice(before.wire)
            .filter((entry) => entry.at >= geometryAt && entry.at <= frame.at);
          return {
            frame,
            latencyMs:
              frame.at - (occlusionQA.geometries.find((event) => event.at >= before.at)?.at ?? before.at),
            layouts: wire.filter((e) => e.message.type === 'layout'),
            barriers: wire.filter((e) => e.message.type === 'presentation.prepare'),
            keyframes: wire.filter((e) => e.message.type === 'frame' && e.message.keyframe),
            waiting: !!document.querySelector('.resize-waiting'),
            frozen: !!document.querySelector('.remote-resize-freeze'),
            box: document.querySelector('.remote-viewport').getBoundingClientRect().toJSON(),
            layout: [...occlusionQA.wire].reverse().find((entry) => entry.message.type === 'layout')?.message,
          };
        },
        { before, pageHeight },
      );
      await page.evaluate(() => {
        occlusionQA.measuring = false;
      });
      assert.equal(sample.layouts.length, 0, label + ' sent layout');
      assert.equal(sample.barriers.length, 0, label + ' started barrier');
      assert.equal(sample.keyframes.length, 0, label + ' sent keyframe');
      assert.equal(sample.layout.generation, before.layout.generation, label + ' changed generation');
      assert.equal(sample.layout.epoch, before.layout.epoch, label + ' changed epoch');
      assert.equal(sample.waiting, false);
      assert.equal(sample.frozen, false);
      assert.ok(Math.abs(sample.box.height - initial.box.height) < 1);
      assert.ok(
        events.some((event) => event.type === 'resize' && Math.abs(event.height - pageHeight) <= 1),
        'remote height did not follow occlusion',
      );
      results.push({ label, ...sample });
      await writeFile(
        join(run, 'results.json'),
        JSON.stringify({ browser: browserName, mode, results, events }, null, 2),
      );
      return sample;
    }
    const stableHeight = Math.round(initial.box.height);
    await page.evaluate(() => {
      occlusionQA.armed = true;
    });
    const viewport = page.locator('.remote-viewport').first();
    const box = await viewport.boundingBox();
    await measure(
      'open',
      async () => {
        await session.pointer.move(box.x + 150, box.y + 48);
        await session.pointer.down();
        await session.pointer.up();
      },
      stableHeight - 360,
    );
    const inputPoint = events.filter((event) => event.type === 'pointer').at(-1);
    assert.ok(
      Math.abs(inputPoint.x - 150) <= 1 && Math.abs(inputPoint.y - 48) <= 1,
      'input above keyboard changed scale',
    );
    const pointerEvents = events.filter((event) => event.type === 'pointer').length;
    await session.pointer.move(box.x + 400, box.y + stableHeight - 50);
    await session.pointer.down();
    await session.pointer.up();
    await page.waitForTimeout(100);
    assert.equal(
      events.filter((event) => event.type === 'pointer').length,
      pointerEvents,
      'blank-band input reached the page',
    );
    await page.keyboard.insertText('stable');
    await page.waitForTimeout(200);
    assert.ok(events.some((event) => event.value === 'stable'));
    await measure(
      'candidate-panel',
      () => page.evaluate(() => occlusionQA.resize(600)),
      stableHeight - (1040 - 600),
    );
    await measure('minimum-page-height', () => page.evaluate(() => occlusionQA.resize(100)), 120);
    const beforePan = await page.evaluate(() => occlusionQA.wire.length);
    await page.evaluate(() => {
      occlusionQA.offset = 24;
      visualViewport.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(180);
    assert.equal(
      await page.evaluate(
        (start) => occlusionQA.wire.slice(start).filter((entry) => entry.message.type === 'layout').length,
        beforePan,
      ),
      0,
    );
    await page.evaluate(() => {
      occlusionQA.offset = 0;
      visualViewport.dispatchEvent(new Event('scroll'));
      occlusionQA.armed = false;
    });
    await measure('close', () => page.evaluate(() => occlusionQA.resize(null)), stableHeight);
    if (kind === 'recovery') {
      await page.evaluate(() => {
        occlusionQA.armed = true;
      });
      await measure(
        'reopen',
        async () => {
          await session.pointer.move(box.x + 150, box.y + 48);
          await session.pointer.down();
          await session.pointer.up();
        },
        stableHeight - 360,
      );
      const cdp = await context.newCDPSession(page);
      if (browserName === 'edge') {
        await cdp.send('Input.imeSetComposition', { text: '\u4f60', selectionStart: 1, selectionEnd: 1 });
        await cdp.send('Input.insertText', { text: '\u4f60' });
      } else await page.keyboard.insertText('!');
      await page.waitForTimeout(250);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      assert.equal(await page.evaluate(() => document.activeElement?.matches('.remote-input')), true);
      assert.ok(
        events.some((event) => event.value === (browserName === 'edge' ? 'stable\u4f60' : 'stable!')),
      );
    }
    await page.evaluate(() => {
      occlusionQA.armed = false;
      occlusionQA.resize(null);
    });
    await page.waitForTimeout(300);
    const generation = await page.evaluate(
      () => [...occlusionQA.wire].reverse().find((e) => e.message.type === 'layout')?.message.generation,
    );
    await page.setViewportSize({ width: 1200, height: 1040 });
    await page.waitForFunction(
      (old) =>
        occlusionQA.wire.some(
          (entry) =>
            entry.message.type === 'layout' &&
            entry.message.generation !== '0' &&
            BigInt(entry.message.generation) > BigInt(old),
        ),
      generation,
      { timeout: 45000 },
    );
    await ready();
    await page.waitForTimeout(500);
    const resized = await viewport.boundingBox();
    await page.evaluate(() => {
      occlusionQA.armed = true;
    });
    await session.pointer.move(resized.x + 150, resized.y + 48);
    await session.pointer.down();
    await session.pointer.up();
    await page.waitForFunction(
      () =>
        [...occlusionQA.wire].reverse().find((entry) => entry.message.type === 'view.viewport')?.message
          .pageHeight < 700,
    );
    const beforeRotation = await page.evaluate(() => ({
      wire: occlusionQA.wire.length,
      generation: [...occlusionQA.wire].reverse().find((entry) => entry.message.type === 'layout').message
        .generation,
    }));
    await page.evaluate(() => {
      occlusionQA.armed = false;
      occlusionQA.height = 840;
      occlusionQA.measuring = true;
    });
    await page.setViewportSize({ width: 1040, height: 1200 });
    await page.waitForFunction(
      ({ generation, start }) => {
        const next = occlusionQA.wire
          .slice(start)
          .find(
            (entry) =>
              entry.message.type === 'view.viewport' &&
              BigInt(entry.message.outputGeneration) > BigInt(generation),
          );
        return next && Math.abs(next.message.pageHeight - 751) <= 1;
      },
      { generation: beforeRotation.generation, start: beforeRotation.wire },
      { timeout: 45000 },
    );
    await page.waitForFunction(
      () => occlusionQA.frames.some((frame) => frame.correct && Math.abs(frame.pageHeight - 751) <= 1),
      undefined,
      { timeout: 45000 },
    );
    const rotation = await page.evaluate((start) => {
      const wire = occlusionQA.wire.slice(start);
      const layout = wire.find(
        (entry) => entry.message.type === 'layout' && entry.message.generation !== '0',
      )?.message;
      const frame = wire.find(
        (entry) => entry.message.type === 'frame' && entry.message.layoutEpoch === layout?.epoch,
      )?.message;
      return {
        generation: layout?.generation,
        barriers: new Set(
          wire
            .filter((entry) => entry.message.type === 'presentation.prepare')
            .map((entry) => entry.message.barrierId),
        ).size,
        firstPageHeight: frame?.viewports?.[0]?.pageHeight,
        firstKeyframe: frame?.keyframe,
      };
    }, beforeRotation.wire);
    assert.ok(BigInt(rotation.generation) > BigInt(beforeRotation.generation));
    assert.ok(rotation.barriers > 0);
    assert.equal(rotation.firstPageHeight, 751, 'rotation generation started without the current occlusion');
    assert.equal(rotation.firstKeyframe, true);
    normalChanges.push({ label: 'rotation-with-keyboard', ...rotation });
    await page.evaluate(() => {
      occlusionQA.resize(null);
      occlusionQA.measuring = false;
    });
    await page.waitForTimeout(500);
    if (kind === 'viewport') {
      await session.openStart();
      await session.tile('\u6d4f\u89c8\u5668').click();
      const address = page
        .getByRole('textbox', { name: '\u641c\u7d22\u6216\u8f93\u5165\u7f51\u5740', exact: true })
        .last();
      await address.fill(url + '/two');
      await address.press('Enter');
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.remote-viewport')].length === 2 &&
          [...document.querySelectorAll('.remote-viewport video')].every((video) => video.videoWidth > 0),
        undefined,
        { timeout: 30000 },
      );
      await page.waitForTimeout(2000);
      const views = await page
        .locator('.remote-viewport')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({ id: node.dataset.viewId, box: node.getBoundingClientRect().toJSON() })),
        );
      const beforeOwnerMove = await page.evaluate(() => ({
        wire: occlusionQA.wire.length,
        generation: [...occlusionQA.wire].reverse().find((entry) => entry.message.type === 'layout').message
          .generation,
      }));
      const neighbourResizes = events.filter(
        (event) => event.path === '/page' && event.type === 'resize',
      ).length;
      await page.evaluate(() => {
        occlusionQA.armed = true;
        occlusionQA.measuring = true;
      });
      await session.pointer.move(views[1].box.x + 150, views[1].box.y + 48);
      await session.pointer.down();
      await session.pointer.up();
      const checkOwners = async (owner) => {
        await page.waitForFunction(
          ({ ids, owner, height }) => {
            return ids.every((id) => {
              const value = [...occlusionQA.wire]
                .reverse()
                .find(
                  (entry) => entry.message.type === 'view.viewport' && entry.message.viewId === id,
                )?.message;
              return value && Math.abs(value.pageHeight - (id === owner ? height - 360 : height)) <= 1;
            });
          },
          { ids: views.map((view) => view.id), owner, height: Math.round(views[0].box.height) },
          { timeout: 45000 },
        );
        const start = await page.evaluate(() => occlusionQA.frames.length);
        await page.waitForFunction(
          ({ ids, owner, height, start }) =>
            ids.every((id) =>
              occlusionQA.frames
                .slice(start)
                .some(
                  (frame) =>
                    frame.viewId === id &&
                    frame.correct &&
                    frame.pageHeight === (id === owner ? height - 360 : height),
                ),
            ),
          { ids: views.map((view) => view.id), owner, height: Math.round(views[0].box.height), start },
          { timeout: 45000 },
        );
      };
      await checkOwners(views[1].id);
      assert.equal(
        events.filter((event) => event.path === '/page' && event.type === 'resize').length,
        neighbourResizes,
        'neighbour reflowed when keyboard opened',
      );
      await session.pointer.move(views[0].box.x + 150, views[0].box.y + 48);
      await session.pointer.down();
      await session.pointer.up();
      await checkOwners(views[0].id);
      const ownerMove = await page.evaluate(
        ({ start, generation }) => {
          const wire = occlusionQA.wire.slice(start);
          return {
            generations: wire.filter(
              (entry) => entry.message.type === 'layout' && entry.message.generation !== generation,
            ).length,
            barriers: wire.filter((entry) => entry.message.type === 'presentation.prepare').length,
          };
        },
        { start: beforeOwnerMove.wire, generation: beforeOwnerMove.generation },
      );
      assert.deepEqual(ownerMove, { generations: 0, barriers: 0 });
      results.push({ label: 'editing-window-transfer', ...ownerMove });
    }
    await page.screenshot({ path: join(run, 'complete.png') });
    await writeFile(
      join(run, 'results.json'),
      JSON.stringify({ browser: browserName, mode, results, normalChanges, events }, null, 2),
    );
    console.log(
      JSON.stringify({
        browser: browserName,
        mode,
        results: results.map(({ label, latencyMs, layouts, barriers, keyframes }) => ({
          label,
          latencyMs,
          generations: 0,
          layouts: layouts?.length ?? 0,
          barriers: Array.isArray(barriers) ? barriers.length : barriers,
          keyframes: keyframes?.length ?? 0,
        })),
      }),
    );
  } finally {
    if (session) {
      await session.page.screenshot({ path: join(run, 'final.png') }).catch(() => {});
      await writeFile(
        join(run, 'final-dom.json'),
        JSON.stringify(
          await session.page
            .evaluate(() => ({ text: document.body.innerText, state: window.__remotekitTest?.state() }))
            .catch(() => null),
          null,
          2,
        ),
      );
    }
    if (session)
      await writeFile(
        join(run, 'wire.json'),
        JSON.stringify(
          await session.page
            .evaluate(() => ({
              wire: occlusionQA.wire,
              frames: occlusionQA.frames,
              geometries: occlusionQA.geometries,
            }))
            .catch(() => null),
          null,
          2,
        ),
      );
    await session?.close();
    await stack?.stop();
    fixture.closeAllConnections();
    await new Promise((done) => fixture.close(done));
  }
}
