import assert from 'node:assert/strict';
import test from 'node:test';
import { ViewportRequests } from '../client/control/viewport-requests';
import { keyboardTimeline } from '../client/editing/keyboard-timeline';
import { occlusionRevision } from '../shared/occlusion-revision';
import type { ProductState, ViewerViewport } from '../shared/product';
import { productSnapshot } from './client-fixture';

function stateFor(generation: number | null, activeSpaceId = 'space'): ProductState {
  const state = productSnapshot();
  state.viewer = { connected: generation !== null, generation };
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
  state.workspace.spaces = ['space', 'other'].map((id) => ({
    id,
    name: null,
    windowIds: id === 'space' ? ['window'] : [],
    focusedWindowId: id === 'space' ? 'window' : null,
    weights: [1],
    lastActiveAt: 0,
  })) as ProductState['workspace']['spaces'];
  state.workspace.activeSpaceId = activeSpaceId;
  return state;
}

function fixture(t: import('node:test').TestContext, generation: number | null = 7) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 3 });
  const sent: ViewerViewport[] = [];
  const owner = new ViewportRequests(async (params) => {
    sent.push(params);
  });
  t.after(() => owner.reset());
  owner.observe(stateFor(generation), true);
  owner.measure(800, 600, 1, true);
  return { owner, sent };
}

const revisionOf = (params: ViewerViewport) => params.windows[0].occlusionRevision;

test('revisions are the attach generation over a sequence that never reads the device clock', (t) => {
  // A device clock near zero must not matter: nothing in the revision comes from Date.
  const { owner, sent } = fixture(t);
  assert.equal(revisionOf(sent[0]), occlusionRevision(7, 1));
  owner.setGeometry('window', 900, 500);
  owner.flush();
  assert.equal(revisionOf(sent[1]), occlusionRevision(7, 2));
});

test('a new generation restarts the sequence at 1 and discards revisions of the old one', async (t) => {
  const { owner, sent } = fixture(t);
  owner.setGeometry('window', 900, 500);
  owner.flush();
  assert.equal(revisionOf(sent[1]), occlusionRevision(7, 2));
  owner.observe(stateFor(8), true);
  owner.flush();
  assert.equal(sent.length, 3);
  assert.equal(revisionOf(sent[2]), occlusionRevision(8, 1));
  assert.ok(BigInt(revisionOf(sent[2])) > BigInt(revisionOf(sent[1])));
});

test('nothing is sent while Control reports no connected generation', (t) => {
  const { sent, owner } = fixture(t, null);
  owner.flush();
  assert.equal(sent.length, 0);
  owner.observe(stateFor(3), true);
  assert.equal(revisionOf(sent[0]), occlusionRevision(3, 1));
});

test('a reply of the previous generation cannot acknowledge the new one', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 3 });
  const pending: { resolve(): void }[] = [];
  const sent: ViewerViewport[] = [];
  const owner = new ViewportRequests((params) => {
    sent.push(params);
    return new Promise<void>((resolve) => pending.push({ resolve }));
  });
  t.after(() => owner.reset());
  owner.observe(stateFor(7), true);
  owner.measure(800, 600, 1, true);
  owner.observe(stateFor(8), true);
  owner.flush();
  assert.deepEqual(sent.map(revisionOf), [occlusionRevision(7, 1), occlusionRevision(8, 1)]);
  pending[0].resolve();
  await Promise.resolve();
  owner.flush();
  assert.equal(sent.length, 2, 'the new request is still the pending one');
});

test('an exhausted sequence stops reporting instead of wrapping', (t) => {
  const { owner, sent } = fixture(t);
  (owner as unknown as { sequence: number }).sequence = 0xffffffff;
  owner.setGeometry('window', 901, 500);
  owner.flush();
  assert.equal(sent.length, 1);
  assert.equal(owner.getSnapshot()?.code, 'limit_exceeded');
});

test('a report describes the space the Stage rendered, not the one the state already names', (t) => {
  const { owner, sent } = fixture(t);
  owner.setRenderedSpace('space');
  const before = sent.length;
  owner.setGeometry('window', 801, 600);
  assert.equal(sent.length, before, 'ordinary geometry still waits out the 50ms window');
  // State switches to B; the Stage has not rendered B, so A's measurements stay A's.
  owner.observe(stateFor(7, 'other'), true);
  t.mock.timers.tick(60);
  const stale = sent[sent.length - 1];
  assert.equal(stale.activeSpaceId, 'space');
  assert.equal(stale.windows[0].visible, true);
  assert.equal(stale.windows[0].width, 801);
  // B rendered: reported at once, with B's visibility.
  const count = sent.length;
  owner.setRenderedSpace('other');
  assert.equal(sent.length, count + 1);
  assert.equal(sent[count].activeSpaceId, 'other');
  assert.equal(sent[count].windows[0].visible, false);
});

test('the keyboard timeline still matches the occlusion revision this owner sent', (t) => {
  const { owner, sent } = fixture(t);
  keyboardTimeline.clear();
  keyboardTimeline.tap();
  owner.setOcclusion('view', 250);
  owner.flush();
  const revision = revisionOf(sent[sent.length - 1]);
  assert.equal(sent[sent.length - 1].windows[0].occludedBottom, 250);
  assert.equal(revision, occlusionRevision(7, 2));
  keyboardTimeline.viewportObserved(occlusionRevision(7, 1));
  keyboardTimeline.viewportObserved(revision);
  const steps = keyboardTimeline.export(0)[0].steps.map((item) => item.step);
  assert.deepEqual(steps, ['tap', 'occlusion-sent', 'frame-height']);
  keyboardTimeline.clear();
});
