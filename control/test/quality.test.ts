import test from 'node:test';
import assert from 'node:assert/strict';
import { QualityState } from '../server/quality';
import { emptyWorkspace } from '../server/persistence/workspaces';
const workspace = () => ({
  ...emptyWorkspace('tenant'),
  windows: [{ id: 'w', appId: 'browser', activeTabId: 'tab', lastActiveAt: 1 }],
  spaces: [{ id: 'space', windowIds: ['w'], weights: [1], focusedWindowId: 'w', lastActiveAt: 1 }],
  activeSpaceId: 'space',
});
const viewport = {
  devicePixelRatio: 1,
  windows: [{ windowId: 'w', width: 800, height: 600, visible: true }],
};
const feedback = (sequence: number, now: number, latency = 400) => ({
  sequence,
  sourceCaptureId: String(sequence),
  sampledAtServerMs: now,
  visible: true,
  presentationLatencyMs: latency,
  latencySource: 'capture-end-to-paint',
  clockUncertaintyMs: 2,
  sampleCount: 50,
  windowMs: 2000,
});

test('quality choices only select WebRTC degradation preference', () => {
  const state = workspace(),
    quality = new QualityState(),
    measured = {
      ...viewport,
      devicePixelRatio: 2,
      windows: [{ windowId: 'w', width: 1920, height: 1080, visible: true }],
    };
  for (const [preference, degradationPreference] of [
    ['quality', 'maintain-resolution'],
    ['auto', 'balanced'],
    ['smooth', 'maintain-framerate'],
  ] as const) {
    state.settings.workspace.qualityPreference = preference;
    const result = quality.snapshot(state, measured, 100);
    assert.equal(result.effectiveDpr, 2);
    assert.deepEqual(result.requested, { degradationPreference, maxFps: 60, audio: true });
    for (const obsolete of ['baseResolutionFactor', 'adaptiveResolutionFactor', 'pixelBudget', 'targetFps'])
      assert.equal(obsolete in result, false);
    assert.equal(measured.windows[0].width, 1920);
  }
});

test('pages render at the reported Viewer DPR regardless of UI scale, preference and feedback', () => {
  const state = workspace(),
    quality = new QualityState();
  // The Viewer already reports devicePixelRatio × UI scale; the setting is not applied twice.
  state.settings.workspace.uiScale = 2;
  const measured = { ...viewport, devicePixelRatio: 1.5, refreshHz: 120.9 };
  assert.deepEqual(quality.snapshot(state, measured).requested, {
    degradationPreference: 'balanced',
    audio: true,
    maxFps: 120,
  });
  for (let sequence = 1; sequence <= 30; sequence++) {
    const now = 100000 + sequence * 2000;
    assert.equal(
      quality.observe(
        { ...feedback(sequence, now, sequence < 15 ? 1000 : 100), displayHzEstimate: 30 },
        now,
        true,
      ),
      true,
    );
    const result = quality.snapshot(state, measured, now);
    assert.equal(result.effectiveDpr, 1.5);
    assert.equal(result.requested.maxFps, 120);
    assert.equal(result.estimatedLatencyMs, sequence < 15 ? 1000 : 100);
  }
});

test('high refresh displays retain their measured capability while policy respects the SDK FPS ceiling', () => {
  const quality = new QualityState(),
    state = workspace();
  for (const refreshHz of [240, 360, 500]) {
    const measured = { ...viewport, refreshHz };
    assert.deepEqual(quality.snapshot(state, measured).requested, {
      degradationPreference: 'balanced',
      audio: true,
      maxFps: 240,
    });
    assert.equal(measured.refreshHz, refreshHz);
  }
});

test('all preferences retain client DPR until the physical atlas allocation bound', () => {
  const state = workspace(),
    measured = {
      devicePixelRatio: 2,
      windows: [{ windowId: 'w', width: 2560, height: 1440, visible: true }],
    };
  for (const preference of ['quality', 'auto', 'smooth'] as const) {
    state.settings.workspace.qualityPreference = preference;
    assert.equal(new QualityState().snapshot(state, measured).effectiveDpr, 2);
    assert.ok(
      new QualityState().snapshot(state, {
        ...measured,
        windows: [{ windowId: 'w', width: 8192, height: 4096, visible: true }],
      }).effectiveDpr < 1,
    );
  }
});

test('feedback validates fresh source, clock and visibility solely for diagnostic observations', () => {
  const quality = new QualityState(),
    state = workspace();
  assert.equal(quality.observe(feedback(1, 100000), 100000, true), true);
  assert.equal(quality.snapshot(state, viewport, 100000).feedbackStatus, 'valid');
  assert.equal(quality.observe({ ...feedback(2, 102000), sourceCaptureId: '1' }, 102000, true), false);
  assert.equal(quality.observe({ ...feedback(3, 104000), clockUncertaintyMs: 26 }, 104000, true), false);
  assert.equal(quality.observe(feedback(4, 100000), 106001, true), false);
  assert.equal(quality.observe(feedback(5, 108000), 108000, false), false);
  assert.equal(quality.snapshot(state, viewport, 108000).feedbackStatus, 'stale');
  assert.equal(quality.snapshot(state, viewport, 1000).feedbackStatus, 'stale');
  quality.resetFeedback();
  assert.equal(quality.snapshot(state, viewport, 108000).feedbackStatus, 'unknown');
  assert.equal(quality.observe(feedback(1, 110000), 110000, true), true);
});

test('audio policy follows either selected output channel', () => {
  const state = workspace(),
    quality = new QualityState();
  for (const left of [false, true])
    for (const right of [false, true]) {
      state.settings.workspace.audioChannels = { left, right };
      assert.equal(quality.snapshot(state, viewport).requested.audio, left || right);
    }
});
