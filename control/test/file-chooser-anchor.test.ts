import test from 'node:test';
import assert from 'node:assert/strict';
import type { FileRequestAnchor } from '../shared/product';
import { placeFileChooser, projectFileInput } from '../client/files/file-chooser-anchor';
import type { Layout, Surface } from '../client/presentation/types';

const surface: Surface = {
  id: 'view',
  session: 'session',
  instance: '7',
  document: '10',
  focus: 'token',
  x: 88,
  y: 40,
  width: 900,
  height: 600,
  deviceScaleFactor: 1.5,
};
const layout: Layout = {
  type: 'layout',
  generation: '4',
  epoch: '8',
  width: 1200,
  height: 900,
  views: [surface],
};
const anchor: FileRequestAnchor = {
  instance: '7',
  document: '10',
  layoutGeneration: '4',
  deviceScaleFactor: 1.5,
  x: 45,
  y: 50,
  width: 100,
  height: 32,
  viewportWidth: 600,
  viewportHeight: 400,
};
const bounds = { left: 120, top: 180, width: 600, height: 400 };

test('file input anchor projects remote DIP independent of atlas offset and sampling', () => {
  const expected = { left: 165, top: 230, width: 100, height: 32 };
  assert.deepEqual(projectFileInput(anchor, layout, surface, bounds), expected);
  assert.deepEqual(
    projectFileInput(
      anchor,
      layout,
      { ...surface, width: 450, height: 450, mediaScaleX: 0.5, mediaScaleY: 0.75 },
      bounds,
    ),
    expected,
  );
});
test('stale identity, scale, remote bounds and resizing fall back to the unanchored dialog', () => {
  for (const mismatched of [
    { instance: '8' },
    { document: '11' },
    { layoutGeneration: '5' },
    { deviceScaleFactor: 1 },
    { viewportWidth: 550 },
    { x: 550 },
    { y: -1 },
  ]) {
    assert.equal(projectFileInput({ ...anchor, ...mismatched }, layout, surface, bounds), undefined);
  }
  assert.equal(projectFileInput(anchor, { ...layout, reconfiguring: true }, surface, bounds), undefined);
  assert.equal(projectFileInput(anchor, layout, { ...surface, stale: true }, bounds), undefined);
  assert.equal(projectFileInput(anchor, layout, surface, { ...bounds, height: 330 }), undefined);
});
test('chooser stays in visual bounds, prefers below and can flip above without covering the input', () => {
  const viewport = { left: 10, top: 100, width: 700, height: 600 };
  assert.deepEqual(placeFileChooser({ left: 500, top: 160, width: 100, height: 30 }, viewport), {
    width: 360,
    left: 338,
    top: 198,
    maxHeight: 420,
    above: false,
  });
  assert.deepEqual(placeFileChooser({ left: 100, top: 660, width: 100, height: 30 }, viewport), {
    width: 360,
    left: 100,
    top: 652,
    maxHeight: 420,
    above: true,
  });
  assert.equal(placeFileChooser({ left: 100, top: 680, width: 100, height: 30 }, viewport), undefined);
  const compactViewport = { left: 0, top: 0, width: 568, height: 320 };
  assert.deepEqual(placeFileChooser({ left: 100, top: 104, width: 100, height: 40 }, compactViewport), {
    width: 360,
    left: 100,
    top: 152,
    maxHeight: 156,
    above: false,
  });
  assert.equal(placeFileChooser({ left: 100, top: 105, width: 100, height: 40 }, compactViewport), undefined);
});
