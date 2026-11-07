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
  assert.deepEqual(projectFileInput(anchor, layout, surface, bounds, 1), expected);
  assert.deepEqual(
    projectFileInput(
      anchor,
      layout,
      { ...surface, width: 450, height: 450, mediaScaleX: 0.5, mediaScaleY: 0.75 },
      bounds,
      1,
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
    assert.equal(projectFileInput({ ...anchor, ...mismatched }, layout, surface, bounds, 1), undefined);
  }
  assert.equal(projectFileInput(anchor, { ...layout, reconfiguring: true }, surface, bounds, 1), undefined);
  assert.equal(projectFileInput(anchor, layout, { ...surface, stale: true }, bounds, 1), undefined);
  assert.equal(projectFileInput(anchor, layout, surface, { ...bounds, height: 330 }, 1), undefined);
});
test('scaled file input validates layout dimensions and projects into visual pixels', () => {
  for (const scale of [0.75, 1.5]) {
    const visual = Object.fromEntries(
      Object.entries(bounds).map(([key, value]) => [key, value * scale]),
    ) as typeof bounds;
    assert.deepEqual(projectFileInput(anchor, layout, surface, visual, scale), {
      left: 165 * scale,
      top: 230 * scale,
      width: 100 * scale,
      height: 32 * scale,
    });
    assert.equal(
      projectFileInput(anchor, layout, surface, { ...visual, height: 330 * scale }, scale),
      undefined,
    );
  }
});
test('chooser stays in visual bounds, prefers below and can flip above without covering the input', () => {
  const viewport = { left: 10, top: 100, width: 700, height: 600 };
  assert.deepEqual(placeFileChooser({ left: 500, top: 160, width: 100, height: 30 }, viewport, 1), {
    width: 420,
    left: 278,
    top: 198,
    maxHeight: 420,
    above: false,
  });
  assert.deepEqual(placeFileChooser({ left: 100, top: 660, width: 100, height: 30 }, viewport, 1), {
    width: 420,
    left: 100,
    top: 652,
    maxHeight: 420,
    above: true,
  });
  assert.equal(placeFileChooser({ left: 100, top: 680, width: 100, height: 30 }, viewport, 1), undefined);
  const compactViewport = { left: 0, top: 0, width: 568, height: 320 };
  assert.deepEqual(placeFileChooser({ left: 100, top: 104, width: 100, height: 40 }, compactViewport, 1), {
    width: 420,
    left: 100,
    top: 152,
    maxHeight: 156,
    above: false,
  });
  assert.equal(
    placeFileChooser({ left: 100, top: 105, width: 100, height: 40 }, compactViewport, 1),
    undefined,
  );
});

test('chooser design dimensions and placement scale with the UI at 1.5', () => {
  const scale = 1.5;
  const viewport = { left: 15, top: 150, width: 1050, height: 900 };
  assert.deepEqual(placeFileChooser({ left: 750, top: 240, width: 150, height: 45 }, viewport, scale), {
    width: 630,
    left: 417,
    top: 297,
    maxHeight: 630,
    above: false,
  });
  assert.deepEqual(placeFileChooser({ left: 150, top: 990, width: 150, height: 45 }, viewport, scale), {
    width: 630,
    left: 150,
    top: 978,
    maxHeight: 630,
    above: true,
  });
  const compact = { left: 0, top: 0, width: 600, height: 480 };
  assert.deepEqual(placeFileChooser({ left: 150, top: 156, width: 150, height: 60 }, compact, scale), {
    width: 564,
    left: 18,
    top: 228,
    maxHeight: 234,
    above: false,
  });
  assert.equal(placeFileChooser({ left: 150, top: 157, width: 150, height: 60 }, compact, scale), undefined);
  assert.equal(
    placeFileChooser({ left: 15, top: 0, width: 150, height: 60 }, { ...compact, width: 449 }, scale),
    undefined,
  );
});
