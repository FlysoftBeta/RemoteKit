import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyboardSession, type KeyboardContext } from '../client/editing/keyboard-session';
const initial: KeyboardContext = {
  document: 'doc',
  enabled: true,
  manual: false,
  editor: 'inactive',
  focused: false,
  ready: true,
  now: 0,
};
function session() {
  const keyboard = new KeyboardSession();
  let context = initial;
  const observe = (patch: Partial<KeyboardContext>) => keyboard.observe((context = { ...context, ...patch }));
  observe({});
  return { keyboard, observe };
}
test('Android opening: remote focus, DOM focus, resize and output gaps do not form a feedback loop', () => {
  const { keyboard, observe } = session();
  assert.deepEqual(observe({ editor: 'active' }), { open: true });
  keyboard.attached(false);
  for (let n = 0; n < 20; n++) {
    assert.deepEqual(observe({ focused: true, ready: false, editor: 'unknown', now: n * 300 }), {});
    assert.equal(keyboard.deadline, undefined);
    assert.deepEqual(observe({ editor: 'active', ready: true }), {});
  }
});
test('Android Back keeps DOM focus; geometry and target changes cannot reopen it', () => {
  const { keyboard, observe } = session();
  observe({ editor: 'active' });
  keyboard.attached(false);
  keyboard.systemDismissed();
  assert.equal(keyboard.shown(true, false, true), false);
  assert.deepEqual(observe({ focused: true, ready: false }), {});
  assert.deepEqual(observe({ ready: true }), {});
  assert.deepEqual(keyboard.activate(), { open: true });
  keyboard.attached(true);
  assert.equal(keyboard.shown(true, false, true), true, 'floating IME needs no resize');
});
test('an OS-refused request is consumed and only another user activation retries', () => {
  const { keyboard, observe } = session();
  assert.deepEqual(observe({ editor: 'active' }), { open: true });
  assert.deepEqual(observe({ focused: false }), {});
  assert.deepEqual(keyboard.activate(), { open: true });
});
test('same-document replacement keeps DOM focus but confirmed NONE closes once', () => {
  const { keyboard, observe } = session();
  observe({ editor: 'active' });
  keyboard.attached(false);
  assert.deepEqual(observe({ focused: true, editor: 'inactive', now: 10 }), {});
  assert.equal(keyboard.deadline, 210);
  assert.deepEqual(observe({ editor: 'active', now: 140 }), {});
  assert.equal(keyboard.deadline, undefined);
  observe({ editor: 'inactive', now: 200 });
  assert.deepEqual(observe({ now: 400 }), { close: 'editor-lost' });
  assert.deepEqual(observe({ focused: false, editor: 'active', now: 401 }), {});
});
test('explicit NONE during a media gap is still authoritative', () => {
  const { keyboard, observe } = session();
  observe({ editor: 'active' });
  keyboard.attached(false);
  observe({ editor: 'unknown', focused: true, ready: false, now: 5 });
  observe({ editor: 'inactive', now: 10 });
  assert.deepEqual(observe({ now: 210 }), { close: 'editor-lost' });
});
test('document, lock and manual policy are boundaries; resumed media is not activation', () => {
  const { keyboard, observe } = session();
  observe({ editor: 'active' });
  keyboard.attached(false);
  assert.deepEqual(observe({ focused: true, enabled: false }), { close: 'boundary' });
  assert.deepEqual(observe({ focused: false, enabled: true }), {});
  assert.deepEqual(observe({ document: 'new', focused: true }), { close: 'boundary' });
  assert.deepEqual(observe({ focused: false }), { open: true });
  assert.deepEqual(observe({ manual: true, focused: true }), { close: 'boundary' });
  assert.deepEqual(keyboard.activate(), {});
  assert.deepEqual(keyboard.activate(true), { open: true });
});
test('late target arrival cannot extend an expired blur grace', () => {
  const { keyboard, observe } = session();
  observe({ editor: 'active' });
  keyboard.attached(false);
  observe({ editor: 'inactive', focused: true, now: 1 });
  assert.deepEqual(observe({ editor: 'active', now: 201 }), { close: 'boundary' });
  assert.deepEqual(observe({ focused: false }), {});
});
