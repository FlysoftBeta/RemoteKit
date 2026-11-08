import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KeyboardViewport,
  ResizePreview,
  ViewportTransition,
  pixelAlignedViewportBounds,
  resizeSnapshotSize,
  visibleContentBounds,
  FREEZE_MAX_PIXELS,
  surfaceMatchesViewport,
} from '../client/presentation/viewport-transition';

const viewport = (height: number, layoutHeight = 844, width = 390) => ({
  visual: { height, width, offsetLeft: 0, offsetTop: 0 },
  layoutWidth: width,
  layoutHeight,
  scale: 1,
});

test('only settled full height restoration reports a system dismissal', () => {
  const keyboard = new KeyboardViewport();
  keyboard.measure(viewport(844), true, true, 0);
  assert.equal(keyboard.measure(viewport(445), true, true, 1), 'keyboard');
  keyboard.measure(viewport(625), true, true, 10);
  assert.equal(keyboard.open, true);
  keyboard.measure(viewport(844), true, true, 20);
  assert.equal(keyboard.settle(30), false);
  keyboard.measure(viewport(445), true, true, 31);
  assert.equal(keyboard.settle(160), false, 'restore before a new shrink is inconclusive');
  keyboard.measure(viewport(844), true, true, 200);
  assert.equal(keyboard.settle(340), true);
  assert.equal(keyboard.open, false);
  assert.equal(keyboard.dismissals, 1);
});
const old = { left: 0, top: 80, width: 390, height: 764 },
  small = { ...old, height: 364 };
test('fractional split bounds keep integer DIP sizes and device pixel origins', () => {
  assert.deepEqual(pixelAlignedViewportBounds({ left: 802.5, top: 40, width: 797.5, height: 844 }, 1, 1), {
    left: 803,
    top: 40,
    width: 798,
    height: 844,
  });
  assert.deepEqual(
    pixelAlignedViewportBounds({ left: 100.4, top: 50.4, width: 500.1, height: 300 }, 1.25, 2),
    { left: 80.4, top: 40.4, width: 400, height: 240 },
  );
  assert.deepEqual(
    pixelAlignedViewportBounds({ left: 802.5, top: 40, width: 797.5, height: 844 }, 1, 1.0000000298023224),
    { left: 803, top: 40, width: 798, height: 844 },
  );
});
test('visual viewport offset and size intersect actual content bounds', () => {
  assert.deepEqual(visibleContentBounds(old, { offsetLeft: 10, offsetTop: 100, width: 350, height: 400 }), {
    left: 10,
    top: 100,
    width: 350,
    height: 400,
  });
  assert.deepEqual(
    visibleContentBounds(old, { offsetLeft: 0, offsetTop: 0, width: 390, height: 444 }),
    small,
  );
});
test('one fixed copy spans keyboard animation and clears only on the new desired presentation', () => {
  const state = new ViewportTransition();
  state.ready('peer/doc', '1', old);
  assert.ok(state.begin('peer/doc', small, 390 * 764, true));
  assert.deepEqual(state.freeze?.bounds, old);
  assert.equal(state.begin('peer/doc', { ...small, height: 300 }, 100, true), false);
  assert.equal(state.ready('peer/doc', '2', small), false);
  assert.equal(state.confirmed?.layout, '1');
  assert.ok(state.freeze);
  state.ready('peer/doc', '3', { ...small, height: 300 });
  assert.equal(state.freeze, undefined);
});
test('slow recovery retains the preview; document/peer invalidation and pixel budget never manufacture ready', () => {
  const state = new ViewportTransition();
  state.ready('peer/doc', '1', old);
  assert.equal(state.begin('peer/doc', small, FREEZE_MAX_PIXELS + 1, true), false);
  assert.equal(state.begin('peer/doc', small, 100, false), false);
  assert.ok(state.begin('peer/doc', small, 100, true));
  state.invalidate('peer/doc');
  assert.ok(state.freeze);
  assert.equal(state.confirmed?.layout, '1');
  assert.equal(state.begin('peer/doc', small, 100, true), false);
  state.invalidate('other-peer/doc');
  assert.equal(state.freeze, undefined);
  assert.equal(state.confirmed, undefined);
});

