import { freezeSnapshot } from '../util/store';
import { TouchView, type TouchViewPorts, type TouchOwnerState } from './touch-view';

export class TouchSession {
  private readonly views = new Set<TouchView>();

  createView(ports: TouchViewPorts, viewId: string, canvas: HTMLCanvasElement) {
    const view = new TouchView(ports, viewId, canvas);
    this.views.add(view);
    const remove = view.subscribe(() => {
      if (view.isDetached) {
        this.views.delete(view);
        remove();
      }
      this.notify();
    });
    return view;
  }

  reset() {
    this.views.forEach((view) => view.reset());
    this.notify();
  }

  private notify() {
    this.snapshot = freezeSnapshot({
      owners: [...this.views].map((view) => ({ viewId: view.viewId, ...view.getSnapshot() })),
    });
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();
  private snapshot: { owners: ({ viewId: string } & TouchOwnerState)[] } = { owners: [] };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
}
