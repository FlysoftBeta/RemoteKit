import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { distribution, summarize } from '../measure/schedlab/summarize.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/schedlab/', import.meta.url));
test('joins wire RTP including zero; measures scroll starts, motion FPS and quantiles', () => {
  const temporary = resolve(root, 'develop/tmp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'schedlab-summary-'));
  try {
    cpSync(fixtures, directory, { recursive: true });
    const result = summarize(directory);
    const scroll = result.tenants[0],
      video = result.tenants[1];
    assert.deepEqual(scroll.join, { encoded: 4, matched: 4, fraction: 1 });
    assert.equal(scroll.latencyMs.p50, 30);
    assert.ok(Math.abs(scroll.latencyMs.p95 - 74) < 1e-10);
    assert.ok(Math.abs(scroll.latencyMs.p99 - 78.8) < 1e-10);
    assert.equal(scroll.latencyMs.max, 80);
    assert.equal(scroll.scrollStartMs.p50, 45);
    assert.equal(scroll.scrollStartMs.p95, 76.5);
    assert.equal(scroll.scrollResponseMs.p50, 100);
    assert.ok(Math.abs(scroll.scrollFps - 4000 / 1010) < 1e-10);
    assert.equal(video.videoFps, 1);
    assert.equal(result.aggregate.latencyMs.p50, 35);
    assert.equal(result.byKind.S4.encoderBytes, 460);
    assert.equal(result.byKind.V.qp.p50, 29);
    assert.equal(result.aggregate.admission.interactive.grants, 4);
    assert.ok(Math.abs(result.aggregate.admission.interactive.waitMs.p95 - 2.85) < 1e-10);
    assert.equal(result.aggregate.gpu.VideoEncode.mean, 12.5);
    assert.equal(result.aggregate.gpu.VideoDecode.mean, null);
    assert.ok(Math.abs(scroll.sender.meanPacketSendDelayMs - 2) < 1e-10);
    assert.equal(scroll.receiver.meanDecodeMs, 1);
    const frames = readFileSync(join(directory, 'frames-0.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(frames[0].rtpTimestamp, 0);
    assert.equal(frames[0].latency, 10);
    assert.match(readFileSync(join(directory, 'summary.md'), 'utf8'), /Scroll start p95/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('quantiles interpolate and preserve missing samples', () => {
  assert.deepEqual(distribution([]), { samples: 0, mean: null, p50: null, p95: null, p99: null, max: null });
  assert.equal(distribution([10, 30]).p95, 29);
  assert.equal(distribution([null, 7, NaN]).p99, 7);
});
