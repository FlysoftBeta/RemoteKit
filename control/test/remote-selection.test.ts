import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { RemoteSelectionTarget } from '../client/selection/remote-selection';
import type { SelectionMessage } from '../client/rtc/protocol';
import type { Surface } from '../client/presentation/types';
import { RemoteKitError } from '../shared/errors';
import { deviceClipboard } from '../client/clipboard/device-clipboard';

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
  selectionRevision: '3',
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

test('remote handles and extents project through DPR, media scaling, letterbox and shell scaling', async () => {
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
  assert.deepEqual(await target.run('copy'), { kind: 'sent' });
  assert.deepEqual(sent.pop(), { type: 'selection_command', menu: '5', command: 'copy' });
  assert.deepEqual(target.handles(), {});
});

test('a caret-only remote target dismisses with its presentation revision and hides clipped handles', () => {
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
  assert.deepEqual(sent, [{ type: 'selection.dismiss', revision: '3' }]);
  assert.equal(target.alive(), false);
});

test('remote paste refreshes before dispatch and abandons a retired menu', async () => {
  const sent: Record<string, unknown>[] = [];
  const target = new RemoteSelectionTarget(
    {
      input: {
        ensureInputFocus: () => true,
        sendInput: (_surface: Surface, event: Record<string, unknown>) => {
          sent.push(event);
          return true;
        },
      },
    } as never,
    message,
    surface,
    { width: 450, height: 300, canvas: { left: 20, top: 30, width: 400, height: 200 } },
    canvas,
  );
  const originalPrepare = deviceClipboard.preparePaste;
  let finish!: () => void;
  deviceClipboard.preparePaste = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  try {
    const first = target.run('paste');
    assert.equal(sent.length, 0);
    finish();
    assert.deepEqual(await first, { kind: 'unknown' });
    assert.deepEqual(sent.pop(), { type: 'selection_command', menu: '5', command: 'paste' });
    target.update(
      { ...message, revision: '2' },
      surface,
      { width: 450, height: 300, canvas: { left: 20, top: 30, width: 400, height: 200 } },
      canvas,
    );
    const second = target.run('paste');
    target.collapse();
    sent.length = 0;
    finish();
    assert.equal((await second).kind, 'not-sent');
    assert.equal(sent.length, 0);
  } finally {
    deviceClipboard.preparePaste = originalPrepare;
  }
});

const geometry = { width: 450, height: 300, canvas: { left: 20, top: 30, width: 400, height: 200 } };
const targetWith = (sendInput: () => boolean) =>
  new RemoteSelectionTarget(
    { input: { ensureInputFocus: () => true, sendInput } } as never,
    message,
    surface,
    geometry,
    canvas,
  );

test('a command that was not sent reports the error and keeps the menu usable', async () => {
  const target = targetWith(() => false);
  const outcome = await target.run('copy');
  assert.equal(outcome.kind, 'not-sent');
  assert.equal(outcome.kind === 'not-sent' && outcome.error.code, 'unavailable');
  assert.equal(target.alive(), true);
  assert.deepEqual(target.commands(), ['copy', 'contextMenu']);
});

test('a failed paste preparation is not sent', async () => {
  const sent: Record<string, unknown>[] = [];
  const target = targetWith(() => {
    sent.push({});
    return true;
  });
  const originalPrepare = deviceClipboard.preparePaste;
  deviceClipboard.preparePaste = () => Promise.reject(new RemoteKitError('forbidden', '剪贴板不可用'));
  try {
    const outcome = await target.run('paste');
    assert.equal(outcome.kind === 'not-sent' && outcome.error.code, 'forbidden');
    assert.equal(sent.length, 0);
    assert.equal(target.alive(), true);
  } finally {
    deviceClipboard.preparePaste = originalPrepare;
  }
});

test('cut and paste have an unknown result: no resend until the selection updates', async () => {
  let count = 0;
  const target = targetWith(() => ++count > 0);
  const originalPrepare = deviceClipboard.preparePaste;
  deviceClipboard.preparePaste = async () => undefined;
  try {
    assert.deepEqual(await target.run('paste'), { kind: 'unknown' });
    assert.deepEqual(await target.run('paste'), { kind: 'unknown' });
    assert.deepEqual(await target.run('cut'), { kind: 'unknown' });
    assert.equal(count, 1);
    assert.equal(target.alive(), true);
    target.update({ ...message, revision: '2' }, surface, geometry, canvas);
    assert.deepEqual(await target.run('cut'), { kind: 'unknown' });
    assert.equal(count, 2);
  } finally {
    deviceClipboard.preparePaste = originalPrepare;
  }
});

test('a dismissal carries the revision the viewer saw, menu or not', () => {
  const sent: Record<string, unknown>[] = [];
  const target = targetWith(() => {
    sent.push({});
    return true;
  });
  const events: Record<string, unknown>[] = [];
  const recording = new RemoteSelectionTarget(
    {
      input: {
        sendInput: (_surface: Surface, event: Record<string, unknown>) => {
          events.push(event);
          return true;
        },
      },
    } as never,
    { ...message, selectionRevision: '41' },
    surface,
    geometry,
    canvas,
  );
  recording.collapse();
  assert.deepEqual(events, [{ type: 'selection.dismiss', revision: '41' }]);
  assert.equal(target.alive(), true);
});
