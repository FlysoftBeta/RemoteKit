import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { inputFixture } from './client-fixture';
import { ViewportInput } from '../client/input/viewport-input';
import type { Surface, Layout } from '../client/presentation/types';
import { deviceClipboard } from '../client/clipboard/device-clipboard';

function fixture(t: TestContext) {
  const transport = inputFixture();
  const surface: Surface = {
    id: 'v',
    session: 's',
    instance: 'i',
    document: 'd',
    focus: '7',
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    deviceScaleFactor: 1,
  };
  const layout: Layout = {
    type: 'layout',
    generation: '1',
    epoch: '2',
    width: 640,
    height: 480,
    views: [surface],
  };
  transport.presentation.layout = layout;
  transport.editing.handle(layout);
  const body = {};
  const document = Object.assign(new EventTarget(), { body, activeElement: body as unknown, hidden: false });
  const window = Object.assign(new EventTarget(), {
    matchMedia: (query: string) => ({ matches: query.includes('fine') }),
  });
  const restore: (() => void)[] = [];
  for (const [name, value] of Object.entries({ document, window })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restore.push(() => {
      if (old) Object.defineProperty(globalThis, name, old);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const editor = Object.assign(new EventTarget(), {
    value: '',
    inputMode: 'none',
    setSelectionRange() {},
    focus() {
      document.activeElement = editor;
      editor.dispatchEvent(new Event('focus'));
    },
    blur() {
      document.activeElement = body;
      editor.dispatchEvent(new Event('blur'));
    },
  });
  const canvas = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    hasPointerCapture: () => false,
    setPointerCapture() {},
    releasePointerCapture() {},
  });
  const sent: any[] = [];
  const channel: any = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (data: string) => sent.push(JSON.parse(data)),
  };
  transport.endpoint.bindChannel(channel);
  const viewport = new ViewportInput(
    {
      input: transport.input,
      editing: transport.editing,
      touch: transport.touch,
      presentation: {
        get layout() {
          return transport.presentation.layout;
        },
        selectedViewId: undefined,
        canInput: () => ({ surface, layout, attempt: 0 }),
        subscribe: () => () => {},
        subscribeFrames: () => () => {},
      },
    },
    surface.id,
    canvas as unknown as HTMLCanvasElement,
    editor as unknown as HTMLTextAreaElement,
    () => {},
  );
  viewport.configure(true, false, {
    waiting: false,
    keyboardOpen: false,
    keyboardDismissals: 0,
    blocksInput: () => false,
  });
  t.after(() => {
    viewport.dispose();
    transport.input.reset();
    restore.forEach((run) => run());
  });
  function emit(target: EventTarget, type: string, values: Record<string, unknown> = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, values);
    target.dispatchEvent(event);
  }
  const click = (pointerType = 'mouse') => {
    const value = {
      pointerId: 1,
      pointerType,
      button: 0,
      buttons: 1,
      clientX: 30,
      clientY: 30,
      detail: 1,
      getModifierState: () => false,
    };
    emit(canvas, 'pointerdown', value);
    emit(canvas, 'pointerup', { ...value, buttons: 0 });
  };
  const ack = () => {
    const requests = sent.filter((message) => message.type === 'focus');
    const request = requests[requests.length - 1];
    channel.onmessage({
      data: JSON.stringify({
        type: 'focus',
        ok: true,
        focusRequestId: request.focusRequestId,
        layoutEpoch: '2',
        token: { view: 'v', session: 's', instance: 'i', document: 'd', focus: '8' },
      }),
    });
  };
  const owner = (documentId = 'd', revision = '1', target = '31', focusSource = 'pointer') => {
    channel.onmessage({
      data: JSON.stringify({
        type: 'input.editable',
        version: 1,
        revision,
        view: { ...surface, document: documentId, focus: '8' },
        editable: {
          active: true,
          target,
          type: 1,
          flags: 0,
          focusSource,
          focusRevision: revision,
          selectionStart: 0,
          selectionEnd: 0,
          compositionStart: -1,
          compositionEnd: -1,
          caretX: 1,
          caretY: 1,
          caretWidth: 1,
          caretHeight: 12,
        },
      }),
    });
  };
  const text = (data: string) => {
    for (const char of data)
      emit(editor, 'beforeinput', { inputType: 'insertText', data: char, isComposing: false });
  };
  const events = () => sent.filter((message) => message.type === 'input').map((message) => message.event);
  return {
    transport,
    surface,
    layout,
    viewport,
    editor,
    document,
    click,
    ack,
    owner,
    text,
    events,
    emit,
    sent,
    channel,
  };
}

