export class KeyedSerialQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(key) ?? Promise.resolve()).then(work, work);
    this.pending.set(key, next);
    const release = () => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    };
    void next.then(release, release);
    return next;
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(this.pending.values());
  }
}
