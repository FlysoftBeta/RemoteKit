import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { beginTabPointer, registerTabStrip } from '../client/app/tab-drag';

test('drag targets stay in their registered group while browser windows share a group', async () => {
  const dom = new JSDOM('<body></body>');
  const { window } = dom;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    getComputedStyle: window.getComputedStyle.bind(window),
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const strips: string[] = [];
  try {
    const strip = (id: string, group: string, left: number) => {
      const node = window.document.createElement('div');
      const tab = window.document.createElement('div');
      tab.className = 'window-tab';
      tab.dataset.tabId = id;
      node.append(tab);
      window.document.body.append(node);
      node.getBoundingClientRect = () => ({
        left,
        right: left + 200,
        top: 0,
        bottom: 40,
        height: 40,
        width: 200,
        x: left,
        y: 0,
        toJSON() {},
      });
      tab.getBoundingClientRect = node.getBoundingClientRect;
      Object.defineProperty(tab, 'offsetWidth', { value: 180 });
      registerTabStrip(id, group, node);
      strips.push(id);
      return tab;
    };
    const browser = strip('browser1', 'browser', 0);
    const files = strip('files1', 'files:files1', 300);
    strip('browser2', 'browser', 600);
    strip('files2', 'files:files2', 900);
    const moves: unknown[] = [];
    const pointer = (type: string, x: number) => {
      const event = new window.Event(type);
      Object.assign(event, { pointerId: 1, clientX: x, clientY: 20 });
      window.dispatchEvent(event);
    };
    const drag = (tab: HTMLElement, id: string, fromX: number, toX: number) => {
      beginTabPointer({
        event: {
          currentTarget: tab,
          target: tab,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          clientX: fromX,
          clientY: 20,
        } as unknown as React.PointerEvent<HTMLElement>,
        tabId: id,
        windowId: id,
        title: id,
        index: 0,
        move: (...args) => moves.push(args),
        longPress() {},
      });
      pointer('pointermove', toX);
      pointer('pointerup', toX);
    };
    drag(browser, 'browser1', 20, 350);
    assert.deepEqual(moves, []);
    drag(browser, 'browser1', 20, 650);
    assert.deepEqual(moves, [['browser1', 'browser2', 0]]);
    moves.length = 0;
    drag(files, 'files1', 320, 650);
    drag(files, 'files1', 320, 950);
    assert.deepEqual(moves, []);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    for (const id of strips) registerTabStrip(id, '', null);
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
