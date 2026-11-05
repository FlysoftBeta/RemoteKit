import { RemoteKitError } from '../../shared/errors';
import type { ProductTab, ProductWorkspace } from '../../shared/product';
export const WORKSPACE_LIMITS = Object.freeze({ tabs: 32, windows: 8, sites: 4096 });
export function findTab(workspace: ProductWorkspace, id: string): ProductTab {
  const tab = workspace.tabs.find((tab) => tab.id === id);
  if (!tab) throw new RemoteKitError('not_found', '标签页不存在');
  return tab;
}
export function findWindow(workspace: ProductWorkspace, id: string) {
  const window = workspace.windows.find((window) => window.id === id);
  if (!window) throw new RemoteKitError('not_found', '窗口不存在');
  return window;
}
export function reservesFilesTab(tab: ProductTab) {
  return (
    tab.kind === 'files' ||
    (tab.navigation?.previousKind === 'files' &&
      !tab.navigation.resolved &&
      ['applying', 'unknown'].includes(tab.navigation.status))
  );
}
