import test from 'node:test';
import assert from 'node:assert/strict';
import { EditingInput, editingKey } from '../client/editing-input';

test('local keyboard dismissal commits the pending composition once on its current target', () => {
  const input = new EditingInput();
  input.focus('document/target');
  input.start('document/target');
  input.update('document/target', '你');
  input.update('document/target', '你好');
  assert.equal(input.finishCurrent('document/other', 10), undefined);
  assert.deepEqual(input.finishCurrent('document/target', 11), { type: 'ime_commit', text: '你好' });
  assert.equal(input.end('document/target', '你好', 12), undefined);
  assert.deepEqual(input.edit('document/target', 'insertText', '你好', 13, 'input').events, []);
  assert.equal(input.finishCurrent('document/target', 14), undefined);
});

test('a browser compositionend takes precedence, and remote target replacement revokes pending composition', () => {
  const input = new EditingInput();
  input.focus('document/target');
  input.start('document/target');
  input.update('document/target', 'ni');
  assert.deepEqual(input.end('document/target', '你', 10), { type: 'ime_commit', text: '你' });
  assert.equal(input.finishCurrent('document/target', 11), undefined);
  input.start('document/target');
  input.update('document/target', '旧');
  input.focus('document/other');
  assert.equal(input.finishCurrent('document/target', 12), undefined);
  assert.equal(input.finishCurrent('document/other', 12), undefined);
});

test('composition is bound to local focus and document, late end cannot borrow new owner', () => {
  const input = new EditingInput();
  input.focus('attempt/session/view/instance/old');
  input.start('attempt/session/view/instance/old');
  assert.equal(input.update('attempt/session/view/instance/old', '旧')!.type, 'ime_set');
  input.focus('attempt/session/view/instance/new');
  assert.equal(input.update('attempt/session/view/instance/new', '旧'), undefined);
  assert.equal(input.end('attempt/session/view/instance/new', '旧', 20), undefined);
  input.start('attempt/session/view/instance/new');
  input.invalidate();
  input.focus('attempt/session/view/instance/new');
  assert.equal(input.end('attempt/session/view/instance/new', '失焦', 21), undefined);
});
test('same document composition survives layout resize and commits once', () => {
  const input = new EditingInput();
  input.focus('doc');
  input.start('doc');
  input.focus('doc');
  assert.equal(input.composing, true);
  assert.equal(input.end('doc', '你好', 10)!.text, '你好');
  assert.deepEqual(input.edit('doc', 'insertText', '你好', 11, 'input').events, []);
  assert.equal(input.end('doc', '你好', 12), undefined);
  assert.equal(input.edit('doc', 'insertText', '你', 100, 'input').events[0].text, '你');
});
test('mobile null-data deletes and line breaks become complete native key pairs', () => {
  const input = new EditingInput();
  input.focus('doc');
  for (const [type, code] of [
    ['deleteContentBackward', 8],
    ['deleteContentForward', 46],
    ['insertLineBreak', 13],
    ['insertParagraph', 13],
  ] as const) {
    const events = input.edit('doc', type, null, 10, 'before').events;
    assert.deepEqual(
      events.map((e) => e.action),
      ['down', 'up'],
    );
    assert.equal(events[0].windows_key_code, code);
    assert.deepEqual(input.edit('doc', type, null, 11, 'input').events, []);
  }
  assert.equal(editingKey('Enter', 'down').text, '\r');
  assert.equal(editingKey('Enter', 'up').text, '');
});
test('physical Enter/delete and composition events never double-apply via input fallback', () => {
  const input = new EditingInput();
  input.focus('doc');
  input.physicalKey('Enter', 10);
  assert.deepEqual(input.edit('doc', 'insertLineBreak', null, 11, 'before').events, []);
  assert.deepEqual(input.edit('doc', 'insertLineBreak', null, 12, 'input').events, []);
  input.start('doc');
  assert.deepEqual(input.edit('doc', 'insertText', 'x', 20, 'input').events, []);
});
test('dictation insertion is supported, context-dependent replacement is explicit and never appended', () => {
  const input = new EditingInput();
  input.focus('doc');
  assert.equal(input.edit('doc', 'insertFromDictation', '😀你好', 1, 'input').events[0].text, '😀你好');
  const result = input.edit('doc', 'insertReplacementText', 'rewrite', 2, 'before');
  assert.equal(result.unsupported, 'insertReplacementText');
  assert.deepEqual(result.events, []);
  assert.deepEqual(input.edit('other', 'insertText', 'old', 3, 'input').events, []);
});

test('target loss quarantines the old OS composition through end and trailing input', () => {
  const input = new EditingInput();
  input.focus('a');
  input.start('a');
  input.update('a', '旧');
  input.invalidate();
  assert.equal(input.update(undefined, '旧文'), undefined);
  assert.deepEqual(input.edit(undefined, 'insertText', '旧文', 1, 'before').events, []);
  input.focus('b');
  assert.equal(input.composing, true);
  assert.deepEqual(input.edit('b', 'insertText', '旧文', 2, 'before').events, []);
  assert.equal(input.end('b', '旧文', 3), undefined);
  assert.equal(input.composing, false);
  assert.deepEqual(input.edit('b', 'insertText', '旧文', 4, 'before').events, []);
  assert.deepEqual(input.edit('b', 'insertText', null, 5, 'input').events, []);
  assert.deepEqual(input.edit('b', 'insertText', '新', 6, 'before').events, [
    { type: 'ime_commit', text: '新' },
  ]);
});

test('hard blur can omit compositionend without blocking subsequent Latin input', () => {
  const input = new EditingInput();
  input.focus('a');
  input.start('a');
  input.update('a', 'old');
  input.invalidate();
  input.blurred(10);
  input.focus('b');
  assert.equal(input.composing, false);
  assert.deepEqual(input.edit('b', 'insertText', 'x', 12, 'before').events, [
    { type: 'ime_commit', text: 'x' },
  ]);
  assert.equal(input.end('b', 'stale', 13), undefined);
  assert.deepEqual(input.edit('b', 'insertText', 'stale', 14, 'input').events, []);
  assert.equal(input.start('b'), true);
  assert.deepEqual(input.end('b', '新', 15), { type: 'ime_commit', text: '新' });
});
