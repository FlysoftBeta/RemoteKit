import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyboardVisibility } from '../client/keyboard-visibility';

test('dismissing the keyboard suppresses automatic focus until the remote editor changes', () => {
  const keyboard = new KeyboardVisibility();
  keyboard.sync('document/first', false);
  assert.equal(keyboard.takeAutoAttempt(), true);
  assert.equal(keyboard.takeAutoAttempt(), false);
  assert.equal(keyboard.autoAllowed, true);
  keyboard.hide();
  keyboard.sync('document/first', false);
  assert.equal(keyboard.autoAllowed, false);
  assert.equal(keyboard.takeAutoAttempt(), false);
  keyboard.sync('document/second', false);
  assert.equal(keyboard.takeAutoAttempt(), true);
  keyboard.sync(undefined, false);
  assert.equal(keyboard.autoAllowed, false);
  keyboard.sync('document/second', false);
  assert.equal(keyboard.takeAutoAttempt(), true);
});

test('manual policy suppresses all automatic opens and disabling it re-arms the current editor', () => {
  const keyboard = new KeyboardVisibility();
  keyboard.sync('document/first', true);
  assert.equal(keyboard.autoAllowed, false);
  assert.equal(keyboard.takeAutoAttempt(), false);
  keyboard.sync('document/second', true);
  assert.equal(keyboard.takeAutoAttempt(), false);
  keyboard.sync('document/second', false);
  assert.equal(keyboard.takeAutoAttempt(), true);
});
