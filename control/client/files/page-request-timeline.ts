export interface PageRequestTimelineSample {
  stateAtMs: number;
  stateWallMs: number;
  renderedAtMs?: number;
  renderedWallMs?: number;
}

const MAX_TIMELINES = 16;

/** One entry per file request: when its state reached the client and when the basket first rendered. */
export class PageRequestTimeline {
  private readonly history = new Map<string, PageRequestTimelineSample>();

  /** The ids of the file requests in a received product state; only first sightings are recorded. */
  stateReceived(ids: readonly string[], now = performance.now(), wallMs = Date.now()) {
    for (const id of ids) {
      if (this.history.has(id)) continue;
      this.history.set(id, { stateAtMs: now, stateWallMs: wallMs });
      if (this.history.size > MAX_TIMELINES) this.history.delete(this.history.keys().next().value!);
    }
  }

  rendered(id: string, now = performance.now(), wallMs = Date.now()) {
    const sample = this.history.get(id);
    if (!sample || sample.renderedAtMs !== undefined) return;
    sample.renderedAtMs = now;
    sample.renderedWallMs = wallMs;
  }

  export(since: number): PageRequestTimelineSample[] {
    return [...this.history.values()].filter((item) => item.stateAtMs >= since).map((item) => ({ ...item }));
  }

  clear() {
    this.history.clear();
  }
}

export const pageRequestTimeline = new PageRequestTimeline();
