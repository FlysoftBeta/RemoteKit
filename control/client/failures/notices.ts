import type { Presentation } from './present';

export interface Notice {
  key: string;
  kind: 'progress' | 'info' | 'failure';
  presentation: Presentation;
  since: number;
}
export class Notices {
  private items: Notice[] = [];
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private dismissed = new Map<string, string>();
  getSnapshot = () => this.items;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  post(key: string, presentation: Presentation) {
    if (presentation.class === 'silent') return this.resolve(key);
    const existing = this.items.find((item) => item.key === key);
    const signature = JSON.stringify(presentation);
    if (
      this.dismissed.get(key) === signature ||
      (existing && JSON.stringify(existing.presentation) === signature)
    )
      return;
    clearTimeout(this.timers.get(key));
    const kind =
      presentation.class === 'A'
        ? 'progress'
        : presentation.class === 'C' || presentation.action
          ? 'failure'
          : 'info';
    this.items = [
      { key, kind, presentation, since: existing?.since ?? Date.now() },
      ...this.items.filter((item) => item.key !== key),
    ];
    if (kind === 'info')
      this.timers.set(
        key,
        setTimeout(() => this.dismiss(key), 4000),
      );
    this.emit();
  }
  resolve(key: string) {
    this.dismissed.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (!this.items.some((item) => item.key === key)) return;
    this.items = this.items.filter((item) => item.key !== key);
    this.emit();
  }
  dismiss(key: string) {
    const item = this.items.find((notice) => notice.key === key);
    this.resolve(key);
    if (item) this.dismissed.set(key, JSON.stringify(item.presentation));
  }
  clear() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.dismissed.clear();
    this.items = [];
    this.emit();
  }
  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}
export const notices = new Notices();
