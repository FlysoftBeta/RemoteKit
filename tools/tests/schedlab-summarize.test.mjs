import { ensureProfileConfig } from '../measure/osr-video-profile-server.mjs';
import { runInNewContext } from 'node:vm';
import { compare } from '../measure/schedlab/compare.mjs';
import { cdpConnect } from '../cdp.mjs';
import { finishRun } from '../measure/schedlab/run.mjs';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

test('comparison requires matching geometry, tenant count and workload mix', () => {
  const directory = mkdtempSync(join(root, 'develop/tmp/schedlab-compare-'));
  try {
    const baseline = join(directory, 'baseline');
    const candidate = join(directory, 'candidate');
    cpSync(fixtures, baseline, { recursive: true });
    const summary = summarize(baseline);
    summary.case = { geometry: 'F', count: 2, mix: ['S4', 'V'] };
    mkdirSync(candidate);
    writeFileSync(join(baseline, 'summary.json'), JSON.stringify(summary));
    for (const change of [{ geometry: 'T' }, { count: 3 }, { mix: ['V', 'V'] }]) {
      writeFileSync(
        join(candidate, 'summary.json'),
        JSON.stringify({ ...summary, case: { ...summary.case, ...change } }),
      );
      assert.throws(() => compare([baseline, candidate]), /No matching baseline/);
    }
    writeFileSync(join(candidate, 'summary.json'), JSON.stringify(summary));
    assert.match(compare([baseline, candidate]), /synthetic/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed runs and failed summaries retain raw traces', async () => {
  const directory = mkdtempSync(join(root, 'develop/tmp/schedlab-retain-'));
  try {
    cpSync(fixtures, directory, { recursive: true });
    const metadata = JSON.parse(readFileSync(join(directory, 'run.json')));
    await assert.rejects(
      finishRun(directory, metadata, {}, Error('injected run failure')),
      /injected run failure/,
    );
    assert(readFileSync(join(directory, 'resources.jsonl')).length > 0);
    writeFileSync(join(directory, 'run.json'), 'invalid JSON');
    await assert.rejects(finishRun(directory, metadata, {}));
    assert(readFileSync(join(directory, 'resources.jsonl')).length > 0);
    writeFileSync(join(directory, 'run.json'), JSON.stringify(metadata));
    await finishRun(directory, metadata, {});
    assert.throws(() => readFileSync(join(directory, 'resources.jsonl')), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CDP bounds requests, rejects all pending on disconnect, and accepts replies', async (t) => {
  let socket;
  class Socket {
    readyState = 1;
    messages = [];
    constructor() {
      socket = this;
      queueMicrotask(() => this.onopen());
    }
    send(message) {
      this.messages.push(JSON.parse(message));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const nativeSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => {
    globalThis.WebSocket = nativeSocket;
  });
  const cdp = await cdpConnect('ws://fixture', { timeoutMs: 15 });
  const response = cdp.send('Runtime.evaluate');
  socket.onmessage({ data: JSON.stringify({ id: socket.messages.at(-1).id, result: { value: 42 } }) });
  assert.deepEqual(await response, { value: 42 });
  await assert.rejects(cdp.send('unanswered'), /CDP timeout: unanswered/);
  const pending = [cdp.send('first'), cdp.send('second')];
  const rejected = pending.map((work) => assert.rejects(work, /CDP closed/));
  socket.close();
  await Promise.all(rejected);
  await assert.rejects(cdp.send('after close'), /CDP closed/);
});

test('fixture readiness follows initialization and initialization failures reach the runner', async () => {
  const source = readFileSync(join(root, 'tools/measure/schedlab/web/fixture.mjs'), 'utf8');
  for (const failure of ['decode', 'first-play', 'second-play', null]) {
    const sent = [];
    let socket, finishDecode;
    let playCount = 0;
    class Socket {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        socket = this;
      }
      send(value) {
        sent.push(JSON.parse(value));
      }
    }
    const video = {
      addEventListener(type, callback) {
        if (type === 'loadedmetadata') queueMicrotask(callback);
      },
      play() {
        playCount++;
        return (failure === 'first-play' && playCount === 1) || (failure === 'second-play' && playCount === 2)
          ? Promise.reject(Error(failure))
          : Promise.resolve();
      },
    };
    class Picture {
      decode() {
        return new Promise((resolve, reject) => {
          finishDecode = () => reject(Error('decode'));
        });
      }
    }
    runInNewContext(source, {
      URLSearchParams,
      WebSocket: Socket,
      Image: Picture,
      location: { search: failure === 'decode' ? '?kind=U10' : '?kind=V&t0=1', origin: 'http://fixture' },
      performance: { timeOrigin: 1, now: () => 0 },
      queueMicrotask,
      setTimeout: (callback) => {
        queueMicrotask(callback);
      },
      document: { createElement: () => video, body: { append() {} } },
    });
    socket.readyState = 1;
    socket.onopen();
    assert(!sent.some((event) => event.type === 'fixtureReady'));
    if (finishDecode) finishDecode();
    await new Promise(setImmediate);
    assert.equal(sent.at(-1).type, failure ? 'fixtureError' : 'fixtureReady');
    if (failure) assert.match(sent.at(-1).message, new RegExp(failure));
    else assert.equal(playCount, 2);
  }
});

test('profile config is complete and explicit state preserves existing bytes', async () => {
  const directory = mkdtempSync(join(root, 'develop/tmp/profile-config-'));
  try {
    const path = join(directory, 'control.json');
    const config = { nodes: { local: { local: { root: directory } } } };
    await ensureProfileConfig(path, {}, config);
    const document = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(document.version, 1);
    assert(document.media && document.quotas && document.storage.logs);
    assert(document.nodes.local.peer && document.nodes.local.rtc && document.nodes.local.limits);
    const saved = ' { "keep": "exact bytes" } \n';
    writeFileSync(path, saved);
    await ensureProfileConfig(path, { state: directory }, config);
    assert.equal(readFileSync(path, 'utf8'), saved);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
