import assert from 'node:assert/strict';
import test from 'node:test';
import { contrastColor, launcherLayout, originColor, whiteContrast } from '../client/app/launcher-layout';
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

test('rows share the available height within bounds', () => {
  const rows = [item('a', 'frequent', 1), item('b', 'apps', 1), item('c', 'pages', 1), item('d', 'files', 1)];
  assert.equal(launcherLayout(rows, 800).height, 152);
  assert.equal(launcherLayout(rows, 2000).height, 168);
  assert.equal(launcherLayout(rows, 200).height, 88);
  assert.equal(launcherLayout(rows.slice(0, 2), 400).height, 152);
  assert.equal(launcherLayout(rows, 2000, '', 390).height, 111);
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
  const groups = launcherLayout(entries, 600).groups;
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
    assert.equal(launcherLayout(many, 600).groups[0].tiles.length, group === 'pages' ? 16 : 12);
  }
});

test('tile spans follow group semantics and score ratios at boundaries', () => {
  const entries = [
    item('a', 'frequent', 9),
    item('b', 'frequent', 6),
    item('c', 'frequent', 4.5),
    item('d', 'frequent', 4.49),
  ];
  const tiles = launcherLayout(entries, 600).groups[0].tiles;
  assert.deepEqual(
    tiles.map((tile) => [tile.size, tile.span]),
    [
      ['wide', 3],
      ['medium', 2],
      ['medium', 2],
      ['small', 1],
    ],
  );
  assert.equal(
    launcherLayout([item('a', 'frequent', 9), item('b', 'frequent', 7)], 600).groups[0].tiles[0].size,
    'medium',
  );
  const semantic = [
    item('builtin', 'apps', 0, { appId: 'browser' }),
    item('used', 'apps', 0.01, { appId: 'web:x' }),
    item('unused', 'apps', 0, { appId: 'web:y' }),
    item('favorite', 'pages', 0, { favorite: true }),
    item('plain', 'pages', 100),
    item('file', 'files', 0, { organized: true }),
  ];
  assert.deepEqual(
    launcherLayout(semantic, 600).groups.flatMap((group) => group.tiles.map((tile) => tile.size)),
    ['small', 'small', 'small', 'medium', 'medium', 'medium'],
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
    launcherLayout(entries, 600, 'notes').groups[0].tiles.map((tile) => tile.key),
    ['c', 'b', 'a'],
  );
  assert.equal(launcherLayout(entries, 600, 'missing').groups.length, 0);
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
