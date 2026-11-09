import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { modifiers, mouseButtonModifiers } from '../client/input/keys';
import { penInput } from '../client/input/pen-input';
import { ViewportInput, type ViewportInputPorts } from '../client/input/viewport-input';
import { TouchSession } from '../client/input/touch-session';
import { mergeTouchMoves, type TouchPacket } from '../client/input/touch-input';
import type { Layout, Surface } from '../client/presentation/types';
import { encodeOutgoing } from '../client/rtc/protocol';

const surface: Surface = {
  id: 'v',
  session: 's',
  instance: 'i',
  document: 'd',
  focus: 'f',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  deviceScaleFactor: 2,
  mediaScaleX: 0.5,
  mediaScaleY: 1,
};
const keyboard = {
  shiftKey: true,
  ctrlKey: true,
  altKey: true,
  metaKey: true,
  getModifierState: (key: string) => key === 'CapsLock' || key === 'NumLock',
};

function fixture(t: TestContext) {
  for (const name of ['document', 'window']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
    t.after(() =>
      previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name),
    );
  }
  t.mock.method(performance, 'now', () => 100);
  const sent: Record<string, unknown>[] = [];
  const captured = new Set<number>();
  const canvas = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    hasPointerCapture: (id: number) => captured.has(id),
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  const subscribe = () => () => {};
  const ports = {
    input: {
      sendInput: (_surface: Surface, event: Record<string, unknown>) => {
        sent.push(event);
        return true;
      },
      inputIdentity: () => 'identity',
      getSnapshot: () => ({ focus: { phase: 'granted', token: 'f' }, queued: 0, sent: 0 }),
      subscribeInputResults: subscribe,
      subscribeInputDelivery: subscribe,
      subscribe,
      touchStartWall: () => undefined,
      ensureInputFocus() {},
      focusPointer() {},
      focus() {},
    },
    presentation: {
      layout: {
        type: 'layout',
        generation: '1',
        epoch: '1',
        width: 800,
        height: 600,
        views: [surface],
      } as Layout,
      canInput: () => true,
      subscribe,
      subscribeFrames: subscribe,
    },
    touch: new TouchSession(),
    editing: {
      subscribe,
      createView: () => ({
        observe() {},
        onFocus() {},
        onBlur() {},
        compositionStart() {},
        activateKeyboard() {},
        beginPointerFocus() {},
        focusEditor() {},
        release() {},
        dispose() {},
      }),
    },
  } as unknown as ViewportInputPorts;
  const view = new ViewportInput(
    ports,
    'v',
    canvas as unknown as HTMLCanvasElement,
    Object.assign(new EventTarget(), { inputMode: 'none' }) as HTMLTextAreaElement,
    () => {},
  );
  t.after(() => view.dispose());
  const emit = (type: string, values: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    const { timeStamp = 100, ...properties } = values;
    Object.assign(event, {
      ...keyboard,
      pointerType: 'mouse',
      pointerId: 7,
      clientX: 20,
      clientY: 30,
      button: 0,
      buttons: 1,
      pressure: 0.7,
      tiltX: -30,
      tiltY: 45,
      twist: 120,
      width: 1,
      height: 1,
      detail: 1,
      ...properties,
    });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    canvas.dispatchEvent(event);
  };
  return { sent, emit, view };
}

test('shared modifiers carry locks and held buttons without key location bits', () => {
  assert.equal(modifiers(keyboard), 15 | (1 << 9) | (1 << 10));
  assert.equal(modifiers({ ...keyboard, getModifierState: () => false }), 15);
  assert.equal(modifiers({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }), 0);
  assert.equal((modifiers(keyboard) | mouseButtonModifiers(31)) & ((1 << 4) | (1 << 11) | (1 << 12)), 0);
});

