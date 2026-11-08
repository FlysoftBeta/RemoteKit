import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardLayout, keyboardLayoutMessage } from '../client/input/keyboard-layout';
import { inputFixture } from './client-fixture';
import { encodeOutgoing, type KeyboardLayoutMessage } from '../client/rtc/protocol';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
class Keyboard extends EventTarget {
  map = new Map([
    ['KeyA', 'q'],
    ['Digit1', '1'],
    ['KeyE', '😀'],
  ]);
  async getLayoutMap() {
    return this.map;
  }
}
function navigatorKeyboard(t: TestContext, keyboard: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { keyboard } });
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, 'navigator', previous)
      : Reflect.deleteProperty(globalThis, 'navigator'),
  );
}

test('layout wire entries are bounded and use UTF-16 lengths', () => {
  const map = new Map([
    ['KeyA', '😀😀'],
    ['KeyB', 'abcde'],
    ['Bad-Code', 'a'],
    ['', 'a'],
    ['KeyC', ''],
  ]);
  assert.deepEqual(keyboardLayoutMessage(map), { type: 'keyboard.layout', entries: [['KeyA', '😀😀']] });
  assert.equal(
    keyboardLayoutMessage(new Map(Array.from({ length: 300 }, (_, i) => [`Key${i}`, 'a']))).entries.length,
    256,
  );
  assert.deepEqual(JSON.parse(encodeOutgoing(keyboardLayoutMessage(map))), keyboardLayoutMessage(map));
});

test('layout is sent on connect, layoutchange and reconnect without retained maps', async () => {
  const keyboard = new Keyboard();
  const layout = new KeyboardLayout();
  const sent: KeyboardLayoutMessage[] = [];
  layout.connect((message) => sent.push(message), keyboard);
  await settle();
  assert.deepEqual(sent[0], { type: 'keyboard.layout', entries: [...keyboard.map] });
  keyboard.map = new Map([['KeyA', 'a']]);
  keyboard.dispatchEvent(new Event('layoutchange'));
  await settle();
  assert.deepEqual(sent[1].entries, [['KeyA', 'a']]);
  layout.disconnect();
  keyboard.dispatchEvent(new Event('layoutchange'));
  await settle();
  assert.equal(sent.length, 2);
  layout.connect((message) => sent.push(message), keyboard);
  await settle();
  assert.deepEqual(sent[2].entries, [['KeyA', 'a']]);
  layout.disconnect();
});

test('missing and failing keyboard APIs send nothing and old connection promises cannot send', async (t) => {
  navigatorKeyboard(t, undefined);
  const layout = new KeyboardLayout();
  const sent: KeyboardLayoutMessage[] = [];
  layout.connect((message) => sent.push(message));
  layout.connect((message) => sent.push(message), {
    getLayoutMap: async () => {
      throw new Error('denied');
    },
  });
  await settle();
  let resolve!: (map: Map<string, string>) => void;
  layout.connect((message) => sent.push(message), {
    getLayoutMap: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  layout.disconnect();
  resolve(new Map([['KeyA', 'a']]));
  await settle();
  assert.deepEqual(sent, []);
});

test('input channel lifecycle sends the session map without needing a view', async (t) => {
  const keyboard = new Keyboard();
  navigatorKeyboard(t, keyboard);
  const { input, endpoint, authorization } = inputFixture();
  const sent: KeyboardLayoutMessage[] = [];
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    close() {},
  } as unknown as RTCDataChannel;
  endpoint.events.subscribe(input.onChannel);
  t.after(() => input.onChannel({ type: 'closed' }));
  endpoint.bindChannel(channel);
  await settle();
  assert.deepEqual(sent[0], { type: 'keyboard.layout', entries: [...keyboard.map] });
  assert.equal(sent.length, 1);
  input.layoutChanged();
  await settle();
  assert.equal(sent.length, 1);
  input.onChannel({ type: 'closed' });
  input.onChannel({ type: 'open' });
  await settle();
  assert.equal(sent.length, 2);
  input.reset();
  authorization.productLocked = true;
  input.onChannel({ type: 'open' });
  await settle();
  assert.equal(sent.length, 2);
  authorization.productLocked = false;
  input.layoutChanged();
  await settle();
  assert.equal(sent.length, 3);
});
