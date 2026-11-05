import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { inputFixture } from './client-fixture';
import { TouchInput } from '../client/input/touch-input';
import type { Surface } from '../client/presentation/types';
import { touchTerminalResult, type TouchOwner } from '../client/input/touch-terminal';
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
    transport.touch.clearTerminalInput();
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
test('destroyed target receipts retire exact old touch through production transport and allow next tap', (t) => {
  const { transport, surface, sent, channel } = setup(t);
  const touch = new TouchInput('destroyed'),
    identity = transport.input.inputIdentity(surface);
  let owner: TouchOwner | undefined;
  const results: InputResult[] = [];
  transport.input.subscribeInputResults((result) => {
    results.push(result);
    if (
      owner &&
      touchTerminalResult(owner, result, transport.input.inputIdentity(surface), touch.contactIds.length)
    ) {
      touch.reset();
      owner = undefined;
    }
  });
  const start = touch.sample(identity, 'start', point(0), 0, undefined)!;
  owner = { surface: { ...surface }, identity, packet: start };
  transport.input.sendInput(surface, start);
  const move = touch.sample(identity, 'move', point(30), 30)!;
  owner.packet = move;
  transport.input.sendInput(surface, move);
  const end = touch.sample(identity, 'end', point(30), 40)!;
  owner.packet = end;
  transport.input.sendInput(surface, end);
  touch.accepted(end);
  const oldOwner = owner;
  const reply = (index: number, extra: object) =>
    channel.onmessage({
      data: JSON.stringify({
        type: 'input.result',
        clientSequence: sent[index].sequence,
        ok: false,
        ...extra,
      }),
    });
  reply(1, {
    error: 'touch owner destroyed',
    touchState: 'terminal-invalidated',
    touchSequenceId: move.sequenceId,
  });
  assert.equal(owner, undefined);
  assert.equal(results[0].ok, false); // retirement is not delivery success
  const next = touch.sample(identity, 'start', point(10), 100, undefined)!;
  assert.notEqual(next.sequenceId, start.sequenceId);
  owner = { surface: { ...surface }, identity, packet: next };
  transport.input.sendInput(surface, next);
  reply(2, { touchState: 'terminal-invalidated', touchSequenceId: end.sequenceId });
  assert.equal(owner.packet, next); // late end for retired owner cannot clear new contact
  assert.equal(touchTerminalResult(oldOwner, results[0], `new-attempt:${identity}`, 0), undefined);
  const nextEnd = touch.sample(identity, 'end', point(10), 110)!;
  owner.packet = nextEnd;
  transport.input.sendInput(surface, nextEnd, { touchTerminal: true });
  touch.accepted(nextEnd);
  const heldOwner = owner;
  assert.ok(heldOwner); // local queue admission and no ACK keep the owner unresolved
  reply(4, {
    error: 'touch_terminal_timeout',
    touchState: 'terminal-unconfirmed',
    touchSequenceId: nextEnd.sequenceId,
  });
  assert.equal(owner, heldOwner); // timeout must not pretend completion
  reply(0, { touchState: 'terminal-invalidated', touchSequenceId: start.sequenceId });
  assert.equal(owner, heldOwner);
  channel.onmessage({
    data: JSON.stringify({ type: 'input.result', clientSequence: sent[4].sequence, ok: true }),
  });
  assert.equal(owner, heldOwner);
  channel.onmessage({
    data: JSON.stringify({
      type: 'input.result',
      clientSequence: sent[4].sequence,
      ok: true,
      touchState: 'processed',
      touchSequenceId: nextEnd.sequenceId,
    }),
  });
  assert.equal(owner, undefined);
});

