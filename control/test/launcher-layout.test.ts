import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contrastColor,
  launcherLayout,
  originColor,
  packTiles,
  whiteContrast,
} from '../client/app/launcher-layout';
import type { LauncherItem } from '../shared/product';

const item = (
  key: string,
  group: LauncherItem['group'],
  score = 0,
  extra: Partial<LauncherItem> = {},
): LauncherItem => ({
  key,
  group,
  kind: group === 'apps' ? 'app' : group === 'files' ? 'file' : 'page',
  title: key,
  score,
  ...extra,
});

test('the tile unit follows the width and groups wrap to the visible columns without a height limit', () => {
  const groups = [
    item('a', 'frequent', 1),
    item('b', 'apps', 1),
    item('c', 'pages', 1),
    item('d', 'files', 1),
  ];
  const layout = launcherLayout(groups, '', 1200);
  assert.deepEqual(
    layout.groups.map((group) => group.rows),
    [1, 1, 1, 1],
  );
  assert.equal(layout.unit, 104);
  assert.equal(launcherLayout(groups, '', 300).unit, 94);
  assert.equal(launcherLayout(groups, '', 150).unit, 64);
  const pair = [item('w', 'frequent', 9), item('w2', 'frequent', 6), item('s', 'frequent', 1)];
  assert.equal(launcherLayout(pair, '', 358).groups[0].rows, 3);
  // Twelve tiles at three visible columns take four rows; no cap, the Start screen scrolls.
  const many = Array.from({ length: 12 }, (_, index) => item('f' + index, 'frequent', 0));
  const narrow = launcherLayout(many, '', 358);
  assert.equal(narrow.groups[0].rows, 4);
  assert.ok(narrow.groups[0].columns <= 3);
  const pages = Array.from({ length: 16 }, (_, index) => item('p' + index, 'pages', 0));
  assert.equal(launcherLayout(pages, '', 358).groups[0].rows, 6);
});

test('launcher grouping applies limits, ordering, and frequent de-duplication', () => {
  const entries = [
    item('popular', 'frequent', 10),
    item('popular', 'pages', 10),
    item('plain', 'pages', 9),
    item('favorite', 'pages', 1, { favorite: true }),
    item('loose', 'files', 10),
    item('organized', 'files', 1, { organized: true }),
    item('web', 'apps', 30, { appId: 'web:one' }),
    item('settings', 'apps', 0, { appId: 'settings' }),
    item('browser', 'apps', 0, { appId: 'browser' }),
    item('files', 'apps', 0, { appId: 'files' }),
  ];
  const groups = launcherLayout(entries).groups;
  assert.deepEqual(
    groups.map((group) => [group.id, group.tiles.map((tile) => tile.key)]),
    [
      ['frequent', ['popular']],
      ['apps', ['browser', 'files', 'settings', 'web']],
      ['pages', ['favorite', 'plain']],
      ['files', ['organized', 'loose']],
    ],
  );
  for (const group of ['frequent', 'pages', 'files'] as const) {
    const many = Array.from({ length: 30 }, (_, index) => item(String(index), group, 30 - index));
    assert.equal(launcherLayout(many).groups[0].tiles.length, group === 'pages' ? 16 : 12);
  }
});

test('tile sizes follow relative use, gated by rank so sizes stay mixed', () => {
  const scores = [10, 7, 5, 3, 2.4, 1, 0];
  const entries = scores.map((score, index) => item('t' + index, 'frequent', score));
  assert.deepEqual(
    launcherLayout(entries, '', 1200).groups[0].tiles.map((tile) => tile.size),
    ['large', 'wide', 'wide', 'wide', 'small', 'small', 'small'],
  );
  const equal = Array.from({ length: 6 }, (_, index) => item('e' + index, 'apps', 1));
  assert.deepEqual(
    launcherLayout(equal, '', 1200).groups[0].tiles.map((tile) => tile.size),
    ['large', 'wide', 'wide', 'small', 'small', 'small'],
  );
  const unused = Array.from({ length: 4 }, (_, index) => item('u' + index, 'apps', 0));
  assert.ok(launcherLayout(unused).groups[0].tiles.every((tile) => tile.size === 'small'));
  const pair = launcherLayout([item('a', 'frequent', 9), item('b', 'frequent', 7)]).groups[0];
  assert.equal(pair.rows, 1);
  assert.deepEqual(
    pair.tiles.map((tile) => tile.size),
    ['small', 'small'],
  );
});

