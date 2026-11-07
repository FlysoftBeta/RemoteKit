import { RemoteKitError } from '../../shared/errors';
import type {
  ProductSpace,
  ProductTab,
  ProductWindow,
  ProductWorkspace,
  WindowPlacement,
} from '../../shared/product';
export const WORKSPACE_LIMITS = Object.freeze({ tabs: 32, windows: 12, windowsPerSpace: 3, sites: 4096 });
export function findTab(workspace: ProductWorkspace, id: string): ProductTab {
  const tab = workspace.tabs.find((tab) => tab.id === id);
  if (!tab) throw new RemoteKitError('not_found', 'Tab does not exist');
  return tab;
}
export function findWindow(workspace: ProductWorkspace, id: string): ProductWindow {
  const window = workspace.windows.find((window) => window.id === id);
  if (!window) throw new RemoteKitError('not_found', 'Window does not exist');
  return window;
}
export function findSpace(workspace: ProductWorkspace, id: string): ProductSpace {
  const space = workspace.spaces.find((space) => space.id === id);
  if (!space) throw new RemoteKitError('not_found', 'Space does not exist');
  return space;
}
export function windowSpace(workspace: ProductWorkspace, windowId: string): ProductSpace {
  const space = workspace.spaces.find((space) => space.windowIds.includes(windowId));
  if (!space) throw new RemoteKitError('not_found', 'Window space does not exist');
  return space;
}
export function windowClosing(workspace: ProductWorkspace, windowId: string): boolean {
  return (
    workspace.pendingWindowCloseId === windowId ||
    workspace.pendingWindowCloseIds?.includes(windowId) === true
  );
}
export function assertWindowMutable(workspace: ProductWorkspace, windowId: string) {
  if (windowClosing(workspace, windowId)) throw new RemoteKitError('conflict', 'The window is closing');
}
export function normalizeWeights(space: ProductSpace) {
  const sum = space.weights.reduce((total, weight) => total + weight, 0);
  space.weights = space.weights.map((weight) => weight / sum);
}
export function focusWindow(workspace: ProductWorkspace, windowId: string, now = Date.now()) {
  const window = findWindow(workspace, windowId);
  const space = windowSpace(workspace, windowId);
  workspace.activeSpaceId = space.id;
  space.focusedWindowId = window.id;
  space.lastActiveAt = now;
  window.lastActiveAt = now;
}
function detachWindow(workspace: ProductWorkspace, windowId: string) {
  const space = windowSpace(workspace, windowId);
  const index = space.windowIds.indexOf(windowId);
  space.windowIds.splice(index, 1);
  space.weights.splice(index, 1);
  if (space.windowIds.length) {
    normalizeWeights(space);
    if (space.focusedWindowId === windowId)
      space.focusedWindowId = space.windowIds[Math.min(index, space.windowIds.length - 1)];
  } else {
    const spaceIndex = workspace.spaces.indexOf(space);
    workspace.spaces.splice(spaceIndex, 1);
    if (workspace.activeSpaceId === space.id)
      workspace.activeSpaceId =
        workspace.spaces[Math.min(spaceIndex, workspace.spaces.length - 1)]?.id ?? null;
  }
}
export function removeWindow(workspace: ProductWorkspace, windowId: string) {
  if (!workspace.windows.some((window) => window.id === windowId)) return;
  detachWindow(workspace, windowId);
  workspace.windows = workspace.windows.filter((window) => window.id !== windowId);
  workspace.tabs = workspace.tabs.filter((tab) => tab.windowId !== windowId);
}
export function placeWindow(
  workspace: ProductWorkspace,
  windowId: string,
  placement: WindowPlacement,
  spaceId: string,
  now = Date.now(),
) {
  assertWindowMutable(workspace, windowId);
  if (!placement || !['space', 'split'].includes(placement.mode))
    throw new RemoteKitError('invalid_request', 'Invalid window placement');
  let target: ProductSpace | undefined;
  if (placement.mode === 'split') {
    assertWindowMutable(workspace, placement.besideWindowId);
    if (!['left', 'right'].includes(placement.side) || placement.besideWindowId === windowId)
      throw new RemoteKitError('invalid_request', 'Invalid window placement');
    findWindow(workspace, placement.besideWindowId);
    target = windowSpace(workspace, placement.besideWindowId);
    if (!target.windowIds.includes(windowId) && target.windowIds.length >= WORKSPACE_LIMITS.windowsPerSpace)
      throw new RemoteKitError('limit_exceeded', 'Each space supports up to 3 windows');
    const previousIndex = target.windowIds.indexOf(windowId);
    if (previousIndex >= 0) {
      const [weight] = target.weights.splice(previousIndex, 1);
      target.windowIds.splice(previousIndex, 1);
      const index = target.windowIds.indexOf(placement.besideWindowId) + (placement.side === 'right' ? 1 : 0);
      target.windowIds.splice(index, 0, windowId);
      target.weights.splice(index, 0, weight);
      focusWindow(workspace, windowId, now);
      return;
    }
  }
  if (workspace.spaces.some((space) => space.windowIds.includes(windowId))) detachWindow(workspace, windowId);
  if (placement.mode === 'space') {
    target = {
      id: spaceId,
      windowIds: [windowId],
      weights: [1],
      focusedWindowId: windowId,
      lastActiveAt: now,
    };
    workspace.spaces.push(target);
  } else {
    const besideIndex = target!.windowIds.indexOf(placement.besideWindowId);
    const weight = target!.weights[besideIndex] / 2;
    target!.weights[besideIndex] = weight;
    const index = besideIndex + (placement.side === 'right' ? 1 : 0);
    target!.windowIds.splice(index, 0, windowId);
    target!.weights.splice(index, 0, weight);
  }
  focusWindow(workspace, windowId, now);
}
