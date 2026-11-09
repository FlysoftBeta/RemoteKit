import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LocalInputTarget } from '../client/selection/local-input';
import { LocalTextTarget } from '../client/selection/local-text';
import { wordAt } from '../client/selection/target';
import { AppClipboard } from '../client/clipboard/app-clipboard';
import { deviceClipboard } from '../client/clipboard/device-clipboard';
import { placeViewportSelectionMenu } from '../client/app/viewport-geometry';

const dom = new JSDOM('<html><body></body></html>', { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  InputEvent: dom.window.InputEvent,
  ShadowRoot: dom.window.ShadowRoot,
});

function field(value: string, textarea = false) {
  const input = document.createElement(textarea ? 'textarea' : 'input');
  document.body.replaceChildren(input);
  input.value = value;
  input.focus();
  let text = 'app clipboard';
  const writes: string[] = [];
  const target = new LocalInputTarget(input, {
    read: () => text,
    write: async (value) => {
      text = value;
      writes.push(value);
    },
  });
  return { input, target, writes };
}

test('local cut and paste use the app clipboard and emit cancellable edit events', async () => {
  for (const textarea of [false, true]) {
    const { input, target, writes } = field('alpha bravo charlie', textarea);
    input.setSelectionRange(6, 11);
    const edits: string[] = [];
    input.addEventListener('input', (event) => edits.push((event as InputEvent).inputType));
    await target.run('cut');
    assert.deepEqual(writes, ['bravo']);
    assert.equal(input.value, 'alpha  charlie');
    await target.run('paste');
    assert.equal(input.value, 'alpha bravo charlie');
    assert.equal(input.selectionStart, 11);
    assert.deepEqual(edits, ['deleteByCut', 'insertFromPaste']);
    input.addEventListener('beforeinput', (event) => event.preventDefault(), { once: true });
    await target.run('paste');
    assert.equal(input.value, 'alpha bravo charlie');
    input.readOnly = true;
    assert(!target.commands().includes('cut'));
    assert(!target.commands().includes('paste'));
  }
});

test('copy preserves selection, select all updates it, passwords cannot be copied', async () => {
  const { input, target, writes } = field('alpha bravo');
  input.setSelectionRange(6, 11);
  await target.run('copy');
  assert.deepEqual(writes, ['bravo']);
  assert.equal(input.selectionStart, 6);
  await target.run('selectAll');
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 11);
  if (input instanceof HTMLInputElement) input.type = 'password';
  assert(!target.commands().includes('copy'));
  await target.run('copy');
  assert.equal(writes.length, 1);
});

test('local text copies DOM selection and selects only its content', async () => {
  const content = document.createElement('div');
  content.innerHTML = '<b>alpha</b> bravo';
  document.body.replaceChildren(content);
  const writes: string[] = [];
  const target = new LocalTextTarget(content, {
    read: () => '',
    write: async (text) => {
      writes.push(text);
    },
  });
  await target.run('selectAll');
  await target.run('copy');
  assert.deepEqual(writes, ['alpha bravo']);
  target.collapse();
  assert(document.getSelection()?.isCollapsed);
});

test('app clipboard ignores stale revisions and clears across account changes', async () => {
  const clipboard = new AppClipboard();
  clipboard.configure('a', async () => ({ revision: '3' }));
  clipboard.receive({ revision: '2', text: 'remote' });
  assert.equal(clipboard.read(), 'remote');
  await clipboard.write('local');
  clipboard.receive({ revision: '1', text: 'stale' });
  assert.equal(clipboard.read(), 'local');
  clipboard.configure('b', async () => ({ revision: '1' }));
  assert.equal(clipboard.read(), '');
  clipboard.configure(undefined, async () => ({ revision: '1' }));
  await assert.rejects(clipboard.write('offline'), { code: 'unavailable' });
});

test('mouse targets expose commands without touch handles', () => {
  const { input } = field('alpha bravo');
  input.setSelectionRange(6, 11);
  const clipboard = { read: () => '', write: async () => {} };
  const target = new LocalInputTarget(input, clipboard, 'mouse');
  assert.deepEqual(target.handles(), {});
  assert(target.commands().includes('copy'));
});

test('word expansion handles boundaries, non-Latin letters and surrogate pairs', () => {
  assert.deepEqual(wordAt('alpha bravo', 8), [6, 11]);
  assert.deepEqual(wordAt('alpha bravo', 11), [6, 11]);
  assert.deepEqual(wordAt('你好 world', 1), [0, 2]);
  assert.deepEqual(wordAt('😀 bravo', 0), [0, 2]);
  assert.deepEqual(wordAt('😀 bravo', 1), [0, 2]);
  assert.deepEqual(wordAt('', 0), [0, 0]);
});

test('a delayed cut acknowledgement cannot delete edits made while it was pending', async () => {
  const { input } = field('alpha bravo');
  input.setSelectionRange(6, 11);
  let acknowledge!: () => void;
  const target = new LocalInputTarget(input, {
    read: () => '',
    write: () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  });
  const cutting = target.run('cut');
  input.value = 'newly typed text';
  acknowledge();
  await cutting;
  assert.equal(input.value, 'newly typed text');
});

test('explicit paste refreshes the device first and cannot overwrite a changed selection', async () => {
  const { input } = field('alpha bravo');
  input.setSelectionRange(6, 11);
  const originalRead = deviceClipboard.readForPaste;
  let finish!: () => void;
  let text = 'stale';
  deviceClipboard.readForPaste = () => new Promise<void>((resolve) => {
    finish = () => { text = 'fresh'; resolve(); };
  });
  const target = new LocalInputTarget(input, { read: () => text, write: async () => {} });
  try {
    const paste = target.run('paste');
    finish();
    await paste;
    assert.equal(input.value, 'alpha fresh');
    input.setSelectionRange(0, 5);
    const stalePaste = target.run('paste');
    input.setSelectionRange(6, 11);
    finish();
    await stalePaste;
    assert.equal(input.value, 'alpha fresh');
  } finally {
    deviceClipboard.readForPaste = originalRead;
  }
});

test('shared placement flips and clamps within the visual viewport above the keyboard', () => {
  const viewport = { left: 20, top: 60, width: 320, height: 240 };
  assert.deepEqual(
    placeViewportSelectionMenu({ left: 5, top: 64, width: 20, height: 20 }, viewport, 200, 24),
    { left: 28, top: 116 },
  );
  assert.deepEqual(
    placeViewportSelectionMenu({ left: 330, top: 280, width: 10, height: 20 }, viewport, 200, 24),
    { left: 132, top: 236 },
  );
});
