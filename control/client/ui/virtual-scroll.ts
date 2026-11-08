// Adapted from FlysoftBeta/talos-ng packages/virtual/src/core/{sizes,scroller}.ts.
/** Item sizes with prefix sums and O(log n) lookup. */
export class SizeIndex {
  private values: number[];
  private tree: number[];

  constructor(values: readonly number[]) {
    const n = values.length;
    const tree = new Array<number>(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      tree[i] += values[i - 1];
      const parent = i + (i & -i);
      if (parent <= n) tree[parent] += tree[i];
    }
    this.values = values.slice();
    this.tree = tree;
  }

  get length(): number {
    return this.values.length;
  }

  get total(): number {
    return this.prefix(this.length);
  }

  size(index: number): number {
    return this.values[index];
  }

  prefix(end: number): number {
    let sum = 0;
    for (let i = end; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  find(y: number): number {
    const n = this.length;
    if (!n) return -1;
    let index = 0;
    let sum = 0;
    let step = 1;
    while (step * 2 <= n) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = index + step;
      if (next <= n && sum + this.tree[next] <= y) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(index, n - 1);
  }
}

export function virtualRange(sizes: SizeIndex, top: number, height: number, overscan = 600) {
  if (!sizes.length || height <= 0) return { start: 0, end: 0, offset: 0 };
  const start = sizes.find(Math.max(0, top - overscan));
  const end = sizes.find(Math.max(0, top + height + overscan)) + 1;
  return { start, end, offset: sizes.prefix(start) };
}
