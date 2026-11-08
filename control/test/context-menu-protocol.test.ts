import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeIncoming, type ContextMenuMessage } from '../client/rtc/protocol';
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
const message = (revision = '1'): ContextMenuMessage => ({
  type: 'input.contextMenu',
  version: 1,
  revision,
  view: { session: 's', id: 'v', instance: 'i', document: 'd' },
  menu: { id: '18446744073709551615', x: 10, y: 20, source: 'mouse' },
});

test('context protocol accepts menu sources, all details and close messages', () => {
  for (const source of ['mouse', 'touch', 'keyboard'] as const) {
    const value = {
      ...message(),
      menu: {
        ...message().menu!,
        source,
        link: { url: 'https://example.com/', text: 'Example' },
        image: { src: 'http://example.com/image' },
        selection: 'a'.repeat(254) + '😀',
        editable: { undo: true, redo: false, cut: true, copy: true, paste: false, selectAll: true },
      },
    };
    assert.deepEqual(decodeIncoming(JSON.stringify(value)), value);
  }
  for (const view of [null, message().view]) {
    const value = { ...message(), view, menu: null };
    assert.deepEqual(decodeIncoming(value), value);
  }
});

test('context protocol rejects malformed identity, ids, source, geometry and bounded details', () => {
  for (const value of [
    { ...message(), version: 2 },
    { ...message(), revision: '01' },
    { ...message(), revision: 1 },
    { ...message(), view: null },
    { ...message(), view: { ...message().view, instance: 1 } },
    ...[
      { id: '0' },
      { id: '01' },
      { id: 1 },
      { x: Infinity },
      { y: NaN },
      { source: 'pen' },
      { link: { url: 'about:blank', text: '' } },
      { link: { url: 'https://example.com' } },
      { image: { src: 'data:image/png;base64,AA==' } },
      { image: { src: 'blob:https://example.com/image' } },
      { image: { src: 'https://example.com/' + '中'.repeat(677) } },
      { selection: 'a'.repeat(257) },
      { selection: 'a'.repeat(255) + '😀' },
      { selection: 'a\ud800' },
      { selection: ' text ' },
      { editable: { undo: true } },
      { editable: { undo: 1, redo: true, cut: true, copy: true, paste: true, selectAll: true } },
    ].map((menu) => ({ ...message(), menu: { ...message().menu, ...menu } })),
  ])
    assert.equal(decodeIncoming(value).type, 'decode-error', JSON.stringify(value));
  const url = 'https://example.com/' + 'a'.repeat(2048 - 'https://example.com/'.length);
  assert.equal(
    decodeIncoming({ ...message(), menu: { ...message().menu, link: { url, text: '' } } }).type,
    'input.contextMenu',
  );
  assert.equal(
    decodeIncoming({ ...message(), menu: { ...message().menu, link: { url: url + 'a', text: '' } } }).type,
    'decode-error',
  );
});

test('context revisions are exact and independent, with stale-document messages consuming the watermark', () => {
  const editing = new EditingSession({ rtc: { attempt: 1 } });
  editing.handle(layout);
  editing.handle(message('9007199254740992'));
  editing.handle(message('9007199254740993'));
  const latest = editing.getSnapshot();
  editing.handle(message('9007199254740992'));
  editing.handle({ ...message('9007199254740993'), view: null, menu: null });
  assert.equal(editing.getSnapshot(), latest);
  editing.handle({
    type: 'input.selection',
    version: 1,
    revision: '9999999999999999999',
    view: null,
    menu: null,
  });
  assert.equal(editing.getSnapshot().contextMenu?.revision, '9007199254740993');
  editing.handle({ ...message('9007199254740994'), view: { ...message().view!, document: 'gone' } });
  assert.equal(editing.getSnapshot().contextMenu, undefined);
  editing.handle(message('9007199254740993'));
  assert.equal(editing.getSnapshot().contextMenu, undefined);
  editing.handle({ ...message('9007199254740995'), view: null, menu: null });
  assert.equal(editing.getSnapshot().contextMenu?.menu, null);
});

test('context survives resize and focus, clears on each selection identity boundary, and resets revision on reconnect', () => {
  const editing = new EditingSession({ rtc: { attempt: 1 } });
  editing.handle(layout);
  editing.handle(message());
  editing.handle({ ...layout, generation: '0', views: [] });
  editing.handle({ ...layout, views: [{ ...surface, focus: 'next', height: 500 }] });
  assert.equal(editing.getSnapshot().contextMenu?.menu?.id, message().menu!.id);
  for (const key of ['session', 'id', 'instance', 'document'] as const) {
    editing.reset();
    editing.handle(layout);
    editing.handle(message());
    editing.handle({ ...layout, views: [{ ...surface, [key]: 'next' }] });
    assert.equal(editing.getSnapshot().contextMenu, undefined);
    editing.handle(layout);
    assert.equal(editing.getSnapshot().contextMenu, undefined);
  }
  editing.reset();
  editing.handle(layout);
  editing.handle(message('2'));
  editing.clear();
  editing.handle(message('1'));
  assert.equal(editing.getSnapshot().contextMenu, undefined);
  editing.reset();
  editing.handle(layout);
  editing.handle(message());
  assert.equal(editing.getSnapshot().contextMenu?.revision, '1');
  editing.reconcile([]);
  assert.equal(editing.getSnapshot().contextMenu, undefined);
});
