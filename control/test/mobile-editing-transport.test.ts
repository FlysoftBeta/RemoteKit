import test from 'node:test';
import assert from 'node:assert/strict';
import { inputFixture } from './client-fixture';
import { EditingInput } from '../client/editing/editing-input';
import { DeferredEditingInput } from '../client/editing/mobile-editing-state';
import type { Surface } from '../client/presentation/types';

function setup() {
  const transport = inputFixture();
  transport.presentation.canInput = () => false;
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
  transport.presentation.layout = {
    type: 'layout',
    generation: '1',
    epoch: '2',
    width: 400,
    height: 768,
    views: [surface],
  };
  transport.editing.mobileEditing.acceptLayout(transport.presentation.layout);
  const sent: any[] = [];
  const channel: any = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (text: string) => sent.push(JSON.parse(text)),
  };
  transport.endpoint.bindChannel(channel);
  const receive = (value: unknown) => channel.onmessage({ data: JSON.stringify(value) });
  const editable = (revision: string, focus = '7', active = true, target = active ? '31' : '0') =>
    receive({
      type: 'input.editable',
      version: 1,
      revision,
      view: active ? { ...surface, focus } : null,
      editable: {
        focusSource: 'pointer',
        focusRevision: '1',
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
  const layout = transport.presentation.layout,
    peer = { close: () => assert.fail('RTC must remain intact') };
  transport.rtc.peer = peer;
  assert.equal(transport.presentation.displayReady, false);
  editable('1');
  assert.ok(transport.editing.mobileEditing.forView(surface));
  assert.equal(transport.presentation.layout, layout);
  assert.equal(surface.focus, '7');
  assert.equal(transport.presentation.displayReady, false);
  assert.equal(transport.rtc.peer, peer);
  assert.equal(transport.input.sendInput(surface, { type: 'ime_commit', text: 'blocked' }), false);
  editable('2', '7', false);
  assert.equal(transport.editing.mobileEditing.forView(surface), undefined);
  editable('1');
  assert.equal(transport.editing.mobileEditing.forView(surface), undefined);
});
test('reconfigure preserves keyboard owner and composition, then uses the fresh exact lease', () => {
  const { transport, surface, editable, receive } = setup();
  const layout = transport.presentation.layout!;
  const input = new EditingInput(),
    queue = new DeferredEditingInput();
  editable('1');
  const identity = transport.editing.editingIdentity(surface);
  input.focus(identity);
  assert.ok(input.start(identity));
  receive({ ...layout, generation: '0', epoch: '3', views: [], reconfiguring: true });
  assert.deepEqual(transport.presentation.layout!.views, []);
  assert.equal(transport.editing.editingSurface('v'), surface);
  const owner = transport.editing.mobileEditing.forKeyboard(transport.editing.editingSurface('v'))?.editable
    .target;
  assert.equal(owner, '31');
  assert.equal(transport.editing.mobileEditing.forView(surface), undefined);
  assert.equal(
    transport.input.sendInput(surface, { type: 'ime_set', text: '你', editableTarget: owner }),
    false,
  );
  assert.ok(queue.enqueue(owner!, { ...input.update(identity, '你'), editableTarget: owner }));
  editable('2', '8');
  assert.equal(
    transport.editing.mobileEditing.forKeyboard(transport.editing.editingSurface('v'))?.editable.target,
    owner,
  );
  assert.equal(transport.editing.mobileEditing.forView(surface), undefined);
  const next = { ...surface, focus: '8', height: 340 };
  receive({ ...layout, generation: '2', epoch: '4', views: [next] });
  assert.equal(transport.editing.mobileEditing.forView(next)?.editable.target, owner);
  assert.deepEqual(queue.drain(owner!), [
    { type: 'ime_set', text: '你', selection_start: 1, selection_end: 1, editableTarget: owner },
  ]);
  assert.deepEqual(input.end(identity, '你好', 1), { type: 'ime_commit', text: '你好' });
  assert.equal(transport.presentation.displayReady, false);
  editable('3', '8', false);
  assert.equal(transport.editing.mobileEditing.forKeyboard(transport.editing.editingSurface('v')), undefined);
});
test('all output barriers preserve editing; only an authoritative view removal revokes it', () => {
  const { transport, surface, editable, receive } = setup();
  const layout = transport.presentation.layout!;
  editable('1');
  receive({ ...layout, generation: '0', epoch: '3', views: [], reconfiguring: true });
  editable('2', '8', true, '32');
  assert.equal(
    transport.editing.mobileEditing.forKeyboard(transport.editing.editingSurface('v'))?.editable.target,
    '32',
  );
  assert.equal(transport.editing.mobileEditing.forView(surface), undefined);
  const next = { ...surface, focus: '8' };
  receive({ ...layout, generation: '2', epoch: '4', views: [next] });
  assert.equal(transport.editing.mobileEditing.forView(next)?.editable.target, '32');
  receive({ ...layout, generation: '0', epoch: '5', views: [], reconfiguring: true });
  receive({ ...layout, generation: '0', epoch: '6', views: [] });
  assert.deepEqual(transport.editing.editingSurface('v'), next);
  assert.equal(transport.editing.mobileEditing.forKeyboard(next)?.editable.target, '32');
  assert.equal(transport.editing.mobileEditing.forView(next), undefined);
  receive({ ...layout, generation: '3', epoch: '7', views: [] });
  assert.equal(transport.editing.editingSurface('v'), undefined);
  assert.equal(transport.editing.mobileEditing.forKeyboard(next), undefined);
});
test('focus ACK reevaluates one early editable candidate without modifying token from feedback', () => {
  const { transport, surface, editable, receive, sent } = setup();
  transport.presentation.canInput = () => true;
  transport.input.ensureInputFocus(surface);
  const request = sent[0];
  editable('1', '8');
  assert.equal(surface.focus, '7');
  assert.equal(transport.editing.mobileEditing.forView(surface), undefined);
  receive({
    type: 'focus',
    ok: true,
    focusRequestId: request.focusRequestId,
    layoutEpoch: '2',
    token: { view: 'v', session: 's', instance: 'i', document: 'd', focus: '8' },
  });
  assert.equal(surface.focus, '8');
  assert.ok(transport.editing.mobileEditing.forView(surface));
  transport.input.focus(surface, false);
  assert.equal(transport.editing.mobileEditing.forView(surface), undefined);
  transport.input.reset();
});

test('dismissal shares input ordering and can close menus during a media barrier', () => {
  const { transport, surface, sent, receive } = setup();
  transport.presentation.canInput = () => true;
  assert(transport.input.sendInput(surface, { type: 'ime_commit', text: 'done' }));
  assert(transport.input.sendInput(surface, { type: 'editing.dismiss', target: '31', revision: '8' }));
  const ordered = sent.filter((message) => message.sequence);
  assert.equal(ordered[0].type, 'input');
  assert.equal(ordered[0].event.type, 'ime_commit');
  assert.equal(ordered[1].type, 'editing.dismiss');
  assert.equal(ordered[1].target, '31');
  assert.equal(ordered[1].revision, '8');
  assert.equal(BigInt(ordered[1].sequence), BigInt(ordered[0].sequence) + 1n);
  transport.presentation.canInput = () => false;
  assert(transport.input.sendInput(surface, { type: 'selection_command', menu: '5', command: 'dismiss' }));
  assert.equal(sent[sent.length - 1].event.command, 'dismiss');
  assert(transport.input.sendInput(surface, { type: 'context_command', menu: '6', command: 'dismiss' }));
  assert.equal(sent[sent.length - 1].event.menu, '6');
  receive({ ...transport.presentation.layout!, generation: '0', epoch: '3', views: [], reconfiguring: true });
  assert(transport.input.sendInput(surface, { type: 'editing.dismiss', target: '31', revision: '8' }));
  assert.equal(sent[sent.length - 1].type, 'editing.dismiss');
  assert.equal(sent[sent.length - 1].document, 'd');
  transport.input.reset();
});
