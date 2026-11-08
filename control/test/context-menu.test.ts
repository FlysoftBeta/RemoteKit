import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContextMenuInteraction,
  contextMenuItems,
  type ContextMenuCloseReason,
} from '../client/app/context-menu-items';
import type { ContextMenu, ContextCommand } from '../client/rtc/protocol';
import type { ProductAction, ProductTab } from '../shared/product';

const menu: ContextMenu = { id: '1', x: 12, y: 40, source: 'mouse' };
const tab: ProductTab = {
  id: 'tab',
  windowId: 'window',
  webviewId: 'v',
  title: 'Page',
  url: 'https://example.com/',
};
const items = (value: Partial<ContextMenu>) => contextMenuItems({ ...menu, ...value }, tab, 'bing');

test('context menu link and image groups route URLs and commands to their owners', () => {
  assert.deepEqual(
    items({
      link: { url: 'https://example.com/link', text: 'Link' },
      image: { src: 'https://example.com/image' },
    }),
    [
      [
        {
          label: '在新标签页中打开链接',
          action: { type: 'tab.create', windowId: 'window', url: 'https://example.com/link' },
        },
        { label: '复制链接地址', command: 'copyLinkAddress' },
      ],
      [
        {
          label: '在新标签页中打开图片',
          action: { type: 'tab.create', windowId: 'window', url: 'https://example.com/image' },
        },
        { label: '复制图片', command: 'copyImage' },
        { label: '复制图片地址', command: 'copyImageAddress' },
      ],
    ],
  );
  assert.equal(items({ image: { src: 'https://example.com/image' } }).length, 1);
});

test('editable menu shows disabled commands and groups undo/redo separately', () => {
  assert.deepEqual(
    items({
      selection: 'Selected',
      editable: { undo: true, redo: false, cut: false, copy: true, paste: true, selectAll: false },
    }),
    [
      [
        { label: '撤销', command: 'undo', disabled: false },
        { label: '重做', command: 'redo', disabled: true },
      ],
      [
        { label: '剪切', command: 'cut', disabled: true },
        { label: '复制', command: 'copy', disabled: false },
        { label: '粘贴', command: 'paste', disabled: false },
        { label: '全选', command: 'selectAll', disabled: true },
      ],
    ],
  );
});

test('selection search labels truncate after 16 code points and keep the complete query', () => {
  for (const selection of ['短词', 'a'.repeat(15) + '😀', 'a'.repeat(15) + '😀z']) {
    const group = items({ selection })[0];
    const label =
      Array.from(selection).slice(0, 16).join('') + (Array.from(selection).length > 16 ? '…' : '');
    assert.deepEqual(group, [
      { label: '复制', command: 'copy' },
      {
        label: `使用Bing搜索"${label}"`,
        action: { type: 'tab.create', windowId: 'window', query: selection },
      },
    ]);
  }
  assert.equal(contextMenuItems({ ...menu, selection: '词' }, tab, 'baidu')[0][1].label, '使用百度搜索"词"');
});

test('page menu reads navigation availability from the product tab', () => {
  assert.deepEqual(items({}), [
    [
      { label: '返回', disabled: true, action: { type: 'tab.command', tabId: 'tab', command: 'back' } },
      { label: '前进', disabled: true, action: { type: 'tab.command', tabId: 'tab', command: 'forward' } },
      { label: '重新加载', action: { type: 'tab.command', tabId: 'tab', command: 'reload' } },
    ],
  ]);
  const enabled = contextMenuItems(menu, { ...tab, canGoBack: true, canGoForward: true }, 'google')[0];
  assert.equal(enabled[0].disabled, false);
  assert.equal(enabled[1].disabled, false);
});

function interaction() {
  const events: (ContextCommand | ProductAction | 'closed')[] = [];
  return {
    events,
    interaction: new ContextMenuInteraction({
      command: (command) => events.push(command),
      product: (action) => events.push(action),
      closed: () => events.push('closed'),
    }),
  };
}

test('Escape, outside mouse/touch, window blur and hidden viewport dismiss once through cleanup', () => {
  for (const reason of ['escape', 'outside', 'blur', 'hidden'] satisfies ContextMenuCloseReason[]) {
    const { interaction: menu, events } = interaction();
    menu.close(reason);
    menu.close('hidden');
    menu.close('outside');
    menu.choose({ label: 'Copy', command: 'copy' });
    assert.deepEqual(events, ['dismiss', 'closed'], reason);
  }
});

test('Browser close and supersession do not send dismiss during cleanup', () => {
  const { interaction: menu, events } = interaction();
  menu.close('browser');
  menu.close('hidden');
  assert.deepEqual(events, ['closed']);
});

test('Browser commands close without dismiss and product actions send before a single dismiss', () => {
  for (const command of [
    'undo',
    'redo',
    'cut',
    'copy',
    'paste',
    'selectAll',
    'copyLinkAddress',
    'copyImage',
    'copyImageAddress',
  ] satisfies ContextCommand[]) {
    const { interaction: menu, events } = interaction();
    menu.choose({ label: command, command });
    menu.close('hidden');
    assert.deepEqual(events, [command, 'closed']);
  }
  const { interaction: menu, events } = interaction();
  const action: ProductAction = { type: 'tab.create', windowId: 'window', query: 'example.com' };
  menu.choose({ label: 'Search', action, disabled: true });
  assert.deepEqual(events, []);
  menu.choose({ label: 'Search', action });
  menu.close('outside');
  menu.close('hidden');
  assert.deepEqual(events, [action, 'dismiss', 'closed']);
});