test('move end and cancel require explicit matching retirement proof and full owner identity', (t) => {
  const { transport, surface, sent, channel } = setup(t),
    identity = transport.input.inputIdentity(surface);
  const touch = new TouchInput('terminal');
  const start = touch.sample(identity, 'start', point(0), 0, undefined)!;
  const owner: TouchOwner = { surface: { ...surface }, identity, packet: start };
  const results: InputResult[] = [];
  transport.input.subscribeInputResults((result) => results.push(result));
  for (const action of ['move', 'end', 'cancel'] as const) {
    const packet = { ...start, action };
    transport.input.sendInput(surface, packet);
    channel.onmessage({
      data: JSON.stringify({
        type: 'input.result',
        clientSequence: sent[sent.length - 1].sequence,
        ok: false,
        touchState: 'terminal-invalidated',
        touchSequenceId: start.sequenceId,
      }),
    });
    const result = results[results.length - 1];
    assert.equal(touchTerminalResult(owner, result, identity, 1), 'invalidated');
    assert.equal(
      touchTerminalResult(owner, { ...result, touchSequenceId: 'unknown' }, identity, 1),
      undefined,
    );
    assert.equal(touchTerminalResult(owner, { ...result, touchState: undefined }, identity, 1), undefined);
    for (const field of ['session', 'id', 'instance', 'document'] as const)
      assert.equal(
        touchTerminalResult(
          owner,
          { ...result, surface: { ...result.surface, [field]: 'other' } },
          identity,
          1,
        ),
        undefined,
      );
    assert.equal(touchTerminalResult(owner, { ...result, identity: 'other' }, identity, 1), undefined);
  }
});
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
      error: 'busy',
    }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].surface.document, 'd');
  assert.equal(results[0].event, event);
  assert.equal(results[0].ok, false);
  unsubscribe();
  assert.equal(transport.observations.diagnostics.error, 'busy');
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

test('terminal timeout starts on submission, survives ordinary receipt churn, and queries the original request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport, surface, sent, channel } = setup(t);
  const deliveries: InputDelivery[] = [];
  const results: InputResult[] = [];
  transport.input.subscribeInputDelivery((delivery) => deliveries.push(delivery));
  transport.input.subscribeInputResults((result) => results.push(result));
  const end = { type: 'touch', gestureMode: 'client-v1', action: 'end', sequenceId: 'terminal' };
  channel.bufferedAmount = 300000;
  assert.equal(transport.input.sendInput(surface, end, { touchTerminal: true }), true);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(
    deliveries.map((item) => item.phase),
    ['queued'],
  );
  assert.equal(sent.length, 0);
  channel.bufferedAmount = 0;
  channel.onbufferedamountlow();
  const original = sent[0].sequence;
  const reply = (touchState: string, touchSequenceId: string, ok = true) =>
    channel.onmessage({
      data: JSON.stringify({
        type: 'input.result',
        clientSequence: original,
        ok,
        touchState,
        touchSequenceId,
      }),
    });
  reply('accepted-pending', 'terminal');
  reply('accepted-pending', 'terminal');
  for (let i = 0; i < 260; i++)
    assert.equal(transport.input.sendInput(surface, { type: 'ime_commit', text: 'x' }), true);
  reply('processed', 'old');
  assert.deepEqual(
    results.map((item) => item.touchState),
    ['accepted-pending'],
  );
  t.mock.timers.tick(250);
  assert.deepEqual(sent[sent.length - 1], {
    type: 'input.touchStatus',
    clientSequence: original,
    sequenceId: 'terminal',
  });
  reply('terminal-unconfirmed', 'terminal', false);
  for (const delay of [500, 1000, 2000, 1000]) t.mock.timers.tick(delay);
  await Promise.resolve();
  assert.deepEqual(
    deliveries.map((item) => item.phase),
    ['queued', 'submitted', 'unconfirmed'],
  );
  assert.equal(transport.touch.retryTouchTerminal(transport.input.inputIdentity(surface), 'terminal'), true);
  t.mock.timers.tick(250);
  assert.deepEqual(sent[sent.length - 1], {
    type: 'input.touchStatus',
    clientSequence: original,
    sequenceId: 'terminal',
  });
  assert.equal(
    sent.filter((item) => item.type === 'input' && item.event?.sequenceId === 'terminal').length,
    1,
  );
  reply('processed', 'terminal');
  assert.deepEqual(
    results.map((item) => item.touchState),
    ['accepted-pending', 'terminal-unconfirmed', 'processed'],
  );
  assert.equal(results[results.length - 1]?.event, end);
  assert.equal(transport.touch.retryTouchTerminal(transport.input.inputIdentity(surface), 'terminal'), false);
});

