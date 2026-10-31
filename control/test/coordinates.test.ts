import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPointToDip, markerSourceRect, surfacePixelScale } from '../client/coordinates';
import type { Surface } from '../client/types';
test('client coordinates and marker regions combine DPR with independent media sampling', () => {
  const surface: Surface = { id: '1', session: '1', instance: '1', document: '1', focus: '1', x: 4, y: 8, width: 820, height: 1180, deviceScaleFactor: 2, mediaScale: .5 };
  assert.equal(surfacePixelScale(surface), 1);
  assert.deepEqual(clientPointToDip(surface, { left: 20, top: 40, width: 410, height: 590 }, 225, 335), { x: 410, y: 590 });
  assert.deepEqual(markerSourceRect(surface), { x: 4, y: 8, width: 256, height: 112 });
  assert.equal(surfacePixelScale({ deviceScaleFactor: 1.25, mediaScale: .5 }), .625);
  assert.equal(surfacePixelScale({ deviceScaleFactor: 2 }), 2);
});
