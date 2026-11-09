import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { KeyboardPreferenceContext, useAutoFocus } from '../client/editing/local-autofocus';

const dom = new JSDOM('<html><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
let coarse = true;
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: coarse }) });

function Field({
  enabled = true,
  mode,
  textarea = false,
}: {
  enabled?: boolean;
  mode?: string;
  textarea?: boolean;
}) {
  const ref = useAutoFocus<HTMLInputElement | HTMLTextAreaElement>(enabled);
  return createElement(textarea ? 'textarea' : 'input', { ref, inputMode: mode });
}

async function mount({
  autoOpen = false,
  enabled = true,
  mode,
  textarea = false,
}: {
  autoOpen?: boolean;
  enabled?: boolean;
  mode?: string;
  textarea?: boolean;
} = {}) {
  const host = document.getElementById('app')!;
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        KeyboardPreferenceContext.Provider,
        { value: autoOpen },
        createElement(Field, { enabled, mode, textarea }),
      ),
    ),
  );
  const input = host.firstElementChild as HTMLInputElement | HTMLTextAreaElement;
  return { root, input };
}

test('coarse pointer autofocus suppresses soft input until the first tap and preserves hardware focus', async () => {
  coarse = true;
  const { root, input } = await mount();
  try {
    assert.equal(document.activeElement, input);
    assert.equal(input.inputMode, 'none');
    let modeAtPointer = '';
    input.addEventListener('pointerdown', () => {
      modeAtPointer = input.getAttribute('inputmode') ?? '';
    });
    input.dispatchEvent(new dom.window.Event('pointerdown'));
    assert.equal(modeAtPointer, '');
    assert.equal(input.hasAttribute('inputmode'), false);
    input.inputMode = 'decimal';
    input.dispatchEvent(new dom.window.Event('blur'));
    assert.equal(input.inputMode, 'decimal', 'restore listeners are removed after the first event');
  } finally {
    await act(async () => root.unmount());
  }
});

test('blur restores an explicit input mode on a textarea', async () => {
  coarse = true;
  const { root, input } = await mount({ mode: 'numeric', textarea: true });
  try {
    assert.equal(input.inputMode, 'none');
    input.blur();
    assert.equal(input.getAttribute('inputmode'), 'numeric');
  } finally {
    await act(async () => root.unmount());
  }
});

test('unmount restores input mode and removes restoration listeners', async () => {
  coarse = true;
  const { root, input } = await mount({ mode: 'email' });
  assert.equal(input.inputMode, 'none');
  await act(async () => root.unmount());
  assert.equal(input.inputMode, 'email');
  input.inputMode = 'text';
  input.dispatchEvent(new dom.window.Event('pointerdown'));
  input.dispatchEvent(new dom.window.Event('blur'));
  assert.equal(input.inputMode, 'text');
});

test('auto-open preference and fine pointers focus without changing input mode', async () => {
  for (const options of [
    { autoOpen: true, coarse: true },
    { autoOpen: false, coarse: false },
  ]) {
    coarse = options.coarse;
    const { root, input } = await mount({ autoOpen: options.autoOpen, mode: 'search' });
    try {
      assert.equal(document.activeElement, input);
      assert.equal(input.inputMode, 'search');
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test('disabled autofocus leaves the input unfocused and its mode intact', async () => {
  coarse = true;
  const { root, input } = await mount({ enabled: false, mode: 'url' });
  try {
    assert.notEqual(document.activeElement, input);
    assert.equal(input.inputMode, 'url');
  } finally {
    await act(async () => root.unmount());
  }
});

test('preference changes do not refocus a mounted input', async () => {
  coarse = true;
  const { root, input } = await mount();
  input.blur();
  await act(async () =>
    root.render(createElement(KeyboardPreferenceContext.Provider, { value: true }, createElement(Field))),
  );
  assert.notEqual(document.activeElement, input);
  await act(async () => root.unmount());
});