test('ordinary partial release succeeds without a status query or releasing the other contact', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport, surface, sent, channel } = setup(t);
  const identity = transport.input.inputIdentity(surface);
  const touch = new TouchInput('partial');
  touch.sample(identity, 'start', point(0), 0, undefined);
  touch.sample(identity, 'start', { ...point(0), id: 2 }, 1);
  const end = touch.sample(identity, 'end', point(0), 2)!;
  const results: InputResult[] = [];
  transport.input.subscribeInputResults((result) => results.push(result));
  transport.input.sendInput(surface, end, { touchTerminal: false });
  channel.onmessage({
    data: JSON.stringify({ type: 'input.result', clientSequence: sent[0].sequence, ok: true }),
  });
  t.mock.timers.tick(5000);
  assert.equal(sent.length, 1);
  assert.equal(results.length, 1);
  assert.equal(touchTerminalResult({ identity, surface, packet: end }, results[0], identity, 1), undefined);
});

test('exact cleanup settles a lost terminal and a late original result cannot clear the next touch', (t) => {
  const { transport, surface, sent, channel } = setup(t),
    identity = transport.input.inputIdentity(surface);
  const touch = new TouchInput('cleanup');
  const results: InputResult[] = [];
  transport.input.subscribeInputResults((result) => results.push(result));
  const receive = (clientSequence: string, touchSequenceId: string, touchState: string, ok: boolean) =>
    channel.onmessage({
      data: JSON.stringify({ type: 'input.result', clientSequence, touchSequenceId, touchState, ok }),
    });
  for (let index = 0; index < 50; ++index) {
    const start = touch.sample(identity, 'start', point(0), index * 10, undefined)!;
    assert.equal(transport.input.sendInput(surface, start), true);
    const end = touch.sample(identity, 'end', point(0), index * 10 + 1)!;
    assert.equal(transport.input.sendInput(surface, end, { touchTerminal: true }), true);
    const original = sent[sent.length - 1].sequence;
    touch.accepted(end);
    receive(original, end.sequenceId, 'terminal-unconfirmed', false);
    const cancel = { ...end, action: 'cancel' as const, points: [], gestures: [] };
    assert.equal(transport.input.sendInput(surface, cancel), true);
    const cleanup = sent[sent.length - 1].sequence;
    const owner = { identity, surface, packet: cancel };
    assert.equal(touchTerminalResult(owner, results[results.length - 1], identity, 0), undefined);
    receive(cleanup, 'wrong-owner', 'processed', true);
    assert.equal(results[results.length - 1]?.touchState, 'terminal-unconfirmed');
    receive(index % 2 === 0 ? cleanup : original, end.sequenceId, 'processed', true);
    assert.equal(touchTerminalResult(owner, results[results.length - 1], identity, 0), 'processed');
    assert.equal(transport.touch.retryTouchTerminal(identity, end.sequenceId), false);
    const count = results.length;
    receive(index % 2 === 0 ? original : cleanup, end.sequenceId, 'processed', true);
    assert.equal(results.length, count);
  }
  assert.deepEqual(sent.map((message) => message.event.action).slice(-3), ['start', 'end', 'cancel']);
});