test('paste survives confirmation of its pointer focus while clipboard synchronization is pending', async (t) => {
  const f = fixture(t);
  let finish!: (value: { revision: string }) => void;
  const pending = new Promise<{ revision: string }>((resolve) => {
    finish = resolve;
  });
  Object.assign(f.document, { hasFocus: () => false });
  deviceClipboard.configure('paste-test', true, () => pending);
  t.after(() => deviceClipboard.configure(undefined, false, async () => ({ revision: '0' })));
  f.click();
  f.ack();
  f.emit(f.editor, 'paste', { clipboardData: { getData: () => 'clipboard text' } });
  await new Promise((resolve) => setImmediate(resolve));
  f.owner();
  finish({ revision: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    f
      .events()
      .filter((event) => event.windows_key_code === 86)
      .map((event) => event.action),
    ['down', 'up'],
  );
});

test('touch focuses the proxy and queues the first characters before remote editable feedback', (t) => {
  const f = fixture(t);
  let blurred = false;
  f.document.activeElement = {
    blur() {
      blurred = true;
      f.document.activeElement = f.document.body;
    },
  };
  f.click('touch');
  assert.equal(f.document.activeElement, f.editor);
  assert.equal(blurred, true);
  f.text('Tap');
  f.ack();
  f.owner();
  f.text('ped');
  assert.equal(
    f
      .events()
      .filter((event) => event.text)
      .map((event) => event.text)
      .join(''),
    'Tapped',
  );
});

test('immediate typing follows its pointer through the exact focus ACK and keeps all characters in order', (t) => {
  const f = fixture(t);
  f.click();
  f.text('De');
  assert.deepEqual(f.events(), []);
  f.ack();
  f.owner();
  f.text('sktop');
  assert.deepEqual(
    f
      .events()
      .slice(0, 2)
      .map((event) => event.action),
    ['down', 'up'],
  );
  assert.equal(
    f
      .events()
      .filter((event) => event.text)
      .map((event) => event.text)
      .join(''),
    'Desktop',
  );
  assert.deepEqual(
    f
      .events()
      .filter((event) => event.text)
      .map((event) => event.type),
    ['key', 'key', 'ime_commit', 'ime_commit', 'ime_commit', 'ime_commit', 'ime_commit'],
  );
});

test('a different document drops the pending pointer keys and composition', (t) => {
  const f = fixture(t);
  f.click();
  f.text('old');
  f.emit(f.editor, 'compositionstart');
  f.emit(f.editor, 'compositionupdate', { data: '旧' });
  f.channel.onmessage({
    data: JSON.stringify({ ...f.layout, views: [{ ...f.surface, document: 'next', focus: '8' }] }),
  });
  f.owner('next');
  f.ack();
  f.emit(f.editor, 'compositionend', { data: '旧' });
  assert.equal(f.events().filter((event) => event.text).length, 0);
});

test('pending IME binds to the matching pointer owner and preserves its preedit and commit', (t) => {
  const f = fixture(t);
  f.click();
  f.emit(f.editor, 'compositionstart');
  f.emit(f.editor, 'compositionupdate', { data: '你' });
  assert.deepEqual(f.events(), []);
  f.owner();
  assert.deepEqual(f.events(), []);
  f.ack();
  f.emit(f.editor, 'compositionupdate', { data: '你好' });
  f.emit(f.editor, 'compositionend', { data: '你好' });
  const ime = f.events().filter((event) => event.type.startsWith('ime'));
  assert.deepEqual(
    ime.map((event) => [event.type, event.text, event.editableTarget]),
    [
      ['ime_set', '你', '31'],
      ['ime_set', '你好', '31'],
      ['ime_commit', '你好', '31'],
    ],
  );
});

test('IME completed before ownership uses the ordered remote character path once', (t) => {
  const f = fixture(t);
  f.click();
  f.emit(f.editor, 'compositionstart');
  f.emit(f.editor, 'compositionupdate', { data: '你好🙂世界' });
  f.emit(f.editor, 'compositionend', { data: '你好🙂世界' });
  f.ack();
  f.owner();
  f.emit(f.editor, 'input', { inputType: 'insertText', data: '你好🙂世界', isComposing: false });
  const characters = f.events().filter((event) => event.text);
  assert.equal(characters.map((event) => event.text).join(''), '你好🙂世界');
  assert.ok(
    characters.every(
      (event) => event.type === 'key' && event.action === 'char' && typeof event.dom_key === 'string',
    ),
  );
});

test('script focus cannot inherit a composition started for the pending pointer', (t) => {
  const f = fixture(t);
  f.click();
  f.emit(f.editor, 'compositionstart');
  f.emit(f.editor, 'compositionupdate', { data: 'old' });
  f.ack();
  f.owner('d', '1', '32', 'script');
  f.emit(f.editor, 'compositionend', { data: 'old' });
  assert.equal(f.events().filter((event) => event.text).length, 0);
});

test('a superseding pointer isolates the old composition end from the new focus', (t) => {
  const f = fixture(t);
  f.click();
  f.emit(f.editor, 'compositionstart');
  f.emit(f.editor, 'compositionupdate', { data: 'old' });
  f.click();
  f.ack();
  f.owner();
  f.emit(f.editor, 'compositionend', { data: 'old' });
  assert.equal(f.events().filter((event) => event.text).length, 0);
});

test('a superseding pointer drops queued text and rejects the old focus ACK', (t) => {
  const f = fixture(t);
  f.click();
  f.text('old');
  const old = f.sent.find((message) => message.type === 'focus');
  f.click();
  f.text('new');
  f.channel.onmessage({
    data: JSON.stringify({
      type: 'focus',
      ok: true,
      focusRequestId: old.focusRequestId,
      layoutEpoch: '2',
      token: { view: 'v', session: 's', instance: 'i', document: 'd', focus: '8' },
    }),
  });
  assert.deepEqual(f.events(), []);
  f.ack();
  f.owner();
  assert.equal(
    f
      .events()
      .filter((event) => event.text)
      .map((event) => event.text)
      .join(''),
    'new',
  );
});
