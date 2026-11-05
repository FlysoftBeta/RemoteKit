/**
 * Optional 2/15 Hz stimulus and idle-tail image comparison for the local UD710 runner.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { start } from './ud710-lag-scenario.mjs';
export { controlEnvironment, endpointArgs, viewport } from './ud710-lag-scenario.mjs';

const roi = { x: 64, y: 64, width: 640, height: 320 };
const stimulus = `<!doctype html><meta charset="utf-8"><title>UD710 sparse motion</title>
<style>
  body { margin:0; overflow:hidden; }
  #marker { position:fixed; top:0; left:0; }
</style>
<canvas id="pattern" width="1920" height="800"></canvas><canvas id="marker" width="224" height="32"></canvas>
<script>
  const source = document.querySelector('#pattern');
  const context = source.getContext('2d');
  const marker = document.querySelector('#marker').getContext('2d');
  const tile = document.createElement('canvas');
  tile.width = source.width;
  tile.height = source.height;
  const background = tile.getContext('2d');
  const gradient = background.createLinearGradient(0, 0, tile.width, tile.height);
  gradient.addColorStop(0, '#f0e9c5');
  gradient.addColorStop(.47, '#b6d3d8');
  gradient.addColorStop(1, '#db9dba');
  background.fillStyle = gradient;
  background.fillRect(0, 0, tile.width, tile.height);
  for (let y = 0; y < tile.height; y += 8) {
    background.fillStyle = y % 24 === 0 ? '#8b97a9' : '#b4c3cd';
    background.fillRect(0, y, tile.width, 1);
  }
  const colors = ['#14263b', '#214242', '#502138', '#353510'];
  for (let y = 24; y < tile.height; y += 24) {
    for (let x = 12; x < tile.width; x += 192) {
      background.fillStyle = colors[(x + y / 24) % colors.length];
      background.font = (10 + (y / 24) % 5) + 'px Arial';
      background.fillText('Text ' + y + '.' + x + ' · 0123456789', x, y);
      background.fillRect(x + 136, y - 9, 12, 10);
    }
  }
  let phase = 0;
  let markerTime = 0;
  let tick = 0;
  let timer;
  function draw() {
    const offset = (++tick * 17) % tile.width;
    context.drawImage(tile, -offset, 0);
    context.drawImage(tile, tile.width - offset, 0);
    markerTime = Date.now() >>> 0;
    marker.fillStyle = 'white';
    marker.fillRect(0, 0, 224, 32);
    marker.fillStyle = 'black';
    for (let bit = 0; bit < 32; bit++) {
      if (markerTime >>> bit & 1) {
        marker.fillRect((bit % 16) * 14, Math.floor(bit / 16) * 16, 14, 16);
      }
    }
  }
  async function sendReference(previous) {
    const {x, y, width, height} = ${JSON.stringify(roi)};
    const reference = document.createElement('canvas');
    reference.width = width;
    reference.height = height;
    reference.getContext('2d').drawImage(source, x, y, width, height, 0, 0, width, height);
    await fetch('/reference/' + previous, {method:'POST', body:JSON.stringify({
      sourceFrames:tick, markerTime, png:reference.toDataURL('image/png'),
    })});
  }
  draw();
  (async () => {
    for (;;) {
      const next = await fetch('/phase?previous=' + phase).then(response => response.json());
      const previous = phase;
      phase = next;
      clearInterval(timer);
      if (phase) {
        tick = 0;
        draw();
        timer = setInterval(() => {
          if (tick < phase * 10) draw();
        }, 1000 / phase);
      } else if (previous) {
        await sendReference(previous);
      }
    }
  })();
</script>`;

export function createScenario() {
  const pending = new Set();
  const references = new Map();
  let phase = 0;
  function changePhase(value) {
    phase = value;
    for (const response of pending) response.end(JSON.stringify(value));
    pending.clear();
  }

  async function captureQuality(page, run, fps, reference) {
    const captured = await page.evaluate(
      async ({ reference, roi }) => {
        const video = document.querySelector('.remote-video-plane video');
        const layout = window.diagnosticQA.latestLayout;
        const plane = layout?.planes?.[0];
        if (
          layout?.planes?.length !== 1 ||
          layout.reconfiguring ||
          !plane?.ready ||
          plane.mediaScaleX !== 1 ||
          plane.mediaScaleY !== 1 ||
          layout.width !== video.videoWidth ||
          layout.height !== video.videoHeight
        ) {
          throw new Error('Expected one ready, unscaled atlas plane for pixel comparison');
        }
        const canvas = document.createElement('canvas');
        canvas.width = roi.width;
        canvas.height = roi.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const picture = new Image();
        picture.src = reference.png;
        await picture.decode();

        context.drawImage(video, plane.x, plane.y, 224, 32, 0, 0, 224, 32);
        const marker = context.getImageData(0, 0, 224, 32).data;
        let decodedTime = 0;
        for (let bit = 0; bit < 32; bit++) {
          const x = (bit % 16) * 14 + 7;
          const y = Math.floor(bit / 16) * 16 + 8;
          if (marker[(y * 224 + x) * 4] < 100) decodedTime |= 1 << bit;
        }

        context.drawImage(
          video,
          plane.x + roi.x,
          plane.y + roi.y,
          roi.width,
          roi.height,
          0,
          0,
          roi.width,
          roi.height,
        );
        const decoded = context.getImageData(0, 0, roi.width, roi.height).data;
        const png = canvas.toDataURL('image/png');
        context.drawImage(picture, 0, 0);
        const source = context.getImageData(0, 0, roi.width, roi.height).data;
        const errors = new Uint32Array(256);
        let sum = 0;
        let squared = 0;
        for (let i = 0; i < source.length; ++i) {
          if (i % 4 === 3) continue;
          const delta = Math.abs(decoded[i] - source[i]);
          sum += delta;
          squared += delta * delta;
          errors[delta]++;
        }
        const channels = roi.width * roi.height * 3;
        let cumulative = 0;
        const p95 = errors.findIndex((count) => (cumulative += count) >= channels * 0.95);
        return {
          decodedTime: decodedTime >>> 0,
          meanAbsoluteError: sum / channels,
          rgbRmse: Math.sqrt(squared / channels),
          rgbAbsoluteErrorP95: p95,
          atlasOffset: [plane.x, plane.y],
          png,
        };
      },
      { reference, roi },
    );
    function save(label, dataUrl) {
      return writeFile(join(run, label + '-' + fps + 'hz.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
    await Promise.all([save('reference', reference.png), save('decoded', captured.png)]);
    const { png, ...metrics } = captured;
    return {
      ...metrics,
      sourceFrames: reference.sourceFrames,
      sourceMarkerTime: reference.markerTime,
      sameMarker: metrics.decodedTime === reference.markerTime,
    };
  }

  return {
    fixture(request, response) {
      if (request.url.startsWith('/phase?')) {
        response.setHeader('Cache-Control', 'no-store');
        if (request.url === '/phase?previous=' + phase) {
          pending.add(response);
          response.once('close', () => pending.delete(response));
        } else {
          response.end(JSON.stringify(phase));
        }
        return;
      }
      if (request.method === 'POST' && /^\/reference\/(2|15)$/.test(request.url)) {
        const fps = Number(request.url.split('/').at(-1));
        request.setEncoding('utf8');
        let text = '';
        request.on('data', (chunk) => {
          text += chunk;
          if (text.length > 2 * 1024 * 1024) request.destroy();
        });
        request.on('end', () => {
          try {
            const reference = JSON.parse(text);
            assert(
              Number.isInteger(reference.markerTime) &&
                Number.isInteger(reference.sourceFrames) &&
                reference.png.startsWith('data:image/png;base64,'),
            );
            references.set(fps, reference);
            response.end();
          } catch {
            response.statusCode = 400;
            response.end();
          }
        });
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(stimulus);
    },
    start,
    async measure({ page, run, read, log, sleep }) {
      const offset = await read('diagnosticQA.lagClockOffset()');
      await log('phase-idle', { wall: Date.now(), offset });
      await sleep(3000);
      for (const fps of [2, 15]) {
        changePhase(fps);
        await log('phase-motion-' + fps + 'hz', { wall: Date.now() });
        await sleep(10000);
        changePhase(0);
        await log('phase-idle-' + fps + 'hz', { wall: Date.now() });
        await sleep(4000);
        assert(references.has(fps), 'No reference for ' + fps + ' Hz');
        await log('quality-' + fps + 'hz', await captureQuality(page, run, fps, references.get(fps)));
      }
      await log('phase-done', { wall: Date.now(), offset: await read('diagnosticQA.lagClockOffset()') });
      await log(
        'frame-raw',
        await read(`({
        dims:diagnosticQA.lagDims,
        timeOrigin:performance.timeOrigin,
        frames:diagnosticQA.lagFrames
      })`),
      );
    },
  };
}