test('viewport readiness checks both exact sampling axes and rejects old geometry', () => {
  const surface = {
    id: '1',
    session: 's',
    instance: 'i',
    document: 'd',
    focus: 'f',
    x: 0,
    y: 0,
    width: 800,
    height: 594,
    deviceScaleFactor: 2,
    mediaScale: 0.495,
    mediaScaleX: 0.5,
    mediaScaleY: 0.495,
  };
  assert.ok(surfaceMatchesViewport(surface, { width: 800, height: 600 }));
  assert.equal(
    surfaceMatchesViewport({ ...surface, mediaScaleX: 0.495 }, { width: 800, height: 600 }),
    false,
  );
  assert.equal(surfaceMatchesViewport(surface, { width: 800, height: 500 }), false);
  assert.equal(surfaceMatchesViewport({ ...surface, mediaScaleY: NaN }, { width: 800, height: 600 }), false);
  const downsampled = {
    ...surface,
    width: 534,
    height: 282,
    deviceScaleFactor: 1,
    mediaScaleX: 1 / 3,
    mediaScaleY: 1 / 3,
  };
  assert.ok(surfaceMatchesViewport(downsampled, { width: 1600, height: 844 }));
  assert.equal(surfaceMatchesViewport(downsampled, { width: 1590, height: 844 }), false);
});
test('simultaneous layout and visual viewport shrink is classified on coarse pointers', () => {
  const keyboard = new KeyboardViewport();
  keyboard.measure(viewport(844), true, true, 0);
  assert.equal(keyboard.measure(viewport(843, 843), true, true, 1), undefined);
  assert.equal(keyboard.measure(viewport(842, 842), true, true, 2), undefined);
  assert.equal(keyboard.open, false);
  assert.equal(keyboard.measure(viewport(450, 450), true, true, 3), 'keyboard');
  assert.equal(
    keyboard.measure(viewport(844, 450), true, true, 4),
    undefined,
    'use the smaller viewport during interleaved restoration',
  );
  assert.equal(keyboard.measure(viewport(844), false, true, 5), 'keyboard');
  assert.equal(keyboard.settle(145), true);
});

test('viewport event followed by repeated geometry and then content resize keeps the peek', () => {
  const preview = new ResizePreview();
  assert.equal(preview.measure(false, 'keyboard', 1), false);
  preview.complete(); // An old ready frame before content resize is not completion.
  assert.equal(preview.measure(false, undefined, 2), false);
  assert.equal(preview.measure(true, undefined, 3), true);
  assert.equal(preview.measure(false, undefined, 4), true);
  assert.equal(preview.measure(true, undefined, 2000), true, 'delayed content updates retain the IME cause');
  preview.clear(); // A matching new frame completes the transition.
  assert.equal(preview.measure(true, undefined, 200), false, 'unrelated content resize uses stretch');
});

test('viewport event can reclassify a content-first preview without copying again', () => {
  const preview = new ResizePreview();
  assert.equal(preview.measure(true, undefined, 1), false);
  assert.equal(preview.measure(false, 'keyboard', 2), true);
  assert.equal(preview.measure(false, undefined, 3), true);
  assert.equal(preview.measure(true, 'ordinary', 4), false);
});

test('resize reversal can return to the authorized size without waiting for a new server layout', () => {
  const state = new ViewportTransition();
  state.ready('doc', '1', old);
  assert.ok(state.begin('doc', small, 100, true));
  assert.equal(state.begin('doc', old, 100, true), false);
  state.ready('doc', '1', old);
  assert.equal(state.freeze, undefined);
});

test('offset-only measurements preserve keyboard state without starting a new preview', () => {
  const keyboard = new KeyboardViewport();
  keyboard.measure(viewport(844), true, false, 0);
  const panned = viewport(444);
  assert.equal(keyboard.measure(panned, true, false, 1), 'keyboard');
  panned.visual = { ...panned.visual, offsetTop: 385, offsetLeft: 1 };
  assert.equal(keyboard.measure(panned, true, false, 2), undefined);
  assert.equal(keyboard.open, true);
  assert.equal(keyboard.deadline, undefined);
});

test('pinch zoom and orientation resets do not report a keyboard dismissal', () => {
  for (const changed of [{ ...viewport(422, 844, 195), scale: 2 }, viewport(390, 390, 844)]) {
    const keyboard = new KeyboardViewport();
    keyboard.measure(viewport(844), true, true, 0);
    keyboard.measure(viewport(444), true, true, 1);
    assert.equal(keyboard.measure(changed, true, true, 2), 'ordinary');
    assert.equal(keyboard.settle(500), false);
    assert.equal(keyboard.dismissals, 0);
  }
});
test('oversized preview downscales within its pixel budget', () => {
  assert.deepEqual(resizeSnapshotSize(390, 764), { width: 390, height: 764 });
  assert.deepEqual(resizeSnapshotSize(4096, 4096), { width: 2048, height: 2048 });
  assert.equal(resizeSnapshotSize(0, 764), undefined);
});
