import { RemoteKitError } from '../shared/errors';
import { formatError } from '../client/util/format-error';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { inputFixture } from './client-fixture';
import { TouchInput } from '../client/input/touch-input';
import type { Surface } from '../client/presentation/types';
import type { InputDelivery, InputResult } from '../client/input/types';

function setup(t: TestContext) {
  const transport = inputFixture();
  const surface: Surface = {
    id: '1',
    session: 's',
    instance: 'i',
    document: 'd',
    focus: '7',
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    deviceScaleFactor: 1,
  };
  transport.presentation.layout = {
    type: 'layout',
    generation: '1',
    epoch: '2',
    width: 640,
    height: 480,
    views: [surface],
  };
  let ready = true;
  transport.presentation.canInput = () => ready;
  const sent: any[] = [];
  const channel: any = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (data: string) => sent.push(JSON.parse(data)),
  };
  transport.endpoint.bindChannel(channel);
  t.after(() => {
    transport.input.reset();
    transport.touch.reset();
  });
  return {
    transport,
    surface,
    sent,
    channel,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}
const point = (y: number) => ({ id: 1, x: 10, y, pressure: 0.5 });
test('DC backpressure batches recent sampling history and reliably drains start/move/end in order', (t) => {
  const { transport, surface, sent, channel } = setup(t);
  channel.bufferedAmount = 300000;
  const touch = new TouchInput('dc'),
    identity = transport.input.inputIdentity(surface);
  assert.equal(
    transport.input.sendInput(surface, touch.sample(identity, 'start', point(0), 0, 1700000000000000)!),
    true,
  );
  for (let i = 1; i <= 100; i++)
    assert.equal(transport.input.sendInput(surface, touch.sample(identity, 'move', point(i), i)!), true);
  assert.equal(transport.input.sendInput(surface, touch.sample(identity, 'end', point(100), 101)!), true);
  assert.equal(sent.length, 0);
  channel.bufferedAmount = 0;
  channel.onbufferedamountlow();
  assert.equal(sent[0].event.action, 'start');
  assert.equal(sent[sent.length - 1].event.action, 'end');
  const moves = sent.slice(1, -1);
  assert.ok(moves.length > 0 && moves.length < 100);
  for (const packet of moves) {
    assert.equal(packet.event.action, 'move');
    assert.ok((packet.event.samples?.length ?? 0) <= 32);
    assert.ok(packet.event.gestures.length <= 8);
  }
  assert.equal(moves[moves.length - 1].event.sampleElapsedUs, 100000);
  assert.equal(sent[sent.length - 1].event.sampleElapsedUs, 101000);
  assert.equal(transport.input.touchInputStats.merged, 100 - moves.length);
});
test('terminal touch waits for matching paint and stale layout invalidates queued tokens', (t) => {
  const { transport, surface, sent, setReady } = setup(t);
  const touch = new TouchInput('gate'),
    identity = transport.input.inputIdentity(surface);
  transport.input.sendInput(surface, touch.sample(identity, 'start', point(0), 0)!);
  setReady(false);
  const cancel = touch.cancel()!;
  assert.equal(transport.input.sendInput(surface, cancel), true);
  touch.accepted(cancel);
  assert.equal(sent.length, 1);
  setReady(true);
  transport.input.drainInput();
  assert.equal(sent[1].event.action, 'cancel');
  const next = touch.sample(identity, 'start', point(0), 100)!;
  setReady(false);
  assert.equal(transport.input.sendInput(surface, next), false);
  assert.equal(transport.input.sendInput(surface, touch.cancel()!), true);
  transport.presentation.layout!.epoch = '3';
  setReady(true);
  transport.input.drainInput();
  assert.equal(sent.length, 2);
  assert.ok(transport.input.touchInputStats.dropped >= 1);
});
test('editing identity survives layout changes but changes on document and reconnect', (t) => {
  const { transport, surface } = setup(t);
  const owner = transport.editing.editingIdentity(surface);
  transport.presentation.layout!.epoch = '3';
  transport.presentation.layout!.generation = '4';
  surface.width = 800;
  surface.focus = '8';
  assert.equal(transport.editing.editingIdentity(surface), owner);
  surface.document = 'next';
  assert.notEqual(transport.editing.editingIdentity(surface), owner);
  surface.document = 'd';
  transport.rtc.attempt++;
  assert.notEqual(transport.editing.editingIdentity(surface), owner);
});
test('input results associate rejection with original event and immutable target snapshot', (t) => {
  const { transport, surface, channel, sent } = setup(t);
  const results: any[] = [];
  const unsubscribe = transport.input.subscribeInputResults((result) => results.push(result));
  const event = { type: 'touch', action: 'end', sequenceId: 'gesture' };
  transport.input.sendInput(surface, event);
  const request = sent[0];
  surface.document = 'next';
  channel.onmessage({
    data: JSON.stringify({
      type: 'input.result',
      clientSequence: request.sequence,
      ok: false,
      error: { code: 'busy', message: 'busy' },
    }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].surface.document, 'd');
  assert.equal(results[0].event, event);
  assert.equal(results[0].ok, false);
  unsubscribe();
  assert.equal(transport.observations.diagnostics.error, formatError(new RemoteKitError('busy', '')));
});
test('focus ACK preserves gesture identity and second contact does not renew focus', (t) => {
  const { transport, surface, sent, channel } = setup(t);
  transport.input.ensureInputFocus(surface);
  const request = sent[0],
    identity = transport.input.inputIdentity(surface);
  const touch = new TouchInput('focus');
  transport.input.sendInput(surface, touch.sample(identity, 'start', point(0), 0)!);
  channel.onmessage({
    data: JSON.stringify({
      type: 'focus',
      ok: true,
      focusRequestId: request.focusRequestId,
      layoutEpoch: '2',
      token: { view: '1', session: 's', instance: 'i', document: 'd', focus: '8' },
    }),
  });
  assert.equal(transport.input.inputIdentity(surface), identity);
  assert.equal(sent[1].event.action, 'start');
  assert.equal(sent[1].focus, '8');
  transport.input.ensureInputFocus(surface);
  assert.equal(sent.length, 2);
  surface.focus = '9';
  assert.notEqual(transport.input.inputIdentity(surface), identity);
  assert.equal(transport.input.sendInput(surface, touch.cancel()!), false);
});
test('focus backlog reserves capacity for cancellation after ordinary input budget fills', (t) => {
  const { transport, surface, sent, channel } = setup(t);
  transport.input.ensureInputFocus(surface);
  const request = sent[0];
  const touch = new TouchInput('reserve');
  transport.input.sendInput(
    surface,
    touch.sample(transport.input.inputIdentity(surface), 'start', point(0), 0)!,
  );
  for (let i = 0; i < 111; i++)
    assert.equal(transport.input.sendInput(surface, { type: 'ime_commit', text: 'x' }), true);
  assert.equal(transport.input.sendInput(surface, { type: 'ime_commit', text: 'overflow' }), false);
  assert.equal(transport.input.sendInput(surface, touch.cancel()!), true);
  channel.onmessage({
    data: JSON.stringify({
      type: 'focus',
      ok: true,
      focusRequestId: request.focusRequestId,
      layoutEpoch: '2',
      token: { view: '1', session: 's', instance: 'i', document: 'd', focus: '7' },
    }),
  });
  assert.equal(sent[sent.length - 1].event.action, 'cancel');
});

test('client gesture cumulative progress remains ordered before cancellation/new raw', (t) => {
  const { transport, surface, sent, channel } = setup(t);
  channel.bufferedAmount = 300000;
  const inputIdentity = transport.input.inputIdentity(surface);
  const progress = {
    type: 'gesture',
    gestureMode: 'client-v1',
    sequenceId: 'old',
    inputIdentity,
    action: 'momentum',
    sampleElapsedUs: 100,
    cumulativeX: 10,
    cumulativeY: 0,
  };
  assert.equal(transport.input.sendInput(surface, progress), true);
  assert.equal(
    transport.input.sendInput(surface, { ...progress, sampleElapsedUs: 200, cumulativeX: 20 }),
    true,
  );
  assert.equal(
    transport.input.sendInput(surface, {
      ...progress,
      action: 'cancel',
      sampleElapsedUs: 200,
      cumulativeX: 20,
    }),
    true,
  );
  assert.equal(
    transport.input.sendInput(surface, {
      type: 'touch',
      gestureMode: 'client-v1',
      sequenceId: 'new',
      inputIdentity,
      action: 'start',
      gestures: [],
      points: [],
    }),
    true,
  );
  channel.bufferedAmount = 0;
  channel.onbufferedamountlow();
  assert.deepEqual(
    sent.map((p) => p.event.action),
    ['momentum', 'cancel', 'start'],
  );
  assert.equal(sent[0].event.cumulativeX, 20);
  surface.document = 'new';
  assert.equal(transport.input.sendInput(surface, progress), false);
});

test('client candidate backlog refuses overflow without silently discarding raw moves or transitions', (t) => {
  const { transport, surface, sent, channel } = setup(t);
  channel.bufferedAmount = 300000;
  const inputIdentity = transport.input.inputIdentity(surface);
  for (let n = 0; n < 112; n++)
    assert.equal(
      transport.input.sendInput(surface, {
        type: 'touch',
        gestureMode: 'client-v1',
        sequenceId: 'q',
        inputIdentity,
        action: 'move',
        sampleElapsedUs: n,
        points: [],
        gestures: Array(8).fill({ type: 'scrollUpdate', x: 0, y: 0, deltaX: 1, deltaY: 0 }),
      }),
      true,
    );
  assert.equal(transport.input.sendInput(surface, { type: 'ime_commit', text: 'overflow' }), false);
  assert.equal(
    transport.input.sendInput(surface, {
      type: 'touch',
      gestureMode: 'client-v1',
      sequenceId: 'q',
      inputIdentity,
      action: 'cancel',
      points: [],
      gestures: [],
    }),
    true,
  );
  channel.bufferedAmount = 0;
  channel.onbufferedamountlow();
  assert.equal(sent.length, 113);
  assert.equal(sent[112].event.action, 'cancel');
  assert.equal(
    sent.slice(0, 112).reduce((sum, p) => sum + p.event.gestures.length, 0),
    896,
  );
});

test('focus timeout and rejected focus explicitly discard queued events with original identity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport, surface, sent, channel } = setup(t);
  const deliveries: InputDelivery[] = [];
  transport.input.subscribeInputDelivery((delivery) => deliveries.push(delivery));
  for (const reject of [false, true]) {
    transport.input.ensureInputFocus(surface);
    const request = sent[sent.length - 1],
      identity = transport.input.inputIdentity(surface);
    const end = {
      type: 'touch',
      gestureMode: 'client-v1',
      action: 'end',
      inputIdentity: identity,
      sequenceId: 'focus',
    };
    assert.equal(transport.input.sendInput(surface, end), true);
    if (reject)
      channel.onmessage({
        data: JSON.stringify({
          type: 'focus',
          focusRequestId: request.focusRequestId,
          layoutEpoch: '2',
          ok: false,
          error: { code: 'conflict', message: 'stale_focus' },
        }),
      });
    else t.mock.timers.tick(2000);
    await Promise.resolve();
    assert.notEqual(transport.input.inputIdentity(surface), identity);
    assert.deepEqual(
      deliveries.splice(0).map((item) => [item.phase, item.identity, item.event, item.reason]),
      [
        ['queued', identity, end, undefined],
        ['discarded', identity, end, reject ? 'focus-rejected' : 'focus-timeout'],
      ],
    );
  }
  assert.deepEqual(
    sent.map((item) => item.type),
    ['focus', 'focus'],
  );
});