test('layout replacement retires only a submitted touch with its acknowledged focus token', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport, surface, sent, channel, setReady } = setup(t);
  const receive = (message: object) => channel.onmessage({ data: JSON.stringify(message) });
  const layout = (epoch: string) =>
    receive({ type: 'layout', generation: '1', epoch, width: 640, height: 480, views: [{ ...surface }] });
  const deliveries: InputDelivery[] = [];
  const results: InputResult[] = [];
  transport.input.subscribeInputDelivery((delivery) => deliveries.push(delivery));
  transport.input.subscribeInputResults((result) => results.push(result));

  transport.input.ensureInputFocus(surface);
  let current = transport.presentation.layout!.views[0];
  const start = (id: string) => ({
    type: 'touch',
    action: 'start',
    gestureMode: 'client-v1',
    sequenceId: id,
    inputIdentity: transport.input.inputIdentity(current),
  });
  assert.equal(transport.input.sendInput(current, start('never-submitted')), true);
  layout('3');
  await Promise.resolve();
  assert.deepEqual(
    deliveries.map((delivery) => delivery.phase),
    ['queued', 'discarded'],
  );
  assert.deepEqual(
    sent.map((message) => message.type),
    ['focus'],
  );

  current = transport.presentation.layout!.views[0];
  transport.input.ensureInputFocus(current);
  const focus = sent[sent.length - 1];
  assert.equal(transport.input.sendInput(current, start('lost-original-start')), true);
  receive({
    type: 'focus',
    focusRequestId: focus.focusRequestId,
    layoutEpoch: '3',
    ok: true,
    token: {
      view: current.id,
      session: current.session,
      instance: current.instance,
      document: current.document,
      focus: '8',
    },
  });
  await Promise.resolve();
  const submitted = deliveries[deliveries.length - 1];
  assert.equal(submitted.phase, 'submitted');
  assert.equal(submitted.surface.focus, '8');
  const lease = {
    surface: submitted.surface,
    identity: submitted.identity,
    layoutEpoch: submitted.layoutEpoch!,
    authorization: submitted.authorization,
  };
  const cancel = { ...submitted.event, action: 'cancel', points: [] };
  assert.equal(transport.touch.retireTouch(lease, cancel), false); // requires a replacement epoch
  setReady(false);
  layout('4'); // same output generation, different sampling/layout epoch
  assert.equal(transport.input.sendInput(current, { ...submitted.event, action: 'move' }), false);
  assert.equal(transport.touch.retireTouch(lease, cancel), true); // no coordinate paint required
  const request = sent[sent.length - 1];
  assert.deepEqual(request, {
    type: 'input.touchRetire',
    view: '1',
    session: 's',
    instance: 'i',
    document: 'd',
    focus: '8',
    layoutEpoch: '3',
    sequence: request.sequence,
    sequenceId: 'lost-original-start',
  });
  receive({
    type: 'input.result',
    clientSequence: request.sequence,
    ok: true,
    touchState: 'accepted-pending',
    touchSequenceId: request.sequenceId,
  });
  layout('5'); // another layout cannot prune the outstanding retirement receipt
  t.mock.timers.tick(250);
  assert.deepEqual(sent[sent.length - 1], {
    type: 'input.touchStatus',
    clientSequence: request.sequence,
    sequenceId: request.sequenceId,
  });
  receive({
    type: 'input.result',
    clientSequence: request.sequence,
    ok: false,
    touchState: 'terminal-invalidated',
    touchSequenceId: request.sequenceId,
  });
  assert.deepEqual(
    results.map((result) => result.touchState),
    ['accepted-pending', 'terminal-invalidated'],
  );
  assert.equal(results[1].identity, lease.identity);
  assert.equal(results[1].surface.focus, '8');
  assert.equal(transport.touch.retryTouchTerminal(lease.identity, request.sequenceId), false);
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
    assert.equal(transport.input.sendInput(surface, end, { touchTerminal: true }), true);
    if (reject)
      channel.onmessage({
        data: JSON.stringify({
          type: 'focus',
          focusRequestId: request.focusRequestId,
          layoutEpoch: '2',
          ok: false,
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

test('unresolved terminal storage reserves end and cancel capacity and leaves keyboard available', (t) => {
  const { transport, surface, sent } = setup(t);
  const end = (index: number) => ({
    type: 'touch',
    gestureMode: 'client-v1',
    action: 'end',
    sequenceId: String(index),
  });
  for (let i = 0; i < 48; i++) assert.equal(transport.input.sendInput(surface, end(i)), true);
  assert.equal(transport.input.sendInput(surface, { ...end(100), action: 'start' }), false);
  for (let i = 48; i < 56; i++) assert.equal(transport.input.sendInput(surface, end(i)), true);
  assert.equal(transport.input.sendInput(surface, end(56)), false);
  for (let i = 56; i < 64; i++)
    assert.equal(transport.input.sendInput(surface, { ...end(i), action: 'cancel' }), true);
  assert.equal(transport.input.sendInput(surface, { ...end(64), action: 'cancel' }), false);
  assert.equal(transport.input.sendInput(surface, { type: 'ime_commit', text: 'x' }), true);
  assert.equal(sent.length, 65);
});

test('a local channel send failure reports discarded touch packets and drops dependent queued input', async (t) => {
  const { transport, surface, sent, channel } = setup(t);
  const deliveries: InputDelivery[] = [];
  transport.input.subscribeInputDelivery((delivery) => deliveries.push(delivery));
  const start = { type: 'touch', gestureMode: 'client-v1', action: 'start', sequenceId: 'failed' };
  const end = { ...start, action: 'end' };
  channel.bufferedAmount = 300000;
  assert.equal(transport.input.sendInput(surface, start), true);
  assert.equal(transport.input.sendInput(surface, end, { touchTerminal: true }), true);
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
  assert.equal(transport.touch.retryTouchTerminal(transport.input.inputIdentity(surface), 'failed'), false);
});
