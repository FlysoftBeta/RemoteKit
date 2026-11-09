import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { RemoteSelectionTarget } from '../client/selection/remote-selection';
import type { SelectionMessage } from '../client/rtc/protocol';
import type { Surface } from '../client/presentation/types';

const dom = new JSDOM('<canvas></canvas>');
const canvas = dom.window.document.querySelector('canvas')!;
canvas.getBoundingClientRect = () => new dom.window.DOMRect(100, 200, 800, 400);
const surface: Surface = {
  session: 's',
  id: 'v',
  instance: 'i',
  document: 'd',
  focus: 'f',
  x: 200,
  y: 600,
  width: 1200,
  height: 800,
  deviceScaleFactor: 2,
  mediaScaleX: 0.75,
  mediaScaleY: 1,
};
const message: SelectionMessage = {
  type: 'input.selection',
  version: 1,
  revision: '1',
  outputGeneration: '7',
  layoutEpoch: '9',
  view: surface,
  menu: { id: '5', x: 100, y: 40, width: 100, height: 20, handleHeight: 24, commands: ['copy'], more: true },
  handles: {
    start: { x: 100, y: 60, lineHeight: 20 },
    end: { x: 200, y: 60, lineHeight: 20 },
    insertion: null,
  },
};

test('remote handles and extents project through DPR, media scaling, letterbox and shell scaling', () => {
  const sent: Record<string, unknown>[] = [];
  const input = {
    sendInput: (_surface: Surface, event: Record<string, unknown>) => {
      sent.push(event);
      return true;
    },
    ensureInputFocus() {
      return true;
    },
  };
  const target = new RemoteSelectionTarget(
    { input } as never,
    message,
    surface,
    { width: 450, height: 300, canvas: { left: 20, top: 30, width: 400, height: 200 } },
    canvas,
  );
  assert.deepEqual(target.handles(), {
    start: { x: 200, y: 260, lineHeight: 20, visible: true },
    end: { x: 300, y: 260, lineHeight: 20, visible: true },
  });
  assert.deepEqual(target.anchor(), { left: 200, top: 240, width: 100, height: 20 });
  target.dragHandle('start', { x: 350, y: 320 });
  assert.deepEqual(sent.pop(), { type: 'selection.extent', which: 'start', x: 250, y: 120 });
  assert.deepEqual(target.commands(), ['copy', 'contextMenu']);
  target.run('copy');
  assert.deepEqual(sent.pop(), { type: 'selection_command', menu: '5', command: 'copy' });
  assert.deepEqual(target.handles(), {});
});

test('a caret-only remote target dismisses without a menu and hides clipped handles', () => {
  const sent: Record<string, unknown>[] = [];
  const target = new RemoteSelectionTarget(
    {
      input: {
        sendInput: (_surface: Surface, event: Record<string, unknown>) => {
          sent.push(event);
          return true;
        },
      },
    } as never,
    {
      ...message,
      menu: null,
      handles: { start: null, end: null, insertion: { x: 900, y: 60, lineHeight: 20 } },
    },
    surface,
    { width: 450, height: 300, canvas: { left: 20, top: 30, width: 400, height: 200 } },
    canvas,
  );
  assert.equal(target.handles().insertion?.visible, false);
  target.collapse();
  assert.deepEqual(sent, [{ type: 'selection_command', menu: '0', command: 'dismiss' }]);
  assert.equal(target.alive(), false);
});
