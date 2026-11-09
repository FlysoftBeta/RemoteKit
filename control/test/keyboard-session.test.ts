import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyboardSession, type KeyboardContext } from '../client/editing/keyboard-session';
const initial: KeyboardContext = {
  document: 'doc',
  enabled: true,
  autoOpen: true,
  editor: 'inactive',
  focused: false,
  ready: true,
  now: 0,
};
function session(patch: Partial<KeyboardContext> = {}) {
  const keyboard = new KeyboardSession();
  let context = { ...initial, ...patch };
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
test('document and lock are boundaries; disabling auto-open keeps an attached keyboard', () => {
  const { keyboard, observe } = session();
  observe({ editor: 'active' });
  keyboard.attached(false);
  assert.deepEqual(observe({ focused: true, enabled: false }), { close: 'boundary' });
  assert.deepEqual(observe({ focused: false, enabled: true }), {});
  assert.deepEqual(observe({ document: 'new', focused: true }), { close: 'boundary' });
  assert.deepEqual(observe({ focused: false }), { open: true });
  keyboard.attached(false);
  assert.deepEqual(observe({ autoOpen: false, focused: true }), {});
  assert.deepEqual(observe({ ready: false }), {});
  assert.deepEqual(observe({ ready: true }), {});
});

test('document entry opens only with auto-open enabled', () => {
  for (const autoOpen of [false, true]) {
    const { observe } = session({ autoOpen });
    assert.deepEqual(observe({ editor: 'active' }), autoOpen ? { open: true } : {});
    assert.deepEqual(observe({ document: 'new' }), autoOpen ? { open: true } : {});
  }
});

test('enabling auto-open arms the current document; disabling dismisses an automatic arm', () => {
  const { observe } = session({ autoOpen: false });
  assert.deepEqual(observe({ editor: 'active', ready: false }), {});
  assert.deepEqual(observe({ autoOpen: true }), {});
  assert.deepEqual(observe({ ready: true }), { open: true });
  observe({ document: 'new', editor: 'inactive' });
  observe({ autoOpen: false });
  assert.deepEqual(observe({ editor: 'active' }), {});
});

test('tap and explicit activation arm with auto-open disabled', () => {
  for (const explicit of [false, true]) {
    const { keyboard, observe } = session({ autoOpen: false });
    observe({ editor: 'active' });
    assert.deepEqual(keyboard.activate(explicit, 100), { open: true });
  }
});

test('a tap without an active editor lapses at 1500 ms', () => {
  for (const editor of ['inactive', 'unknown'] as const) {
    const { keyboard, observe } = session({ autoOpen: false, editor });
    assert.deepEqual(keyboard.activate(false, 100), {});
    assert.equal(keyboard.deadline, 1600);
    assert.deepEqual(observe({ now: 1599 }), {});
    assert.equal(keyboard.deadline, 1600);
    assert.deepEqual(observe({ now: 1600 }), {});
    assert.equal(keyboard.deadline, undefined);
    assert.deepEqual(observe({ now: 1601, editor: 'active' }), {});
  }
});

test('an active editor first observed after the tap deadline cannot open', () => {
  const { keyboard, observe } = session({ autoOpen: false });
  keyboard.activate(false, 100);
  assert.deepEqual(observe({ now: 1601, editor: 'active' }), {});
});

test('an active editor inside the tap window can wait for frame and resize readiness', () => {
  const { keyboard, observe } = session({ autoOpen: false, ready: false });
  keyboard.activate(false, 100);
  assert.deepEqual(observe({ now: 1599, editor: 'active' }), {});
  assert.equal(keyboard.deadline, undefined);
  assert.deepEqual(observe({ now: 5000, ready: true }), { open: true });
  assert.deepEqual(observe({ now: 5100 }), {});
});

test('tap arms do not lapse with auto-open enabled', () => {
  const { keyboard, observe } = session();
  keyboard.systemDismissed();
  keyboard.activate(false, 100);
  assert.equal(keyboard.deadline, undefined);
  assert.deepEqual(observe({ now: 5000, editor: 'active' }), { open: true });
});

test('disabling auto-open preserves a tap arm', () => {
  const { keyboard, observe } = session({ ready: false });
  keyboard.activate(false, 100);
  assert.deepEqual(observe({ now: 200, autoOpen: false, editor: 'active' }), {});
  assert.deepEqual(observe({ now: 5000, ready: true }), { open: true });
});

test('enabling auto-open replaces consumed tap intent with an automatic arm', () => {
  const { keyboard, observe } = session({ autoOpen: false, editor: 'active' });
  assert.deepEqual(keyboard.activate(false, 100), { open: true });
  keyboard.attached(false);
  observe({ ready: false, autoOpen: true });
  observe({ autoOpen: false });
  assert.deepEqual(observe({ ready: true }), {});
});

test('entering another document clears a pending tap arm', () => {
  const { keyboard, observe } = session({ autoOpen: false });
  keyboard.activate(false, 100);
  assert.deepEqual(observe({ document: 'new', editor: 'active', now: 200 }), {});
  assert.equal(keyboard.deadline, undefined);
});

test('late target arrival cannot extend an expired blur grace', () => {
  const { keyboard, observe } = session();
  observe({ editor: 'active' });
  keyboard.attached(false);
  observe({ editor: 'inactive', focused: true, now: 1 });
  assert.deepEqual(observe({ editor: 'active', now: 201 }), { close: 'boundary' });
  assert.deepEqual(observe({ focused: false }), {});
});