test('a local channel send failure reports discarded touch packets and drops dependent queued input', async (t) => {
  const { transport, surface, sent, channel } = setup(t);
  const deliveries: InputDelivery[] = [];
  transport.input.subscribeInputDelivery((delivery) => deliveries.push(delivery));
  const start = { type: 'touch', gestureMode: 'client-v1', action: 'start', sequenceId: 'failed' };
  const end = { ...start, action: 'end' };
  channel.bufferedAmount = 300000;
  assert.equal(transport.input.sendInput(surface, start), true);
  assert.equal(transport.input.sendInput(surface, end), true);
  assert.equal(transport.input.sendInput(surface, { type: 'ime_commit', text: 'still queued' }), true);
  const send = channel.send;
  channel.send = () => {
    throw new Error('send failed');
  };
  channel.bufferedAmount = 0;
  channel.onbufferedamountlow();
  channel.send = send;
  channel.onbufferedamountlow();
  await Promise.resolve();
  assert.deepEqual(
    deliveries.map((item) => [item.phase, item.event, item.reason]),
    [
      ['queued', start, undefined],
      ['queued', end, undefined],
      ['discarded', start, 'channel-send-failed'],
      ['discarded', end, 'touch-send-failed'],
    ],
  );
  assert.deepEqual(
    sent.map((item) => item.event.type),
    ['ime_commit'],
  );
});

test('unacknowledged terminals never block successive touch starts or poll', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport, surface, sent } = setup(t);
  const touch = new TouchInput('rapid');
  const identity = transport.input.inputIdentity(surface);
  for (let i = 0; i < 100; ++i) {
    const start = touch.sample(identity, 'start', point(0), i * 100)!;
    assert.equal(transport.input.sendInput(surface, start), true);
    touch.accepted(start);
    const end = touch.sample(identity, 'end', point(0), i * 100 + 20)!;
    assert.equal(transport.input.sendInput(surface, end), true);
    touch.accepted(end);
  }
  t.mock.timers.tick(30000);
  assert.equal(sent.length, 200);
  assert.ok(sent.every((message) => message.type === 'input'));
  assert.equal(
    new Set(sent.filter((m) => m.event.action === 'start').map((m) => m.event.sequenceId)).size,
    100,
  );
});
