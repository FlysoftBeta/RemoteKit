export function freezeSnapshot<T>(snapshot: T): T {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    (Array.isArray(snapshot) || Object.getPrototypeOf(snapshot) === Object.prototype)
  ) {
    Object.values(snapshot).forEach(freezeSnapshot);
    Object.freeze(snapshot);
  }
  return snapshot;
}
export class Store<T> {
  private readonly listeners = new Set<() => void>();
  private snapshot: T;
  constructor(snapshot: T) {
    this.snapshot = freezeSnapshot(snapshot);
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected publish(snapshot: T) {
    this.snapshot = freezeSnapshot(snapshot);
    this.listeners.forEach((listener) => listener());
  }
}

export class Events<T> {
  private readonly listeners = new Set<(event: T) => void>();
  subscribe = (listener: (event: T) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit(event: T) {
    this.listeners.forEach((listener) => listener(event));
  }
}
