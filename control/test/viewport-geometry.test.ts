import test from 'node:test';
import assert from 'node:assert/strict';
import {
  placeSelectionMenu,
  projectEditableCaret,
  type ViewportGeometry,
} from '../client/app/viewport-geometry';
import type { Surface } from '../client/presentation/types';
import type { EditableMessage, SelectionMenu } from '../client/rtc/protocol';

const surface: Surface = {
  session: 's',
  id: 'v',
  instance: 'i',
  document: 'd',
  focus: 'f',
  x: 300,
  y: 400,
  width: 1200,
  height: 1600,
  deviceScaleFactor: 2,
  mediaScaleX: 0.75,
  mediaScaleY: 0.5,
};
const geometry: ViewportGeometry = {
  width: 450,
  height: 850,
  canvas: { left: 20, top: 30, width: 400, height: 800 },
};
const editable: EditableMessage = {
  type: 'input.editable',
  version: 1,
  revision: '1',
  view: surface,
  editable: {
    active: true,
    type: 1,
    target: '1',
    flags: 2,
    selectionStart: 0,
    selectionEnd: 0,
    compositionStart: -1,
    compositionEnd: -1,
    caretX: 200,
    caretY: 400,
    caretWidth: 1,
    caretHeight: 40,
  },
};
const menu: SelectionMenu = {
  id: '1',
  x: 300,
  y: 400,
  width: 100,
  height: 40,
  handleHeight: 30,
  commands: ['copy', 'paste'],
};

test('caret projection uses root DIP and canvas layout offsets with anisotropic media scale and DPR', () => {
  assert.deepEqual(projectEditableCaret(surface, editable, geometry), {
    left: 120,
    top: 230,
    height: 20,
    fontSize: 20,
    lineHeight: '20px',
  });
  const uniform = { ...surface, mediaScaleX: undefined, mediaScaleY: undefined, mediaScale: 0.5 };
  assert.ok(Math.abs(projectEditableCaret(uniform, editable, geometry)!.left - (20 + 200 / 3)) < 1e-10);
  // Atlas offsets and transformed client bounds are absent from the local projection.
  assert.deepEqual(
    projectEditableCaret({ ...surface, x: 9000, y: 8000 }, editable, geometry),
    projectEditableCaret(surface, editable, geometry),
  );
});

test('caret clamps its entire height and one-pixel width inside the section with a minimum font size', () => {
  const project = (caretX: number, caretY: number, caretHeight: number) =>
    projectEditableCaret(
      surface,
      {
        ...editable,
        editable: { ...editable.editable, caretX, caretY, caretHeight },
      },
      geometry,
    );
  assert.deepEqual(project(-100, -100, 8), {
    left: 0,
    top: 0,
    height: 4,
    fontSize: 12,
    lineHeight: '12px',
  });
  assert.deepEqual(project(10000, 10000, 40), {
    left: 449,
    top: 830,
    height: 20,
    fontSize: 20,
    lineHeight: '20px',
  });
  assert.equal(project(0, 0, 10000)?.height, geometry.height);
});

test('caret feedback requires a matching session, view, instance, document and valid caret flag', () => {
  for (const key of ['session', 'id', 'instance', 'document'] as const) {
    assert.equal(projectEditableCaret({ ...surface, [key]: 'other' }, editable, geometry), undefined);
  }
  for (const message of [
    undefined,
    { ...editable, view: null },
    { ...editable, editable: { ...editable.editable, flags: 1 } },
    { ...editable, editable: { ...editable.editable, active: false } },
  ])
    assert.equal(projectEditableCaret(surface, message, geometry), undefined);
  assert.ok(projectEditableCaret({ ...surface, focus: 'next' }, editable, geometry));
});

test('selection menu centres above the anchor or below the handles and clamps to section gutters', () => {
  assert.deepEqual(placeSelectionMenu(surface, menu, geometry, 104), { left: 143, top: 186 });
  assert.deepEqual(placeSelectionMenu(surface, { ...menu, y: 0 }, geometry, 104), { left: 143, top: 73 });
  assert.equal(placeSelectionMenu(surface, { ...menu, x: -1000 }, geometry, 104).left, 8);
  assert.equal(placeSelectionMenu(surface, { ...menu, x: 10000 }, geometry, 104).left, 338);
  const short = { ...geometry, height: 80 };
  assert.equal(placeSelectionMenu(surface, { ...menu, y: 0 }, short, 104).top, 36);
  assert.equal(placeSelectionMenu(surface, { ...menu, y: 36 }, geometry, 104).top, 91);
  assert.equal(
    placeSelectionMenu(
      surface,
      { ...menu, y: 36 },
      { ...geometry, canvas: { ...geometry.canvas, top: 34 } },
      104,
    ).top,
    8,
  );
});