test('pen events retain mouse routing, contact metadata, eraser state and hover pressure', (t) => {
  const { emit, sent } = fixture(t);
  emit('pointerdown', { pointerType: 'pen' });
  assert.deepEqual(sent[0], {
    type: 'mouse',
    action: 'down',
    x: 40,
    y: 30,
    button: 1,
    modifiers: modifiers(keyboard) | 64,
    click_count: 1,
    pen: { id: 7, pressure: 0.7, tiltX: -30, tiltY: 45, twist: 120, eraser: false },
  });
  emit('pointerup', { pointerType: 'pen', buttons: 0, pressure: 0 });
  emit('pointermove', { pointerType: 'pen', buttons: 0, pressure: 0.5, twist: undefined });
  assert.deepEqual(sent[2].pen, { id: 7, pressure: 0, tiltX: -30, tiltY: 45, twist: 0, eraser: false });
  emit('pointerdown', { pointerType: 'pen', button: 5, buttons: 32 });
  assert.equal(sent[3].button, 1);
  assert.equal((sent[3].pen as { eraser: boolean }).eraser, true);
  assert.equal(sent[3].modifiers, modifiers(keyboard) | 64);
  emit('pointercancel', { pointerType: 'pen', buttons: 0, pressure: 0 });
  assert.equal(sent[4].action, 'up');
  assert.equal((sent[4].pen as { pressure: number }).pressure, 0);
  assert.equal(penInput({ pointerType: 'mouse' } as PointerEvent), undefined);
});

test('synthetic pen release retains identity and locks with zero pressure', (t) => {
  const { emit, sent, view } = fixture(t);
  emit('pointerdown', { pointerType: 'pen' });
  view.dispose();
  assert.equal(sent[1].action, 'up');
  assert.equal(sent[1].modifiers, modifiers(keyboard));
  assert.equal((sent[1].pen as { id: number }).id, 7);
  assert.equal((sent[1].pen as { pressure: number }).pressure, 0);
});

test('mouse and wheel encode event lock states without a pen object', (t) => {
  const { emit, sent } = fixture(t);
  emit('pointerdown');
  emit('wheel', { deltaX: 2, deltaY: 3, deltaMode: 0, buttons: 0 });
  assert.equal(sent[0].pen, undefined);
  assert.equal(sent[1].modifiers, modifiers(keyboard));
  assert.deepEqual(sent[1], { type: 'wheel', x: 40, y: 30, dx: -2, dy: -3, modifiers: modifiers(keyboard) });
});

test('touch contact size uses coordinate DIP scales and survives client gestures and coalescing', (t) => {
  const { emit, sent } = fixture(t);
  emit('pointerdown', { pointerType: 'touch', width: 8, height: 12, timeStamp: 90 });
  assert.deepEqual((sent[0] as TouchPacket).points[0], {
    id: 7,
    x: 40,
    y: 30,
    pressure: 0.7,
    width: 16,
    height: 12,
  });
  assert.equal(sent[0].gestureMode, 'client-v1');
  emit('pointermove', {
    pointerType: 'touch',
    width: 10,
    height: 14,
    getCoalescedEvents: () => [
      { clientX: 20, clientY: 30, timeStamp: 95, pressure: 0.6, width: 9, height: 13 },
    ],
  });
  const batch = mergeTouchMoves(sent[sent.length - 2], sent[sent.length - 1])!;
  assert.deepEqual(batch.samples![0].points[0], {
    id: 7,
    x: 40,
    y: 30,
    pressure: 0.6,
    width: 18,
    height: 13,
  });
  assert.equal(batch.points[0].width, 20);
  assert.equal(batch.points[0].height, 14);
  assert.equal(
    JSON.parse(
      encodeOutgoing({
        type: 'input',
        session: 's',
        view: 'v',
        instance: 'i',
        document: 'd',
        focus: 'f',
        layoutEpoch: '1',
        outputGeneration: '1',
        sequence: '1',
        event: batch,
      }),
    ).event.points[0].width,
    20,
  );
  emit('pointercancel', { pointerType: 'touch' });
  emit('pointerdown', { pointerType: 'touch' });
  assert.equal((sent[sent.length - 1] as TouchPacket).points[0].width, undefined);
  assert.equal((sent[sent.length - 1] as TouchPacket).points[0].height, undefined);
});
