import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ClientGestures, GESTURE_SLOP_DIP, LONG_PRESS_US } from '../client/input/client-gestures';
import { TouchView } from '../client/input/touch-view';
import type { Surface, Layout } from '../client/presentation/types';
import type { TouchPacket } from '../client/input/touch-input';

const point = (x = 10, id = 1) => ({ id, x, y: 20, pressure: 0.5 });
const surface: Surface = {
  session: 's',
  id: 'v',
  instance: 'i',
  document: 'd',
  focus: 'f',
  x: 0,
  y: 0,
  width: 400,
  height: 800,
  deviceScaleFactor: 1,
};

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false } });
  t.after(() =>
    previousDocument
      ? Object.defineProperty(globalThis, 'document', previousDocument)
      : Reflect.deleteProperty(globalThis, 'document'),
  );
  const sent: Record<string, unknown>[] = [];
  const presentation = {
    layout: {
      type: 'layout',
      generation: '1',
      epoch: '1',
      width: 400,
      height: 800,
      views: [surface],
    } as Layout,
  };
  const view = new TouchView(
    {
      input: {
        inputIdentity: (surface) => surface.document,
        sendInput: (_surface, packet) => {
          sent.push(packet);
          return true;
        },
        subscribeInputResults: () => () => {},
        subscribeInputDelivery: () => () => {},
        touchStartWall: () => 123000000,
      },
      presentation,
    },
    surface.id,
    { hasPointerCapture: () => false } as unknown as HTMLCanvasElement,
  );
  t.after(() => view.dispose());
  const advance = (ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  const sample = (action: 'start' | 'move' | 'end', p = point()) => view.sample(action, p, now);
  return { view, sent, sample, advance, presentation };
}

test('long press fires once at 500ms within slop on the touch source clock and final up is longTap', (t) => {
  const { sent, sample, advance } = fixture(t);
  sample('start');
  advance(200);
  sample('move', point(10 + GESTURE_SLOP_DIP));
  advance(299);
  assert.equal(
    sent.some((packet) => packet.action === 'longPress'),
    false,
  );
  advance(1);
  assert.deepEqual(sent[2], {
    type: 'gesture',
    gestureMode: 'client-v1',
    action: 'longPress',
    sequenceId: sent[0].sequenceId,
    inputIdentity: 'd',
    sampleElapsedUs: LONG_PRESS_US,
    x: 18,
    y: 20,
  });
  advance(1000);
  sample('move', point(100));
  sample('start', point(200, 2));
  advance(10);
  sample('move', point(400, 2));
  sample('end', point(400, 2));
  advance(10);
  sample('end', point(200));
  assert.equal(sent.filter((packet) => packet.action === 'longPress').length, 1);
  assert.deepEqual(
    (sent[sent.length - 1] as TouchPacket).gestures.map((gesture) => gesture.type),
    ['longTap'],
  );
  assert.deepEqual(
    sent
      .filter((packet) => packet.type === 'touch')
      .flatMap((packet) => (packet as TouchPacket).gestures.map((gesture) => gesture.type)),
    ['tapDown', 'longTap'],
  );
  assert.equal(
    sent.some((packet) => ['momentum', 'momentumEnd'].includes(String(packet.action))),
    false,
  );
});

test('long press deadline uses the captured down time rather than DOM event arrival', (t) => {
  const { view, sent, advance } = fixture(t);
  view.sample('start', point(), 50);
  advance(449);
  assert.equal(sent.length, 1);
  advance(1);
  assert.equal(sent[1].action, 'longPress');
  assert.equal(sent[1].sampleElapsedUs, LONG_PRESS_US);
});

for (const boundary of ['slop', 'second-finger', 'end', 'cancel', 'reset', 'dispose', 'identity'] as const) {
  test(`long press is cancelled by ${boundary}`, (t) => {
    const { view, sent, sample, advance, presentation } = fixture(t);
    sample('start');
    advance(200);
    if (boundary === 'slop') {
      sample('move', point(10 + GESTURE_SLOP_DIP + 0.1));
      sample('move');
    } else if (boundary === 'second-finger') {
      sample('start', point(11, 2));
      sample('end', point(11, 2));
    } else if (boundary === 'end') sample('end');
    else if (boundary === 'cancel') view.cancelTouches();
    else if (boundary === 'reset') view.reset();
    else if (boundary === 'dispose') view.dispose();
    else presentation.layout = { ...presentation.layout, views: [{ ...surface, document: 'next' }] };
    advance(1000);
    assert.equal(
      sent.some((packet) => packet.action === 'longPress'),
      false,
    );
  });
}

test('recognizer ignores early/repeated timeout and cancel after long press never emits tapCancel', () => {
  const gestures = new ClientGestures();
  gestures.update('start', [point()], 0);
  assert.equal(gestures.longPress(LONG_PRESS_US - 1), undefined);
  assert.deepEqual(gestures.longPress(LONG_PRESS_US), { x: 10, y: 20 });
  assert.equal(gestures.longPress(LONG_PRESS_US + 1), undefined);
  assert.deepEqual(gestures.update('cancel', [], LONG_PRESS_US + 2), []);
  assert.equal(gestures.momentum, undefined);
});
