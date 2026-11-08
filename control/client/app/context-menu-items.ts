import { SEARCH_ENGINES, type ProductAction, type ProductTab, type SearchEngine } from '../../shared/product';
import type { ContextCommand, ContextMenu } from '../rtc/protocol';

export interface ContextMenuItem {
  label: string;
  disabled?: boolean;
  command?: ContextCommand;
  action?: ProductAction;
}

export function contextMenuItems(
  menu: ContextMenu,
  tab: ProductTab,
  engine: SearchEngine,
): ContextMenuItem[][] {
  const groups: ContextMenuItem[][] = [];
  const open = (label: string, url: string): ContextMenuItem => ({
    label,
    action: { type: 'tab.create', windowId: tab.windowId, url },
  });
  if (menu.link)
    groups.push([
      open('在新标签页中打开链接', menu.link.url),
      { label: '复制链接地址', command: 'copyLinkAddress' },
    ]);
  if (menu.image)
    groups.push([
      open('在新标签页中打开图片', menu.image.src),
      { label: '复制图片', command: 'copyImage' },
      { label: '复制图片地址', command: 'copyImageAddress' },
    ]);
  if (menu.editable) {
    const edit = (label: string, command: keyof NonNullable<ContextMenu['editable']>): ContextMenuItem => ({
      label,
      command,
      disabled: !menu.editable![command],
    });
    groups.push([edit('撤销', 'undo'), edit('重做', 'redo')]);
    groups.push([
      edit('剪切', 'cut'),
      edit('复制', 'copy'),
      edit('粘贴', 'paste'),
      edit('全选', 'selectAll'),
    ]);
  } else if (menu.selection) {
    const points = Array.from(menu.selection);
    const label = points.slice(0, 16).join('') + (points.length > 16 ? '…' : '');
    const name = SEARCH_ENGINES.find((item) => item.value === engine)!.label;
    groups.push([
      { label: '复制', command: 'copy' },
      {
        label: `使用${name}搜索"${label}"`,
        action: { type: 'tab.create', windowId: tab.windowId, query: menu.selection },
      },
    ]);
  }
  if (!groups.length)
    groups.push([
      {
        label: '返回',
        disabled: !tab.canGoBack,
        action: { type: 'tab.command', tabId: tab.id, command: 'back' },
      },
      {
        label: '前进',
        disabled: !tab.canGoForward,
        action: { type: 'tab.command', tabId: tab.id, command: 'forward' },
      },
      { label: '重新加载', action: { type: 'tab.command', tabId: tab.id, command: 'reload' } },
    ]);
  return groups;
}

export type ContextMenuCloseReason = 'escape' | 'outside' | 'blur' | 'hidden' | 'browser';

export class ContextMenuInteraction {
  private closed = false;

  constructor(
    private readonly ports: {
      command(command: ContextCommand): void;
      product(action: ProductAction): void;
      closed(): void;
    },
  ) {}

  close(reason: ContextMenuCloseReason) {
    if (this.closed) return;
    this.closed = true;
    if (reason !== 'browser') this.ports.command('dismiss');
    this.ports.closed();
  }

  choose(item: ContextMenuItem) {
    if (this.closed || item.disabled) return;
    this.closed = true;
    if (item.command) this.ports.command(item.command);
    if (item.action) {
      this.ports.product(item.action);
      this.ports.command('dismiss');
    }
    this.ports.closed();
  }
}
