import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import { EditingInput } from '../client/editing-input';
import { DeferredEditingInput } from '../client/mobile-editing-state';
import type { Surface } from '../client/types';

function setup() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({}) } });
  let transport: RemoteTransport;
  try {
    transport = new RemoteTransport();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
  const surface: Surface = {
    session: 's',
    id: 'v',
    instance: 'i',
    document: 'd',
    focus: '7',
    x: 0,
    y: 0,
    width: 390,
    height: 764,
    deviceScaleFactor: 1,
  };
  transport.layout = {
    type: 'layout',
    generation: '1',
    epoch: '2',
    width: 400,
    height: 768,
    views: [surface],
  };
  transport.mobileEditing.acceptLayout(transport.layout);
  const sent: any[] = [];
  const channel: any = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (text: string) => sent.push(JSON.parse(text)),
  };
  (transport as any).bindChannel(channel);
  const receive = (value: unknown) => channel.onmessage({ data: JSON.stringify(value) });
  const editable = (revision: string, focus = '7', active = true, target = active ? '31' : '0') =>
    receive({
      type: 'input.editable',
      version: 1,
      revision,
      view: active ? { ...surface, focus } : null,
      editable: {
        type: active ? 1 : 0,
        active,
        target,
        flags: 0,
        selectionStart: 0,
        selectionEnd: 0,
        compositionStart: -1,
        compositionEnd: -1,
        caretX: 10,
        caretY: 20,
        caretWidth: 1,
        caretHeight: 10,
      },
    });
  return { transport, surface, receive, editable, sent };
}
test('editable feedback only updates peer editing state and never opens frame/input/RTC barriers', () => {
  const { transport, surface, editable } = setup();
  const layout = transport.layout,
    peer = { close: () => assert.fail('RTC must remain intact') };
  (transport as any).peer = peer;
  assert.equal(transport.displayReady, false);
  editable('1');
  assert.ok(transport.mobileEditing.forView(surface));
  assert.equal(transport.layout, layout);
  assert.equal(surface.focus, '7');
  assert.equal(transport.displayReady, false);
  assert.equal((transport as any).peer, peer);
  assert.equal(transport.sendInput(surface, { type: 'ime_commit', text: 'blocked' }), false);
  editable('2', '7', false);
  assert.equal(transport.mobileEditing.forView(surface), undefined);
  editable('1');
  assert.equal(transport.mobileEditing.forView(surface), undefined);
});
test('reconfigure preserves keyboard owner and composition, then uses the fresh exact lease', () => {
  const { transport, surface, editable, receive } = setup();
  const layout = transport.layout!;
  const input = new EditingInput(),
    queue = new DeferredEditingInput();
  editable('1');
  const identity = transport.editingIdentity(surface);
  input.focus(identity);
  assert.ok(input.start(identity));
  receive({ ...layout, generation: '0', epoch: '3', views: [], reconfiguring: true });
  assert.deepEqual(transport.layout!.views, []);
  assert.equal(transport.editingSurface('v'), surface);
  const owner = transport.mobileEditing.forKeyboard(transport.editingSurface('v'))?.editable.target;
  assert.equal(owner, '31');
  assert.equal(transport.mobileEditing.forView(surface), undefined);
  assert.equal(transport.sendInput(surface, { type: 'ime_set', text: '你', editableTarget: owner }), false);
  assert.ok(queue.enqueue(owner!, { ...input.update(identity, '你'), editableTarget: owner }));
  editable('2', '8');
  assert.equal(transport.mobileEditing.forKeyboard(transport.editingSurface('v'))?.editable.target, owner);
  assert.equal(transport.mobileEditing.forView(surface), undefined);
  const next = { ...surface, focus: '8', height: 340 };
  receive({ ...layout, generation: '2', epoch: '4', views: [next] });
  assert.equal(transport.mobileEditing.forView(next)?.editable.target, owner);
  assert.deepEqual(queue.drain(owner!), [
    { type: 'ime_set', text: '你', selection_start: 1, selection_end: 1, editableTarget: owner },
  ]);
  assert.deepEqual(input.end(identity, '你好', 1), { type: 'ime_commit', text: '你好' });
  assert.equal(transport.displayReady, false);
  editable('3', '8', false);
  assert.equal(transport.mobileEditing.forKeyboard(transport.editingSurface('v')), undefined);
});
test('all output barriers preserve editing; only an authoritative view removal revokes it', () => {
  const { transport, surface, editable, receive } = setup();
  const layout = transport.layout!;
  editable('1');
  receive({ ...layout, generation: '0', epoch: '3', views: [], reconfiguring: true });
  editable('2', '8', true, '32');
  assert.equal(transport.mobileEditing.forKeyboard(transport.editingSurface('v'))?.editable.target, '32');
  assert.equal(transport.mobileEditing.forView(surface), undefined);
  const next = { ...surface, focus: '8' };
  receive({ ...layout, generation: '2', epoch: '4', views: [next] });
  assert.equal(transport.mobileEditing.forView(next)?.editable.target, '32');
  receive({ ...layout, generation: '0', epoch: '5', views: [], reconfiguring: true });
  receive({ ...layout, generation: '0', epoch: '6', views: [] });
  assert.deepEqual(transport.editingSurface('v'), next);
  assert.equal(transport.mobileEditing.forKeyboard(next)?.editable.target, '32');
  assert.equal(transport.mobileEditing.forView(next), undefined);
  receive({ ...layout, generation: '3', epoch: '7', views: [] });
  assert.equal(transport.editingSurface('v'), undefined);
  assert.equal(transport.mobileEditing.forKeyboard(next), undefined);
});
test('focus ACK reevaluates one early editable candidate without modifying token from feedback', () => {
  const { transport, surface, editable, receive, sent } = setup();
  (transport as any).canInput = () => true;
  transport.ensureInputFocus(surface);
  const request = sent[0];
  editable('1', '8');
  assert.equal(surface.focus, '7');
  assert.equal(transport.mobileEditing.forView(surface), undefined);
  receive({
    type: 'focus',
    ok: true,
    focusRequestId: request.focusRequestId,
    layoutEpoch: '2',
    token: { view: 'v', session: 's', instance: 'i', document: 'd', focus: '8' },
  });
  assert.equal(surface.focus, '8');
  assert.ok(transport.mobileEditing.forView(surface));
  transport.focus(surface, false);
  assert.equal(transport.mobileEditing.forView(surface), undefined);
  clearTimeout((transport as any).focusTimer);
});
