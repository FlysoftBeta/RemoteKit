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
const { TransferDialog, AdminUsersSection } = await import('../client/app/admin/users');

test('self menus allow online management and current-node binding saves without transferring', async () => {
  const root = createRoot(document.getElementById('app')!);
  const calls: { method: string; params: any }[] = [];
  const user = {
    username: 'administrator',
    isAdmin: true,
    disabled: false,
    online: true,
    lastLoginAt: null,
    session: {
      state: 'running',
      nodeId: 'alpha',
      boundNodeId: 'alpha',
      dataState: 'dirty',
      nodeOffline: false,
      checkpointAt: null,
    },
    secondFactors: { pin: true, face: true },
    storage: { bytes: 0, quotaBytes: null },
  };
  const call: any = async (method: string, params: any) => {
    calls.push({ method, params });
    return method === 'admin.nodes'
      ? [
          { nodeId: 'alpha', state: 'ready' },
          { nodeId: 'beta', state: 'ready' },
        ]
      : [user];
  };
  const click = async (element: Element) =>
    act(async () => {
      (element as HTMLElement).click();
    });
  const text = (selector: string, name: string) =>
    Array.from(document.querySelectorAll(selector)).find((item) => item.textContent === name)!;
  try {
    await act(async () => {
      root.render(createElement(AdminUsersSection, { online: true, self: user.username, call }));
    });
    await click(document.querySelector('[aria-label="administrator 的操作"]')!);
    for (const name of ['重置密码', '清除 PIN 与人脸', '转移', '重置浏览器数据', '强制下线', '立即停止'])
      assert.notEqual(text('[role="menuitem"]', name)?.getAttribute('aria-disabled'), 'true', name);
    for (const name of ['停用账户', '转让管理员', '删除用户'])
      assert.equal(text('[role="menuitem"]', name)?.getAttribute('aria-disabled'), 'true', name);
    await click(text('[role="menuitem"]', '转移'));
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, true);
    await act(async () => {
      document
        .querySelector('[role="combobox"]')!
        .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    assert(text('[role="option"]', 'alpha（当前）'));
    await click(text('[role="option"]', 'alpha（当前）'));
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.disabled, false);
    const save = text('button', '保存') as HTMLButtonElement;
    assert.equal(save.disabled, true);
    await click(checkbox);
    assert.equal(save.disabled, false);
    await click(save);
    assert.deepEqual(calls.find((entry) => entry.method === 'admin.transfer')?.params, {
      username: 'administrator',
      nodeId: 'alpha',
      bind: false,
    });
    assert.match(document.body.textContent!, /已绑定/);
    await click(document.querySelector('[aria-label="administrator 的操作"]')!);
    await click(text('[role="menuitem"]', '强制下线'));
    assert.match(document.body.textContent!, /你将退出所有设备，需要重新登录/);
    await click(text('button', '取消'));
    await click(document.querySelector('[aria-label="administrator 的操作"]')!);
    await click(text('[role="menuitem"]', '立即停止'));
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent!, /用户在线时浏览器会随即重新启动、标签页重新载入/);
    assert.doesNotMatch(dialog.textContent!, /用户会被强制下线/);
    await click(text('button', '停止'));
    assert.deepEqual(calls.find((entry) => entry.method === 'admin.stop')?.params, {
      username: 'administrator',
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

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
