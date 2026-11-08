export class Cache {
  private readonly entries = new Map<string, { expires: number; value: unknown }>();
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 1000,
  ) {}

  async get<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expires > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return structuredClone(entry.value) as T;
    }
    const value = await load();
    this.entries.delete(key);
    this.entries.set(key, { expires: this.now() + ttl, value: structuredClone(value) });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }

  clear() {
    this.entries.clear();
  }
}
