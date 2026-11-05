import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockDomain, ClockProbe } from '../client/media/clock-domain';
import { CaptureLatency } from '../client/media/capture-latency';
import { QualityState } from '../server/quality';

test('independent Control +500ms and Endpoint -300ms retain true 100ms latency and Control freshness', () => {
  const latency = new CaptureLatency(),
    control = new ClockDomain();
  latency.calibrate(0, 1000, 10, 1010, 705, 500);
  control.calibrate(0, 1000, 10, 1010, 1505);
  for (let i = 0; i < 3; i++) {
    const now = 100 + i * 1000;
    latency.record(i, 'a', {
      captureWallTimeMs: now + 600,
      captureMonotonicMs: now + 395,
      captureClockUncertaintyMs: 1,
      sourceCaptureId: String(i + 1),
    });
    latency.paint(i, 'a', now, 1000 + now);
  }
  const report = latency.report(2200, 3200, true, control)!;
  assert.equal(report.presentationLatencyMs, 100);
  assert.equal(report.clockUncertaintyMs, 7);
  assert.equal(report.sampledAtControlMs, 3700);
  assert.equal(report.sampledAtServerMs, 3700);
  assert.equal(new QualityState().observe(report, 3700, true), true);
  assert.equal(latency.inputStart(2100, 2200, 3200), 2794000);
});

test('missing Control calibration pauses feedback while Endpoint touch calibration remains usable', () => {
  const latency = new CaptureLatency();
  latency.calibrate(0, 1000, 10, 1010, 705, 500);
  latency.record(1, 'a', {
    captureWallTimeMs: 700,
    captureMonotonicMs: 495,
    captureClockUncertaintyMs: 1,
    sourceCaptureId: '1',
  });
  latency.paint(1, 'a', 100, 1100);
  assert.equal(latency.report(2100, 3100, true), undefined);
  assert.equal(typeof latency.inputStart(2000, 2100, 3100), 'number');
});

test('late metadata uses the original presentation observation even across a later calibration', () => {
  const latency = new CaptureLatency(),
    control = new ClockDomain();
  latency.calibrate(100, 1100, 110, 1110, 805, 600);
  control.calibrate(100, 1100, 110, 1110, 1605);
  latency.record(1, 'a', {
    captureWallTimeMs: 650,
    captureMonotonicMs: 445,
    captureClockUncertaintyMs: 1,
    sourceCaptureId: '1',
  });
  latency.paint(1, 'a', 50, 1050);
  const report = latency.report(2150, 3150, true, control)!;
  assert.equal(report.presentationLatencyMs, 100);
  assert.equal(report.sampledAtControlMs, 3650);
});

test('first capture after calibration cannot hide an Endpoint wall or monotonic jump', () => {
  for (const mono of [495, 995]) {
    const latency = new CaptureLatency();
    latency.calibrate(0, 1000, 10, 1010, 705, 500);
    latency.record(1, 'a', {
      captureWallTimeMs: mono === 495 ? 1200 : 700,
      captureMonotonicMs: mono,
      captureClockUncertaintyMs: 1,
      sourceCaptureId: '1',
    });
    latency.paint(1, 'a', 100, 1100);
    assert.equal(latency.inputStart(100, 100, 1100), undefined);
  }
});

test('single-flight nonce rejects old peer pongs and timed out samples, then retries', () => {
  const clock = new ClockDomain(),
    probe = new ClockProbe(clock);
  const first = probe.begin(0, 1000)!;
  assert.equal(probe.begin(100, 1100), undefined);
  assert.equal(probe.complete('wrong', 10, 1010, 705, 500), false);
  assert.equal(probe.complete(first.requestId, 1600, 2600, 2300, 2100), false);
  const next = probe.begin(5000, 6000)!;
  assert.equal(
    probe.pong({ ...next, type: 'clock.pong', serverTimeMs: 5705, serverMonotonicMs: 5500 }, 5010, 6010),
    true,
  );
  probe.reset();
  assert.equal(clock.mapping(5010, 6010), undefined);
  const replacement = probe.begin(5020, 6020)!;
  assert.equal(probe.complete(next.requestId, 5030, 6030, 5730, 5525), false);
  assert.equal(
    probe.pong(
      { ...replacement, type: 'clock.pong', serverTimeMs: 5725, serverMonotonicMs: 5520 },
      5030,
      6030,
    ),
    true,
  );
});

test('each domain independently invalidates wall/monotonic jumps, expiry and excessive RTT', () => {
  for (const kind of ['client-wall', 'remote-wall', 'remote-mono', 'expiry', 'rtt']) {
    const endpoint = new ClockDomain(),
      control = new ClockDomain();
    endpoint.calibrate(0, 1000, 10, 1010, 705, 500);
    control.calibrate(0, 1000, 10, 1010, 1505);
    if (kind === 'client-wall') assert.equal(endpoint.mapping(100, 1500), undefined);
    if (kind === 'remote-wall') assert.equal(endpoint.calibrate(5000, 6000, 5010, 6010, 6205, 5500), false);
    if (kind === 'remote-mono') assert.equal(endpoint.calibrate(5000, 6000, 5010, 6010, 5705, 5400), false);
    if (kind === 'expiry') assert.equal(endpoint.mapping(16000, 17000), undefined);
    if (kind === 'rtt') {
      const cold = new ClockDomain();
      assert.equal(cold.calibrate(0, 1000, 60, 1060, 730, 525), false);
      assert.equal(cold.mapping(60, 1060), undefined);
    }
    assert.deepEqual(control.mapping(100, 1100), { wall: 1600, uncertainty: 6 });
  }
});

test('local clock discontinuity cancels pending nonce and immediately permits resampling', () => {
  for (const next of [
    [5, 1015],
    [20, 1500],
  ]) {
    const probe = new ClockProbe(new ClockDomain());
    const first = probe.begin(10, 1010)!;
    const retry = probe.begin(next[0], next[1])!;
    assert.ok(retry);
    assert.notEqual(first.requestId, retry.requestId);
    assert.equal(probe.complete(first.requestId, next[0] + 10, next[1] + 10, 705, 500), false);
  }
});
