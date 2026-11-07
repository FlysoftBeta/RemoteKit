import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planAtlas, feasibleDpr } from '../server/atlas-plan';
import { QualityState } from '../server/quality';
import { emptyWorkspace } from '../server/persistence/workspaces';
test('TS and C++ share exact packing/allocation fixtures', () => {
  for (const line of readFileSync(
    new URL('../../protocol/atlas-plan-fixtures.txt', import.meta.url),
    'utf8',
  ).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [name, scale, alignment, list, w, h, pw, ph] = line.split(/\s+/);
    const items =
      list === '-'
        ? []
        : list.split(',').map((v) => {
            const [width, height] = v.split('x').map(Number);
            return { width, height };
          });
    const p = planAtlas(items, +scale, +alignment);
    assert.deepEqual(
      p ? [p.width, p.height, p.physical.width, p.physical.height] : [0, 0, 0, 0],
      [+w, +h, +pw, +ph],
      name,
    );
  }
});
test('axis constraints lower real DPR without shrinking DIP; minimum failure is explicit', () => {
  const state = emptyWorkspace('t');
  state.settings.workspace.qualityPreference = 'quality';
  state.windows = [{ id: 'w', appId: 'browser', activeTabId: 't', lastActiveAt: 1 }];
  state.spaces = [{ id: 'space', windowIds: ['w'], weights: [1], focusedWindowId: 'w', lastActiveAt: 1 }];
  state.activeSpaceId = 'space';
  const viewport = {
    devicePixelRatio: 4,
    windows: [{ windowId: 'w', width: 8192, height: 400, visible: true }],
  };
  const quality = new QualityState().snapshot(state, viewport);
  assert.ok(quality.effectiveDpr < 1);
  assert.ok(planAtlas(viewport.windows, quality.effectiveDpr));
  assert.equal(viewport.windows[0].width, 8192);
  assert.throws(
    () =>
      feasibleDpr(
        [
          { width: 8192, height: 8192 },
          { width: 8192, height: 8192 },
        ],
        0.5,
      ),
    { code: 'limit_exceeded' },
  );
});
