import test from 'node:test';
import assert from 'node:assert/strict';
import { inputFixture } from './client-fixture';
import type { Surface } from '../client/presentation/types';

function setup() {
  const transport = inputFixture();
  const surface = (id: string): Surface => ({
    id,
    session: 's',
    instance: `i${id}`,
    document: `d${id}`,
    focus: '7',
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    deviceScaleFactor: 1,
  });
  const a = surface('1'),
    b = surface('2'),
    sent: Record<string, any>[] = [];
  const channel: any = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (data: string) => sent.push(JSON.parse(data)),
  };
  transport.presentation.layout = {
    type: 'layout',
    generation: '1',
    epoch: '2',
    width: 1280,
    height: 480,
    views: [a, b],
  };
  // These tests isolate focus ACK ordering; rendering readiness has its own tests.
  transport.presentation.canInput = () => true;
  transport.endpoint.bindChannel(channel);
  const ack = (request: Record<string, any>, extras: Record<string, unknown> = {}) =>
    channel.onmessage({
      data: JSON.stringify({
        type: 'focus',
        ok: true,
        focusRequestId: request.focusRequestId,
        layoutEpoch: request.layoutEpoch,
        token: {
          view: request.view,
          session: request.session,
          instance: request.instance,
          document: request.document,
          focus: request.focus,
        },
        ...extras,
      }),
    });
  return { transport, a, b, sent, ack };
}

test('already-focused ACK releases input even when the focus token remains unchanged', () => {
  const { transport, a, sent, ack } = setup();
  transport.input.focus(a, true);
  const request = sent[0];
  transport.input.sendInput(a, { type: 'ime_commit', text: 'first' });
  assert.equal(sent.length, 1);
  transport.input.focus(a, true);
  assert.equal(sent.length, 1, 'duplicate pending focus preserves its queue');
  ack(request);
  assert.equal(sent[1].event.text, 'first');
  assert.equal(sent[1].focus, '7');
  transport.input.focus(a, true);
  transport.input.sendInput(a, { type: 'ime_commit', text: 'second' });
  ack(sent[2]);
  assert.equal(sent[3].event.text, 'second');
});

test('rapid A to B to A ignores old ACK and rejects mismatched epoch or identity', () => {
  const { transport, a, b, sent, ack } = setup();
  transport.input.focus(a, true);
  const old = sent[0];
  transport.input.focus(b, true);
  transport.input.focus(a, true);
  const current = sent[2];
  transport.input.sendInput(a, { type: 'ime_commit', text: 'current' });
  ack(old);
  ack(current, { layoutEpoch: '1' });
  ack(current, {
    token: { view: '1', session: 'other', instance: a.instance, document: a.document, focus: '8' },
  });
  assert.equal(sent.length, 3);
  ack(current);
  assert.equal(sent.length, 4);
  assert.equal(sent[3].event.text, 'current');
  assert.equal(sent[3].view, '1');
});

test('matched rejected focus drops queued input and reports the rejection', () => {
  const { transport, a, sent, ack } = setup();
  transport.input.focus(a, true);
  transport.input.sendInput(a, { type: 'ime_commit', text: 'reject' });
  ack(sent[0], { ok: false, error: 'stale_focus' });
  assert.equal(sent.length, 1);
  assert.equal(transport.observations.diagnostics.error, 'stale_focus');
  transport.input.ensureInputFocus(a);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].focusRequestId, sent[0].focusRequestId);
  ack(sent[0], { ok: false });
  transport.input.ensureInputFocus(a);
  assert.equal(sent.length, 2, 'old rejection preserves the new pending request');
  ack(sent[1]);
  transport.input.ensureInputFocus(a);
  assert.equal(sent.length, 2, 'successful ACK preserves established focus');
});

test('focus timeout revokes only its own optimistic identity and permits a new request', (t) => {
  const timers: (() => void)[] = [];
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => {
    timers.push(callback);
    return timers.length;
  }) as any);
  t.mock.method(globalThis, 'clearTimeout', (() => {}) as any);
  const { transport, a, b, sent, ack } = setup();
  transport.input.ensureInputFocus(a);
  transport.input.sendInput(a, { type: 'ime_commit', text: 'expired' });
  timers[0]();
  transport.input.ensureInputFocus(a);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].focusRequestId, sent[1].focusRequestId);
  timers[0]();
  transport.input.ensureInputFocus(a);
  assert.equal(sent.length, 2, 'old timeout leaves new request intact');
  ack(sent[1]);
  timers[1]();
  transport.input.ensureInputFocus(a);
  assert.equal(sent.length, 2, 'queued old timeout cannot revoke ACK');
  transport.input.focus(b, true);
  const old = timers[timers.length - 1]!;
  transport.input.focus(a, true);
  old();
  transport.input.ensureInputFocus(a);
  assert.equal(sent.length, 4);
  ack(sent[3]);
  assert.equal(
    sent.some((message) => message.type === 'input'),
    false,
    'expired queued input is discarded',
  );
});
