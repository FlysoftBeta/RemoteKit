import { randomUUID } from 'node:crypto';
import { RemoteKitError, toRemoteKitError, wireError } from '../../shared/errors';
import type { ViewConfiguration } from '../endpoint/types';

import type { ProductTab, ProductWorkspace } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import { focusWindow, placeWindow, windowClosing, windowSpace, WORKSPACE_LIMITS } from './model';
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
    private readonly services: Pick<DomainServices, 'operations' | 'viewers' | 'workspace'>,
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
            error: wireError(
              new RemoteKitError(
                'not_found',
                popup.status === 'timed_out' ? '新页面创建已过期' : '新页面已关闭',
              ),
            ),
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
      if (!opener || opener.signIn) continue;
      const openerWindow = state.windows.find((window) => window.id === opener.windowId);
      if (!openerWindow || ![3, 4, 5, 6].includes(popup.disposition)) continue;
      if (
        windowClosing(state, openerWindow.id) ||
        openerWindow.appId === `web:${state.pendingAppUninstallId}`
      )
        continue;
      const webApp = openerWindow.appId.startsWith('web:');
      const before = structuredClone(state);
      const now = this.context.clock.wallMs();
      let target = openerWindow;
      const newWindow =
        (!webApp && [5, 6].includes(popup.disposition)) || (webApp && popup.disposition === 5);
      if (newWindow) {
        if (state.windows.length >= WORKSPACE_LIMITS.windows) continue;
        target = { id: randomUUID(), appId: openerWindow.appId, activeTabId: null, lastActiveAt: now };
        state.windows.push(target);
        const openerSpace = windowSpace(state, openerWindow.id);
        placeWindow(
          state,
          target.id,
          webApp && openerSpace.windowIds.length < WORKSPACE_LIMITS.windowsPerSpace
            ? { mode: 'split', besideWindowId: openerWindow.id, side: 'right' }
            : { mode: 'space' },
          randomUUID(),
          now,
        );
      } else if (webApp) {
        const browser = state.windows
          .filter((window) => window.appId === 'browser' && !windowClosing(state, window.id))
          .sort((left, right) => right.lastActiveAt - left.lastActiveAt)[0];
        if (browser) target = browser;
        else {
          if (state.windows.length >= WORKSPACE_LIMITS.windows) continue;
          target = { id: randomUUID(), appId: 'browser', activeTabId: null, lastActiveAt: now };
          state.windows.push(target);
          placeWindow(state, target.id, { mode: 'space' }, randomUUID(), now);
        }
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
        idleKeepAlive: false,
        webviewId: this.context.store.workspaces.viewId(),
        kind: 'remote',
        title: '新页面',
        url: address,
        popup: { provisionalId: popup.provisionalId, status: 'pending' },
      };
      state.tabs.push(tab);
      if (popup.disposition !== 4 || webApp) {
        target.activeTabId = tab.id;
        focusWindow(state, target.id, now);
      }
      this.context.store.transaction(() => {
        this.services.workspace.recordAction(before, state, { type: 'tab.activate', tabId: tab.id });
        this.context.store.operations.savePopupWorkspace(state, popup.provisionalId, tab.id);
      });
      this.services.viewers.push(state.tenantId);
    }
  }
}
