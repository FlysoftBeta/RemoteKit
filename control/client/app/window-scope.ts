import type { ProductState } from '../../shared/product';

/** Product state that changes with every snapshot and is not read by a window's content. */
const VOLATILE: ReadonlySet<string> = new Set([
  'snapshotSequence',
  'operationReceipts',
  'operationGeneration',
  'serverIncarnation',
]);
/** Workspace parts a window's content reads through its own window, tabs and group, or not at all. */
const WORKSPACE_PER_WINDOW: ReadonlySet<string> = new Set([
  'revision',
  'activeSpaceId',
  'windows',
  'spaces',
  'tabs',
]);

const sameList = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, index) => Object.is(item, b[index]));

/**
 * Whether two product states are the same for the window `windowId`. Recency stamps of other
 * windows and groups, the active group and focus (a window is told whether it is focused) and the tabs of
 * other windows (only which tabs exist matters) do not make a window render again.
 */
export function sameWindowScope(previous: ProductState, next: ProductState, windowId: string): boolean {
  if (previous === next) return true;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (key === 'workspace' || VOLATILE.has(key)) continue;
    if (!Object.is(previous[key as keyof ProductState], next[key as keyof ProductState])) return false;
  }
  const a = previous.workspace;
  const b = next.workspace;
  if (a === b) return true;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (WORKSPACE_PER_WINDOW.has(key)) continue;
    if (!Object.is(a[key as keyof typeof a], b[key as keyof typeof b])) return false;
  }
  if (
    !sameList(
      a.tabs.map((tab) => tab.id),
      b.tabs.map((tab) => tab.id),
    )
  )
    return false;
  if (
    !sameList(
      a.tabs.filter((tab) => tab.windowId === windowId),
      b.tabs.filter((tab) => tab.windowId === windowId),
    )
  )
    return false;
  if (a.windows.length !== b.windows.length) return false;
  for (let index = 0; index < a.windows.length; index++) {
    const before = a.windows[index];
    const after = b.windows[index];
    if (before === after) continue;
    // The window itself is compared as its own prop, with its recency stamp.
    if (before.id === windowId && after.id === windowId) continue;
    if (
      !sameList(Object.values({ ...before, lastActiveAt: 0 }), Object.values({ ...after, lastActiveAt: 0 }))
    )
      return false;
  }
  if (a.spaces.length !== b.spaces.length) return false;
  for (let index = 0; index < a.spaces.length; index++) {
    const before = a.spaces[index];
    const after = b.spaces[index];
    if (before === after) continue;
    if (
      before.id !== after.id ||
      before.name !== after.name ||
      !sameList(before.windowIds, after.windowIds) ||
      !sameList(before.weights, after.weights)
    )
      return false;
  }
  return true;
}
