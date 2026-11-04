import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardViewport, ViewportTransition, resizeSnapshotSize, visibleContentBounds, FREEZE_MAX_MS, FREEZE_MAX_PIXELS, surfaceMatchesViewport } from '../client/viewport-transition';

test('only full keyboard-height restoration counts as a system keyboard dismissal', () => {
  const keyboard = new KeyboardViewport();
  const viewport = (height: number, width = 390) => ({
    visual: { height, width, offsetLeft: 0, offsetTop: 0 },
    layoutWidth: width, layoutHeight: 844, scale: 1,
  });
  keyboard.measure(viewport(844), true, true);
  keyboard.measure(viewport(445), true, true);
  keyboard.measure(viewport(625), true, true);
  assert.equal(keyboard.open, true);
  assert.equal(keyboard.restoreCount, 0);
  keyboard.measure(viewport(844), true, true);
  assert.equal(keyboard.open, false);
  assert.equal(keyboard.restoreCount, 1);
  keyboard.measure(viewport(440), true, true);
  keyboard.measure(viewport(440, 480), true, true);
  assert.equal(keyboard.open, false);
  assert.equal(keyboard.restoreCount, 1);
});
const old = { left: 0, top: 80, width: 390, height: 764 }, small = { ...old, height: 364 };
test('visual viewport offset and size intersect actual content bounds', () => {
  assert.deepEqual(visibleContentBounds(old, { offsetLeft: 10, offsetTop: 100, width: 350, height: 400 }), { left: 10, top: 100, width: 350, height: 400 });
  assert.deepEqual(visibleContentBounds(old, { offsetLeft: 0, offsetTop: 0, width: 390, height: 444 }), small);
});
test('one fixed copy spans keyboard animation and clears only on the new desired presentation', () => {
  const state = new ViewportTransition(); state.ready('peer/doc', '1', old);
  assert.ok(state.begin('peer/doc', small, 100, 390 * 764, true));
  assert.deepEqual(state.freeze?.bounds, old);
  assert.equal(state.begin('peer/doc', { ...small, height: 300 }, 200, 100, true), false);
  state.ready('peer/doc', '2', small); assert.ok(state.freeze);
  state.ready('peer/doc', '3', { ...small, height: 300 }); assert.equal(state.freeze, undefined);
});
test('freeze expiry, document/peer invalidation and pixel budget never manufacture ready', () => {
  const state = new ViewportTransition(); state.ready('peer/doc', '1', old);
  assert.equal(state.begin('peer/doc', small, 0, FREEZE_MAX_PIXELS + 1, true), false);
  assert.equal(state.begin('peer/doc', small, 0, 100, false), false);
  assert.ok(state.begin('peer/doc', small, 0, 100, true));
  state.invalidate('peer/doc', FREEZE_MAX_MS); assert.equal(state.freeze, undefined);
  assert.equal(state.confirmed?.layout, '1');
  assert.ok(state.begin('peer/doc', small, 2000, 100, true));
  state.invalidate('other-peer/doc', 2001); assert.equal(state.freeze, undefined); assert.equal(state.confirmed, undefined);
});

test('viewport readiness checks both exact sampling axes and rejects old geometry', () => {
  const surface = { id: '1', session: 's', instance: 'i', document: 'd', focus: 'f', x: 0, y: 0,
    width: 800, height: 594, deviceScaleFactor: 2, mediaScale: .495, mediaScaleX: .5, mediaScaleY: .495 };
  assert.ok(surfaceMatchesViewport(surface, { width: 800, height: 600 }));
  assert.equal(surfaceMatchesViewport({ ...surface, mediaScaleX: .495 }, { width: 800, height: 600 }), false);
  assert.equal(surfaceMatchesViewport(surface, { width: 800, height: 500 }), false);
  assert.equal(surfaceMatchesViewport({ ...surface, mediaScaleY: NaN }, { width: 800, height: 600 }), false);
});
test('keyboard peek follows vertical occlusion and its release even after editor blur', () => {
  const keyboard = new KeyboardViewport();
  const viewport = (height: number, layoutHeight = 844, width = 390) => ({
    visual: { width, height, offsetLeft: 0, offsetTop: 0 }, scale: 1, layoutWidth: width, layoutHeight,
  });
  assert.equal(keyboard.measure(viewport(844), true, false), false);
  assert.equal(keyboard.measure(viewport(444), true, false), true);
  assert.equal(keyboard.measure(viewport(844), false, false), true);
  assert.equal(keyboard.measure(viewport(444), false, true), false);
  assert.equal(keyboard.measure(viewport(400, 844, 450), true, true), false);
  assert.equal(keyboard.measure(viewport(350, 350, 450), true, false), false);
  assert.equal(keyboard.measure(viewport(300, 300, 450), true, true), true);
  assert.equal(keyboard.measure(viewport(350, 350, 450), false, true), true);
  assert.equal(keyboard.measure(viewport(350, 300, 450), true, true), true);
});
test('CSS content height changes alone use the ordinary preview, even while the keyboard is open', () => {
  const keyboard = new KeyboardViewport();
  const viewport = { visual: { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 }, scale: 1, layoutWidth: 390, layoutHeight: 844 };
  keyboard.measure(viewport, true, true);
  assert.equal(keyboard.measure({ ...viewport }, true, true), false);
  const occluded = { ...viewport, visual: { ...viewport.visual, height: 444 } };
  assert.equal(keyboard.measure(occluded, true, true), true);
  assert.equal(keyboard.measure({ ...occluded }, true, true), false);
  assert.equal(keyboard.open, true);
  assert.equal(keyboard.measure(viewport, false, true), true);
});
test('panning a keyboard-shrunk viewport preserves keyboard state without another peek', () => {
  const keyboard = new KeyboardViewport();
  const layout = { scale: 1, layoutWidth: 390, layoutHeight: 844 };
  const visual = { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 };
  assert.equal(keyboard.measure({ ...layout, visual }, true, false), false);
  const panned = { ...visual, height: 444, offsetTop: 400 };
  assert.equal(keyboard.measure({ ...layout, visual: panned }, true, false), true);
  assert.equal(keyboard.measure({ ...layout, visual: { ...panned, offsetTop: 385, offsetLeft: 1 } }, true, false), false);
  assert.equal(keyboard.open, true);
  assert.equal(keyboard.measure({ ...layout, visual }, false, false), true);
  assert.equal(keyboard.open, false);
});
test('pinch zoom is not a keyboard preview even while an editor is focused', () => {
  const keyboard = new KeyboardViewport();
  const layout = { layoutWidth: 390, layoutHeight: 844 };
  const visual = { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 };
  keyboard.measure({ ...layout, scale: 1, visual }, true, true);
  assert.equal(keyboard.measure({ ...layout, scale: 2, visual: { ...visual, width: 195, height: 422 } }, true, true), false);
  assert.equal(keyboard.open, false);
});
test('oversized preview downscales within its pixel budget', () => {
  assert.deepEqual(resizeSnapshotSize(390, 764), { width: 390, height: 764 });
  assert.deepEqual(resizeSnapshotSize(4096, 4096), { width: 2048, height: 2048 });
  assert.equal(resizeSnapshotSize(0, 764), undefined);
});
