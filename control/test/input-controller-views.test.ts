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

function touchFixture(t: import('node:test').TestContext) {
  const results = new Events<InputResult>();
  const deliveries = new Events<InputDelivery>();
  const sent: Record<string, unknown>[] = [];
  const presentation = { layout: { ...layout, views: [{ ...surface }] } as Layout | null };
  const captured = new Set<number>();
  const released: number[] = [];
  const view = new TouchView(
    {
      input: {
        inputIdentity: () => `${presentation.layout?.epoch}:${presentation.layout?.views[0].document}`,
        sendInput: (_surface, event) => {
          sent.push(event);
          return true;
        },
        subscribeInputResults: results.subscribe,
        subscribeInputDelivery: deliveries.subscribe,
        touchStartWall: () => undefined,
      },
      presentation,
    },
    '1',
    {
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => {
        captured.delete(id);
        released.push(id);
      },
    } as unknown as HTMLCanvasElement,
  );
  t.after(() => view.dispose());
  return { view, sent, results, deliveries, presentation, captured, released };
}
const touchPoint = (id = 1) => ({ id, x: 10, y: 20, pressure: 0.5 });

test('touch end immediately releases local ownership and late results cannot block the next gesture', (t) => {
  const { view, sent, results } = touchFixture(t);
  assert.equal(view.sample('start', touchPoint(), 0), true);
  assert.equal(view.sample('end', touchPoint(), 30), true);
  assert.equal(view.getSnapshot().phase, 'released');
  assert.equal(view.sample('start', touchPoint(2), 50), true);
  results.emit({ surface, identity: '2:d', event: sent[1], sequence: '2', ok: false });
  assert.equal(view.getSnapshot().phase, 'active');
  assert.deepEqual(
    sent.map((packet) => packet.action),
    ['start', 'end', 'start'],
  );
  assert.notEqual(sent[0].sequenceId, sent[2].sequenceId);
});

test('pointer cancellation and unmount send one whole-sequence cancel without retries', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { view, sent, captured, released } = touchFixture(t);
  view.sample('start', touchPoint(), 0);
  view.sample('start', touchPoint(2), 10);
  captured.add(1);
  captured.add(2);
  view.cancelTouches();
  view.cancelTouches();
  view.dispose();
  t.mock.timers.tick(30000);
  assert.deepEqual(
    sent.map((packet) => packet.action),
    ['start', 'start', 'cancel'],
  );
  assert.deepEqual(released, [1, 2]);
  assert.equal(view.getSnapshot().phase, 'released');
});

test('layout replacement drops stale local coordinates and admits the next start immediately', (t) => {
  const { view, sent, presentation } = touchFixture(t);
  view.sample('start', touchPoint(), 0);
  presentation.layout!.epoch = '3';
  view.syncTouchOwner();
  assert.equal(view.sample('move', touchPoint(), 20), false);
  assert.equal(view.sample('start', touchPoint(2), 30), true);
  assert.deepEqual(
    sent.map((packet) => packet.action),
    ['start', 'start'],
  );
  presentation.layout = null;
  view.syncTouchOwner();
  presentation.layout = { ...layout, views: [{ ...surface, document: 'next' }] };
  assert.equal(view.sample('start', touchPoint(3), 40), true);
});

test('partial release preserves the other contact without requiring a result', (t) => {
  const { view } = touchFixture(t);
  view.sample('start', touchPoint(), 0);
  view.sample('start', touchPoint(2), 10);
  view.sample('end', touchPoint(), 20);
  assert.deepEqual(view.contactIds, [2]);
  assert.equal(view.getSnapshot().phase, 'active');
  assert.equal(view.sample('end', touchPoint(2), 30), true);
  assert.equal(view.getSnapshot().phase, 'released');
});

function editingFixture(t: import('node:test').TestContext) {
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
    addEventListener() {},
    removeEventListener() {},
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
      focusSource: 'pointer',
      focusRevision: '1',
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
        inputIdentity: () => 'input-owner',
        getSnapshot: () => ({ focus: { phase: 'granted', token: '7' }, queued: 0, sent: 0 }),
        focus() {},
      },
    },
    '1',
    editor as unknown as HTMLTextAreaElement,
  );
  const resize = { waiting: false, keyboardOpen: false, keyboardDismissals: 0, blocksInput: () => false };
  view.configure(true, false, resize);
  return {
    view,
    editing,
    editor,
    document,
    sent,
    resize,
    get ready() {
      return ready;
    },
    set ready(value: boolean) {
      ready = value;
    },
  };
}

test('responsive editor replacement keeps local focus and fences the old composition target', (t) => {
  const f = editingFixture(t);
  const { view, editing, editor, document, resize } = f;
  view.toggleKeyboard();
  view.compositionStart();
  view.compositionUpdate('你好');
  const previous = editing.mobileEditing.current!;
  f.ready = false;
  view.configure(true, false, { ...resize, waiting: true, blocksInput: () => true });
  editing.handle({ ...layout, generation: '0', epoch: '3', views: [], reconfiguring: true });
  editing.handle({
    ...previous,
    revision: '2',
    view: null,
    editable: { ...previous.editable, active: false, target: '0', type: 0 },
  });
  view.observe();
  assert.equal(document.activeElement, editor);
  assert.equal(view.editing.composing, true);
  editing.handle({
    ...previous,
    revision: '3',
    editable: { ...previous.editable, target: '32', focusSource: 'script', focusRevision: '2' },
  });
  editing.handle({ ...layout, generation: '2', epoch: '4' });
  f.ready = true;
  view.configure(true, false, resize);
  view.observe();
  assert.equal(document.activeElement, editor);
  assert.equal(view.editing.composing, true);
  view.compositionEnd('你好');
  assert.deepEqual(
    f.sent.filter((event) => event.type === 'ime_commit'),
    [],
  );
});

test('editing controller defers edits through presentation loss and expires them without a React timer', (t) => {
  const f = editingFixture(t);
  const { view, sent, resize } = f;
  view.toggleKeyboard();
  f.ready = false;
  view.sendEdit({ type: 'ime_commit', text: 'first' });
  assert.equal(sent.length, 0);
  f.ready = true;
  view.observe();
  assert.equal(sent[0].text, 'first');
  f.ready = false;
  view.sendEdit({ type: 'ime_commit', text: 'expired' });
  t.mock.timers.tick(3000);
  f.ready = true;
  view.observe();
  assert.equal(sent.filter((event) => event.text === 'expired').length, 0);
  assert.ok(view.getSnapshot().error);
  sent.length = 0;
  view.compositionStart();
  view.compositionUpdate('finish');
  view.toggleKeyboard();
  assert.deepEqual(
    sent.map((event) => event.type),
    ['ime_set', 'ime_commit', 'editing.dismiss'],
  );
  assert.equal(sent[2].target, '31');
  assert.equal(sent[2].revision, '1');
  sent.length = 0;
  view.toggleKeyboard();
  view.configure(true, false, { ...resize, keyboardDismissals: 1 });
  assert.deepEqual(
    sent.map((event) => event.type),
    ['editing.dismiss'],
  );
  sent.length = 0;
  view.release();
  assert.deepEqual(sent, []);
});
