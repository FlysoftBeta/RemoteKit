import { createContext, useContext, useLayoutEffect } from 'react';

export type FloatingIcon = 'keyboard' | 'keyboard-hide' | 'fullscreen-exit' | 'sound' | 'stop';
export type DockAnchor =
  'top-left' | 'top' | 'top-right' | 'left' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

export type FloatingAction = {
  id: string;
  order: number;
  label: string;
  detail?: string;
  icon: FloatingIcon;
  // Edge slot used until the user drags the button elsewhere, and the slots it may be dragged to.
  anchor: DockAnchor;
  anchors?: readonly DockAnchor[];
  run: () => void;
  disabled?: boolean;
  attention?: 'notice' | 'recording';
  className?: string;
};

type Entry = Omit<FloatingAction, 'run'> & { run: { current: () => void } };

export class FloatingActions {
  private entries = new Map<string, Entry>();
  private snapshot: readonly FloatingAction[] = [];
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  set(id: string, action: FloatingAction | undefined) {
    const previous = this.entries.get(id);
    if (!action) {
      if (!previous) return;
      this.entries.delete(id);
      this.publish();
      return;
    }
    if (previous && sameEntry(previous, action)) {
      previous.run.current = action.run;
      return;
    }
    this.entries.set(id, { ...action, run: { current: action.run } });
    this.publish();
  }

  private publish() {
    this.snapshot = [...this.entries.values()]
      .sort((a, b) => a.order - b.order)
      .map((entry) => ({ ...entry, run: () => entry.run.current() }));
    for (const listener of this.listeners) listener();
  }
}

function sameEntry(entry: Entry, action: FloatingAction) {
  return (
    entry.order === action.order &&
    entry.label === action.label &&
    entry.detail === action.detail &&
    entry.icon === action.icon &&
    entry.anchor === action.anchor &&
    entry.anchors === action.anchors &&
    entry.disabled === action.disabled &&
    entry.attention === action.attention &&
    entry.className === action.className
  );
}

export const FloatingActionsContext = createContext<FloatingActions | null>(null);

// Registers an action for as long as the caller passes one; null withdraws it. The provider's
// owner passes its registry directly because it renders outside its own context.
export function useFloatingAction(
  id: string,
  action: Omit<FloatingAction, 'id'> | null,
  owner?: FloatingActions,
) {
  const context = useContext(FloatingActionsContext);
  const registry = owner ?? context;
  useLayoutEffect(() => {
    if (!registry) return;
    registry.set(id, action ? { ...action, id } : undefined);
  });
  useLayoutEffect(() => () => registry?.set(id, undefined), [registry, id]);
}
