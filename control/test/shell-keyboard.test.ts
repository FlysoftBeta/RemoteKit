import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ShellKeyboard } from '../client/editing/shell-keyboard';
import { FloatingActions } from '../client/app/floating-actions';

test('shell keyboard toggle retains the focused field and its reopening action', async () => {
  const dom = new JSDOM('<input id="address" value="draft"><textarea class="remote-input"></textarea>');
  const document = dom.window.document;
  const actions = new FloatingActions();
  const keyboard = new ShellKeyboard(document, actions);
  try {
    const field = document.querySelector('input')!;
    field.focus();
    assert.equal(actions.getSnapshot()[0]?.label, '隐藏键盘');
    actions.getSnapshot()[0].run();
    await Promise.resolve();
    assert.equal(document.activeElement, field);
    assert.equal(field.value, 'draft');
    assert.equal(field.inputMode, 'none');
    assert.equal(actions.getSnapshot()[0]?.label, '显示键盘');
    actions.getSnapshot()[0].run();
    assert.equal(document.activeElement, field);
    assert.equal(field.inputMode, '');
    assert.equal(actions.getSnapshot()[0]?.label, '隐藏键盘');
    document.querySelector('textarea')!.focus();
    await Promise.resolve();
    assert.equal(actions.getSnapshot().length, 0);
  } finally {
    keyboard.dispose();
    dom.window.close();
  }
});
