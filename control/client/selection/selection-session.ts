import type { SelectionTarget } from './target';

export let applyingSelection = false;
export function applySelection(run: () => void) {
  applyingSelection = true;
  try {
    run();
  } finally {
    applyingSelection = false;
  }
}

class SelectionSession {
  private target?: SelectionTarget;
  private revision = 0;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.revision;
  current = () => this.target;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  show(target: SelectionTarget) {
    this.target = target;
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }
  hide = () => {
    this.target = undefined;
    this.revision++;
    this.listeners.forEach((listener) => listener());
  };
  dismiss = (target: SelectionTarget) => {
    if (this.target !== target) return;
    target.collapse();
    this.hide();
  };
  release(target: SelectionTarget) {
    if (this.target === target) this.hide();
  }
}

export const selectionSession = new SelectionSession();
