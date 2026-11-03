import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPointToDip, pointerPointToDip, markerSourceRect, surfacePixelScale, surfaceDipSize, wheelDeltaToDip } from '../client/coordinates';
import type { Surface } from '../client/types';
test('client coordinates and marker regions combine DPR with independent media sampling', () => {
  const surface: Surface = { id: '1', session: '1', instance: '1', document: '1', focus: '1', x: 4, y: 8, width: 820, height: 1180, deviceScaleFactor: 2, mediaScale: .5 };
  assert.equal(surfacePixelScale(surface), 1);
  assert.deepEqual(clientPointToDip(surface, { left: 20, top: 40, width: 410, height: 590 }, 225, 335), { x: 410, y: 590 });
  assert.deepEqual(markerSourceRect(surface), { x: 4, y: 8, width: 256, height: 112 });
  assert.equal(surfacePixelScale({ deviceScaleFactor: 1.25, mediaScale: .5 }), .625);
  assert.equal(surfacePixelScale({ deviceScaleFactor: 2 }), 2);
});

test('leave clamps, captured gestures preserve outside coordinates, and ordinary input rejects them', () => {
  const surface: Surface = { id: '2', session: '1', instance: '3', document: '4', focus: '5', x: 4, y: 8, width: 1230, height: 1770, deviceScaleFactor: 2, mediaScale: .75 };
  const rect = { left: 20, top: 40, width: 410, height: 590 };
  assert.equal(clientPointToDip(surface, rect, 450, 335), null);
  assert.deepEqual(clientPointToDip(surface, rect, 450, 335, 'clamp'), { x: 820, y: 590 });
  assert.deepEqual(clientPointToDip(surface, rect, 10, 650, 'clamp'), { x: 0, y: 1180 });
  assert.equal(clientPointToDip(surface, { ...rect, width: 0 }, 450, 335, 'clamp'), null);
  assert.equal(clientPointToDip(surface, rect, NaN, 335, 'clamp'), null);
  // A new layout uses its own current geometry, never a cached old-layout point.
  assert.deepEqual(clientPointToDip({ ...surface, width: 600, height: 300 }, rect, 450, 335, 'clamp'), { x: 400, y: 100 });
  // Preserve drag/edge scrolling and terminal coordinates beyond the canvas.
  for (const action of ['move', 'up', 'cancel'] as const) {
    assert.deepEqual(pointerPointToDip(surface, rect, 450, 335, action, true), { x: 860, y: 590 });
    assert.equal(pointerPointToDip(surface, rect, 450, 335, action, false), null);
  }
  assert.equal(pointerPointToDip(surface, { ...rect, width: 0 }, 450, 335, 'move', true), null);
  assert.equal(pointerPointToDip(surface, rect, Infinity, 335, 'up', true), null);
  assert.deepEqual(pointerPointToDip(surface, rect, 450, 335, 'leave', false), { x: 820, y: 590 });
});

test('different X/Y adaptation preserves exact DIP input, marker ROI and page wheel distances', () => {
  // AdaptFrame alignment can round each encoded axis by a different ratio.
  const surface: Surface = { id: '1', session: '1', instance: '1', document: '1', focus: '1', x: 4, y: 8,
    width: 800, height: 594, deviceScaleFactor: 2, mediaScale: .495, mediaScaleX: .5, mediaScaleY: .495 };
  assert.deepEqual(surfaceDipSize(surface), { width: 800, height: 600 });
  assert.deepEqual(clientPointToDip(surface, { left: 20, top: 40, width: 400, height: 300 }, 220, 190), { x: 400, y: 300 });
  assert.deepEqual(markerSourceRect(surface), { x: 4, y: 8, width: 256, height: 110.88 });
  assert.deepEqual(wheelDeltaToDip(surface, 1, -2, 2), { x: 800, y: -1200 });
  assert.deepEqual(wheelDeltaToDip(surface, 1, -2, 1), { x: 16, y: -32 });
  assert.deepEqual(wheelDeltaToDip(surface, 1, -2, 0), { x: 1, y: -2 });
  assert.deepEqual(clientPointToDip({ ...surface, mediaScaleY: 0 }, { left: 0, top: 0, width: 400, height: 300 }, 200, 150), null);
});
