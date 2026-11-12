import { randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { LearningProvider } from '../../shared/learning';
import type { ProductWorkspace } from '../../shared/product';
import { assertWindowMutable, findWindow, WORKSPACE_LIMITS } from './model';

export function openSignInTab(
  state: ProductWorkspace,
  provider: LearningProvider,
  windowId: string,
  url: string,
  viewId: string,
) {
  const window = findWindow(state, windowId);
  assertWindowMutable(state, windowId);
  if (window.appId !== (provider === 'changyan' ? 'study' : 'questions'))
    throw new RemoteKitError('invalid_request', '请在对应的学习窗口中登录');
  if (state.tabs.length >= WORKSPACE_LIMITS.tabs)
    throw new RemoteKitError('limit_exceeded', '标签页已达上限', { capacity: 'tabs' });
  if (state.tabs.some((tab) => tab.windowId === windowId))
    throw new RemoteKitError('conflict', '窗口正在登录');
  const tab = {
    id: randomUUID(),
    windowId,
    webviewId: viewId,
    kind: 'remote' as const,
    title: provider === 'changyan' ? '畅言验证' : '新教育登录',
    url,
    signIn: provider,
  };
  state.tabs.push(tab);
  window.activeTabId = tab.id;
  return tab;
}

export function closeSignInTab(state: ProductWorkspace, tabId: string) {
  const tab = state.tabs.find((tab) => tab.id === tabId && tab.signIn);
  if (!tab) return;
  state.tabs = state.tabs.filter((item) => item.id !== tabId);
  const window = state.windows.find((window) => window.id === tab.windowId);
  if (window?.activeTabId === tabId) window.activeTabId = null;
  return tab;
}