test('three or more tiles wrap onto two rows on a wide tablet screen', () => {
  const entries = [9, 7, 5, 1].map((score, index) => item('w' + index, 'frequent', score));
  const group = launcherLayout(entries, '', 1280).groups[0];
  assert.equal(group.rows, 2);
  assert.ok(group.tiles.some((tile) => tile.size !== 'small'));
  for (const tile of group.tiles) assert.ok(tile.row + tile.rows <= 2);
});

test('a short landscape tablet keeps every group of three or more tiles on two rows', () => {
  const entries = [
    ...Array.from({ length: 12 }, (_, index) => item('f' + index, 'frequent', 12 - index)),
    ...['browser', 'files', 'study', 'questions', 'settings', 'admin'].map((appId, index) =>
      item(appId, 'apps', 6 - index, { appId }),
    ),
    ...Array.from({ length: 16 }, (_, index) => item('p' + index, 'pages', 1)),
    ...Array.from({ length: 12 }, (_, index) => item('d' + index, 'files', 1)),
  ];
  const layout = launcherLayout(entries, '', 1280);
  assert.equal(layout.groups.length, 4);
  for (const group of layout.groups) assert.ok(group.rows >= 2, group.id + ' wraps');
});

test('packing fills the first column top to bottom before extending right', () => {
  assert.deepEqual(
    packTiles(['large', 'wide', 'small', 'small', 'small'], 3).cells.map((cell) => [cell.column, cell.row]),
    [
      [0, 0],
      [0, 2],
      [2, 0],
      [2, 1],
      [2, 2],
    ],
  );
  const packed = packTiles(['wide', 'small', 'wide', 'small'], 2);
  assert.deepEqual(
    packed.cells.map((cell) => [cell.column, cell.row]),
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 0],
    ],
  );
  assert.equal(packed.columns, 3);
  assert.deepEqual(
    packTiles(['large', 'wide', 'small'], 1).cells.map((cell) => [cell.size, cell.column]),
    [
      ['small', 0],
      ['small', 1],
      ['small', 2],
    ],
  );
});

test('search matches title, URL and subtitle and removes duplicate keys', () => {
  const entries = [
    item('a', 'frequent', 1, { title: 'Notes' }),
    item('a', 'apps', 1, { title: 'Notes' }),
    item('b', 'pages', 2, { url: 'https://notes.test/' }),
    item('c', 'files', 3, { subtitle: 'NOTES' }),
  ];
  assert.deepEqual(
    launcherLayout(entries, 'notes').groups[0].tiles.map((tile) => tile.key),
    ['c', 'b', 'a'],
  );
  assert.equal(launcherLayout(entries, 'missing').groups.length, 0);
});

test('HSL lightness clamping guarantees white text contrast and stable origin colors', () => {
  for (let red = 0; red < 256; red += 17)
    for (let green = 0; green < 256; green += 17)
      for (let blue = 0; blue < 256; blue += 17) {
        const hex = '#' + [red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('');
        const clamped = contrastColor(hex);
        const rgb = [1, 3, 5].map((at) => parseInt(clamped.slice(at, at + 2), 16) / 255);
        assert.ok(whiteContrast(rgb) >= 4.5, clamped);
      }
  assert.equal(originColor('https://example.test/a'), originColor('https://example.test/b?q=1'));
  assert.equal(contrastColor('#000000'), '#000000');
});
