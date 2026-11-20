import assert from 'node:assert/strict';
import test from 'node:test';
import { ViewportRequests } from '../client/control/viewport-requests';
import type { ViewerViewport } from '../shared/product';
import { productSnapshot } from './client-fixture';

function fixture(t: import('node:test').TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const sent: { at: number; params: ViewerViewport }[] = [];
  const owner = new ViewportRequests(async (params) => {
    sent.push({ at: Date.now(), params });
  });
  const state = productSnapshot();
  state.workspace.windows = [{ id: 'window', activeTabId: 'tab', appId: 'browser', lastActiveAt: 0 }];
  state.workspace.tabs = [
    {
      id: 'tab',
      windowId: 'window',
      webviewId: 'view',
      title: '',
      url: 'about:blank',
      kind: 'remote',
      idleKeepAlive: false,
    },
  ];
  state.workspace.spaces = [
    {
      id: 'space',
      name: null,
      windowIds: ['window'],
      focusedWindowId: 'window',
      weights: [1],
      lastActiveAt: 0,
    },
  ];
  state.workspace.activeSpaceId = 'space';
  owner.observe(state, true);
  t.after(() => owner.reset());
  return { owner, sent, state };
}

test('viewport leads immediately, sends latest values every 50ms during continuous changes, and flushes the final value', async (t) => {
  const { owner, sent } = fixture(t);
  owner.measure(800, 600, 1, true);
  assert.equal(sent.length, 1);
  for (let i = 1; i <= 12; i++) {
    t.mock.timers.tick(10);
    owner.setGeometry('window', 800 + i, 512);
  }
  assert.deepEqual(
    sent.map((item) => item.at - sent[0].at),
    [0, 50, 100],
  );
  assert.deepEqual(
    sent.map((item) => item.params.windows[0].width),
    [800, 804, 809],
  );
  owner.flush();
  assert.equal(sent[sent.length - 1].params.windows[0].width, 812);
  assert.equal(sent[sent.length - 1].at - sent[0].at, 120);
  t.mock.timers.tick(50);
  await Promise.resolve();
  assert.equal(sent.length, 4);
});

test('normalized unchanged geometry does not schedule or postpone a pending update', async (t) => {
  const { owner, sent, state } = fixture(t);
  owner.measure(800.1, 600.1, 1, true);
  await Promise.resolve();
  owner.measure(800.2, 600.2, 1, true);
  owner.observe(structuredClone(state), true);
  t.mock.timers.tick(50);
  assert.equal(sent.length, 1);
  owner.setGeometry('window', 810.1, 512.1);
  assert.equal(sent.length, 2);
  t.mock.timers.tick(10);
  owner.setGeometry('window', 820.1, 512.1);
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(10);
    owner.setGeometry('window', 820.2, 512.2);
    owner.observe(structuredClone(state), true);
  }
  assert.equal(sent.length, 3);
  assert.equal(sent[sent.length - 1].params.windows[0].width, 820);
});

test('stable geometry and occlusion merge independently with ordered revisions', async (t) => {
  const { owner, sent } = fixture(t);
  owner.measure(800, 1000, 1, true);
  owner.setGeometry('window', 900, 900);
  owner.setOcclusion('view', 250.4);
  t.mock.timers.tick(50);
  assert.deepEqual(
    sent[sent.length - 1].params.windows.map(({ width, height, occludedBottom }) => [
      width,
      height,
      occludedBottom,
    ]),
    [[900, 900, 250]],
  );
  owner.setOcclusion('view', 300);
  owner.flush();
  assert.equal(sent[sent.length - 1].params.windows[0].occludedBottom, 300);
  assert.ok(
    BigInt(sent[2].params.windows[0].occlusionRevision) > BigInt(sent[1].params.windows[0].occlusionRevision),
  );
  await Promise.resolve();
  owner.measure(800, 1000, 1, true);
  t.mock.timers.tick(100);
  assert.equal(sent.length, 3);
});

test('divider previews keep intermediate dimensions local and commit after release', (t) => {
  const { owner, sent } = fixture(t);
  owner.measure(800, 600, 1, true);
  owner.preview(true);
  owner.setGeometry('window', 400, 512);
  owner.setGeometry('window', 500, 512);
  t.mock.timers.tick(200);
  assert.equal(sent.length, 1);
  owner.preview(false);
  assert.equal(sent.length, 2);
  owner.setGeometry('window', 500, 512);
  owner.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].params.windows[0].width, 500);
});

test('old viewport replies cannot overwrite the latest acknowledgement', async (t) => {
  const { state } = fixture(t);
  const pending: { resolve(): void; reject(error: Error): void }[] = [];
  const sent: ViewerViewport[] = [];
  const owner = new ViewportRequests((params) => {
    sent.push(params);
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  });
  t.after(() => owner.reset());
  owner.observe(state, true);
  owner.measure(800, 600, 1, true);
  owner.setGeometry('window', 900, 512);
  owner.flush();
  pending[1].resolve();
  await Promise.resolve();
  pending[0].reject(new Error('old request failed'));
  await Promise.resolve();
  await Promise.resolve();
  owner.measure(800, 600, 1, true);
  t.mock.timers.tick(30000);
  assert.equal(sent.length, 2);
  assert.equal(owner.getSnapshot(), undefined);
});
