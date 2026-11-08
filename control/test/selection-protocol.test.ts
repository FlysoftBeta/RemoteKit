import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeIncoming, type SelectionMessage } from '../client/rtc/protocol';
import { EditingSession } from '../client/editing/editing-session';
import type { Layout, Surface } from '../client/presentation/types';

const surface: Surface = {
  session: 's',
  id: 'v',
  instance: 'i',
  document: 'd',
  focus: 'f',
  x: 0,
  y: 0,
  width: 400,
  height: 800,
  deviceScaleFactor: 1,
};
const layout: Layout = {
  type: 'layout',
  generation: '1',
  epoch: '1',
  width: 400,
  height: 800,
  views: [surface],
};
const message = (revision = '1'): SelectionMessage => ({
  type: 'input.selection',
  version: 1,
  revision,
  view: { session: 's', id: 'v', instance: 'i', document: 'd' },
  menu: {
    id: '18446744073709551615',
    x: 30,
    y: 40,
    width: 100,
    height: 20,
    handleHeight: 25,
    commands: ['cut', 'copy', 'paste', 'selectAll'],
    more: true,
  },
});

test('selection protocol accepts visible and cleared menus with exact decimal ids', () => {
  for (const value of [
    message(),
    { ...message('2'), view: null, menu: null },
    { ...message('3'), menu: { ...message().menu!, commands: ['copy', 'selectAll'] } },
  ]) {
    assert.deepEqual(decodeIncoming(JSON.stringify(value)), value);
  }
});

test('selection protocol rejects malformed identity, geometry, revisions and command ordering', () => {
  const valid = message();
  for (const value of [
    { ...valid, version: 2 },
    { ...valid, revision: '01' },
    { ...valid, revision: 1 },
    { ...valid, view: null },
    { ...valid, menu: null },
    { ...valid, view: { ...valid.view!, instance: 1 } },
    ...[
      { id: '0' },
      { id: '01' },
      { id: 1 },
      { x: NaN },
      { y: Infinity },
      { width: -1 },
      { height: -1 },
      { handleHeight: -1 },
      { commands: ['copy', 'cut'] },
      { commands: ['copy', 'copy'] },
      { commands: ['delete'] },
      { commands: null },
      { more: undefined },
      { more: 1 },
    ].map((menu) => ({ ...valid, menu: { ...valid.menu!, ...menu } })),
  ])
    assert.equal(decodeIncoming(value).type, 'decode-error', JSON.stringify(value));
});

test('editing snapshot orders selection revisions independently and consumes stale-document watermarks', () => {
  const editing = new EditingSession({ rtc: { attempt: 1 } });
  editing.handle(layout);
  editing.handle(message('9007199254740992'));
  assert.equal(editing.getSnapshot().selection?.revision, '9007199254740992');
  editing.handle(message('9007199254740993'));
  const newest = editing.getSnapshot();
  editing.handle(message('9007199254740992'));
  editing.handle({ ...message('9007199254740993'), menu: null, view: null });
  assert.equal(editing.getSnapshot(), newest);
  editing.handle({ ...message('9007199254740994'), view: { ...message().view!, document: 'gone' } });
  assert.equal(editing.getSnapshot().selection, undefined);
  editing.handle(message('9007199254740993'));
  assert.equal(editing.getSnapshot().selection, undefined);
  editing.handle({ ...message('9007199254740995'), menu: null, view: null });
  assert.equal(editing.getSnapshot().selection?.menu, null);
});

test('selection follows document authority across resize and focus and clears on identity boundaries', () => {
  const editing = new EditingSession({ rtc: { attempt: 1 } });
  editing.handle(layout);
  editing.handle(message());
  editing.handle({ ...layout, generation: '0', views: [] });
  editing.handle({ ...layout, views: [{ ...surface, focus: 'next', height: 500 }] });
  assert.equal(editing.getSnapshot().selection?.menu?.id, message().menu!.id);
  for (const key of ['session', 'id', 'instance', 'document'] as const) {
    editing.reset();
    editing.handle(layout);
    editing.handle(message());
    editing.handle({ ...layout, views: [{ ...surface, [key]: 'next' }] });
    assert.equal(editing.getSnapshot().selection, undefined);
    editing.handle(layout);
    assert.equal(editing.getSnapshot().selection, undefined);
  }
  editing.reset();
  editing.handle(layout);
  editing.handle(message('2'));
  editing.clear();
  editing.handle(message('1'));
  assert.equal(editing.getSnapshot().selection, undefined);
  editing.handle(message('3'));
  editing.reset();
  assert.equal(editing.getSnapshot().selection, undefined);
  editing.handle(layout);
  editing.handle(message());
  assert.equal(editing.getSnapshot().selection?.revision, '1');
});
