import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyboardVisibility, KEYBOARD_FOCUS_GRACE_MS } from '../client/keyboard-visibility';

test('the first activation is consumed once across repeated state and direct editor replacement', () => {
  const keyboard = new KeyboardVisibility();
  keyboard.sync('doc', true, false, false, false, 0);
  assert.equal(keyboard.takeAutoAttempt(true), false);
  keyboard.sync('doc', true, false, true, false, 5);
  assert.equal(keyboard.takeAutoAttempt(false), false, 'frame or ACK still pending');
  assert.equal(keyboard.takeAutoAttempt(true), true);
  assert.equal(keyboard.sync('doc', true, false, true, true, 10), false, 'replacement stays focused');
  assert.equal(keyboard.takeAutoAttempt(true), false);
});

test('a 130ms same-document NONE gap keeps only local focus and does not rearm', () => {
  const keyboard = new KeyboardVisibility();
  keyboard.sync('doc', true, false, true, false, 0);
  assert.equal(keyboard.takeAutoAttempt(true), true);
  assert.equal(keyboard.sync('doc', true, false, false, true, 10), false);
  assert.equal(keyboard.deadline, 10 + KEYBOARD_FOCUS_GRACE_MS);
  assert.equal(keyboard.sync('doc', true, false, false, true, 100), false);
  assert.equal(keyboard.deadline, 10 + KEYBOARD_FOCUS_GRACE_MS, 'repeat NONE cannot extend grace');
  assert.equal(keyboard.takeAutoAttempt(true), false);
  assert.equal(keyboard.sync('doc', true, false, true, true, 140), false);
  assert.equal(keyboard.deadline, undefined);
  assert.equal(keyboard.takeAutoAttempt(true), false);
});

test('sustained NONE consumes the permit and later editable feedback cannot reopen', () => {
  const keyboard = new KeyboardVisibility();
  keyboard.sync('doc', true, false, true, false, 0);
  assert.equal(keyboard.takeAutoAttempt(true), true);
  keyboard.activate();
  keyboard.sync('doc', true, false, false, true, 1);
  assert.equal(keyboard.sync('doc', true, false, false, true, 201), 'editor-lost');
  keyboard.sync('doc', true, false, true, false, 202);
  assert.equal(keyboard.takeAutoAttempt(true), false);
  keyboard.activate();
  assert.equal(keyboard.takeAutoAttempt(true), true);
});

test('dismissal survives target changes and manual sites require an explicit open', () => {
  const keyboard = new KeyboardVisibility();
  keyboard.sync('doc', true, false, true, false, 0);
  keyboard.dismiss();
  keyboard.sync('doc', true, false, false, false, 5);
  keyboard.sync('doc', true, false, true, false, 10);
  assert.equal(keyboard.takeAutoAttempt(true), false);
  keyboard.activate();
  assert.equal(keyboard.takeAutoAttempt(true), true);
  assert.equal(keyboard.sync('doc', true, true, true, true, 15), 'boundary');
  keyboard.activate();
  assert.equal(keyboard.takeAutoAttempt(true), false);
  assert.equal(keyboard.sync('doc', true, true, true, true, 20), false, 'manual focus remains usable');
  keyboard.sync('doc', true, false, true, false, 25);
  assert.equal(keyboard.takeAutoAttempt(true), true);
});

test('document and activation changes bypass blur grace', () => {
  const keyboard = new KeyboardVisibility();
  keyboard.sync('doc', true, false, true, false, 0);
  assert.equal(keyboard.takeAutoAttempt(true), true);
  assert.equal(keyboard.sync('doc', false, false, false, true, 1), 'boundary');
  assert.equal(keyboard.deadline, undefined);
  keyboard.sync('doc', true, false, true, false, 2);
  assert.equal(keyboard.takeAutoAttempt(true), false);
  assert.equal(keyboard.sync('next', true, false, true, true, 3), 'boundary');
  assert.equal(keyboard.takeAutoAttempt(true), true);
});

test('an editor arriving after grace cannot qualify for the empty desktop keyboard sink', () => {
  const keyboard = new KeyboardVisibility();
  keyboard.sync('doc', true, false, true, false, 0);
  assert.equal(keyboard.takeAutoAttempt(true), true);
  keyboard.sync('doc', true, false, false, true, 1);
  assert.equal(keyboard.sync('doc', true, false, true, true, 201), 'boundary');
  assert.equal(keyboard.takeAutoAttempt(true), false);
});