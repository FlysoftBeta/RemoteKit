const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Returns `next` with every part that is deeply equal to the same place in `previous` replaced by
 * the previous reference, so unchanged parts of a state can be told apart by identity. Both are
 * plain JSON values; neither is mutated.
 */
export function shareStructure<T>(previous: unknown, next: T): T {
  if (previous === next) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    let same = previous.length === next.length;
    const items = next.map((item, index) => {
      const shared = shareStructure(previous[index], item);
      if (shared !== previous[index]) same = false;
      return shared;
    });
    return (same ? previous : items) as T;
  }
  if (isRecord(next)) {
    if (!isRecord(previous)) return next;
    const keys = Object.keys(next);
    let same = Object.keys(previous).length === keys.length;
    const entries: Record<string, unknown> = {};
    for (const key of keys) {
      const shared = shareStructure(previous[key], next[key]);
      if (shared !== previous[key] || !(key in previous)) same = false;
      entries[key] = shared;
    }
    return (same ? previous : entries) as T;
  }
  return next;
}
