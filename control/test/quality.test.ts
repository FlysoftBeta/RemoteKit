import test from 'node:test';
import assert from 'node:assert/strict';
import { QualityController } from '../server/quality';
import { emptyWorkspace } from '../server/store';
const workspace = () => ({ ...emptyWorkspace('tenant'), windows: [{ id: 'w', activeTabId: 'tab', weight: 1 }], activeWindowId: 'w' });
const viewport = { devicePixelRatio: 1, windows: [{ windowId: 'w', width: 800, height: 600, visible: true }] };
const feedback = (sequence: number, now: number, latency = 400) => ({ sequence, sourceCaptureId: String(sequence), sampledAtServerMs: now, visible: true, presentationLatencyMs: latency, latencySource: 'capture-end-to-paint', clockUncertaintyMs: 2, sampleCount: 50, windowMs: 2000 });

test('three presets share measured CSS area/pixel budget and keep DIP geometry independent', () => {
  const state = workspace(), controller = new QualityController(), measured = { devicePixelRatio: 2, windows: [{ windowId: 'w', width: 1920, height: 1080, visible: true }] };
  let q = controller.snapshot(state, measured, 100); assert.equal(q.effectiveDpr, 1); assert.equal(q.baseResolutionFactor, .5); assert.equal(q.targetFps, 52); assert.equal(q.requested.bitrateKbps, 36000);
  state.settings.qualityPreference = 'quality'; q = controller.snapshot(state, measured, 100); assert.equal(q.effectiveDpr, 2); assert.equal(q.targetFps, 50); assert.equal(q.requested.maxBitrateKbps, 48000);
  state.settings.qualityPreference = 'smooth'; q = controller.snapshot(state, { ...measured, refreshHz: 45 }, 100); assert.equal(q.targetFps, 60);
  controller.observe({ ...feedback(1, 100, 200), displayHzEstimate: 45 }, 100, true); q = controller.snapshot(state, measured, 100); assert.equal(q.targetFps, 45); assert.equal(q.requested.bitrateKbps, 24000); assert.ok(q.effectiveDpr < 1); assert.equal(measured.windows[0].width, 1920);
});

test('quality retains requested DPR beyond 4K area until the physical atlas resource bound', () => {
  const state = workspace(); state.settings.qualityPreference = 'quality';
  const q = new QualityController().snapshot(state, { devicePixelRatio: 2, windows: [{ windowId: 'w', width: 2560, height: 1440, visible: true }] });
  assert.equal(q.effectiveDpr, 2); assert.equal(q.baseResolutionFactor, 1);
  assert.equal(q.requested.preferResolution, true); assert.equal(q.requested.targetFps, 50);
  state.settings.qualityPreference = 'auto';
  assert.equal(new QualityController().snapshot(state, viewport).requested.preferResolution, false);
});

test('three fresh high windows reduce by .8, cooldown holds and 30 healthy seconds restore one step', () => {
  const controller = new QualityController(), state = workspace(); controller.snapshot(state, viewport, 100000);
  for (let i = 1; i <= 2; i++) controller.observe(feedback(i, 100000 + i * 2000), 100000 + i * 2000, true);
  assert.equal(controller.snapshot(state, viewport, 104000).adaptiveResolutionFactor, 1);
  controller.observe(feedback(3, 106000), 106000, true); assert.equal(controller.snapshot(state, viewport, 106000).adaptiveResolutionFactor, .8);
  // Wall-clock advancement cannot bypass the server's monotonic cooldown.
  for (let i = 4; i <= 6; i++) controller.observe(feedback(i, 106000 + (i - 3) * 2000), 106000 + (i - 3) * 2000, true, 106000 + (i - 3) * 1000); assert.equal(controller.snapshot(state, viewport, 112000).adaptiveResolutionFactor, .8);
  let sequence = 7; for (let now = 114000; now <= 144000; now += 2000) controller.observe(feedback(sequence++, now, 100), now, true, now - 3000);
  assert.equal(controller.snapshot(state, viewport, 144000).adaptiveResolutionFactor, 1);
});

test('static repeated source, missing/stale clock, uncertainty and hidden windows cannot reduce or restore', () => {
  const controller = new QualityController(), state = workspace(); controller.snapshot(state, viewport, 100000);
  assert.equal(controller.observe(feedback(1, 100000), 100000, true), true);
  for (let i = 2; i <= 6; i++) assert.equal(controller.observe({ ...feedback(i, 100000 + i * 2000), sourceCaptureId: '1' }, 100000 + i * 2000, true), false);
  assert.equal(controller.observe({ ...feedback(7, 116000), clockUncertaintyMs: 26 }, 116000, true), false);
  assert.equal(controller.observe({ ...feedback(8, 116000), clockUncertaintyMs: undefined }, 116000, true), false);
  assert.equal(controller.observe(feedback(9, 110000), 116001, true), false);
  assert.equal(controller.observe(feedback(10, 118000), 118000, false), false);
  assert.equal(controller.snapshot(state, viewport, 118000).adaptiveResolutionFactor, 1);
  controller.resetConnection(); for (let i = 1; i <= 3; i++) controller.observe(feedback(i, 120000 + i * 2000), 120000 + i * 2000, true); assert.equal(controller.snapshot(state, viewport, 126000).adaptiveResolutionFactor, .8);
  for (let i = 4; i <= 25; i++) controller.observe({ ...feedback(i, 126000 + i * 2000, 100), sampleCount: 0 }, 126000 + i * 2000, true);
  assert.equal(controller.snapshot(state, viewport, 176000).adaptiveResolutionFactor, .8);
});

test('DPR floor bounds degradation, RTC reset preserves factor, Viewer reset clears it and clock jumps do not create freshness', () => {
  const controller = new QualityController(), state = workspace(); controller.snapshot(state, viewport, 100000);
  for (let i = 1; i <= 30; i++) controller.observe(feedback(i, 100000 + i * 2000), 100000 + i * 2000, true);
  const q = controller.snapshot(state, viewport, 160000); assert.equal(q.effectiveDpr, .5); assert.equal(q.adaptiveResolutionFactor, .5);
  assert.equal(controller.snapshot(state, viewport, 1000).feedbackStatus, 'stale'); controller.resetFeedback(); assert.equal(controller.snapshot(state, viewport, 160000).adaptiveResolutionFactor, .5); controller.resetConnection(); assert.equal(controller.snapshot(state, viewport, 160000).adaptiveResolutionFactor, 1);
});
