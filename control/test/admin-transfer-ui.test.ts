import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { RemoteKitError } from '../shared/errors';

const dom = new JSDOM('<html><body><div id="app"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'DocumentFragment',
  'ShadowRoot',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'getComputedStyle',
] as const) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { TransferDialog } = await import('../client/app/admin/users');

for (const code of [null, 'unavailable', 'busy', 'internal', 'outcome_unknown'] as const) {
  test(`admin transfer shows progress and ends with ${code ?? 'success'} without resubmitting`, async (t) => {
    const root = createRoot(document.getElementById('app')!);
    let calls = 0;
    let closed = false;
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    try {
      await act(async () => {
        root.render(
          createElement(TransferDialog, {
            open: true,
            title: '转移用户的 Session',
            children: '源节点与目标节点',
            onClose: () => {
              closed = true;
            },
            onConfirm: () => {
              calls++;
              return pending;
            },
          }),
        );
      });
      const button = Array.from(document.querySelectorAll('button')).find(
        (item) => item.textContent === '转移',
      )!;
      await act(async () => {
        button.click();
      });
      assert.equal(calls, 1);
      assert.match(document.querySelector('[role="status"]')!.textContent!, /等待节点确认/);
      assert.equal(button.disabled, true);
      assert.equal(closed, false);
      await act(async () => {
        if (code) fail(new RemoteKitError(code, 'injected', { errorId: 'e-0123456789' }));
        else complete();
      });
      assert.equal(document.querySelector('[role="progressbar"]'), null);
      if (code) {
        assert.equal(closed, false);
        assert.match(document.body.textContent!, new RegExp(`错误代码：${code}`));
        assert.doesNotMatch(document.body.textContent!, /恢复后自动继续|正在转移|转移中/);
        t.mock.timers.enable({ apis: ['setTimeout'] });
        await act(async () => {
          t.mock.timers.tick(300000);
        });
        assert.equal(calls, 1);
      } else {
        assert.equal(closed, true);
      }
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
}
