import { randomUUID } from 'node:crypto';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type { ViewConfiguration } from '../endpoint/types';

import type { ProductTab, ProductWorkspace } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
function url(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192)
    throw new RemoteKitError('invalid_request', '无效网址');
  if (value === 'about:blank') return value;
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new RemoteKitError('invalid_request', '无效输入');
    return parsed.href;
  } catch {
    throw new RemoteKitError('invalid_request', '请输入 HTTP 或 HTTPS 网址');
  }
}

export class Popups {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<DomainServices, 'operations' | 'viewers'>,
  ) {}
  async observePopups(state: ProductWorkspace, snapshot: any) {
    for (const popup of Array.isArray(snapshot.pendingPopups) ? snapshot.pendingPopups : []) {
      if (!popup || typeof popup.provisionalId !== 'string' || popup.provisionalId.length > 256) continue;
      const existing = state.tabs.find((t) => t.popup?.provisionalId === popup.provisionalId);
      if (existing) {
        if (existing.popup?.status === 'pending' && ['closed', 'timed_out'].includes(popup.status)) {
          existing.popup = {
            provisionalId: popup.provisionalId,
            status: 'failed',
            error: popup.status === 'timed_out' ? '新页面创建已过期' : '新页面已关闭',
          };
          this.services.operations.saveWorkspace(state);
        }
        continue;
      }
      if (
        popup.status !== 'pending' ||
        popup.userGesture !== true ||
        this.context.store.operations.popupTabId(state.tenantId, popup.provisionalId) ||
        state.tabs.length >= 32
      )
        continue;
      const opener = state.tabs.find((t) => t.webviewId === popup.openerViewId);
      if (!opener) continue;
      let target = state.windows.find((w) => w.id === opener.windowId);
      if (!target) continue;
      if (![3, 4, 5, 6].includes(popup.disposition)) continue;
      if ([5, 6].includes(popup.disposition)) {
        if (state.windows.length >= 8) continue;
        target = { id: randomUUID(), activeTabId: null, weight: 1 };
        state.windows.push(target);
      }
      let address: string;
      try {
        address = url(popup.url);
      } catch {
        address = 'about:blank';
      }
      const tab: ProductTab = {
        id: randomUUID(),
        windowId: target.id,
        webviewId: this.context.store.workspaces.viewId(),
        kind: 'remote',
        title: '新页面',
        url: address,
        popup: { provisionalId: popup.provisionalId, status: 'pending' },
      };
      state.tabs.push(tab);
      if (popup.disposition !== 4) {
        target.activeTabId = tab.id;
        state.activeWindowId = target.id;
      }
      this.context.store.operations.savePopupWorkspace(state, popup.provisionalId, tab.id);
      this.services.viewers.push(state.tenantId);
    }
  }

  async adopt(state: ProductWorkspace, tab: ProductTab, config: ViewConfiguration): Promise<boolean> {
    const popup = tab.popup!;
    try {
      const adopted = await this.context.endpoint.adoptView(state.tenantId, {
        ...config,
        url: tab.url,
        provisionalId: popup.provisionalId,
      });
      if (adopted?.accepted !== true || adopted.completed !== true)
        throw new RemoteKitError('rejected', 'Endpoint尚未完成新页面收养');
      tab.popup = { provisionalId: popup.provisionalId, status: 'adopted' };
      this.services.operations.saveWorkspace(state);
      return true;
    } catch (error) {
      if (!['not_found', 'rejected'].includes(toRemoteKitError(error).code)) throw error;
      tab.popup = {
        provisionalId: popup.provisionalId,
        status: 'failed',
        error: '新页面已关闭或过期，请关闭后重试',
      };
      this.services.operations.saveWorkspace(state);
      return false;
    }
  }
}
