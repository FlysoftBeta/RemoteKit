import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewportTransition, visibleContentBounds, FREEZE_MAX_MS, FREEZE_MAX_PIXELS, surfaceMatchesViewport } from '../client/viewport-transition';
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
