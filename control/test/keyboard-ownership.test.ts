import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { CANDIDATE_FOCUS_MS, CandidateFocus } from '../client/editing/candidate-focus';
import { keyboardAssignment, keyboardOwner } from '../client/editing/keyboard-ownership';
import { KeyboardTimeline } from '../client/editing/keyboard-timeline';
import { KeyboardViewport } from '../client/editing/keyboard-viewport';

const metrics = (height: number) => ({
  visual: { width: 400, height, offsetLeft: 0, offsetTop: 0 },
  scale: 1,
  layoutWidth: 400,
  layoutHeight: 800,
});

test('the keyboard owner is the focused editable that wants a soft keyboard', () => {
  const dom = new JSDOM(
    '<div class="remote-viewport" data-view-id="v1"><textarea class="remote-input"></textarea></div>' +
      '<input id="search"><input id="hidden" inputmode="none"><button id="b"></button>',
  );
  const document = dom.window.document;
  const remote = document.querySelector<HTMLTextAreaElement>('.remote-input')!;
  assert.deepEqual(keyboardOwner(document.body), { kind: 'none' });
  remote.inputMode = 'text';
  assert.deepEqual(keyboardOwner(remote), { kind: 'remote', viewId: 'v1' });
  remote.inputMode = 'none';
  assert.deepEqual(keyboardOwner(remote), { kind: 'none' });
  assert.deepEqual(keyboardOwner(document.getElementById('search')), { kind: 'shell' });
  assert.deepEqual(keyboardOwner(document.getElementById('hidden')), { kind: 'none' });
  assert.deepEqual(keyboardOwner(document.getElementById('b')), { kind: 'none' });
  dom.window.close();
});

test('a shell keyboard keeps the stable height and reports no remote occlusion (800 to 500)', () => {
  const viewport = new KeyboardViewport();
  viewport.measure(metrics(800), true, true, 0);
  assert.equal(viewport.measure(metrics(500), true, true, 10), 'keyboard');
  assert.equal(viewport.open, true);
  assert.equal(viewport.stableHeight, 800, 'windows keep their 800 px height');
  assert.equal(viewport.occludedBottom, 300);
  assert.deepEqual(keyboardAssignment({ kind: 'shell' }, viewport.occludedBottom, 'v1'), {
    viewId: '',
    remoteBottom: 0,
    shellBottom: 300,
  });
  // Restoring waits for the settle; the shell keyboard never produced an ordinary resize.
  assert.equal(viewport.measure(metrics(800), true, true, 20), 'keyboard');
  assert.equal(viewport.settle(30), false);
  assert.equal(viewport.settle(200), true);
  assert.equal(viewport.stableHeight, 800);
});

test('a remote keyboard occludes only its own view and moving ownership recomputes it', () => {
  assert.deepEqual(keyboardAssignment({ kind: 'remote', viewId: 'v2' }, 300, 'v1'), {
    viewId: 'v2',
    remoteBottom: 300,
    shellBottom: 0,
  });
  assert.deepEqual(keyboardAssignment({ kind: 'none' }, 300, 'v1'), {
    viewId: 'v1',
    remoteBottom: 300,
    shellBottom: 0,
  });
  assert.deepEqual(keyboardAssignment({ kind: 'shell' }, 300, 'v1').viewId, '');
});

test('the first keyboard occlusion value is available before any settle', () => {
  const viewport = new KeyboardViewport();
  viewport.measure(metrics(800), true, true, 0);
  assert.equal(viewport.measure(metrics(760), true, true, 5), 'keyboard');
  assert.equal(viewport.occludedBottom, 40);
  assert.equal(viewport.deadline, undefined);
  assert.equal(viewport.measure(metrics(520), true, true, 15), 'keyboard');
  assert.equal(viewport.occludedBottom, 280);
  assert.equal(viewport.deadline, undefined);
});

test('candidate focus: confirmation ends it, timeout and sustained NONE reject it, precise pointers skip it', () => {
  const candidate = new CandidateFocus();
  candidate.begin('1', 0, true);
  assert.equal(candidate.deadline, CANDIDATE_FOCUS_MS);
  assert.equal(candidate.observe({ editor: 'unknown', revision: '1', now: 100 }, false), false);
  assert.equal(candidate.observe({ editor: 'active', revision: '2', now: 200 }, true), false);
  assert.equal(candidate.active, false);

  candidate.begin('1', 0, true);
  assert.equal(candidate.observe({ editor: 'inactive', revision: '1', now: 100 }, false), false, 'old NONE');
  assert.equal(candidate.observe({ editor: 'inactive', revision: '2', now: 300 }, false), false, 'grace');
  assert.equal(candidate.observe({ editor: 'active', revision: '3', now: 400 }, false), false, 'replaced');
  assert.equal(candidate.observe({ editor: 'inactive', revision: '4', now: 500 }, false), false);
  assert.equal(candidate.observe({ editor: 'inactive', revision: '4', now: 700 }, false), true);

  candidate.begin('1', 0, true);
  assert.equal(candidate.observe({ editor: 'unknown', revision: '1', now: 1499 }, false), false);
  assert.equal(candidate.observe({ editor: 'unknown', revision: '1', now: 1500 }, false), true);

  candidate.begin('1', 0, false);
  assert.equal(candidate.active, false);
  assert.equal(candidate.observe({ editor: 'unknown', revision: '1', now: 5000 }, false), false);
});

test('keyboard timeline records the first occurrence of each step relative to the tap', () => {
  const timeline = new KeyboardTimeline();
  timeline.tap(1000);
  timeline.mark('candidate-focus', 1001);
  timeline.mark('remote-focus', 1040);
  timeline.mark('remote-focus', 1050);
  timeline.occlusionSent('7', 1100);
  timeline.viewportObserved('6', 1150);
  timeline.viewportObserved('7', 1180);
  timeline.mark('open', 1000 + 20_000);
  assert.deepEqual(timeline.export(0), [
    {
      tapAtMs: 1000,
      steps: [
        { step: 'tap', atMs: 0 },
        { step: 'candidate-focus', atMs: 1 },
        { step: 'remote-focus', atMs: 40 },
        { step: 'occlusion-sent', atMs: 100 },
        { step: 'frame-height', atMs: 180 },
      ],
    },
  ]);
  for (let n = 0; n < 12; n++) timeline.tap(2000 + n);
  assert.equal(timeline.export(0).length, 8);
  assert.equal(timeline.export(2008).length, 4);
});
