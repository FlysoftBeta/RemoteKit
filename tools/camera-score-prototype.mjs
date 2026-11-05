// Synthetic-only, bounded scoring comparison. Never reads a user's camera/files.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const root = path.resolve(import.meta.dirname, '..'),
  out = path.resolve(process.argv[2] ?? path.join(root, 'develop/tmp/camera-score-prototype'));
await fs.mkdir(out, { recursive: true });
const context = vm.createContext({});
vm.runInContext(await fs.readFile(path.join(root, 'tools/camera-score-worker.js'), 'utf8'), context);
const score = context.RemoteKitCameraScore,
  w = 160,
  h = 90;
const sharp = Uint8Array.from({ length: w * h }, (_, i) =>
  (((Math.floor(i / w) / 9) | 0) + (((i % w) / 9) | 0)) % 2 ? 190 : 65,
);
function blur(rx, ry) {
  return sharp.map((_, i) => {
    const x = i % w,
      y = (i / w) | 0;
    let sum = 0,
      n = 0;
    for (let dy = -ry; dy <= ry; dy++)
      for (let dx = -rx; dx <= rx; dx++) {
        sum += sharp[Math.max(0, Math.min(h - 1, y + dy)) * w + Math.max(0, Math.min(w - 1, x + dx))];
        n++;
      }
    return sum / n;
  });
}
let seed = 1234;
const fixtures = {
  sharp,
  blur: blur(3, 3),
  motion: blur(6, 0),
  noise: sharp.map((value) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return Math.max(0, Math.min(255, value + (seed % 101) - 50));
  }),
  lowlight: sharp.map((value) => value * 0.12),
};
const results = {
  conditions: {
    synthetic: true,
    width: w,
    height: h,
    inputBytes: w * h,
    remote: 'loopback HTTP, artificial request delay RTT 0/10/70ms; no network bandwidth throttling',
    browserRun: false,
  },
  fixtures: {},
  remote: [],
};
const server = http.createServer(async (req, res) => {
  const delay = Number(new URL(req.url, 'http://localhost').searchParams.get('delay') ?? 0);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > w * h) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const pixels = new Uint8Array(Buffer.concat(chunks));
  if (pixels.length !== w * h) {
    res.writeHead(400).end();
    return;
  }
  const start = performance.now(),
    value = score(pixels, w, h),
    scoreMs = performance.now() - start;
  setTimeout(() => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ value, scoreMs, inputBytes: bytes }));
  }, delay);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  for (const [name, pixels] of Object.entries(fixtures)) {
    const start = performance.now(),
      value = score(pixels, w, h);
    results.fixtures[name] = { ...value, localScoreMs: performance.now() - start };
    await fs.writeFile(path.join(out, `${name}.gray`), pixels);
    for (const delay of [0, 10, 70]) {
      const start = performance.now(),
        response = await fetch(`http://127.0.0.1:${server.address().port}/score?delay=${delay}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: pixels,
        });
      const text = await response.text(),
        remote = JSON.parse(text);
      results.remote.push({
        fixture: name,
        artificialRttMs: delay,
        sequenceWallMs: performance.now() - start,
        requestPayloadBytes: pixels.length,
        responsePayloadBytes: Buffer.byteLength(text),
        scoreMs: remote.scoreMs,
      });
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
// SVG embeds fixed grayscale pixels; each miniature is displayed at 96px, without user images.
const thumbnails = Object.entries(fixtures)
  .map(([name, pixels], index) => {
    let rects = '';
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const gray = pixels[y * w + x];
        rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${gray},${gray},${gray})"/>`;
      }
    return `<g transform="translate(${index * 110},24)"><text y="-8" font-size="11">${name}</text><svg width="96" height="54" viewBox="0 0 ${w} ${h}">${rects}</svg><text y="72" font-size="10">score ${results.fixtures[name].score.toFixed(0)}</text></g>`;
  })
  .join('');
await fs.writeFile(
  path.join(out, 'ranking.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="550" height="105">${thumbnails}</svg>`,
);
await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
console.log(
  JSON.stringify(
    {
      out,
      ranking: Object.entries(results.fixtures)
        .sort((a, b) => b[1].score - a[1].score)
        .map(([name, value]) => ({ name, score: value.score, laplacianScore: value.laplacianScore })),
      remote: results.remote.map((r) => ({
        fixture: r.fixture,
        rtt: r.artificialRttMs,
        wall: r.sequenceWallMs,
        bytes: r.requestPayloadBytes,
      })),
    },
    null,
    2,
  ),
);
