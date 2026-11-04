/**
 * UD710 local sender-queue scenario for test-diagnostic-collection.mjs.
 * See develop/docs/ud710-local-repro-20261104.md for invocation and metric scope.
 */
const rateControl = process.env.REMOTEKIT_QA_UD710_RATE_CONTROL;
if (rateControl && rateControl !== 'cbr' && rateControl !== 'vbr') {
  throw new Error('REMOTEKIT_QA_UD710_RATE_CONTROL must be cbr or vbr');
}
export const viewport = {width:1920, height:888};
export const endpointArgs = ['--encoder=qsv', '--fps=60', '--max-bitrate=48000000'];
if (rateControl) endpointArgs.push('--rate-control=' + rateControl);
export const controlEnvironment = {
  REMOTEKIT_NETWORK_SIM:JSON.stringify({
    oneWayDelayMs:5, downlinkMbps:24, uplinkMbps:1000, maxQueueBytes:300000, maxQueueDelayMs:100,
  }),
  REMOTEKIT_RTC_LOOPBACK_TEST:'1',
};

const stimulus = `<!doctype html><meta charset="utf-8"><title>UD710 controlled scroll</title>
<style>
  body { margin:0; overflow:hidden; background:#f0ece9; font:18px Arial; }
  main { height:100vh; overflow:auto; scrollbar-width:none; }
  section { padding:24px 40px; }
  article { display:grid; grid-template-columns:repeat(4, 1fr); gap:18px; }
  div { padding:12px; border:1px solid #bbb; }
  canvas { position:fixed; inset:0; pointer-events:none; }
</style>
<main><section><h1>RemoteKit scroll stimulus</h1><article></article></section></main>
<canvas width="224" height="32"></canvas>
<script>
  const scroller = document.querySelector('main');
  const grid = document.querySelector('article');
  const text = 'The evening route crossed the city. The station, clock, platform, and painted signs stayed in view while the page scrolled.';
  const colors = ['#deeffa', '#fff1d2', '#efebf7', '#ddf4df', '#f7e1dd'];
  for (let i = 0; i < 480; i++) {
    const card = document.createElement('div');
    card.style.backgroundColor = colors[i % colors.length];
    card.innerHTML = '<strong>Field notes ' + i + '</strong><p>' + text + '</p><p>' + text + '</p>';
    grid.append(card);
  }

  const ctx = document.querySelector('canvas').getContext('2d');
  let active = false;
  let motionStart = 0;
  function marker() {
    const time = Date.now() >>> 0;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 224, 32);
    ctx.fillStyle = 'black';
    for (let bit = 0; bit < 32; bit++) {
      if (!(time >>> bit & 1)) continue;
      const x = (bit % 16) * 14;
      const y = Math.floor(bit / 16) * 16;
      ctx.fillRect(x, y, 14, 16);
    }
  }
  function animate(t) {
    if (!active) return;
    const elapsed = t - motionStart;
    const phase = (elapsed % 1700) / 1700;
    scroller.scrollTop = Math.floor(elapsed / 1700) * 1000 +
      Math.round((1 - Math.pow(1 - phase, 2.2)) * 1000);
    marker();
    requestAnimationFrame(animate);
  }

  marker();
  (async () => {
    for (;;) {
      const next = await fetch('/phase?previous=' + active).then(response => response.json());
      if (next && !active) {
        active = true;
        scroller.scrollTop = 0;
        motionStart = performance.now();
        requestAnimationFrame(animate);
      } else {
        active = next;
      }
    }
  })();
</script>`;

export async function start({page}) {
  await page.evaluate(() => {
    const video = document.querySelector('.remote-video-plane video');
    const canvas = document.createElement('canvas');
    canvas.width = 224;
    canvas.height = 32;
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    const frames = window.diagnosticQA.lagFrames = [];
    window.diagnosticQA.lagDims = [video.videoWidth, video.videoHeight];
    window.diagnosticQA.lagClockOffset = () => Date.now() - (performance.timeOrigin + performance.now());
    function record(now, data) {
      let marker = null;
      if (frames.length % 4 === 0 && video.videoWidth >= canvas.width && video.videoHeight >= canvas.height) {
        // This sparse probe reads the current element pixels. The element can
        // already have advanced beyond the callback metadata's frame.
        ctx.drawImage(video, 0, 0, 224, 32, 0, 0, 224, 32);
        const pixels = ctx.getImageData(0, 0, 224, 32).data;
        let value = 0;
        for (let bit = 0; bit < 32; bit++) {
          const x = (bit % 16) * 14 + 7;
          const y = Math.floor(bit / 16) * 16 + 8;
          if (pixels[(y * 224 + x) * 4] < 100) value |= 1 << bit;
        }
        const delay = ((performance.timeOrigin + data.presentationTime) - (value >>> 0)) | 0;
        if (delay >= 0 && delay < 10000) marker = {value:value >>> 0, delay};
      }
      frames.push({now, ...data, marker});
      video.requestVideoFrameCallback(record);
    }
    video.requestVideoFrameCallback(record);
  });
}

export function createScenario() {
  let motion = false;
  const waiting = new Set();
  function setMotion(active) {
    motion = active;
    for (const response of waiting) response.end(JSON.stringify(active));
    waiting.clear();
  }
  return {
    fixture(request, response) {
      if (request.url.startsWith('/phase?')) {
        response.setHeader('Cache-Control', 'no-store');
        if (request.url === '/phase?previous=' + motion) {
          waiting.add(response);
          response.once('close', () => waiting.delete(response));
        } else {
          response.end(JSON.stringify(motion));
        }
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(stimulus);
    },

    start,

    async measure({read, log, sleep}) {
      const offset = await read('diagnosticQA.lagClockOffset()');
      await log('phase-idle', {wall:Date.now(), offset});
      await sleep(30000);
      setMotion(true);
      await log('phase-motion', {wall:Date.now()});
      await sleep(22000);
      setMotion(false);
      await log('phase-idle-2', {wall:Date.now()});
      await sleep(5000);
      setMotion(true);
      await log('phase-motion-2', {wall:Date.now()});
      await sleep(13000);
      setMotion(false);
      await log('phase-done', {wall:Date.now(), offset:await read('diagnosticQA.lagClockOffset()')});
      await log('frame-raw', await read(`({
        dims:diagnosticQA.lagDims,
        timeOrigin:performance.timeOrigin,
        frames:diagnosticQA.lagFrames
      })`));
    },
  };
}
