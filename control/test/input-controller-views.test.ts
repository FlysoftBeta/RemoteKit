import test from 'node:test';
import assert from 'node:assert/strict';
import { TouchView } from '../client/input/touch-view';
import { EditingView } from '../client/editing/editing-view';
import { EditingSession } from '../client/editing/editing-session';
import { Events } from '../client/util/store';
import type { InputDelivery, InputResult } from '../client/input/types';
import type { Surface, Layout } from '../client/presentation/types';

const surface: Surface = {
  id: '1',
  session: 's',
  instance: 'i',
  document: 'd',
  focus: '7',
  x: 0,
  y: 0,
  width: 390,
  height: 764,
  deviceScaleFactor: 1,
};
const layout: Layout = {
  type: 'layout',
  generation: '1',
  epoch: '2',
  width: 400,
  height: 768,
  views: [surface],
};

test('touch controller holds the owner through pending and unknown outcomes until exact proof', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const results = new Events<InputResult>(),
    deliveries = new Events<InputDelivery>();
  const sent: Record<string, unknown>[] = [];
  const view = new TouchView(
    {
      input: {
        inputIdentity: () => 'owner',
        sendInput: (_surface, event) => {
          sent.push(event);
          return true;
        },
        subscribeInputResults: results.subscribe,
        subscribeInputDelivery: deliveries.subscribe,
        touchStartWall: () => undefined,
      },
      presentation: { layout },
      touch: { touchRetirementCurrent: () => true, retireTouch: () => true, retryTouchTerminal: () => true },
    },
    '1',
    { hasPointerCapture: () => false } as unknown as HTMLCanvasElement,
  );
  t.after(() => view.reset());
  view.sample('start', { id: 1, x: 10, y: 20, pressure: 0.5 }, 0);
  view.sample('end', { id: 1, x: 10, y: 20, pressure: 0.5 }, 30);
  const packet = sent[1];
  deliveries.emit({
    surface,
    identity: 'owner',
    event: packet,
    phase: 'submitted',
    sequence: '2',
    layoutEpoch: '2',
  });
  assert.equal(view.getSnapshot().phase, 'submitted');
  const result: InputResult = {
    surface,
    identity: 'owner',
    event: packet,
    sequence: '2',
    ok: true,
    touchState: 'accepted-pending',
    touchSequenceId: String(packet.sequenceId),
  };
  results.emit(result);
  assert.equal(view.getSnapshot().phase, 'awaitingProof');
  results.emit({ ...result, ok: false, touchState: 'terminal-unconfirmed' });
  assert.equal(view.getSnapshot().phase, 'awaitingProof');
  assert.equal(view.sample('start', { id: 2, x: 10, y: 20, pressure: 0.5 }, 50), false);
  results.emit({ ...result, touchState: 'processed', touchSequenceId: 'stale' });
  assert.equal(view.getSnapshot().phase, 'awaitingProof');
  results.emit({ ...result, touchState: 'processed' });
  assert.equal(view.getSnapshot().phase, 'released');
  assert.equal(view.sample('start', { id: 2, x: 10, y: 20, pressure: 0.5 }, 60), true);
});

test('editing controller defers edits through presentation loss and expires them without a React timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let view: EditingView;
  t.after(() => view?.dispose());
  const body = {};
  const document = { activeElement: body as unknown, body };
  for (const [name, value] of Object.entries({
    document,
    window: { matchMedia: () => ({ matches: false }) },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() =>
      old ? Object.defineProperty(globalThis, name, old) : Reflect.deleteProperty(globalThis, name),
    );
  }
  let ready = true;
  const sent: Record<string, unknown>[] = [];
  const editor = {
    value: '',
    inputMode: 'none',
    setSelectionRange() {},
    focus() {
      document.activeElement = editor;
    },
    blur() {
      document.activeElement = body;
    },
  };
  const editing = new EditingSession({ rtc: { attempt: 1 } });
  editing.handle(layout);
  editing.handle({
    type: 'input.editable',
    version: 1,
    revision: '1',
    view: surface,
    editable: {
      type: 1,
      flags: 0,
      active: true,
      target: '31',
      selectionStart: 0,
      selectionEnd: 0,
      compositionStart: -1,
      compositionEnd: -1,
      caretX: 1,
      caretY: 1,
      caretWidth: 1,
      caretHeight: 12,
    },
  });
  view = new EditingView(
    {
      editing,
      presentation: { canInput: () => (ready ? { surface, layout, attempt: 1 } : null) },
      input: {
        sendInput: (_surface, event) => {
          sent.push(event);
          return true;
        },
        ensureInputFocus() {},
        focus() {},
      },
    },
    '1',
    editor as unknown as HTMLTextAreaElement,
  );
  const resize = { waiting: false, keyboardOpen: false, keyboardDismissals: 0, blocksInput: () => false };
  view.configure(true, false, resize);
  ready = false;
  view.sendEdit({ type: 'ime_commit', text: 'first' });
  assert.equal(sent.length, 0);
  ready = true;
  view.observe();
  assert.equal(sent[0].text, 'first');
  ready = false;
  view.sendEdit({ type: 'ime_commit', text: 'expired' });
  t.mock.timers.tick(3000);
  ready = true;
  view.observe();
  assert.equal(sent.filter((event) => event.text === 'expired').length, 0);
  assert.ok(view.getSnapshot().error);
});
