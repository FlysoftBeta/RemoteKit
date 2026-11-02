import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import type { Surface } from '../client/types';

function setup() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({}) } });
  let transport: RemoteTransport;
  try { transport = new RemoteTransport(); } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
  const surface: Surface = { session: 's', id: 'v', instance: 'i', document: 'd', focus: '7', x: 0, y: 0, width: 390, height: 764, deviceScaleFactor: 1 };
  transport.layout = { type: 'layout', generation: '1', epoch: '2', width: 400, height: 768, views: [surface] };
  const sent: any[] = [];
  const channel: any = { readyState: 'open', bufferedAmount: 0, send: (text: string) => sent.push(JSON.parse(text)) };
  (transport as any).bindChannel(channel);
  const receive = (value: unknown) => channel.onmessage({ data: JSON.stringify(value) });
  const editable = (revision: string, focus = '7', active = true) => receive({ type: 'input.editable', version: 1, revision, view: { ...surface, focus }, editable: { type: active ? 1 : 0, active, flags: 0, selectionStart: 0, selectionEnd: 0, compositionStart: -1, compositionEnd: -1, caretX: 10, caretY: 20, caretWidth: 1, caretHeight: 10 } });
  return { transport, surface, receive, editable, sent };
}
test('editable feedback only updates peer editing state and never opens frame/input/RTC barriers', () => {
  const { transport, surface, editable } = setup();
  const layout = transport.layout, peer = { close: () => assert.fail('RTC must remain intact') };
  (transport as any).peer = peer;
  assert.equal(transport.displayReady, false);
  editable('1'); assert.ok(transport.mobileEditing.forView(surface));
  assert.equal(transport.layout, layout); assert.equal(surface.focus, '7');
  assert.equal(transport.displayReady, false); assert.equal((transport as any).peer, peer);
  assert.equal(transport.sendInput(surface, { type: 'ime_commit', text: 'blocked' }), false);
  editable('2', '7', false); assert.equal(transport.mobileEditing.forView(surface), undefined);
  editable('1'); assert.equal(transport.mobileEditing.forView(surface), undefined);
});
test('focus ACK reevaluates one early editable candidate without modifying token from feedback', () => {
  const { transport, surface, editable, receive, sent } = setup();
  (transport as any).canInput = () => true;
  transport.ensureInputFocus(surface); const request = sent[0];
  editable('1', '8'); assert.equal(surface.focus, '7'); assert.equal(transport.mobileEditing.forView(surface), undefined);
  receive({ type: 'focus', ok: true, focusRequestId: request.focusRequestId, layoutEpoch: '2', token: { view: 'v', session: 's', instance: 'i', document: 'd', focus: '8' } });
  assert.equal(surface.focus, '8'); assert.ok(transport.mobileEditing.forView(surface));
  transport.focus(surface, false); assert.equal(transport.mobileEditing.forView(surface), undefined);
  clearTimeout((transport as any).focusTimer);
});
