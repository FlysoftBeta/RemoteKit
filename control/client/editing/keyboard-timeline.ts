export type KeyboardStep =
  | 'tap'
  | 'remote-focus'
  | 'candidate-focus'
  | 'open'
  | 'inputmode'
  | 'visual-viewport'
  | 'keyboard-detected'
  | 'occlusion-sent'
  | 'frame-height';

export interface KeyboardTimelineSample {
  tapAtMs: number;
  steps: { step: KeyboardStep; atMs: number }[];
}

const MAX_TIMELINES = 8;
const TIMELINE_SPAN_MS = 10_000;

/** One entry per tap: the first occurrence of each step, relative to the tap. */
export class KeyboardTimeline {
  private readonly history: KeyboardTimelineSample[] = [];
  private occlusionRevisions = new Set<string>();

  tap(now = performance.now()) {
    this.occlusionRevisions = new Set();
    this.history.push({ tapAtMs: now, steps: [{ step: 'tap', atMs: 0 }] });
    if (this.history.length > MAX_TIMELINES) this.history.shift();
  }

  mark(step: KeyboardStep, now = performance.now()) {
    const current = this.history[this.history.length - 1];
    if (!current || now - current.tapAtMs > TIMELINE_SPAN_MS) return;
    if (current.steps.some((item) => item.step === step)) return;
    current.steps.push({ step, atMs: Math.round((now - current.tapAtMs) * 10) / 10 });
  }

  /** The viewer reported a keyboard occlusion under this revision. */
  occlusionSent(revision: string, now = performance.now()) {
    this.occlusionRevisions.add(revision);
    this.mark('occlusion-sent', now);
  }

  /** A frame or view.viewport message echoed an occlusion revision. */
  viewportObserved(revision: string, now = performance.now()) {
    if (this.occlusionRevisions.has(revision)) this.mark('frame-height', now);
  }

  export(since: number): KeyboardTimelineSample[] {
    return this.history
      .filter((item) => item.tapAtMs >= since)
      .map((item) => ({ tapAtMs: item.tapAtMs, steps: item.steps.map((step) => ({ ...step })) }));
  }

  clear() {
    this.history.length = 0;
    this.occlusionRevisions = new Set();
  }
}

export const keyboardTimeline = new KeyboardTimeline();
