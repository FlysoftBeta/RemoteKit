import { EDITOR_BLUR_GRACE_MS, type EditorObservation } from './keyboard-session';

export const CANDIDATE_FOCUS_MS = 1500;

export interface CandidateObservation {
  editor: EditorObservation;
  revision: string;
  now: number;
}

/** A tap focuses the local proxy with inputmode=none inside the gesture so the real keyboard
 * request can later be a plain inputmode switch. The remote side confirms it by opening the
 * keyboard; authoritative NONE newer than the tap that outlasts the blur grace, or silence for 1500 ms, rejects it.
 * Only coarse pointers use candidates: a precise pointer keeps its focus for physical keys.
 */
export class CandidateFocus {
  private state?: { revision: bigint; until: number; inactiveUntil?: number };

  get active() {
    return !!this.state;
  }
  get deadline() {
    const state = this.state;
    return state && Math.min(state.until, state.inactiveUntil ?? Infinity);
  }

  begin(revision: string, now: number, coarse: boolean) {
    this.state = coarse ? { revision: BigInt(revision), until: now + CANDIDATE_FOCUS_MS } : undefined;
  }

  /** Returns true when the candidate must be blurred; confirmation just ends the candidate. */
  observe(next: CandidateObservation, confirmed: boolean) {
    const state = this.state;
    if (!state) return false;
    if (confirmed) {
      this.state = undefined;
      return false;
    }
    // Switching editable nodes reports NONE before the replacement target.
    if (next.editor === 'inactive' && BigInt(next.revision) > state.revision)
      state.inactiveUntil ??= next.now + EDITOR_BLUR_GRACE_MS;
    else state.inactiveUntil = undefined;
    const rejected =
      next.now >= state.until || (state.inactiveUntil !== undefined && next.now >= state.inactiveUntil);
    if (rejected) this.state = undefined;
    return rejected;
  }

  clear() {
    this.state = undefined;
  }
}
