import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPointToDip, pointerPointToDip, markerSourceRect, surfacePixelScale } from '../client/coordinates';
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
